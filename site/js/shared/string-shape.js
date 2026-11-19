// The shape a string is drawn with.
//
// A string is drawn as ONE chain of points, whether it is loose or tight. Each
// step the chain falls a little (if the string has spare length), is kept to the
// string's length, and is kept out of the wood and off the floor — its points and
// the links between them. A tight string is simply the chain pulled as short as
// its way round the limbs allows.
//
// The chain never jumps to a shape worked out elsewhere. The route the physics
// uses (string-path.js) serves as a short cut — the chain may shrink straight in
// towards it — but only when every shape on the way there is clear of the puppet,
// that is, when chain and route pass each limb on the same side. Otherwise the
// chain tightens along its own way round, and tells the router which side it is
// on. So a drawn string moves continuously and cannot pass through a limb.
//
// It is deliberately not a lively simulation: a thread has almost no weight and
// a lot of air drag, so it should settle and then not move at all. It is carried
// along with its two ends before it is relaxed, heavily damped, stepped at a
// fixed rate, and frozen once nothing has moved for a moment.
//
// Pure maths on arrays: no Three.js, no DOM, so it can be tested in Node.

import { pushOut, distanceToSegment, viaOn, stringPath, FLOOR } from './string-path.js';
import { qMul, qConj, qRot } from './math.js';

const STEP = 1 / 120;            // fixed time step of the chain (s)
const MAX_STEPS = 3;             // per update
const KEEP = 0.86;               // share of a point's velocity kept per step
const GRAVITY = 9.81;
const PASSES = 18;               // length-enforcing sweeps per step
const MARGIN = 0.006;            // how far off the wood a loose string rests (m)
const SOFT = 0.02;                // spare length (m) below which slack is eased in (see `want`)
const LEAP = 0.02;                 // a drawn point further than this (m) from the chain closes the gap over a few frames, not in one
const JITTER = 0.003;              // a shift smaller than this (m) is followed gently rather than at once ...
const CALM = 0.12;                // ... by this share per frame
const ON_ROUTE = 0.004;            // a tight chain this close to its route (m) is put exactly on it
const HINT_SLACK = 0.03;          // spare length (m) below which the chain tells the router which side of things it is on
const LINK_MARGIN = 0.002;         // clearance the middle of a link keeps from the wood (m)
const LINK_STEP = 0.016;           // how far a link is eased out of the wood per step (m)
const TIE_LINKS = 14;               // how many links from the tie get the link check against the string's own limb
const OWN_PUSH = 0.02;            // the furthest the link check against the string's own limb moves a point in one step (m)
const MAX_PUSH = 0.03;            // the furthest one correction may move a point out of the wood (m)
const SWEEP_REACH = 0.04;          // pieces within this (m) of a point caught in the wood are asked where they would have carried it
const TURN_REACH = 0.25;           // how far from the tie (m, along the string) slack still goes round with the limb
const TURN_SLACK = 0.05;           // spare length (m) from which it does so fully
const HEAL_DEPTH = -0.0005;        // how far into its own limb (m, negative) the end of a string may cut before it is laid round it ...
const HEAL_REACH = 0.06;           // ... and the furthest sideways (m) that may move a point; beyond it the easing has to do
const STEADY = 0.019;              // sideways movement per frame (m) that needs no run-up ...
const GROW = 2.4;                  // ... and how many times last frame's movement is allowed beyond that
const CATCH_UP = 0.5;              // share of the gap to the chain that what is drawn closes per frame when it is far behind
const PINCH = -0.0015;             // a string squeezed between two pieces may be this close to the wood (m; negative: a touch inside, where two limbs press together)
const EASE = 0.003;                 // how far a squeezed string works its way out of the gap per step (m)
const TOUCH = 0.012;              // a chain point this close to a piece counts as resting on it
const DRAWN_MARGIN = 0.003;       // ... and the least clearance anything drawn keeps from it
const SHRINK_STEP = 0.006;        // furthest a point is drawn towards the route in one step (m): well under half the thinnest limb
const MAX_STEP = 0.008;           // furthest the tightening as a whole moves a point in one step (m)
const SHORTEN_ROUNDS = 6;        // curve-shortening rounds per step for a chain that is too long
const STILL = 0.00004;           // movement per update (m) under which a point counts as not moving
const STILL_UPDATES = 10;        // that many still updates in a row and the chain is frozen
const WAKE = 0.0001;             // an end, a nearby piece or the slack moving this much (m) wakes it

export class StringShape {
	/** @param links number of straight pieces the string is drawn with */
	constructor(links = 44) {
		this.n = links;
		const size = (links + 1) * 3;
		this.p = new Float32Array(size);        // the hanging chain
		this.last = new Float32Array(size);     // ... one step ago
		this.taut = new Float32Array(size);     // the same number of points laid along the route
		this.out = new Float32Array(size);      // what to draw
		this.ends = new Float64Array(6);        // where the two ends were last time
		this.before = new Float32Array(size);   // scratch: the chain at the start of a step
		this.held = new Float32Array(size);     // scratch: the chain before its length is enforced
		this.live = false;
		this.time = 0;
		this.still = 0;
		this.asleep = false;
		this.mark = new Float64Array(8);        // what the frozen chain was frozen against
		this.near = [];
		this.nearIndex = [];
		this.own = [];                          // those of them that belong to the limb the string is tied to
		this.was = new Float64Array(0);         // where every piece was at the last update (origin, rotation)
		this.posed = false;
		this.ownPiece = -1;
		this.shift = new Float32Array(size);    // how far each point of the chain was carried along with the ends this update
		this.shiftOut = new Float32Array(size); // ... and each drawn point
		this.ref = new Float32Array(size);      // what was drawn last time, carried along with the two ends
		this.swing = 0;                         // how far the drawn string moved sideways last time (m)
	}

