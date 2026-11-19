/**
 * Motion Puppet — signaling twin of signal.php for hosts that run
 * Spacefast Functions instead of PHP. Same contract, same query string:
 *
 *   GET  /api/signal?op=ping
 *   POST /api/signal?s=CODE&k=offer|answer   body: {"type":"offer|answer","sdp":"..."}
 *   GET  /api/signal?s=CODE&k=offer|answer   -> {"ok":true,"data":{...}|null}
 *
 * Sessions live in the Space database for 15 minutes.
 */

const TTL_MS = 900_000;
const MAX_BODY = 65536;

const json = (status, payload) =>
	new Response(JSON.stringify(payload), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		},
	});

async function table(env) {
	await env.DB.prepare(
		'CREATE TABLE IF NOT EXISTS mp_signal (' +
			'code VARCHAR(16) NOT NULL, kind VARCHAR(8) NOT NULL, ' +
			'body TEXT NOT NULL, ts BIGINT NOT NULL, PRIMARY KEY (code, kind))'
	).run();
	return env.DB;
}

function parse(request) {
	const url = new URL(request.url);
	const session = url.searchParams.get('s') || '';
	const kind = url.searchParams.get('k') || '';
	if (url.searchParams.get('op') === 'ping') return { ping: true };
	if (!/^[A-Z0-9]{6,12}$/.test(session)) return { error: 'bad_session' };
	if (kind !== 'offer' && kind !== 'answer') return { error: 'bad_kind' };
	return { session, kind };
}

async function readRow(db, session, kind) {
	const row = await db
		.prepare('SELECT body, ts FROM mp_signal WHERE code = ? AND kind = ?')
		.bind(session, kind)
		.first();
	if (!row || Number(row.ts) < Date.now() - TTL_MS) return null;
	try {
		return JSON.parse(row.body);
	} catch {
		return null;
	}
}

export async function GET(request, context) {
	const q = parse(request);
	if (q.ping) return json(200, { ok: true, engine: 'functions' });
	if (q.error) return json(400, { ok: false, error: q.error });
	try {
		const db = await table(context.env);
		return json(200, { ok: true, data: await readRow(db, q.session, q.kind) });
	} catch (err) {
		return json(500, { ok: false, error: 'storage_unavailable', detail: String(err && err.message) });
	}
}

export async function POST(request, context) {
	const q = parse(request);
	if (q.ping) return json(200, { ok: true, engine: 'functions' });
	if (q.error) return json(400, { ok: false, error: q.error });

	const raw = await request.text();
	if (!raw || raw.length > MAX_BODY) return json(413, { ok: false, error: 'bad_size' });
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		body = null;
	}
	if (!body || body.type !== q.kind || typeof body.sdp !== 'string' || !body.sdp.startsWith('v=0')) {
		return json(400, { ok: false, error: 'bad_description' });
	}
	const clean = JSON.stringify({ type: q.kind, sdp: body.sdp });

	try {
		const db = await table(context.env);
		const now = Date.now();
		// Sweep expired sessions as we go.
		await db.prepare('DELETE FROM mp_signal WHERE ts < ?').bind(now - TTL_MS).run();

		if (q.kind === 'offer') {
			await db.prepare('DELETE FROM mp_signal WHERE code = ?').bind(q.session).run();
			await db
				.prepare('INSERT INTO mp_signal (code, kind, body, ts) VALUES (?, ?, ?, ?)')
				.bind(q.session, 'offer', clean, now)
				.run();
			return json(200, { ok: true });
		}

		if (!(await readRow(db, q.session, 'offer'))) {
			return json(404, { ok: false, error: 'no_such_session' });
		}
		if (await readRow(db, q.session, 'answer')) {
			return json(409, { ok: false, error: 'already_claimed' });
		}
		try {
			await db
				.prepare('INSERT INTO mp_signal (code, kind, body, ts) VALUES (?, ?, ?, ?)')
				.bind(q.session, 'answer', clean, now)
				.run();
		} catch {
			return json(409, { ok: false, error: 'already_claimed' });
		}
		return json(200, { ok: true });
	} catch (err) {
		return json(500, { ok: false, error: 'storage_unavailable', detail: String(err && err.message) });
	}
}
