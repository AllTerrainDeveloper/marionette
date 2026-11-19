// String-versus-puppet collision: where a string would cut through the wood,
// it is routed over the surface instead.
//
// Strings collide with the very shapes that are drawn and that the physics
// engine collides: the turned pieces of puppet-shapes.js. A piece is a surface
// of revolution with a (possibly squashed) transform, so the test is done in
// the piece's own unscaled space, where it is perfectly round: along a leg of
// the string, compare the distance from the piece's axis with the profile's
// radius at that height, and find where the leg is deepest inside. A point is
// inside the squashed piece exactly when it is inside the round one, so the
// test is exact for the shape on screen.
//
// A string is a taut polyline from its handle to its attachment point. Where
// a leg is inside a piece, a via point is put on the surface straight out from
// the axis. At first touch that point lies on the string itself, so the path
// changes continuously as a limb moves into a string — no popping. A deep wrap
// gets further via points on the same piece, so the string follows the curve
// instead of chording through it.
//
// A string collides with the body it is tied to as well: its attachment point
// is a screw eye on the surface, and if the limb turns, the string winds
// around it.
//
// Pure geometry on flat transform arrays. The simulation solves the string
// through these via points (sim.js), and both renderers call the same function
// on the transforms they display, so what you see is what the physics solved —
// with no extra data on the wire.

import { add, sub, dot, addScaled, len, qRot, qMul, qConj, clamp } from './math.js';
import { SHAPES, radiusTable, radiusAt } from './puppet-shapes.js';

/** Half the string's thickness plus a hair, so it rests on the surface rather than in it. */
export const STRING_MARGIN = 0.004;
/** The lowest a string can be: lying on the stage floor (y = 0). */
export const FLOOR = 0.004;
/** How far a string's tie point (a screw eye) stands off the wood, so the string leaves it rather than lying on it. */
export const TIE_STANDOFF = 0.012;
/** The most via points one string may have. */
export const MAX_VIAS = 10;
/** The most via points one string may have on a single piece. */
const MAX_PER_PIECE = 4;
/** A second via on the same piece is only worth it when the string still cuts this deep. */
const REWRAP_DEPTH = 0.003;
/** Closest approaches this near a leg's end are that end's business, not a new bend. */
const END_CLEARANCE = 0.012;
/** Samples along a leg when looking for its deepest point inside a piece. */
const SCAN = 8;
const EPS = 1e-9;

/** Flat list of collision pieces, one per solid piece of every body. */
export function buildWrapProxies(bodies, shapes = SHAPES) {
	const out = [];
	bodies.forEach((def, body) => {
		for (const p of shapes[def.id] || []) {
			const table = radiusTable(p.profile);
			const y0 = table[0][0], y1 = table[table.length - 1][0];
			const maxR = Math.max(...table.map((row) => row[1]));
			out.push({
				body, at: p.at, rot: p.rot, inv: qConj(p.rot), scale: p.scale, table, y0, y1,
				flatBottom: table[0][1] > 1e-4, flatTop: table[table.length - 1][1] > 1e-4,
				radial: (p.scale[0] + p.scale[2]) / 2,
				bound: Math.hypot(maxR * Math.max(p.scale[0], p.scale[2]), Math.max(Math.abs(y0), Math.abs(y1)) * p.scale[1]),
			});
		}
	});
	return out;
}

function pointSegDist(p, a, b) {
	const ab = sub(b, a);
	const l2 = dot(ab, ab);
	const t = l2 > EPS ? clamp(dot(sub(p, a), ab) / l2, 0, 1) : 0;
	return len(sub(p, addScaled(a, ab, t)));
}

/** World point -> a piece's own unscaled space, where its axis is Y and it is round. */
const toPiece = (f, x) => {
	const v = qRot(f.qi, sub(x, f.o));
	return [v[0] / f.scale[0], v[1] / f.scale[1], v[2] / f.scale[2]];
};
const fromPiece = (f, u) => add(f.o, qRot(f.q, [u[0] * f.scale[0], u[1] * f.scale[1], u[2] * f.scale[2]]));

