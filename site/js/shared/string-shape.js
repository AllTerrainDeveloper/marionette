// The shape a string is drawn with.
//
// A string pulled tight lies on its route round the limbs (string-path.js). A
// string with spare length does not: nothing presses it against the wood, so it
// hangs from its two ends under its own weight and rests on the puppet only
// where it falls against it. This module turns "route + how much string there
// is" into the points to draw, and makes the change between the two gradual.
//
// The hanging part is a chain of points relaxed towards where a thread would
// hang. It is deliberately not a lively simulation: a thread has almost no
// weight and a lot of air drag, so it should settle and then not move at all.
// These keep it calm:
//   - the chain is first carried along with its two ends, then relaxed, so it never
//     has to catch up with a limb that moved;
//   - heavy damping and fixed time steps, so it sinks into place without swinging;
//   - a point that would end up inside the wood is moved to a place clear of
//     every piece, or else left where it was — never bounced between two pieces;
//   - what is drawn eases towards where the string should be over a few frames, so
//     a route that changes abruptly (a tight string finding a shorter way round a
//     limb) shows as a quick slide, not a jump;
//   - once nothing has moved for a moment the chain is frozen until an end,
//     the amount of slack or a nearby limb moves again.
//
// Pure maths on arrays: no Three.js, no DOM, so it can be tested in Node.

import { pushOut, distanceToSegment } from './string-path.js';