	/**
	 * @param route     the tight-string route, [[x, y, z], ...], handle first, tie point last
	 * @param rest      how much string there is (m)
	 * @param broken    a snapped string: it hangs from the handle only
	 * @param pieces    the puppet's pieces in the world (string-path.js wrapFrame)
	 * @param excluded  indices of pieces to ignore (those the tie point sits in)
	 * @param dt        seconds since the last call
	 * @param ownBody   index of the body the string is tied to (its pieces get the stricter link check)
	 * @param memory    the router's memory for this string (see stringPath): while the string hangs loose,
	 *                  the pieces it rests on are written there, so that when it is pulled tight again the
	 *                  route goes round them on the side the string is actually on
	 * @returns the points to draw, flat [x, y, z, ...], links + 1 of them
	 */
	update(route, rest, broken, pieces, excluded, dt, memory = null, ownBody = -1) {
		const n = this.n, p = this.p, last = this.last, taut = this.taut, out = this.out;
		const legs = route.length - 1;
		const top = route[0], end = route[legs];

		// The route's length, and n + 1 points spread evenly along it.
		let length = 0;
		const along = _along;
		along.length = 0;
		along.push(0);
		for (let k = 0; k < legs; k++) {
			length += Math.hypot(route[k + 1][0] - route[k][0], route[k + 1][1] - route[k][1], route[k + 1][2] - route[k][2]);
			along.push(length);
		}
		let leg = 0;
		for (let k = 0; k <= n; k++) {
			const d = (k / n) * length;
			while (leg < legs - 1 && along[leg + 1] < d) leg++;
			const span = along[leg + 1] - along[leg] || 1;
			const u = Math.min(1, Math.max(0, (d - along[leg]) / span));
			const a = route[leg], b = route[leg + 1];
			taut[k * 3] = a[0] + (b[0] - a[0]) * u; taut[k * 3 + 1] = Math.max(FLOOR, a[1] + (b[1] - a[1]) * u); taut[k * 3 + 2] = a[2] + (b[2] - a[2]) * u;
		}

		const slack = rest - length;
		// How long the chain should be: the route plus the spare length — eased in. A string with
		// a millimetre to spare can already belly out by centimetres, and a string carrying load
		// has a slack that flickers around zero, so taken literally a nearly tight string would
		// twitch. The spare length therefore counts in full only once there are centimetres of
		// it (s * s / (s + SOFT): quadratic at first, then s less a constant), which makes the
		// belly grow in proportion to the slack instead of leaping.
		const spare = Math.max(0, slack);
		const want = broken ? rest : length + (spare * spare) / (spare + SOFT);
		const loose = broken || want - length > 1e-5;
		const ends = this.ends;
		if (!this.live) {
			p.set(taut); last.set(taut); out.set(taut);
			ends[0] = top[0]; ends[1] = top[1]; ends[2] = top[2]; ends[3] = end[0]; ends[4] = end[1]; ends[5] = end[2];
			this.live = true; this.asleep = false; this.still = 0; this.time = 0;
			this._keep(pieces);
			return out;
		}

		// Carry everything along with the two ends (a snapped string goes with its handle).
		const ax = top[0] - ends[0], ay = top[1] - ends[1], az = top[2] - ends[2];
		const bx = broken ? ax : end[0] - ends[3], by = broken ? ay : end[1] - ends[4], bz = broken ? az : end[2] - ends[5];
		ends[0] = top[0]; ends[1] = top[1]; ends[2] = top[2]; ends[3] = end[0]; ends[4] = end[1]; ends[5] = end[2];
		// Slack close to where the string is tied goes round with the limb it is tied to, not
		// just along with it: carried by the tie point's travel alone, a loop of slack beside a
		// foot that turns would stay put while the shoe turned into it.
		let turn = null, grip = 0;
		if (!broken && this.posed && ownBody >= 0 && slack > 0) {
			let piece = this.ownPiece;
			if (!(piece >= 0 && piece < pieces.length && pieces[piece].body === ownBody)) {
				piece = -1;
				for (let k = 0; k < pieces.length && piece < 0; k++) if (pieces[k].body === ownBody) piece = k;
				this.ownPiece = piece;
			}
			const w = piece * 7;
			if (piece >= 0 && w + 6 < this.was.length) {
				_q[0] = -this.was[w + 3]; _q[1] = -this.was[w + 4]; _q[2] = -this.was[w + 5]; _q[3] = this.was[w + 6];
				turn = qMul(pieces[piece].q, _q);
				if (Math.abs(turn[0]) + Math.abs(turn[1]) + Math.abs(turn[2]) < 1e-6) turn = null;
				grip = Math.min(1, slack / TURN_SLACK);
			}
		}
		const shift = this.shift, shiftOut = this.shiftOut;
		const ref = this.ref;
		for (let k = 0; k <= n; k++) { const u = k / n, o = k * 3; ref[o] = out[o] + ax + (bx - ax) * u; ref[o + 1] = out[o + 1] + ay + (by - ay) * u; ref[o + 2] = out[o + 2] + az + (bz - az) * u; }
		if (ax || ay || az || bx || by || bz || turn) {
			const each = want / n;
			const tx = end[0] - bx, ty = end[1] - by, tz = end[2] - bz;   // where the tie point was
			for (let k = 0; k <= n; k++) {
				const o = k * 3;
				let u = k / n;
				const hold = turn && k > 0 && k < n ? grip * Math.max(0, 1 - ((n - k) * each) / TURN_REACH) : 0;
				u += hold * (1 - u);
				let dx = ax + (bx - ax) * u, dy = ay + (by - ay) * u, dz = az + (bz - az) * u;
				let ex = dx, ey = dy, ez = dz;
				if (hold > 0) {
					_v[0] = p[o] - tx; _v[1] = p[o + 1] - ty; _v[2] = p[o + 2] - tz;
					let r = qRot(turn, _v);
					dx += (r[0] - _v[0]) * hold; dy += (r[1] - _v[1]) * hold; dz += (r[2] - _v[2]) * hold;
					_v[0] = out[o] - tx; _v[1] = out[o + 1] - ty; _v[2] = out[o + 2] - tz;
					r = qRot(turn, _v);
					ex += (r[0] - _v[0]) * hold; ey += (r[1] - _v[1]) * hold; ez += (r[2] - _v[2]) * hold;
				}
				p[o] += dx; p[o + 1] += dy; p[o + 2] += dz;
				last[o] += dx; last[o + 1] += dy; last[o + 2] += dz;
				out[o] += ex; out[o + 1] += ey; out[o + 2] += ez;
				shift[o] = dx; shift[o + 1] = dy; shift[o + 2] = dz;
				shiftOut[o] = ex; shiftOut[o + 1] = ey; shiftOut[o + 2] = ez;
			}
		} else { shift.fill(0); shiftOut.fill(0); }

		// The pieces this string could be touching, and a figure that changes when any of them moves.
		const near = this.near, nearIndex = this.nearIndex, own = this.own;
		near.length = 0; nearIndex.length = 0; own.length = 0;
		const reach = 0.05 + Math.max(0, slack);
		let where = 0;
		for (let k = 0; k < pieces.length; k++) {
			const f = pieces[k];
			if (excluded && excluded.has(k)) continue;
			if (distanceToSegment(f.o, top, end) > f.bound + reach) continue;
			near.push(f); nearIndex.push(k);
			if (f.body === ownBody) own.push(f);
			where += f.o[0] + 2 * f.o[1] + 3 * f.o[2] + f.q[0] + f.q[1] + f.q[2];
		}

		const mark = this.mark;
		if (this.asleep) {
			const change = Math.abs(top[0] - mark[0]) + Math.abs(top[1] - mark[1]) + Math.abs(top[2] - mark[2])
				+ Math.abs(end[0] - mark[3]) + Math.abs(end[1] - mark[4]) + Math.abs(end[2] - mark[5])
				+ Math.abs(slack - mark[6]) + Math.abs(where - mark[7]);
			if (change < WAKE) { this.swing = 0; this._keep(pieces); return out; }
			this.asleep = false;
			this.still = 0;
		}
		mark[0] = top[0]; mark[1] = top[1]; mark[2] = top[2];
		mark[3] = end[0]; mark[4] = end[1]; mark[5] = end[2];
		mark[6] = slack; mark[7] = where;

		// A limb that has moved onto the string takes the string with it. A point that now lies
		// inside a piece is put where that piece would have carried it (the place it had beside
		// the piece a moment ago, which was clear), and from there goes back towards where it
		// was only as far as the wood lets it. So a string hit by a swinging limb is pushed
		// along by the face that hit it, at the limb's own speed: it is not thrown out by the
		// nearest way, which may be the far side, and it never ends up behind the limb.
		if (near.length && this.posed) {
			const free = broken ? n : n - 1;
			this._sweep(p, shift, free, MARGIN, last);
			this._sweep(out, shiftOut, free, DRAWN_MARGIN, null);
		}

		// The string is ONE chain of points, whether loose or tight. Each step it falls a little
		// (if loose), is kept to its length, and is kept out of the wood. It never jumps to a
		// shape worked out elsewhere: it is drawn towards the tight route a short step at a
		// time, and put back outside the wood whenever a step would take it in.
		// So it moves continuously, and it cannot pass through a limb.
		let moved = 0;
		this.time = Math.min(this.time + dt, STEP * MAX_STEPS);
		const link = (broken ? Math.min(rest, 1.2) : want) / n;
		const free = broken ? n : n - 1;     // last point that is not pinned
		const before = this.before;
		while (this.time >= STEP) {
			this.time -= STEP;
			before.set(p);
			if (loose) {
				// Every free point keeps a little of its momentum and falls.
				for (let k = 1; k <= free; k++) {
					const o = k * 3;
					for (let c = 0; c < 3; c++) {
						const now = p[o + c];
						p[o + c] = now + (now - last[o + c]) * KEEP - (c === 1 ? GRAVITY * STEP * STEP : 0);
					}
				}
			}
			last.set(before);
			const held = this.held;
			held.set(p);
			// No link may be longer than its share of the string. Sweeps alternate direction
			// so both ends are felt along the whole chain.
			for (let pass = 0; pass < PASSES; pass++) {
				p[0] = top[0]; p[1] = top[1]; p[2] = top[2];
				if (!broken) { p[n * 3] = end[0]; p[n * 3 + 1] = end[1]; p[n * 3 + 2] = end[2]; }
				const down = pass % 2 === 0;
				for (let i = 0; i < n; i++) {
					const k = down ? i : n - 1 - i;
					const o = k * 3;
					const dx = p[o + 3] - p[o], dy = p[o + 4] - p[o + 1], dz = p[o + 5] - p[o + 2];
					const l = Math.hypot(dx, dy, dz);
					if (l <= link || l < 1e-9) continue;
					const share = k === 0 ? 0 : !broken && k === n - 1 ? 1 : 0.5;
					const f = (l - link) / l;
					p[o] += dx * f * share; p[o + 1] += dy * f * share; p[o + 2] += dz * f * share;
					p[o + 3] -= dx * f * (1 - share); p[o + 4] -= dy * f * (1 - share); p[o + 5] -= dz * f * (1 - share);
				}
			}
			// The sweeps converge slowly on a chain that is nearly straight, and a chain left too
			// long bellies out further than the string allows. A tight string should be as short
			// as its way round the limbs lets it; a loose one exactly as long as the string.
			if (!broken) {
				const target = want;
				let chain = 0;
				for (let k = 0; k < n; k++) chain += Math.hypot(p[k * 3 + 3] - p[k * 3], p[k * 3 + 4] - p[k * 3 + 1], p[k * 3 + 5] - p[k * 3 + 2]);
				if (chain > Math.max(target, length) * 1.00005) {
					// Shrink the bulge towards the route (a bulge shrunk by a factor g uses about
					// g * g as much extra length) — but each point only a short step at a time,
					// shorter than any limb is thick. A point that would enter the wood on the way
					// is put back out on the side it came from by the checks below, so a string
					// caught round a limb stays caught instead of passing through it.
					const g = Math.sqrt(Math.max(0, target - length) / (chain - length));
					for (let k = 1; k < n; k++) {
						const o = k * 3;
						const dx = (taut[o] - p[o]) * (1 - g), dy = (taut[o + 1] - p[o + 1]) * (1 - g), dz = (taut[o + 2] - p[o + 2]) * (1 - g);
						const d = Math.hypot(dx, dy, dz);
						const f = d > SHRINK_STEP ? SHRINK_STEP / d : 1;
						p[o] += dx * f; p[o + 1] = Math.max(FLOOR, p[o + 1] + dy * f); p[o + 2] += dz * f;
						last[o] += dx * f; last[o + 1] += dy * f; last[o + 2] += dz * f;
					}
					// And tighten it along its own way round as well (every point towards the middle
					// of its two neighbours, kept outside the wood): that is what shortens a string
					// that is caught on something and cannot go straight to the route.
					for (let round = 0; round < SHORTEN_ROUNDS; round++) {
						chain = 0;
						for (let k = 0; k < n; k++) chain += Math.hypot(p[k * 3 + 3] - p[k * 3], p[k * 3 + 4] - p[k * 3 + 1], p[k * 3 + 5] - p[k * 3 + 2]);
						const pull = Math.min(0.5, (chain - Math.max(target, length)) / (0.004 * rest));
						if (pull <= 0.001) break;
						for (let k = 1; k < n; k++) {
							const o = k * 3;
							_point[0] = p[o] + ((p[o - 3] + p[o + 3]) / 2 - p[o]) * pull;
							_point[1] = Math.max(FLOOR, p[o + 1] + ((p[o - 2] + p[o + 4]) / 2 - p[o + 1]) * pull);
							_point[2] = p[o + 2] + ((p[o - 1] + p[o + 5]) / 2 - p[o + 2]) * pull;
							_from[0] = p[o]; _from[1] = p[o + 1]; _from[2] = p[o + 2];
							const clear = near.length ? settle(near, _from, _point) : _point;
							last[o] += clear[0] - p[o]; last[o + 1] += clear[1] - p[o + 1]; last[o + 2] += clear[2] - p[o + 2];
							p[o] = clear[0]; p[o + 1] = clear[1]; p[o + 2] = clear[2];
						}
					}
				}
			}
			// However much the length-keeping above wants to move a point, it moves a bounded distance
			// per step: a string let go by the limb it was caught on straightens over a few
			// frames, it does not appear straight. (Being pushed out of the wood, below, is not
			// held back.)
			for (let k = 1; k <= free; k++) {
				const o = k * 3;
				const dx = p[o] - held[o], dy = p[o + 1] - held[o + 1], dz = p[o + 2] - held[o + 2];
				const d = Math.hypot(dx, dy, dz);
				if (d <= MAX_STEP) continue;
				const f = MAX_STEP / d;
				p[o] = held[o] + dx * f; p[o + 1] = held[o + 1] + dy * f; p[o + 2] = held[o + 2] + dz * f;
				last[o] = p[o]; last[o + 1] = p[o + 1]; last[o + 2] = p[o + 2];
			}
			// A tight string that has all but reached its route is simply on it: no more nudging,
			// so that a taut string on a still puppet is perfectly still.
			if (!loose) {
				let off = 0;
				for (let k = 3; k < n * 3; k++) off = Math.max(off, Math.abs(p[k] - taut[k]));
				if (off < ON_ROUTE) { p.set(taut); last.set(taut); }
			}
			// It cannot be in the wood or under the floor. A point that is gets moved to the
			// last clear place on the way it came (it slides back along its own step, so it
			// cannot change sides of a limb or be thrown to a far way out); only if a limb has
			// moved onto it does it take the nearest way out. Either way it stops there.
			for (let k = 1; k <= free; k++) {
				const o = k * 3;
				_point[0] = p[o]; _point[1] = Math.max(p[o + 1], FLOOR); _point[2] = p[o + 2];
				_from[0] = before[o]; _from[1] = before[o + 1]; _from[2] = before[o + 2];
				const clear = near.length ? settle(near, _from, _point) : _point;
				if (clear !== _point || p[o + 1] < FLOOR) {
					p[o] = clear[0]; p[o + 1] = clear[1]; p[o + 2] = clear[2];
					last[o] = p[o]; last[o + 1] = p[o + 1]; last[o + 2] = p[o + 2];
				}
			}
			held.set(p);
			// A link that cuts through a piece between two points that are themselves clear is
			// eased out of it: both its
			// ends take a small step the way the middle has to go, step after step, until it is
			// clear. Small, because a full push here is what makes a chain zigzag.
			if (near.length) {
				for (let k = 0; k < n; k++) {
					const o = k * 3;
					for (let part = 1; part <= 3; part++) {
						const u = part / 4;
						_point[0] = p[o] + (p[o + 3] - p[o]) * u; _point[1] = p[o + 1] + (p[o + 4] - p[o + 1]) * u; _point[2] = p[o + 2] + (p[o + 5] - p[o + 2]) * u;
						const mx = _point[0], my = _point[1], mz = _point[2];
						const clear = resolve(near, _point, LINK_MARGIN);
						if (clear === _point) continue;
						let dx = clear[0] - mx, dy = clear[1] - my, dz = clear[2] - mz;
						const d = Math.hypot(dx, dy, dz);
						if (d > LINK_STEP) { const f = LINK_STEP / d; dx *= f; dy *= f; dz *= f; }
						// Each end goes that way only as far as it can without entering the wood itself.
						for (let end = 0; end < 2; end++) {
							const e = k + end;
							if (e < 1 || e > free) continue;
							const q = e * 3;
							_from[0] = p[q]; _from[1] = p[q + 1]; _from[2] = p[q + 2];
							_to[0] = p[q] + dx; _to[1] = Math.max(FLOOR, p[q + 1] + dy); _to[2] = p[q + 2] + dz;
							const at = settle(near, _from, _to);
							p[q] = at[0]; p[q + 1] = at[1]; p[q + 2] = at[2];
							last[q] = p[q]; last[q + 1] = p[q + 1]; last[q + 2] = p[q + 2];
						}
					}
				}
			}
			this._bound(held, free, MAX_PUSH);
			held.set(p);
			// Last, so that nothing undoes it: near where it is tied, a link may not cut through
			// the string's own limb, between two
			// points that are themselves clear (a loop of slack falling "through" the shoe it is
			// tied to): if the middle of one of the last links is in that limb, both its ends
			// move by what it takes to get the middle out. (Only there and only for that limb:
			// applied everywhere, it makes a chain zigzag through thin parts such as a hand.)
			if (own.length && !broken) {
				// (A few rounds: getting one link out can put its neighbour in.)
				const first = Math.max(0, n - TIE_LINKS);
				let depth = this._inOwn(first - 1, n - 1);
				for (let round = 0; round < 3 && depth > 0; round++) {
					for (let k = first; k < n; k++) {
						const o = k * 3;
						// Three places along the link, not just its middle: on a rounded shoe a link
						// can have its middle clear and a quarter of it in the wood.
						for (let part = 1; part <= 3; part++) {
							const u = part / 4;
							_point[0] = p[o] + (p[o + 3] - p[o]) * u; _point[1] = p[o + 1] + (p[o + 4] - p[o + 1]) * u; _point[2] = p[o + 2] + (p[o + 5] - p[o + 2]) * u;
							const mx = _point[0], my = _point[1], mz = _point[2];
							const clear = resolve(own, _point);
							if (clear === _point) continue;
							const a = k >= 1, b = k + 1 <= free;
							// With one end pinned (the tie itself), the other has to go further to take the middle as far.
							const reach = a && b ? 1 : Math.min(3, a ? 1 / (1 - u) : 1 / u);
							const dx = (clear[0] - mx) * reach, dy = (clear[1] - my) * reach, dz = (clear[2] - mz) * reach;
							if (a) { p[o] += dx; p[o + 1] = Math.max(FLOOR, p[o + 1] + dy); p[o + 2] += dz; }
							if (b) { p[o + 3] += dx; p[o + 4] = Math.max(FLOOR, p[o + 4] + dy); p[o + 5] += dz; }
						}
					}
					depth = this._inOwn(first - 1, n - 1);
				}
				for (let k = Math.max(1, first); k <= free; k++) { const o = k * 3; if (p[o] !== held[o] || p[o + 1] !== held[o + 1] || p[o + 2] !== held[o + 2]) { last[o] = p[o]; last[o + 1] = p[o + 1]; last[o + 2] = p[o + 2]; } }
			}
			this._bound(held, free, OWN_PUSH);
			for (let k = 3; k < p.length; k++) moved = Math.max(moved, Math.abs(p[k] - before[k]));
		}

		// Last resort, after all the easing above: if the end of the chain still cuts through the
		// limb the string is tied to (a foot flung about with a loop of slack beside it), that
		// end is laid along the way round the limb — the same route a tight string would take.
		if (own.length && !broken) this._heal(p, last, MARGIN);

		// The chain is what is drawn. Real movement is shown at once — anything trailing behind
		// it would lag into a limb that has just moved — but a point that has shifted by less
		// than a few millimetres is followed gently, so the fidgeting of a chain at rest against
		// something (well inside its clearance from the wood) never reaches the screen.
		moved = 0;
		for (let k = 1; k <= (broken ? n : n - 1); k++) {
			const o = k * 3;
			const dx = p[o] - out[o], dy = p[o + 1] - out[o + 1], dz = p[o + 2] - out[o + 2];
			const d = Math.hypot(dx, dy, dz);
			// ... and the rare large one — a string knocked aside by a fast limb — is spread over
			// two or three frames rather than shown as one leap.
			let f = d > LEAP ? Math.max(LEAP / d, CATCH_UP) : d > JITTER ? 1 : CALM;
			if (d > LEAP && near.length) {
				// (unless holding it back would leave it inside the limb that is pushing it)
				_point[0] = out[o] + dx * f; _point[1] = out[o + 1] + dy * f; _point[2] = out[o + 2] + dz * f;
				if (!isClear(near, _point, null, DRAWN_MARGIN)) f = 1;
			}
			out[o] += dx * f; out[o + 1] += dy * f; out[o + 2] += dz * f;
			moved = Math.max(moved, Math.abs(dx * f), Math.abs(dy * f), Math.abs(dz * f));
		}
		// What is drawn may trail the chain by a frame or two, but not through the limb the
		// string is tied to.
		if (own.length && !broken) this._heal(out, null, DRAWN_MARGIN);
		// And no leaps. However the chain got where it is, what is drawn moves sideways at most
		// 2.4 times as far as it did the frame before, or STEADY, whichever is more. A string
		// set moving builds up to any speed within a few frames, but it cannot be in one place
		// and somewhere else the next.
		const most = Math.max(STEADY, GROW * this.swing);
		for (let k = 1; k <= (broken ? n : n - 1); k++) {
			const o = k * 3;
			const dx = out[o] - ref[o], dy = out[o + 1] - ref[o + 1], dz = out[o + 2] - ref[o + 2];
			const d = Math.hypot(dx, dy, dz);
			if (d <= most) continue;
			const f = most / d;
			out[o] = ref[o] + dx * f; out[o + 1] = Math.max(FLOOR, ref[o + 1] + dy * f); out[o + 2] = ref[o + 2] + dz * f;
		}
		// Held back like that, the end of the string may be left cutting its own limb. Then the
		// way round the limb from where it now is — if that is no leap either.
		let swing = this._swing();
		if (own.length && !broken) {
			_held.set(out);
			if (this._heal(out, null, DRAWN_MARGIN, HEAL_REACH)) {
				swing = this._swing();
				if (swing > most) {
					// Too far for one frame: as much of the way there as is not a leap.
					_there.set(out);
					let lo = 0, hi = 1;
					for (let step = 0; step < 5; step++) {
						const t = (lo + hi) / 2;
						for (let k = 3; k < n * 3; k++) out[k] = _held[k] + (_there[k] - _held[k]) * t;
						if (this._swing() > most) hi = t; else lo = t;
					}
					for (let k = 3; k < n * 3; k++) out[k] = _held[k] + (_there[k] - _held[k]) * lo;
					swing = this._swing();
				}
			}
		}
		this.swing = swing;
		out[0] = top[0]; out[1] = Math.max(FLOOR, top[1]); out[2] = top[2];
		if (!broken) { out[n * 3] = end[0]; out[n * 3 + 1] = Math.max(FLOOR, end[1]); out[n * 3 + 2] = end[2]; }

		// When the string is about to go tight, the pieces the chain rests on go to the router,
		// so that the route takes the same side of them. (Not while it is plainly loose: a slack
		// string touches things the tight one would never go round.)
		if (memory && !broken && slack < HINT_SLACK) memory.vias = this._contacts();
		this.still = moved < STILL ? this.still + 1 : 0;
		if (this.still >= STILL_UPDATES) this.asleep = true;
		this._keep(pieces);
		return out;
	}