/**
 * Tests the leg p-q against piece f. Returns null if it stays clear, else
 * { s, depth, point }: where along the leg it is deepest inside the piece, how deep
 * (metres), and the point on the surface (plus margin) to route through instead.
 *
 * In the piece's own space the leg is a straight line and the piece is round, so the
 * depth at any point of the leg is simply (profile radius at that height) - (distance
 * from the axis). The deepest point is found by scanning the stretch of the leg that
 * lies within the piece's height, then refining. This also catches a string running
 * alongside a limb, or straight down through the torso — cases a closest-approach-to-
 * the-axis test misses, because there the axis distance says nothing about the bulge.
 */
function legHit(f, p, q, margin, inset = 0, side = null) {
	const P = toPiece(f, p), Q = toPiece(f, q);
	const dx = Q[0] - P[0], dy = Q[1] - P[1], dz = Q[2] - P[2];
	let s0 = 0, s1 = 1;
	if (Math.abs(dy) < 1e-9) {
		if (P[1] < f.y0 || P[1] > f.y1) return null;
	} else {
		const a = (f.y0 - P[1]) / dy, b = (f.y1 - P[1]) / dy;
		s0 = Math.max(0, Math.min(a, b));
		s1 = Math.min(1, Math.max(a, b));
	}
	// The very ends of a leg are left alone (an end resting in or on a piece cannot be
	// fixed by bending the leg right there); the deepest point is looked for between them.
	s0 = Math.max(s0, inset);
	s1 = Math.min(s1, 1 - inset);
	if (s0 >= s1) return null;
	// A flat end (a drum's face) can be the nearest way out, but only for a leg that comes
	// in through that face without going out through the opposite one; a leg that goes
	// clean through a plate has to go round its rim.
	const top = Math.max(P[1], Q[1]), bottom = Math.min(P[1], Q[1]);
	const overTop = f.flatTop && top > f.y1 && bottom > f.y0;
	const underBottom = f.flatBottom && bottom < f.y0 && top < f.y1;
	const sy = f.scale[1];
	// Depth below the surface, in metres: the smaller of the way out sideways and the way out through a face.
	const depthAt = (s) => {
		const y = P[1] + dy * s;
		let d = (radiusAt(f.table, y) - Math.hypot(P[0] + dx * s, P[2] + dz * s)) * f.radial;
		if (overTop) d = Math.min(d, (f.y1 - y) * sy);
		if (underBottom) d = Math.min(d, (y - f.y0) * sy);
		return d;
	};
	const step = (s1 - s0) / SCAN;
	let bestS = s0, bestD = -Infinity;
	for (let i = 0; i <= SCAN; i++) {
		const s = s0 + step * i;
		const d = depthAt(s);
		if (d > bestD) { bestD = d; bestS = s; }
	}
	let lo = Math.max(s0, bestS - step), hi = Math.min(s1, bestS + step);
	for (let i = 0; i < 7; i++) {
		const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
		if (depthAt(m1) < depthAt(m2)) lo = m1; else hi = m2;
	}
	const s = (lo + hi) / 2;
	const depth = depthAt(s) + margin;
	if (depth <= 0) return null;
	const cx = P[0] + dx * s, cy = P[1] + dy * s, cz = P[2] + dz * s;
	const r = radiusAt(f.table, cy);
	const rho = Math.hypot(cx, cz);
	const sideways = (r - rho) * f.radial;
	// (A way out that would put the string under the floor is no way out.)
	if (overTop && (f.y1 - cy) * sy < sideways) { const point = fromPiece(f, [cx, f.y1 + margin / sy, cz]); if (point[1] >= FLOOR) return { s, depth, point }; }
	if (underBottom && (cy - f.y0) * sy < sideways) { const point = fromPiece(f, [cx, f.y0 - margin / sy, cz]); if (point[1] >= FLOOR) return { s, depth, point }; }
	const reach = r + margin / f.radial;
	let nx, nz;
	if (rho > 1e-6) { nx = cx / rho; nz = cz / rho; }
	else {
		// Dead on the axis: leave sideways, square to the leg.
		const l = Math.hypot(dx, dz);
		if (l > 1e-6) { nx = dz / l; nz = -dx / l; } else { nx = 0; nz = 1; }
	}
	// A string already lying against this piece stays on the side it is on.
	if (side && nx * side[0] + nz * side[1] < 0) { nx = side[0]; nz = side[1]; }
	let point = fromPiece(f, [nx * reach, cy, nz * reach]);
	if (point[1] < FLOOR) {
		// That side is under the floor (a limb lying on the stage): the string goes over it instead.
		const over = fromPiece(f, [-nx * reach, cy, -nz * reach]);
		if (over[1] > point[1]) point = over;
		if (point[1] < FLOOR) point[1] = FLOOR;
	}
	return { s, depth, point };
}

