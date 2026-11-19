// Strings that catch on each other. Optional, and off unless switched on: a real
// marionette's strings do tangle, and it is not what most people come for.
//
// With it off, strings pass through one another as if the others were not there.
// With it on:
//
//   - The drawn chains (string-shape.js) cannot pass through each other. Every pair
//     of links from two different strings is watched from one frame to the next; if
//     one has gone through the other, or they have come closer than a thread's
//     width, they are put back apart on the side each was on.
//   - Where two strings press on each other — each bent round the other, both under
//     tension — that place is a crossing that holds. Both strings are then routed
//     through it, in the drawing and in the physics (sim.setKnots), so the puppet
//     feels the tangle: the strings are shorter by the detour, and pulling one drags
//     on the other. The crossing has no friction: it moves to where the pulls of the
//     two strings balance.
//
// Pure maths on arrays: no Three.js, no DOM, so it can be tested in Node.

const GAP = 0.005;           // how far apart two crossing strings are kept (m)
const REACH = 0.012;         // links closer than this (m) are looked at more closely
const PRESS = 0.04;          // least bend of each string round the other for the crossing to hold
const TENSION = 0.5;         // least tension in each string for it to hold (N)
const SPAN = 3;              // links either side of a crossing its bend is measured over
const DRIFT = 0.04;          // how far an unbalanced crossing moves per frame, per unit of imbalance (m)
const MAX_DRIFT = 0.012;     // ... at most (m)
const MAX_KNOTS = 3;         // crossings that hold, per string

const _da = [0, 0, 0], _db = [0, 0, 0], _n = [0, 0, 0], _w = [0, 0, 0];

/** (a1 - a0) x (b1 - b0) . (b0 - a0): its sign says which side of link a link b passes on. */
function side(A, i, B, j) {
	const a = i * 3, b = j * 3;
	const ax = A[a + 3] - A[a], ay = A[a + 4] - A[a + 1], az = A[a + 5] - A[a + 2];
	const bx = B[b + 3] - B[b], by = B[b + 4] - B[b + 1], bz = B[b + 5] - B[b + 2];
	return (ay * bz - az * by) * (B[b] - A[a]) + (az * bx - ax * bz) * (B[b + 1] - A[a + 1]) + (ax * by - ay * bx) * (B[b + 2] - A[a + 2]);
}

/**
 * Closest places on link i of A and link j of B: writes the two parameters (0..1 along each
 * link, unclamped for the infinite lines) into `out` and returns whether the lines are not parallel.
 */
function closest(A, i, B, j, out) {
	const a = i * 3, b = j * 3;
	_da[0] = A[a + 3] - A[a]; _da[1] = A[a + 4] - A[a + 1]; _da[2] = A[a + 5] - A[a + 2];
	_db[0] = B[b + 3] - B[b]; _db[1] = B[b + 4] - B[b + 1]; _db[2] = B[b + 5] - B[b + 2];
	_w[0] = A[a] - B[b]; _w[1] = A[a + 1] - B[b + 1]; _w[2] = A[a + 2] - B[b + 2];
	const aa = _da[0] * _da[0] + _da[1] * _da[1] + _da[2] * _da[2];
	const bb = _db[0] * _db[0] + _db[1] * _db[1] + _db[2] * _db[2];
	const ab = _da[0] * _db[0] + _da[1] * _db[1] + _da[2] * _db[2];
	const aw = _da[0] * _w[0] + _da[1] * _w[1] + _da[2] * _w[2];
	const bw = _db[0] * _w[0] + _db[1] * _w[1] + _db[2] * _w[2];
	const det = aa * bb - ab * ab;
	if (det < 1e-12 * aa * bb || aa < 1e-12 || bb < 1e-12) return false;
	out[0] = (ab * bw - bb * aw) / det;
	out[1] = (aa * bw - ab * aw) / det;
	return true;
}

const _st = [0, 0];
const inside = (s) => s > -0.02 && s < 1.02;

/** Route `points` ([[x, y, z], ...]) with the places in `knots` ([{ at }]) put in where each lengthens it least. */
export function withKnots(points, knots) {
	if (!knots || !knots.length) return points;
	const out = points.slice();
	for (const knot of knots) {
		let best = 1, least = Infinity;
		for (let k = 1; k < out.length; k++) {
			const a = out[k - 1], b = out[k], c = knot.at;
			const more = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]) + Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]) - Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
			if (more < least) { least = more; best = k; }
		}
		out.splice(best, 0, knot.at);
	}
	return out;
}

export class Tangles {
	constructor() {
		this.enabled = false;
		this.prev = [];      // every string's chain as it was left last time
		this.knots = [];     // per string: the crossings that hold it, [{ at: [x, y, z], with: other string }]
		this.contacts = 0;   // how many pairs of links were touching last time (for the readout)
	}

	clear() {
		this.prev.length = 0;
		this.knots.length = 0;
		this.contacts = 0;
	}