	/**
	 * Takes the end of `points` (the chain, or what is drawn) out of the limb the string is
	 * tied to, if a link there cuts through it. Only the stretch in trouble is touched: between
	 * the clear points either side of it, the points are put on the router's way round the
	 * limb — one on every corner of that route, the rest spread between — so that the links
	 * between them are the route's own legs, which do not cut the wood. Exact, where the
	 * easing in the steps is gradual. Returns whether it had to.
	 */
	_heal(points, follow, margin, reach = HEAL_REACH) {
		const { n } = this;
		const wood = this.own;
		const first = Math.max(0, n - TIE_LINKS);
		let healed = false;
		for (let k = first; k < n; k++) {
			if (!this._cuts(points, k, wood)) continue;
			// The stretch of links in trouble, and a clear point either side of it.
			let start = k, stop = k + 1;
			while (stop < n && this._cuts(points, stop, wood)) stop++;
			for (let tries = 0; start > 0 && tries < 3 && !this._free(points, start, wood, margin); tries++) start--;
			for (let tries = 0; stop < n && tries < 3 && !this._free(points, stop, wood, margin); tries++) stop++;
			let path = null;
			for (let widen = 0; widen < 4; widen++) {
				_a[0] = points[start * 3]; _a[1] = points[start * 3 + 1]; _a[2] = points[start * 3 + 2];
				_b[0] = points[stop * 3]; _b[1] = points[stop * 3 + 1]; _b[2] = points[stop * 3 + 2];
				path = stringPath(_a, _b, wood, _none, margin).points;
				if (stop - start - 1 >= Math.max(1, path.length - 2)) break;   // a point for every corner
				if (start > 0) start--;
				if (stop < n) stop++;
			}
			const inner = stop - start - 1, corners = path.length - 2;
			if (inner < 1) continue;
			// Which point goes on which corner: in proportion to how far along the route it is.
			let length = 0;
			_along.length = 0; _along.push(0);
			for (let i = 0; i < path.length - 1; i++) { length += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1], path[i + 1][2] - path[i][2]); _along.push(length); }
			_index.length = 0; _index.push(0);
			for (let j = 1; j <= corners; j++) {
				let at = Math.round((_along[j] / (length || 1)) * (inner + 1));
				at = Math.max(_index[j - 1] + 1, Math.min(inner - (corners - j), at));
				_index.push(at);
			}
			_index.push(inner + 1);
			if (inner < corners) { _index.length = 0; for (let j = 0; j < path.length; j++) _index.push(Math.round((_along[j] / (length || 1)) * (inner + 1))); }
			// Where each point would go; and only if none has to go far — a stretch that would
			// have to leap is left to the easing, which gets it out over a few frames.
			let far = 0;
			for (let j = 0; j < path.length - 1; j++) {
				const a = path[j], b = path[j + 1], i0 = _index[j], i1 = _index[j + 1];
				for (let i = Math.max(1, i0); i <= Math.min(inner, j === path.length - 2 ? i1 - 1 : i1); i++) {
					const u = i1 > i0 ? (i - i0) / (i1 - i0) : 1, o = (start + i) * 3;
					_round[o] = a[0] + (b[0] - a[0]) * u; _round[o + 1] = Math.max(FLOOR, a[1] + (b[1] - a[1]) * u); _round[o + 2] = a[2] + (b[2] - a[2]) * u;
					// (How far sideways: from the string as it is, not from where this point was on it.)
					_point[0] = _round[o]; _point[1] = _round[o + 1]; _point[2] = _round[o + 2];
					let off = Infinity;
					for (let q = start; q < stop && off > 0; q++) {
						_a[0] = points[q * 3]; _a[1] = points[q * 3 + 1]; _a[2] = points[q * 3 + 2];
						_b[0] = points[q * 3 + 3]; _b[1] = points[q * 3 + 4]; _b[2] = points[q * 3 + 5];
						off = Math.min(off, distanceToSegment(_point, _a, _b));
					}
					far = Math.max(far, off);
				}
			}
			if (far > reach) { k = stop - 1; continue; }
			for (let o = (start + 1) * 3; o < stop * 3; o++) {
				points[o] = _round[o];
				if (follow) follow[o] = _round[o];
			}
			healed = true;
			k = stop - 1;
		}
		return healed;
	}

	/** How far what is drawn has moved sideways since last time: the furthest any of its points is from the string as it was. */
	_swing() {
		const { n, out, ref } = this;
		let swing = 0;
		for (let k = 1; k < n; k++) {
			_point[0] = out[k * 3]; _point[1] = out[k * 3 + 1]; _point[2] = out[k * 3 + 2];
			let d = Infinity;
			for (let j = 0; j < n && d > 0; j++) {
				_a[0] = ref[j * 3]; _a[1] = ref[j * 3 + 1]; _a[2] = ref[j * 3 + 2];
				_b[0] = ref[j * 3 + 3]; _b[1] = ref[j * 3 + 4]; _b[2] = ref[j * 3 + 5];
				d = Math.min(d, distanceToSegment(_point, _a, _b));
			}
			if (d > swing) swing = d;
		}
		return swing;
	}

	/** Whether link `k` of `points` cuts through one of `wood` (four places along it). */
	_cuts(points, k, wood) {
		const o = k * 3;
		for (let part = k === 0 ? 1 : 0; part <= 3; part++) {
			const u = part / 4;
			_point[0] = points[o] + (points[o + 3] - points[o]) * u; _point[1] = points[o + 1] + (points[o + 4] - points[o + 1]) * u; _point[2] = points[o + 2] + (points[o + 5] - points[o + 2]) * u;
			if (!isClear(wood, _point, null, HEAL_DEPTH)) return true;
		}
		return false;
	}

	/** Whether point `k` of `points` is clear of `wood`. */
	_free(points, k, wood, margin) {
		_point[0] = points[k * 3]; _point[1] = points[k * 3 + 1]; _point[2] = points[k * 3 + 2];
		return isClear(wood, _point, null, margin);
	}

	/** How far links `from`..`to` of the chain are inside the limb the string is tied to: the depths at four places on each, added up. */
	_inOwn(from, to) {
		const { p, n, own } = this;
		let total = 0;
		for (let k = Math.max(0, from); k <= Math.min(n - 1, to); k++) {
			const o = k * 3;
			for (let part = k === 0 ? 1 : 0; part <= 3; part++) {
				const u = part / 4;
				_probe[0] = p[o] + (p[o + 3] - p[o]) * u; _probe[1] = p[o + 1] + (p[o + 4] - p[o + 1]) * u; _probe[2] = p[o + 2] + (p[o + 5] - p[o + 2]) * u;
				for (let i = 0; i < own.length; i++) {
					const f = own[i];
					const ex = _probe[0] - f.o[0], ey = _probe[1] - f.o[1], ez = _probe[2] - f.o[2];
					const r = f.bound + MARGIN;
					if (ex * ex + ey * ey + ez * ez > r * r) continue;
					const exit = pushOut(f, _probe, MARGIN);
					if (exit) total += Math.hypot(exit[0] - _probe[0], exit[1] - _probe[1], exit[2] - _probe[2]);
				}
			}
		}
		return total;
	}

	/**
	 * After a correction: no point of the chain further than `most` from where it was (`from`),
	 * and none left inside another piece by it — each stops at the last clear place on its way.
	 */
	_bound(from, free, most) {
		const { p, last, near } = this;
		for (let k = 1; k <= free; k++) {
			const o = k * 3;
			const dx = p[o] - from[o], dy = p[o + 1] - from[o + 1], dz = p[o + 2] - from[o + 2];
			const d = Math.hypot(dx, dy, dz);
			if (d < 1e-7) continue;
			const f = Math.min(1, most / d);
			_from[0] = from[o]; _from[1] = from[o + 1]; _from[2] = from[o + 2];
			_to[0] = from[o] + dx * f; _to[1] = Math.max(FLOOR, from[o + 1] + dy * f); _to[2] = from[o + 2] + dz * f;
			const at = near.length ? settle(near, _from, _to) : _to;
			p[o] = at[0]; p[o + 1] = at[1]; p[o + 2] = at[2];
			last[o] = p[o]; last[o + 1] = p[o + 1]; last[o + 2] = p[o + 2];
		}
	}

	/** Remembers where every piece is, for the next update's sweep. */
	_keep(pieces) {
		if (this.was.length !== pieces.length * 7) this.was = new Float64Array(pieces.length * 7);
		const was = this.was;
		for (let k = 0; k < pieces.length; k++) {
			const f = pieces[k], w = k * 7;
			was[w] = f.o[0]; was[w + 1] = f.o[1]; was[w + 2] = f.o[2];
			was[w + 3] = f.q[0]; was[w + 4] = f.q[1]; was[w + 5] = f.q[2]; was[w + 6] = f.q[3];
		}
		this.posed = true;
	}

	/**
	 * Where `point` belongs if a piece has moved onto it since the last update: the last clear
	 * place between where that piece would have carried it and where it is. Null if no piece
	 * has. (lx, ly, lz) is how far the point was carried along with the string's ends, which
	 * has to be taken off again to know where it was.
	 */
	_carried(point, lx, ly, lz, margin) {
		const { near, nearIndex, was } = this;
		let inside = false;
		for (let i = 0; i < near.length && !inside; i++) {
			const f = near[i];
			const ex = point[0] - f.o[0], ey = point[1] - f.o[1], ez = point[2] - f.o[2];
			const r = f.bound + margin;
			inside = ex * ex + ey * ey + ez * ez <= r * r && !!pushOut(f, point, margin - 0.0015);
		}
		if (!inside) return null;
		// Where it was, as each piece close by would have carried it (two limbs closing on a
		// string — a knee bending — may each have moved onto it), and where it was in the
		// world: of those that are free, the one nearest to where it is now.
		const wx = point[0] - lx, wy = point[1] - ly, wz = point[2] - lz;
		// (Squeezed between two limbs there may be no place with the full clearance from both:
		// then one that is at least out of the wood itself.)
		let cx = 0, cy = 0, cz = 0, best = Infinity, room = margin;
		for (let attempt = 0; attempt < 2 && best === Infinity; attempt++) {
			if (attempt) room = Math.min(margin, PINCH);
			for (let i = -1; i < near.length; i++) {
				if (i < 0) { _from[0] = wx; _from[1] = Math.max(FLOOR, wy); _from[2] = wz; } else {
					const f = near[i], w = nearIndex[i] * 7;
					if (w + 6 >= was.length) continue;
					const ex = point[0] - f.o[0], ey = point[1] - f.o[1], ez = point[2] - f.o[2];
					const r = f.bound + margin + SWEEP_REACH;
					if (ex * ex + ey * ey + ez * ez > r * r) continue;
					_q[0] = -was[w + 3]; _q[1] = -was[w + 4]; _q[2] = -was[w + 5]; _q[3] = was[w + 6];
					_v[0] = wx - was[w]; _v[1] = wy - was[w + 1]; _v[2] = wz - was[w + 2];
					const turned = qRot(qMul(f.q, _q), _v);
					_from[0] = f.o[0] + turned[0]; _from[1] = Math.max(FLOOR, f.o[1] + turned[1]); _from[2] = f.o[2] + turned[2];
				}
				const d = Math.hypot(_from[0] - point[0], _from[1] - point[1], _from[2] - point[2]);
				if (d >= best || !isClear(near, _from, null, room)) continue;
				best = d; cx = _from[0]; cy = _from[1]; cz = _from[2];
			}
		}
		if (best === Infinity) return resolve(near, point, margin);
		let bx = point[0], by = point[1], bz = point[2];
		for (let step = 0; step < 6; step++) {
			_mid[0] = (cx + bx) / 2; _mid[1] = (cy + by) / 2; _mid[2] = (cz + bz) / 2;
			if (isClear(near, _mid, null, room)) { cx = _mid[0]; cy = _mid[1]; cz = _mid[2]; } else { bx = _mid[0]; by = _mid[1]; bz = _mid[2]; }
		}
		return [cx, cy, cz];
	}

	/**
	 * Takes `points` (the chain, or what is drawn) along with any piece that has moved onto
	 * them. (`shift`: how far each point was carried along with the string's ends; `follow`,
	 * if given, is set to the same places.)
	 */
	_sweep(points, shift, free, margin, follow) {
		for (let k = 1; k <= free; k++) {
			const o = k * 3;
			_s[0] = points[o]; _s[1] = points[o + 1]; _s[2] = points[o + 2];
			const at = this._carried(_s, shift[o], shift[o + 1], shift[o + 2], margin);
			if (!at) continue;
			points[o] = at[0]; points[o + 1] = at[1]; points[o + 2] = at[2];
			if (follow) { follow[o] = at[0]; follow[o + 1] = at[1]; follow[o + 2] = at[2]; }
		}
	}

	/** Whether a string drawn through these points stays out of the wood: its points and the middle of each link. */
	_clear(points) {
		const { n, near } = this;
		for (let k = 0; k < n; k++) {
			const o = k * 3;
			for (let half = 0; half < 2; half++) {
				if (k === 0 && half === 0) continue;
				const x = half ? (points[o] + points[o + 3]) / 2 : points[o], y = half ? (points[o + 1] + points[o + 4]) / 2 : points[o + 1], z = half ? (points[o + 2] + points[o + 5]) / 2 : points[o + 2];
				for (let i = 0; i < near.length; i++) {
					const f = near[i];
					const ex = x - f.o[0], ey = y - f.o[1], ez = z - f.o[2];
					if (ex * ex + ey * ey + ez * ez > f.bound * f.bound) continue;
					_probe[0] = x; _probe[1] = y; _probe[2] = z;
					if (pushOut(f, _probe, -DRAWN_MARGIN)) return false;   // more than a few millimetres inside
				}
			}
		}
		return true;
	}

	/** The pieces the hanging chain rests on, in order from the handle: one place on each. */
	_contacts() {
		const { p, n, near, nearIndex } = this;
		const vias = [];
		_seen.clear();
		for (let k = 1; k < n; k++) {
			const o = k * 3;
			_point[0] = p[o]; _point[1] = p[o + 1]; _point[2] = p[o + 2];
			for (let i = 0; i < near.length; i++) {
				if (_seen.has(i)) continue;
				const f = near[i];
				const ex = _point[0] - f.o[0], ey = _point[1] - f.o[1], ez = _point[2] - f.o[2];
				const r = f.bound + TOUCH;
				if (ex * ex + ey * ey + ez * ez > r * r) continue;
				if (!pushOut(f, _point, TOUCH)) continue;
				_seen.add(i);
				vias.push(viaOn(f, nearIndex[i], _point));
			}
		}
		return vias;
	}
}