/**
 * A point of a loose string against piece f: if it lies inside the wood, the nearest
 * place just outside it (through the side, or through a flat end if that is nearer);
 * null if it is already clear.
 */
export function pushOut(f, x, margin = STRING_MARGIN) {
	const u = toPiece(f, x);
	if (u[1] <= f.y0 || u[1] >= f.y1) return null;
	const reach = radiusAt(f.table, u[1]) + margin / f.radial;
	const rho = Math.hypot(u[0], u[2]);
	if (rho >= reach) return null;
	const sideways = (reach - rho) * f.radial;
	const sy = f.scale[1];
	if (f.flatTop && (f.y1 - u[1]) * sy < sideways) return fromPiece(f, [u[0], f.y1 + margin / sy, u[2]]);
	if (f.flatBottom && (u[1] - f.y0) * sy < sideways) return fromPiece(f, [u[0], f.y0 - margin / sy, u[2]]);
	const nx = rho > 1e-6 ? u[0] / rho : 1, nz = rho > 1e-6 ? u[2] / rho : 0;
	return fromPiece(f, [nx * reach, u[1], nz * reach]);
}

/** A point on piece `piece` (index into the frame, f = frame[piece]) as a via the router can carry forward. */
export const viaOn = (f, piece, point) => ({ piece, at: toPiece(f, point) });

/** Distance from point p to the segment a-b. */
export const distanceToSegment = (p, a, b) => pointSegDist(p, a, b);

/**
 * Where a string is actually tied: `def.at`, moved out to the surface if it lies inside
 * the body (a screw eye cannot be in the middle of the wood). Body-local coordinates.
 */
export function effectiveAttach(def, bodies, proxies) {
	const own = bodies.findIndex((b) => b.id === def.body);
	let at = [def.at[0], def.at[1], def.at[2]];
	if (own < 0) return at;
	const mine = proxies.filter((p) => p.body === own);
	const toLocal = (p, x) => { const v = qRot(p.inv, sub(x, p.at)); return [v[0] / p.scale[0], v[1] / p.scale[1], v[2] / p.scale[2]]; };
	const clearance = TIE_STANDOFF;
	const inside = (x) => mine.some((p) => { const u = toLocal(p, x); const r = radiusAt(p.table, u[1]); return r > 0 && Math.hypot(u[0], u[2]) < r + clearance / p.radial; });

	if (def.out) {
		// Leave along a given direction until clear of every piece of the body.
		const dir = def.out;
		const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
		for (let step = 0; step < 300 && inside(at); step++) at = addScaled(at, dir, 0.001 / l);
		return at;
	}
	for (let pass = 0; pass < 4; pass++) {
		let moved = false;
		for (const p of mine) {
			const u = toLocal(p, at);
			const r = radiusAt(p.table, u[1]);
			if (r <= 0) continue;
			const reach = r + clearance / p.radial;
			const rho = Math.hypot(u[0], u[2]);
			if (rho >= reach) continue;
			const nx = rho > 1e-6 ? u[0] / rho : 0, nz = rho > 1e-6 ? u[2] / rho : 1;
			at = add(p.at, qRot(p.rot, [nx * reach * p.scale[0], u[1] * p.scale[1], nz * reach * p.scale[2]]));
			moved = true;
		}
		if (!moved) break;
	}
	return at;
}