	/**
	 * Keeps the strings from passing through each other and finds the crossings that hold.
	 *
	 * @param strings [{ shape (StringShape), active (drawn and not snapped), tension (N) }]
	 * @returns per string, the crossings that hold it (also kept in `this.knots`)
	 */
	update(strings) {
		const knots = this.knots;
		knots.length = strings.length;
		for (let i = 0; i < strings.length; i++) { if (knots[i]) knots[i].length = 0; else knots[i] = []; }
		if (!this.enabled) { this.prev.length = 0; this.contacts = 0; return knots; }
		const prev = this.prev;
		let contacts = 0;

		for (let a = 0; a < strings.length; a++) {
			const sa = strings[a];
			if (!sa.active || !sa.shape.live || !prev[a] || prev[a].length !== sa.shape.p.length) continue;
			for (let b = a + 1; b < strings.length; b++) {
				const sb = strings[b];
				if (!sb.active || !sb.shape.live || !prev[b] || prev[b].length !== sb.shape.p.length) continue;
				contacts += this._pair(sa, sb, prev[a], prev[b], a, b);
			}
		}
		this.contacts = contacts;

		// What each chain looks like now is what the next frame is compared with.
		prev.length = strings.length;
		for (let i = 0; i < strings.length; i++) {
			const p = strings[i].shape.p;
			if (!strings[i].active || !strings[i].shape.live) { prev[i] = null; continue; }
			if (!prev[i] || prev[i].length !== p.length) prev[i] = new Float32Array(p.length);
			prev[i].set(p);
		}
		return knots;
	}