const _along = [];
const _seen = new Set();
const _probe = [0, 0, 0];
const _from = [0, 0, 0];
const _mid = [0, 0, 0];
const _to = [0, 0, 0];
const _point = [0, 0, 0];
const _s = [0, 0, 0];
const _v = [0, 0, 0];
const _q = [0, 0, 0, 1];
const _round = new Float32Array(1203);
const _there = new Float32Array(1203);
const _held = new Float32Array(1203);
const _none = new Set();
const _a = [0, 0, 0];
const _b = [0, 0, 0];
const _index = [];

/**
 * A place for `point` clear of every piece and above the floor. Returns `point` itself if
 * it already is. Otherwise it takes the nearest way out, piece by piece; if that keeps
 * landing in another piece (two overlapping ones) it goes up instead — a string comes to
 * lie on top of things. The move is never more than MAX_PUSH: a point deep inside the
 * puppet works its way out over a few steps rather than appearing somewhere else.
 */
function resolve(pieces, point, margin = MARGIN) {
	const to = exit(pieces, point, margin);
	if (to === point || margin <= PINCH || !isClear(pieces, point, null, PINCH)) return to;
	// It is not in the wood, only closer to it than a string is drawn — squeezed in a gap
	// too narrow to keep its distance from both sides. It stays in the gap and works its
	// way out a little at a time; it is not thrown out of it.
	const dx = to[0] - point[0], dy = to[1] - point[1], dz = to[2] - point[2];
	const d = Math.hypot(dx, dy, dz);
	if (d <= EASE) return to;
	const eased = [point[0] + dx * EASE / d, Math.max(FLOOR, point[1] + dy * EASE / d), point[2] + dz * EASE / d];
	return isClear(pieces, eased, null, PINCH) ? eased : point;
}

