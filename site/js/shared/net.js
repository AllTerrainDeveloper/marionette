// Pairing and transport.
//
// Signaling (exchanging one SDP offer and one SDP answer) goes through a tiny
// HTTP endpoint: signal.php on PHP hosts, or its /api/signal twin where the
// host runs serverless functions instead. Everything after that is a direct
// browser-to-browser WebRTC connection with two data channels (see protocol.js).

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SESSION_TTL = 13 * 60 * 1000;

export function newSessionCode(length = 8) {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

let endpointPromise = null;

/** Finds the signaling endpoint this host actually runs. */
export function findSignalEndpoint() {
	if (endpointPromise) return endpointPromise;
	endpointPromise = (async () => {
		for (const path of ['signal.php', 'api/signal']) {
			try {
				const url = new URL(path, location.href);
				const res = await fetch(`${url}?op=ping`, { cache: 'no-store' });
				if (!res.ok) continue;
				const body = await res.json();
				if (body && body.ok === true) return url.href;
			} catch {
				// Not this one (a static host returns the PHP source or a 404 here).
			}
		}
		endpointPromise = null;
		throw new Error('No signaling endpoint answered (signal.php or /api/signal).');
	})();
	return endpointPromise;
}

async function signal(method, session, kind, description) {
	const endpoint = await findSignalEndpoint();
	const res = await fetch(`${endpoint}?s=${session}&k=${kind}`, {
		method,
		cache: 'no-store',
		headers: description ? { 'content-type': 'application/json' } : undefined,
		body: description ? JSON.stringify({ type: description.type, sdp: description.sdp }) : undefined,
	});
	let body = null;
	try { body = await res.json(); } catch { /* handled below */ }
	if (!res.ok || !body || body.ok !== true) {
		const err = new Error((body && body.error) || `signal_${res.status}`);
		err.code = (body && body.error) || `http_${res.status}`;
		throw err;
	}
	return body.data ?? null;
}

/** Resolves once ICE gathering finishes (or after `timeout` ms with whatever was found). */
function gathered(pc, timeout = 2500) {
	if (pc.iceGatheringState === 'complete') return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
		const check = () => { if (pc.iceGatheringState === 'complete') done(); };
		const timer = setTimeout(done, timeout);
		pc.addEventListener('icegatheringstatechange', check);
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Link {
	constructor() {
		this.pc = null;
		this.rt = null;
		this.ctl = null;
		this.open = false;
		this.onopen = this.onclose = this.onpacket = this.onmessage = this.onstatus = () => {};
	}

	_wire(channel) {
		channel.binaryType = 'arraybuffer';
		if (channel.label === 'rt') {
			this.rt = channel;
			channel.onmessage = (e) => { if (e.data instanceof ArrayBuffer) this.onpacket(e.data); };
		} else if (channel.label === 'ctl') {
			this.ctl = channel;
			channel.onmessage = (e) => {
				if (typeof e.data !== 'string' || e.data.length > 200000) return;
				let msg;
				try { msg = JSON.parse(e.data); } catch { return; }
				if (msg && typeof msg === 'object' && typeof msg.t === 'string') this.onmessage(msg);
			};
			channel.onopen = () => { this.open = true; this.onopen(); };
			channel.onclose = () => this._lost();
		}
	}

	_watch(pc) {
		pc.addEventListener('connectionstatechange', () => {
			if (pc !== this.pc) return;
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this._lost();
			if (pc.connectionState === 'disconnected') {
				// Brief radio hiccups recover on their own; give it a few seconds.
				setTimeout(() => { if (pc === this.pc && pc.connectionState === 'disconnected') this._lost(); }, 4000);
			}
		});
	}

	_lost() {
		if (!this.pc) return;
		const wasOpen = this.open;
		this.close();
		this.onclose(wasOpen);
	}

	/** High-rate state: dropped rather than queued when the channel is busy. */
	sendPacket(buffer) {
		const ch = this.rt;
		if (!ch || ch.readyState !== 'open' || ch.bufferedAmount > 32768) return false;
		try { ch.send(buffer); return true; } catch { return false; }
	}

	/** Must-arrive JSON message. */
	send(message) {
		const ch = this.ctl;
		if (!ch || ch.readyState !== 'open') return false;
		try { ch.send(JSON.stringify(message)); return true; } catch { return false; }
	}

	close() {
		this.open = false;
		const pc = this.pc;
		this.pc = this.rt = this.ctl = null;
		if (pc) { try { pc.close(); } catch { /* already closed */ } }
	}
}

/** Desktop side: publishes an offer under a fresh session code and waits for a phone. */
export class HostLink extends Link {
	constructor() {
		super();
		this.code = '';
		this.oncode = () => {};
		this._run = 0;
	}

	/** Starts (or restarts) waiting for a phone. Re-arms itself when the session expires. */
	async listen() {
		const run = ++this._run;
		this.close();
		try {
			const pc = (this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }));
			this._watch(pc);
			this._wire(pc.createDataChannel('rt', { ordered: false, maxRetransmits: 0 }));
			this._wire(pc.createDataChannel('ctl', { ordered: true }));
			await pc.setLocalDescription(await pc.createOffer());
			await gathered(pc);
			if (run !== this._run) return;
			const code = newSessionCode();
			await signal('POST', code, 'offer', pc.localDescription);
			if (run !== this._run) return;
			this.code = code;
			this.oncode(code);
			this.onstatus('waiting');

			const expires = Date.now() + SESSION_TTL;
			while (run === this._run && Date.now() < expires) {
				await sleep(document.hidden ? 4000 : 1300);
				if (run !== this._run) return;
				let answer = null;
				try { answer = await signal('GET', code, 'answer'); } catch { /* transient */ }
				if (answer && run === this._run) {
					this.onstatus('connecting');
					await pc.setRemoteDescription(answer);
					// If the direct connection never comes up, start over with a new code.
					setTimeout(() => { if (run === this._run && !this.open) this.listen(); }, 20000);
					return;
				}
			}
			if (run === this._run) this.listen();
		} catch (err) {
			if (run !== this._run) return;
			this.onstatus('error', err);
			await sleep(5000);
			if (run === this._run) this.listen();
		}
	}

	stop() {
		this._run++;
		this.close();
	}
}