const STEP = 1 / 120;            // fixed time step of the chain (s)
const MAX_STEPS = 3;             // per update
const KEEP = 0.86;               // share of a point's velocity kept per step
const GRAVITY = 9.81;
const PASSES = 18;               // length-enforcing sweeps per step
const MARGIN = 0.006;            // how far off the wood a loose string rests (m)
const BLEND = 0.03;              // spare length (m) over which a string goes from on-route to fully hanging
const STILL = 0.00004;           // movement per update (m) under which a point counts as not moving
const STILL_UPDATES = 10;        // that many still updates in a row and the chain is frozen
const EASE = 0.07;                // time constant (s) with which the drawn string follows its target
const WAKE = 0.0004;             // an end, a nearby piece or the slack moving this much (m) wakes it

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
		this.live = false;
		this.time = 0;
		this.still = 0;
		this.asleep = false;
		this.mark = new Float64Array(8);        // what the frozen chain was frozen against
		this.near = [];
	}

	/**
	 * @param route     the tight-string route, [[x, y, z], ...], handle first, tie point last
	 * @param rest      how much string there is (m)
	 * @param broken    a snapped string: it hangs from the handle only
	 * @param pieces    the puppet's pieces in the world (string-path.js wrapFrame)
	 * @param excluded  indices of pieces to ignore (those the tie point sits in)
	 * @param dt        seconds since the last call
	 * @returns the points to draw, flat [x, y, z, ...], links + 1 of them
	 */
	update(route, rest, broken, pieces, excluded, dt) {
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
			taut[k * 3] = a[0] + (b[0] - a[0]) * u; taut[k * 3 + 1] = a[1] + (b[1] - a[1]) * u; taut[k * 3 + 2] = a[2] + (b[2] - a[2]) * u;
		}

		// How much of the hanging shape shows: none when tight, all of it with a few centimetres to spare.
		const slack = rest - length;
		const hang = broken ? 1 : Math.min(1, Math.max(0, slack / BLEND));
		const ends = this.ends;
		if (!this.live) {
			p.set(taut); last.set(taut); out.set(taut);
			ends[0] = top[0]; ends[1] = top[1]; ends[2] = top[2]; ends[3] = end[0]; ends[4] = end[1]; ends[5] = end[2];
			this.live = true; this.asleep = false; this.still = 0; this.time = 0;
			return out;
		}

		// Carry everything along with the two ends (a snapped string goes with its handle).
		const ax = top[0] - ends[0], ay = top[1] - ends[1], az = top[2] - ends[2];
		const bx = broken ? ax : end[0] - ends[3], by = broken ? ay : end[1] - ends[4], bz = broken ? az : end[2] - ends[5];
		ends[0] = top[0]; ends[1] = top[1]; ends[2] = top[2]; ends[3] = end[0]; ends[4] = end[1]; ends[5] = end[2];
		if (ax || ay || az || bx || by || bz) {
			for (let k = 0; k <= n; k++) {
				const u = k / n, o = k * 3;
				const dx = ax + (bx - ax) * u, dy = ay + (by - ay) * u, dz = az + (bz - az) * u;
				p[o] += dx; p[o + 1] += dy; p[o + 2] += dz;
				last[o] += dx; last[o + 1] += dy; last[o + 2] += dz;
				out[o] += dx; out[o + 1] += dy; out[o + 2] += dz;
			}
		}

		let moved = 0;
		if (hang <= 0) {
			// Tight: the chain is the route.
			p.set(taut); last.set(taut);
			this.asleep = false; this.still = 0; this.time = 0;
		} else {
			// The pieces this string could be touching, and a figure that changes when any of them moves.
			const near = this.near;
			near.length = 0;
			const reach = 0.05 + slack;
			let where = 0;
			for (let k = 0; k < pieces.length; k++) {
				const f = pieces[k];
				if (excluded && excluded.has(k)) continue;
				if (distanceToSegment(f.o, top, end) > f.bound + reach) continue;
				near.push(f);
				where += f.o[0] + 2 * f.o[1] + 3 * f.o[2] + f.q[0] + f.q[1] + f.q[2];
			}

			const mark = this.mark;
			if (this.asleep) {
				const change = Math.abs(top[0] - mark[0]) + Math.abs(top[1] - mark[1]) + Math.abs(top[2] - mark[2])
					+ Math.abs(end[0] - mark[3]) + Math.abs(end[1] - mark[4]) + Math.abs(end[2] - mark[5])
					+ Math.abs(slack - mark[6]) + Math.abs(where - mark[7]);
				if (change < WAKE) return out;
				this.asleep = false;
				this.still = 0;
			}
			mark[0] = top[0]; mark[1] = top[1]; mark[2] = top[2];
			mark[3] = end[0]; mark[4] = end[1]; mark[5] = end[2];
			mark[6] = slack; mark[7] = where;

			this.time = Math.min(this.time + dt, STEP * MAX_STEPS);
			const link = (broken ? Math.min(rest, 1.2) : rest) / n;
			const free = broken ? n : n - 1;     // last point that is not pinned
			const before = this.before;
			while (this.time >= STEP) {
				this.time -= STEP;
				before.set(p);
				// Every free point keeps a little of its momentum and falls.
				for (let k = 1; k <= free; k++) {
					const o = k * 3;
					for (let c = 0; c < 3; c++) {
						const now = p[o + c];
						p[o + c] = now + (now - last[o + c]) * KEEP - (c === 1 ? GRAVITY * STEP * STEP : 0);
					}
				}
				last.set(before);
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
				// The sweeps above converge slowly on a chain that is nearly straight, and a chain
				// left too long bellies out further than the spare length allows. So measure it,
				// and if it is too long draw every point in towards the route: a bulge shrunk by a
				// factor g uses about g * g as much extra length. As the slack runs out the chain
				// therefore arrives on the route by itself, with nothing left to jump.
				if (!broken) {
					let chain = 0;
					for (let k = 0; k < n; k++) chain += Math.hypot(p[k * 3 + 3] - p[k * 3], p[k * 3 + 4] - p[k * 3 + 1], p[k * 3 + 5] - p[k * 3 + 2]);
					if (chain > rest + 1e-5 && chain > length + 1e-7) {
						const g = Math.sqrt(Math.max(0, rest - length) / (chain - length));
						for (let k = 3; k < n * 3; k++) {
							const moved = (taut[k] - p[k]) * (1 - g);
							p[k] += moved; last[k] += moved;
						}
					}
				}
				// It cannot be in the wood or under the floor. A point that is gets moved to a place
				// clear of every piece; if there is none nearby it stays where it was a step ago.
				// Either way it stops there (no speed carried into the next step). The two points
				// next to the tie are left alone: the screw eye stands off the wood, and they follow it.
				const lastFree = broken ? free : free - 2;
				for (let k = 1; k <= lastFree; k++) {
					const o = k * 3;
					let hit = false;
					if (near.length) {
						_point[0] = p[o]; _point[1] = p[o + 1]; _point[2] = p[o + 2];
						const clear = resolve(near, _point);
						if (clear !== _point) {
							hit = true;
							if (clear) { p[o] = clear[0]; p[o + 1] = clear[1]; p[o + 2] = clear[2]; } else { p[o] = before[o]; p[o + 1] = before[o + 1]; p[o + 2] = before[o + 2]; }
						}
					}
					if (p[o + 1] < 0.004) { p[o + 1] = 0.004; hit = true; }
					if (hit) { last[o] = p[o]; last[o + 1] = p[o + 1]; last[o + 2] = p[o + 2]; }
				}
				for (let k = 3; k < p.length; k++) moved = Math.max(moved, Math.abs(p[k] - before[k]));
			}
		}

		// Drawn: the hanging chain, eased onto the route as the spare length runs out — and
		// what is on screen follows that over a few frames rather than snapping to it.
		const onRoute = 1 - hang;
		const follow = 1 - Math.exp(-Math.max(dt, 1e-4) / EASE);
		for (let k = 3; k < out.length - (broken ? 0 : 3); k++) {
			const target = p[k] + (taut[k] - p[k]) * onRoute;
			const step = (target - out[k]) * follow;
			out[k] += step;
			moved = Math.max(moved, Math.abs(step));
		}
		out[0] = top[0]; out[1] = top[1]; out[2] = top[2];
		if (!broken) { out[n * 3] = end[0]; out[n * 3 + 1] = end[1]; out[n * 3 + 2] = end[2]; }

		if (hang > 0) {
			this.still = moved < STILL ? this.still + 1 : 0;
			if (this.still >= STILL_UPDATES) this.asleep = true;
		}
		return out;
	}
}