	_pair(sa, sb, PA, PB, a, b) {
		const A = sa.shape.p, B = sb.shape.p, na = sa.shape.n, nb = sb.shape.n;
		// Boxes round both chains, now and a frame ago: no overlap, nothing to do.
		let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity;
		for (let k = 0; k <= na; k++) for (const P of [A, PA]) {
			const o = k * 3;
			if (P[o] < ax0) ax0 = P[o]; if (P[o] > ax1) ax1 = P[o];
			if (P[o + 1] < ay0) ay0 = P[o + 1]; if (P[o + 1] > ay1) ay1 = P[o + 1];
			if (P[o + 2] < az0) az0 = P[o + 2]; if (P[o + 2] > az1) az1 = P[o + 2];
		}
		let touching = 0, best = null;
		for (let j = 0; j < nb; j++) {
			const o = j * 3;
			// Link j of B, now and before, against A's box.
			const x0 = Math.min(B[o], B[o + 3], PB[o], PB[o + 3]) - REACH, x1 = Math.max(B[o], B[o + 3], PB[o], PB[o + 3]) + REACH;
			if (x0 > ax1 || x1 < ax0) continue;
			const y0 = Math.min(B[o + 1], B[o + 4], PB[o + 1], PB[o + 4]) - REACH, y1 = Math.max(B[o + 1], B[o + 4], PB[o + 1], PB[o + 4]) + REACH;
			if (y0 > ay1 || y1 < ay0) continue;
			const z0 = Math.min(B[o + 2], B[o + 5], PB[o + 2], PB[o + 5]) - REACH, z1 = Math.max(B[o + 2], B[o + 5], PB[o + 2], PB[o + 5]) + REACH;
			if (z0 > az1 || z1 < az0) continue;
			for (let i = 0; i < na; i++) {
				const q = i * 3;
				if (Math.min(A[q], A[q + 3], PA[q], PA[q + 3]) > x1 || Math.max(A[q], A[q + 3], PA[q], PA[q + 3]) < x0) continue;
				if (Math.min(A[q + 1], A[q + 4], PA[q + 1], PA[q + 4]) > y1 || Math.max(A[q + 1], A[q + 4], PA[q + 1], PA[q + 4]) < y0) continue;
				if (Math.min(A[q + 2], A[q + 5], PA[q + 2], PA[q + 5]) > z1 || Math.max(A[q + 2], A[q + 5], PA[q + 2], PA[q + 5]) < z0) continue;
				if (!closest(A, i, B, j, _st) || !inside(_st[0]) || !inside(_st[1])) continue;
				const s = Math.min(1, Math.max(0, _st[0])), t = Math.min(1, Math.max(0, _st[1]));
				const now = side(A, i, B, j), was = side(PA, i, PB, j);
				// Which side of A's link B's link belongs on: the side it was on.
				let keep = Math.sign(was) || Math.sign(now);
				if (!keep) continue;
				// Gone through since last frame? Only if the two links were over each other then too.
				let through = now * was < 0;
				if (through) through = closest(PA, i, PB, j, _st) && inside(_st[0]) && inside(_st[1]);
				if (!through) keep = Math.sign(now) || keep;
				// The common normal of the two links, pointing from A to B on the side B belongs.
				const ux = A[q + 3] - A[q], uy = A[q + 4] - A[q + 1], uz = A[q + 5] - A[q + 2];
				const vx = B[o + 3] - B[o], vy = B[o + 4] - B[o + 1], vz = B[o + 5] - B[o + 2];
				_n[0] = uy * vz - uz * vy; _n[1] = uz * vx - ux * vz; _n[2] = ux * vy - uy * vx;
				const ln = Math.hypot(_n[0], _n[1], _n[2]);
				if (ln < 1e-9) continue;
				_n[0] *= keep / ln; _n[1] *= keep / ln; _n[2] *= keep / ln;
				// Where B's link is, measured that way from A's.
				const pax = A[q] + (A[q + 3] - A[q]) * s, pay = A[q + 1] + (A[q + 4] - A[q + 1]) * s, paz = A[q + 2] + (A[q + 5] - A[q + 2]) * s;
				const pbx = B[o] + (B[o + 3] - B[o]) * t, pby = B[o + 1] + (B[o + 4] - B[o + 1]) * t, pbz = B[o + 2] + (B[o + 5] - B[o + 2]) * t;
				const gap = (pbx - pax) * _n[0] + (pby - pay) * _n[1] + (pbz - paz) * _n[2];
				if (gap >= REACH) continue;
				touching++;
				if (gap < GAP) {
					// Apart again: half each, unless one of them cannot move (its ends are held).
					const move = GAP - gap;
					const freeA = this._free(sa.shape, i), freeB = this._free(sb.shape, j);
					const shareA = freeA && freeB ? 0.5 : freeA ? 1 : 0, shareB = freeA && freeB ? 0.5 : freeB ? 1 : 0;
					if (shareA) this._shift(sa.shape, i, -_n[0] * move * shareA, -_n[1] * move * shareA, -_n[2] * move * shareA);
					if (shareB) this._shift(sb.shape, j, _n[0] * move * shareB, _n[1] * move * shareB, _n[2] * move * shareB);
				}
				// Does it hold? Each string bent round the other, and pulled.
				const ba = this._bend(A, na, i, pax, pay, paz), bb = this._bend(B, nb, j, pbx, pby, pbz);
				const pressA = ba[0] * _n[0] + ba[1] * _n[1] + ba[2] * _n[2];        // A pulled towards B
				const pressB = -(bb[0] * _n[0] + bb[1] * _n[1] + bb[2] * _n[2]);     // B pulled towards A
				if (pressA > PRESS && pressB > PRESS && sa.tension > TENSION && sb.tension > TENSION) {
					const strength = Math.min(pressA * sa.tension, pressB * sb.tension);
					if (!best || strength > best.strength) best = { strength, i, j, at: [(pax + pbx) / 2, (pay + pby) / 2, (paz + pbz) / 2], ba: [ba[0], ba[1], ba[2]], bb: [bb[0], bb[1], bb[2]] };
				}
			}
		}
		if (best && this.knots[a].length < MAX_KNOTS && this.knots[b].length < MAX_KNOTS) {
			// No friction: the crossing goes where the two pulls balance. Both chains are moved
			// that way a little each frame, which is what lets one string drag on the other.
			const ta = sa.tension, tb = sb.tension, sum = ta + tb;
			let fx = (best.ba[0] * ta + best.bb[0] * tb) / sum, fy = (best.ba[1] * ta + best.bb[1] * tb) / sum, fz = (best.ba[2] * ta + best.bb[2] * tb) / sum;
			const f = Math.hypot(fx, fy, fz);
			if (f > 1e-6) {
				const step = Math.min(MAX_DRIFT, DRIFT * f) / f;
				fx *= step; fy *= step; fz *= step;
				if (this._free(sa.shape, best.i)) this._shift(sa.shape, best.i, fx, fy, fz);
				if (this._free(sb.shape, best.j)) this._shift(sb.shape, best.j, fx, fy, fz);
				best.at[0] += fx; best.at[1] += fy; best.at[2] += fz;
			}
			this.knots[a].push({ at: best.at, with: b });
			this.knots[b].push({ at: best.at, with: a });
		}
		return touching;
	}

	/** Whether link k of a chain can be moved: not if one of its ends is the handle or the tie. */
	_free(shape, k) { return k >= 1 && k + 1 <= shape.n - 1; }

	/** Moves both ends of link k of a chain, in the chain and in what is drawn of it. */
	_shift(shape, k, dx, dy, dz) {
		const { p, last, out } = shape;
		for (let e = k; e <= k + 1; e++) {
			const o = e * 3;
			p[o] += dx; p[o + 1] += dy; p[o + 2] += dz;
			last[o] = p[o]; last[o + 1] = p[o + 1]; last[o + 2] = p[o + 2];
			out[o] += dx; out[o + 1] += dy; out[o + 2] += dz;
		}
		shape.asleep = false;
		shape.still = 0;
	}

	/** Which way a chain is pulled at a place on link k by the string either side of it (the sum of the two unit directions). */
	_bend(P, n, k, x, y, z) {
		const a = Math.max(0, k - SPAN) * 3, b = Math.min(n, k + 1 + SPAN) * 3;
		const ax = P[a] - x, ay = P[a + 1] - y, az = P[a + 2] - z, bx = P[b] - x, by = P[b + 1] - y, bz = P[b + 2] - z;
		const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1;
		return [ax / la + bx / lb, ay / la + by / lb, az / la + bz / lb];
	}
}