/** Phone side: answers the offer stored under `code`. */
export class GuestLink extends Link {
	async join(code) {
		this.close();
		this.onstatus('finding');
		let offer = null;
		for (let attempt = 0; attempt < 4 && !offer; attempt++) {
			offer = await signal('GET', code, 'offer');
			if (!offer) await sleep(700);
		}
		if (!offer) { const e = new Error('This pairing code has expired. Scan the QR code on the stage again.'); e.code = 'expired'; throw e; }

		const pc = (this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }));
		this._watch(pc);
		pc.ondatachannel = (e) => this._wire(e.channel);
		await pc.setRemoteDescription(offer);
		await pc.setLocalDescription(await pc.createAnswer());
		await gathered(pc);
		try {
			await signal('POST', code, 'answer', pc.localDescription);
		} catch (err) {
			this.close();
			if (err.code === 'already_claimed') { const e = new Error('Another phone already took this spot. Scan the other QR code, or ask the stage for a fresh one.'); e.code = 'taken'; throw e; }
			if (err.code === 'no_such_session') { const e = new Error('This pairing code has expired. Scan the QR code on the stage again.'); e.code = 'expired'; throw e; }
			throw err;
		}
		this.onstatus('connecting');
		const deadline = Date.now() + 18000;
		while (!this.open) {
			if (!this.pc || Date.now() > deadline) {
				this.close();
				const e = new Error('The two devices could not reach each other directly. Put both on the same Wi-Fi network and try again.');
				e.code = 'unreachable';
				throw e;
			}
			await sleep(120);
		}
	}
}