const _along = [];
const _point = [0, 0, 0];

/**
 * A place for `point` clear of every piece. Returns `point` itself if it already is,
 * the nearest way out that is clear of all pieces if there is one, or null.
 */
function resolve(pieces, point) {
	let from = point;
	for (let round = 0; round < 3; round++) {
		let best = null, bestMove = Infinity, far = null, farMove = -1;
		let inside = false;
		for (let i = 0; i < pieces.length; i++) {
			const f = pieces[i];
			const ex = from[0] - f.o[0], ey = from[1] - f.o[1], ez = from[2] - f.o[2];
			const r = f.bound + MARGIN + 0.002;
			if (ex * ex + ey * ey + ez * ez > r * r) continue;
			const exit = pushOut(f, from, MARGIN);
			if (!exit) continue;
			inside = true;
			const move = Math.hypot(exit[0] - from[0], exit[1] - from[1], exit[2] - from[2]);
			if (move > farMove) { farMove = move; far = exit; }
			if (move < bestMove && isClear(pieces, exit, f)) { bestMove = move; best = exit; }
		}
		if (!inside) return from;
		if (best) return best;
		from = far;      // out of the deepest piece first, then look again
	}
	return null;
}

function isClear(pieces, point, except) {
	for (let i = 0; i < pieces.length; i++) {
		const f = pieces[i];
		if (f === except) continue;
		const ex = point[0] - f.o[0], ey = point[1] - f.o[1], ez = point[2] - f.o[2];
		const r = f.bound + MARGIN;
		if (ex * ex + ey * ey + ez * ez > r * r) continue;
		// A hair inside the margin still counts as clear, or two touching pieces would never agree.
		if (pushOut(f, point, MARGIN - 0.0015)) return false;
	}
	return true;
}