function exit(pieces, point, margin) {
	let from = point;
	for (let round = 0; round < 4; round++) {
		let best = null, bestMove = Infinity, near = null, nearMove = Infinity;
		for (let i = 0; i < pieces.length; i++) {
			const f = pieces[i];
			const ex = from[0] - f.o[0], ey = from[1] - f.o[1], ez = from[2] - f.o[2];
			const r = f.bound + margin + 0.002;
			if (ex * ex + ey * ey + ez * ez > r * r) continue;
			const out = pushOut(f, from, margin);
			if (!out) continue;
			if (out[1] < FLOOR) out[1] = FLOOR;
			const move = Math.hypot(out[0] - from[0], out[1] - from[1], out[2] - from[2]);
			if (move < nearMove) { nearMove = move; near = out; }
			if (move < bestMove && isClear(pieces, out, f, margin)) { bestMove = move; best = out; }
		}
		if (!near) return from === point ? point : bounded(point, from);
		if (best) return bounded(point, best);
		from = near;
	}
	const up = [point[0], Math.max(point[1], FLOOR), point[2]];
	for (let step = 0; step < 6 && !isClear(pieces, up, null, margin); step++) up[1] += 0.005;
	return up;
}

/**
 * Where a point that moved from `from` to `to` comes to rest: `to` if that is clear of the
 * wood; else, if it started clear, the last clear place on the way (found by halving); else
 * — a limb has moved onto it — the nearest way out of where it is.
 */