/** World-space pieces for the current transforms. Compute once per step / frame, reuse for every string. */
export function wrapFrame(proxies, pos, quat, frame = []) {
	frame.length = proxies.length;
	for (let k = 0; k < proxies.length; k++) {
		const p = proxies[k];
		const i = p.body;
		const c = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
		const qb = [quat[i * 4], quat[i * 4 + 1], quat[i * 4 + 2], quat[i * 4 + 3]];
		const q = qMul(qb, p.rot);
		frame[k] = { body: i, o: add(c, qRot(qb, p.at)), q, qi: qConj(q), scale: p.scale, radial: p.radial, table: p.table, y0: p.y0, y1: p.y1, flatBottom: p.flatBottom, flatTop: p.flatTop, bound: p.bound };
	}
	return frame;
}

/**
 * Pieces a given string never bends around: those of other bodies that already contain
 * its attachment point in the rest pose (bending cannot free an end that is inside).
 */
export function stringExclusions(def, at, bodies, proxies) {
	const own = bodies.findIndex((b) => b.id === def.body);
	const out = new Set();
	if (own < 0) return out;
	const pos = new Float32Array(bodies.length * 3);
	const quat = new Float32Array(bodies.length * 4);
	bodies.forEach((b, i) => { pos.set(b.pos, i * 3); quat[i * 4 + 3] = 1; });
	const attach = add(bodies[own].pos, at);
	wrapFrame(proxies, pos, quat).forEach((f, k) => {
		if (f.body === own) return;
		const u = toPiece(f, attach);
		const r = radiusAt(f.table, u[1]);
		if (r > 0 && Math.hypot(u[0], u[2]) < r + 0.002 / f.radial) out.add(k);
	});
	return out;
}

/**
 * Routes a string from `from` (handle) to `to` (attachment) around the pieces in `frame`.
 * Returns { points, bodies, length }: points[0] is the handle, the last is the attachment,
 * anything between is a via point resting on body `bodies[i]` (-1 for the two ends).
 *
 * This is where a string pulled tight lies. A string that is loose is not on this route
 * at all (the renderers draw it hanging free).
 *
 * `memory` is an object the caller keeps per string ({}). With it the route is continuous
 * in time: last time's via points are carried along with their pieces and slid to where
 * the string now presses, vias the string has lifted off are dropped and new ones added —
 * so a string wound round a limb stays on its side and slides, instead of flipping between
 * two ways round from one moment to the next. The route worked out from scratch is still
 * computed, and wins when it is clearly shorter (the string has slipped free) or when the
 * carried one would cut through the wood.
 */
export function stringPath(from, to, frame, excluded, margin = STRING_MARGIN, memory = null) {
	const fresh = extend([from, to], [-1], frame, excluded, margin);
	if (!memory) return finish(fresh, frame);
	let best = fresh;
	if (memory.vias && memory.vias.length) {
		const kept = carry(from, to, memory.vias, frame, excluded, margin);
		if (kept.length <= fresh.length * (1 + KEEP_LONGER) + KEEP_SLACK && pathPenetration(kept.points, frame, excluded) < KEEP_DEPTH) best = kept;
	}
	// Remember each via as a place on its piece, so it moves with the piece.
	const vias = [];
	for (let i = 1; i < best.points.length - 1; i++) vias.push({ piece: best.pieces[i], at: toPiece(frame[best.pieces[i]], best.points[i]) });
	memory.vias = vias;
	return finish(best, frame);
}

