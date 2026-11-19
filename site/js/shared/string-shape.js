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

import { pushOut, distanceToSegment, viaOn, FLOOR } from './string-path.js';

const STEP = 1 / 120;            // fixed time step of the chain (s)
const MAX_STEPS = 3;             // per update
const KEEP = 0.86;               // share of a point's velocity kept per step
const GRAVITY = 9.81;
const PASSES = 18;               // length-enforcing sweeps per step
const MARGIN = 0.006;            // how far off the wood a loose string rests (m)
const TOUCH = 0.012;              // a chain point this close to a piece counts as resting on it
const DRAWN_MARGIN = 0.003;       // ... and the least clearance anything drawn keeps from it
const HANG_EASE = 0.12;           // time (s) over which a string goes between the two when its slack changes
const BLEND = 0.03;               // spare length (m) over which a string goes from on-route to fully hanging
const SHORTEN_ROUNDS = 16;       // curve-shortening rounds per step for a chain that is too long
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
		this.hang = 0;                          // how much of the hanging shape shows, 0..1
		this.time = 0;
		this.still = 0;
		this.asleep = false;
		this.mark = new Float64Array(8);        // what the frozen chain was frozen against
		this.near = [];
		this.nearIndex = [];
	}

	/**
	 * @param route     the tight-string route, [[x, y, z], ...], handle first, tie point last
	 * @param rest      how much string there is (m)
	 * @param broken    a snapped string: it hangs from the handle only
	 * @param pieces    the puppet's pieces in the world (string-path.js wrapFrame)
	 * @param excluded  indices of pieces to ignore (those the tie point sits in)
	 * @param dt        seconds since the last call
	 * @param memory    the router's memory for this string (see stringPath): while the string hangs loose,
	 *                  the pieces it rests on are written there, so that when it is pulled tight again the
	 *                  route goes round them on the side the string is actually on
	 * @returns the points to draw, flat [x, y, z, ...], links + 1 of them
	 */
	update(route, rest, broken, pieces, excluded, dt, memory = null) {
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

		// How much of the hanging shape shows: none when tight, all of it with a few centimetres to spare.
		const slack = rest - length;
		// How much of the hanging shape shows: none when tight, all of it with a few centimetres
		// to spare. (Mixing the two is only sound when both pass every limb on the same side;
		// the chain tells the router which side it is on — see `memory` — so that they do.)
		// It follows the slack over a moment rather than at once: a route wound round several
		// pieces changes length abruptly now and then, and the string must not twitch tight
		// and loose with it.
		const wanted = broken ? 1 : Math.min(1, Math.max(0, slack / BLEND));
		this.hang += (wanted - this.hang) * (this.live ? 1 - Math.exp(-Math.max(dt, 1e-4) / HANG_EASE) : 1);
		if (wanted <= 0 && this.hang < 0.02) this.hang = 0;
		const hang = this.hang;
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

		// The pieces this string could be touching, and a figure that changes when any of them moves.
		const near = this.near, nearIndex = this.nearIndex;
		near.length = 0; nearIndex.length = 0;
		const reach = 0.05 + Math.max(0, slack);
		let where = 0;
		for (let k = 0; k < pieces.length; k++) {
			const f = pieces[k];
			if (excluded && excluded.has(k)) continue;
			if (distanceToSegment(f.o, top, end) > f.bound + reach) continue;
			near.push(f); nearIndex.push(k);
			where += f.o[0] + 2 * f.o[1] + 3 * f.o[2] + f.q[0] + f.q[1] + f.q[2];
		}

		let moved = 0;
		if (hang <= 0) {
			// Tight: the chain is the route.
			p.set(taut); last.set(taut);
			this.asleep = false; this.still = 0; this.time = 0;
		} else {
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
				// and while it is too long pull every point towards the middle of its two
				// neighbours — which shortens a curve without taking it through anything, as long
				// as each point is put back outside the wood as it goes. The chain thus tightens
				// along its own way round the limbs and arrives taut by itself.
				if (!broken) {
					for (let round = 0; round < SHORTEN_ROUNDS; round++) {
						let chain = 0;
						for (let k = 0; k < n; k++) chain += Math.hypot(p[k * 3 + 3] - p[k * 3], p[k * 3 + 4] - p[k * 3 + 1], p[k * 3 + 5] - p[k * 3 + 2]);
						// (in proportion to how much too long it is, so that a chain a hair over length is
						// nudged a hair, every step alike, rather than left alone and then corrected in bursts)
						const pull = Math.min(0.5, (chain - rest) / (0.004 * rest));
						if (pull <= 0.001) break;
						for (let k = 1; k < n; k++) {
							const o = k * 3;
							_point[0] = p[o] + ((p[o - 3] + p[o + 3]) / 2 - p[o]) * pull;
							_point[1] = Math.max(FLOOR, p[o + 1] + ((p[o - 2] + p[o + 4]) / 2 - p[o + 1]) * pull);
							_point[2] = p[o + 2] + ((p[o - 1] + p[o + 5]) / 2 - p[o + 2]) * pull;
							const clear = near.length ? resolve(near, _point) : _point;
							last[o] += clear[0] - p[o]; last[o + 1] += clear[1] - p[o + 1]; last[o + 2] += clear[2] - p[o + 2];
							p[o] = clear[0]; p[o + 1] = clear[1]; p[o + 2] = clear[2];
						}
					}
				}
				// It cannot be in the wood or under the floor. A point that is gets moved to the
				// nearest place clear of every piece (or, failing that, straight up until it is),
				// and stops there: no speed is carried into the next step.
				for (let k = 1; k <= free; k++) {
					const o = k * 3;
					_point[0] = p[o]; _point[1] = Math.max(p[o + 1], FLOOR); _point[2] = p[o + 2];
					const clear = near.length ? resolve(near, _point) : _point;
					if (clear !== _point || p[o + 1] < FLOOR) {
						p[o] = clear[0]; p[o + 1] = clear[1]; p[o + 2] = clear[2];
						last[o] = p[o]; last[o + 1] = p[o + 1]; last[o + 2] = p[o + 2];
					}
				}
				// Nor may a link cut through a piece between two points that are themselves clear
				// (a loop of slack falling "through" a shoe): if the middle of a link is in the
				// wood, both its ends move by what it takes to get the middle out.
				if (near.length) {
					for (let k = 0; k < n; k++) {
						const o = k * 3;
						_point[0] = (p[o] + p[o + 3]) / 2; _point[1] = (p[o + 1] + p[o + 4]) / 2; _point[2] = (p[o + 2] + p[o + 5]) / 2;
						const mx = _point[0], my = _point[1], mz = _point[2];
						const clear = resolve(near, _point);
						if (clear === _point) continue;
						const dx = clear[0] - mx, dy = clear[1] - my, dz = clear[2] - mz;
						const a = k >= 1, b = k + 1 <= free;
						// A pinned end cannot move, so the free one moves twice as far.
						const fa = a ? 1 : 0, fb = b ? 1 : 0;
						if (a) { p[o] += dx * fa; p[o + 1] = Math.max(FLOOR, p[o + 1] + dy * fa); p[o + 2] += dz * fa; last[o] = p[o]; last[o + 1] = p[o + 1]; last[o + 2] = p[o + 2]; }
						if (b) { p[o + 3] += dx * fb; p[o + 4] = Math.max(FLOOR, p[o + 4] + dy * fb); p[o + 5] += dz * fb; last[o + 3] = p[o + 3]; last[o + 4] = p[o + 4]; last[o + 5] = p[o + 5]; }
					}
				}
				for (let k = 3; k < p.length; k++) moved = Math.max(moved, Math.abs(p[k] - before[k]));
			}
		}

		// Drawn: the hanging chain, eased onto the route as the spare length runs out — and
		// what is on screen follows that over a few frames rather than snapping to it.
		const follow = 1 - Math.exp(-Math.max(dt, 1e-4) / EASE);
		for (let k = 3; k < out.length - (broken ? 0 : 3); k++) {
			const target = p[k] + (taut[k] - p[k]) * (1 - hang);
			const step = (target - out[k]) * follow;
			out[k] += step;
			if (k % 3 === 1 && out[k] < FLOOR) out[k] = FLOOR;
			moved = Math.max(moved, Math.abs(step));
		}
		// Easing and mixing are only allowed to produce a string that is clear of the wood.
		// If what they give cuts through a piece — the route has just changed to another way
		// round a limb, or the hanging shape and the route pass it on different sides — the
		// string is drawn where it should be at once (the hanging shape if it is mostly loose,
		// else the route): a jump is better than a string through a leg.
		if (near.length && !this._clear(out)) {
			const pure = hang >= 0.5 ? p : taut;
			for (let k = 3; k < out.length - (broken ? 0 : 3); k++) out[k] = pure[k];
			moved = Math.max(moved, STILL * 2);
			// Should even that touch the wood, its points are put on the surface.
			for (let k = 1; k < n; k++) {
				const o = k * 3;
				_point[0] = out[o]; _point[1] = out[o + 1]; _point[2] = out[o + 2];
				const clear = resolve(near, _point, DRAWN_MARGIN);
				if (clear !== _point) { out[o] = clear[0]; out[o + 1] = clear[1]; out[o + 2] = clear[2]; }
			}
		}
		out[0] = top[0]; out[1] = Math.max(FLOOR, top[1]); out[2] = top[2];
		if (!broken) { out[n * 3] = end[0]; out[n * 3 + 1] = Math.max(FLOOR, end[1]); out[n * 3 + 2] = end[2]; }

		if (hang > 0 && memory && !broken) memory.vias = this._contacts();
		if (hang > 0) {
			this.still = moved < STILL ? this.still + 1 : 0;
			if (this.still >= STILL_UPDATES) this.asleep = true;
		}
		return out;
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
const _point = [0, 0, 0];