function settle(pieces, from, to) {
	if (isClear(pieces, to, null)) return to;
	let margin = MARGIN;
	if (from[1] < FLOOR || !isClear(pieces, from, null)) {
		// It did not start clear. In the wood (a limb has moved onto it), or squeezed in a gap
		// and staying in one: the way out. Squeezed and heading into the wood: as far as the wood.
		if (from[1] < FLOOR || !isClear(pieces, from, null, PINCH) || isClear(pieces, to, null, PINCH)) return resolve(pieces, to);
		margin = PINCH;
	}
	let ax = from[0], ay = from[1], az = from[2], bx = to[0], by = to[1], bz = to[2];
	for (let i = 0; i < 6; i++) {
		_mid[0] = (ax + bx) / 2; _mid[1] = (ay + by) / 2; _mid[2] = (az + bz) / 2;
		if (isClear(pieces, _mid, null, margin)) { ax = _mid[0]; ay = _mid[1]; az = _mid[2]; } else { bx = _mid[0]; by = _mid[1]; bz = _mid[2]; }
	}
	return [ax, ay, az];
}

/** `to`, or the point MAX_PUSH from `from` towards it if it is further than that. */
function bounded(from, to) {
	const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
	const d = Math.hypot(dx, dy, dz);
	if (d <= MAX_PUSH) return to;
	const k = MAX_PUSH / d;
	return [from[0] + dx * k, Math.max(FLOOR, from[1] + dy * k), from[2] + dz * k];
}

function isClear(pieces, point, except, margin = MARGIN) {
	for (let i = 0; i < pieces.length; i++) {
		const f = pieces[i];
		if (f === except) continue;
		const ex = point[0] - f.o[0], ey = point[1] - f.o[1], ez = point[2] - f.o[2];
		const r = f.bound + margin;
		if (ex * ex + ey * ey + ez * ez > r * r) continue;
		// A hair inside the margin still counts as clear, or two touching pieces would never agree.
		if (pushOut(f, point, margin - 0.0015)) return false;
	}
	return true;
}