/** A carried route may be this much longer than the shortest one before the string lets go of it. */
const KEEP_LONGER = 0.04;
const KEEP_SLACK = 0.02;
/** ... and may not cut deeper than this into any piece (m). */
const KEEP_DEPTH = 0.002;

/** Last time's via points, moved with their pieces and slid to where the string presses now. */
function carry(from, to, vias, frame, excluded, margin) {
	const points = [from];
	const pieces = [-1];
	for (let i = 0; i < vias.length; i++) {
		const via = vias[i];
		const f = frame[via.piece];
		if (!f || (excluded && excluded.has(via.piece))) continue;
		const prev = points[points.length - 1];
		const next = i + 1 < vias.length && frame[vias[i + 1].piece] ? fromPiece(frame[vias[i + 1].piece], vias[i + 1].at) : to;
		const segLen = len(sub(next, prev));
		if (segLen < 0.03) continue;
		const rho = Math.hypot(via.at[0], via.at[2]);
		const side = rho > 1e-6 ? [via.at[0] / rho, via.at[2] / rho] : null;
		const hit = legHit(f, prev, next, margin, END_CLEARANCE / segLen, side);
		// No longer pressed against this piece here: the string has lifted off it.
		if (!hit || hit.depth <= 0) continue;
		points.push(hit.point);
		pieces.push(via.piece);
	}
	points.push(to);
	pieces.push(-1);
	return extend(points, pieces, frame, excluded, margin);
}

/** Adds via points to a route until no leg of it cuts through a piece. `pieces[i]` is the piece via i rests on. */
function extend(points, pieces, frame, excluded, margin) {
	if (pieces.length < points.length) pieces.push(-1);
	let counts = null;
	for (let i = 1; i < points.length - 1; i++) { counts = counts || {}; counts[pieces[i]] = (counts[pieces[i]] || 0) + 1; }
	for (let n = points.length - 2; n < MAX_VIAS; n++) {
		let best = null;
		for (let i = 0; i < points.length - 1; i++) {
			const p = points[i], q = points[i + 1];
			const segLen = len(sub(q, p));
			if (segLen < 0.03) continue;
			for (let k = 0; k < frame.length; k++) {
				const f = frame[k];
				const seen = counts ? counts[k] || 0 : 0;
				if (seen >= MAX_PER_PIECE || (excluded && excluded.has(k))) continue;
				if (pointSegDist(f.o, p, q) > f.bound + margin) continue;
				const hit = legHit(f, p, q, margin, END_CLEARANCE / segLen);
				if (!hit || hit.depth <= (seen ? REWRAP_DEPTH : 0) || (best && hit.depth <= best.depth)) continue;
				best = { depth: hit.depth, at: i + 1, piece: k, point: hit.point };
			}
		}
		if (!best) break;
		points.splice(best.at, 0, best.point);
		pieces.splice(best.at, 0, best.piece);
		counts = counts || {};
		counts[best.piece] = (counts[best.piece] || 0) + 1;
	}
	let length = 0;
	for (let i = 0; i < points.length - 1; i++) length += len(sub(points[i + 1], points[i]));
	return { points, pieces, length };
}

const finish = (route, frame) => ({ points: route.points, bodies: route.pieces.map((k) => (k < 0 ? -1 : frame[k].body)), length: route.length });

/** How deep a path still cuts into any (non-excluded) piece, in metres. For tests and benchmarks. */
export function pathPenetration(points, frame, excluded) {
	let worst = 0;
	for (let i = 0; i < points.length - 1; i++) {
		const segLen = len(sub(points[i + 1], points[i]));
		for (let k = 0; k < frame.length; k++) {
			const f = frame[k];
			if ((excluded && excluded.has(k)) || pointSegDist(f.o, points[i], points[i + 1]) > f.bound) continue;
			const hit = legHit(f, points[i], points[i + 1], 0, END_CLEARANCE / segLen);
			if (!hit) continue;
			worst = Math.max(worst, hit.depth);
		}
	}
	return worst;
}