/**
 * A place for `point` clear of every piece and above the floor. Returns `point` itself if
 * it already is; otherwise the nearest way out that is clear of all pieces; otherwise the
 * point lifted straight up until it is clear — a string comes to lie on top of things.
 */
function resolve(pieces, point, margin = MARGIN) {
	let from = point;
	for (let round = 0; round < 3; round++) {
		let best = null, bestMove = Infinity, far = null, farMove = -1;
		let inside = false;
		for (let i = 0; i < pieces.length; i++) {
			const f = pieces[i];
			const ex = from[0] - f.o[0], ey = from[1] - f.o[1], ez = from[2] - f.o[2];
			const r = f.bound + margin + 0.002;
			if (ex * ex + ey * ey + ez * ez > r * r) continue;
			const exit = pushOut(f, from, margin);
			if (!exit) continue;
			inside = true;
			const move = Math.hypot(exit[0] - from[0], exit[1] - from[1], exit[2] - from[2]);
			if (move > farMove) { farMove = move; far = exit; }
			if (move < bestMove && exit[1] >= FLOOR && isClear(pieces, exit, f, margin)) { bestMove = move; best = exit; }
		}
		if (!inside) return from;
		if (best) return best;
		from = far[1] >= FLOOR ? far : [far[0], FLOOR, far[2]];      // out of the deepest piece first, then look again
	}
	const up = [point[0], Math.max(point[1], FLOOR), point[2]];
	for (let step = 0; step < 40 && !isClear(pieces, up, null, margin); step++) up[1] += 0.005;
	return up;
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
