// String-versus-body collision: where a string would cut through a limb, it is
// routed over the limb's surface instead.
//
// Every rigid body gets a capsule "wrap proxy" (a ball is a zero-length
// capsule; a box becomes a pill along its longest side). A string is a taut
// polyline from its handle to its attachment point. If a segment of it comes
// closer to a proxy's axis than the proxy's radius, a via point is inserted on
// the proxy's surface, opposite the axis, at the point of closest approach.
// At first touch that point lies on the string itself, so the path changes
// continuously as a limb moves into a string — no popping.
//
// This is pure geometry on flat transform arrays. The simulation uses it to
// solve the string through its via points (see sim.js), and both renderers
// call the same function on the transforms they display, so what you see is
// exactly what the physics solved — with no extra data on the wire.

import { add, sub, dot, cross, scale, addScaled, len, norm, qRot, clamp } from './math.js';

/** Half the string's thickness plus a hair, so it rests on the surface rather than in it. */
export const STRING_MARGIN = 0.004;
/** The most limbs one string may wrap over at once. */
export const MAX_VIAS = 3;
/** A body whose surface is this close to the attachment point at rest never deflects that string. */
const NEAR_ATTACH = 0.025;
const EPS = 1e-9;

/** Capsule proxies in each body's local frame: { a, b, r, bound }. */
export function buildWrapProxies(bodies) {
	return bodies.map((def) => {
		if (def.wrap === false) return null;
		if (def.shape === 'ball') return { a: [0, 0, 0], b: [0, 0, 0], r: def.size[0], bound: def.size[0] };
		if (def.shape === 'capsule') {
			const [r, hh] = def.size;
			return { a: [0, -hh, 0], b: [0, hh, 0], r, bound: hh + r };
		}
		// Box: a pill along the longest side, as thick as the other two sides on average.
		const h = def.size;
		const k = h[0] >= h[1] && h[0] >= h[2] ? 0 : h[1] >= h[2] ? 1 : 2;
		const r = (h[(k + 1) % 3] + h[(k + 2) % 3]) / 2;
		const half = Math.max(0, h[k] - r);
		const a = [0, 0, 0], b = [0, 0, 0];
		a[k] = -half; b[k] = half;
		return { a, b, r, bound: half + r };
	});
}

/** Closest points between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection). */
export function closestSegSeg(p1, q1, p2, q2) {
	const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
	const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
	let s = 0, t = 0;
	if (a > EPS || e > EPS) {
		if (a <= EPS) {
			t = clamp(f / e, 0, 1);
		} else {
			const c = dot(d1, r);
			if (e <= EPS) {
				s = clamp(-c / a, 0, 1);
			} else {
				const b = dot(d1, d2);
				const denom = a * e - b * b;
				s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;
				t = (b * s + f) / e;
				if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
				else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
			}
		}
	}
	return { s, t, c1: addScaled(p1, d1, s), c2: addScaled(p2, d2, t) };
}

const pointSegDist = (p, a, b) => {
	const ab = sub(b, a);
	const l2 = dot(ab, ab);
	const t = l2 > EPS ? clamp(dot(sub(p, a), ab) / l2, 0, 1) : 0;
	return len(sub(p, addScaled(a, ab, t)));
};

/** Bodies that never deflect a given string: the one it is tied to, and any it starts out touching. */
export function stringExclusions(def, bodies, proxies) {
	const own = bodies.findIndex((b) => b.id === def.body);
	const out = new Set([own]);
	if (own < 0) return out;
	const attach = add(bodies[own].pos, def.at);
	bodies.forEach((body, i) => {
		const proxy = proxies[i];
		if (!proxy) { out.add(i); return; }
		const d = pointSegDist(attach, add(body.pos, proxy.a), add(body.pos, proxy.b)) - proxy.r;
		if (d < NEAR_ATTACH) out.add(i);
	});
	return out;
}

/** World-space proxy axes for the current transforms. Compute once per step / frame, reuse for every string. */
export function wrapFrame(proxies, pos, quat, frame = []) {
	for (let i = 0; i < proxies.length; i++) {
		const proxy = proxies[i];
		if (!proxy) { frame[i] = null; continue; }
		const c = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
		const q = [quat[i * 4], quat[i * 4 + 1], quat[i * 4 + 2], quat[i * 4 + 3]];
		frame[i] = { c, a: add(c, qRot(q, proxy.a)), b: add(c, qRot(q, proxy.b)), r: proxy.r, bound: proxy.bound };
	}
	return frame;
}

/**
 * Routes a string from `from` (handle) to `to` (attachment) around the bodies in `frame`.
 * Returns { points, bodies, length }: points[0] is the handle, the last is the attachment,
 * anything between is a via point resting on body `bodies[i]` (-1 for the two ends).
 */
export function stringPath(from, to, frame, excluded, margin = STRING_MARGIN) {
	const points = [from, to];
	const bodies = [-1, -1];
	let used = null;
	for (let n = 0; n < MAX_VIAS; n++) {
		let best = null;
		for (let i = 0; i < points.length - 1; i++) {
			const p = points[i], q = points[i + 1];
			const segLen = len(sub(q, p));
			if (segLen < 0.03) continue;
			for (let k = 0; k < frame.length; k++) {
				const f = frame[k];
				if (!f || excluded.has(k) || (used && used.has(k))) continue;
				const reach = f.r + margin;
				if (pointSegDist(f.c, p, q) > f.bound + margin) continue;
				const hit = closestSegSeg(p, q, f.a, f.b);
				// A string end sitting inside a body cannot be fixed by bending the string.
				if (hit.s * segLen < 0.012 || (1 - hit.s) * segLen < 0.012) continue;
				const away = sub(hit.c1, hit.c2);
				const dist = len(away);
				const depth = reach - dist;
				if (depth <= 0 || (best && depth <= best.depth)) continue;
				let normal;
				if (dist > 1e-6) normal = scale(away, 1 / dist);
				else {
					// Dead centre: leave sideways, perpendicular to both the string and the limb.
					normal = norm(cross(sub(q, p), sub(f.b, f.a)));
					if (len(normal) < 0.5) normal = norm(cross(sub(q, p), [0.31, 0.77, 0.55]));
				}
				best = { depth, at: i + 1, body: k, point: addScaled(hit.c2, normal, reach) };
			}
		}
		if (!best) break;
		points.splice(best.at, 0, best.point);
		bodies.splice(best.at, 0, best.body);
		(used || (used = new Set())).add(best.body);
	}
	let length = 0;
	for (let i = 0; i < points.length - 1; i++) length += len(sub(points[i + 1], points[i]));
	return { points, bodies, length };
}

/** How deep a path still cuts into any (non-excluded) body, in metres. For tests and benchmarks. */
export function pathPenetration(points, frame, excluded) {
	let worst = 0;
	for (let i = 0; i < points.length - 1; i++) {
		for (let k = 0; k < frame.length; k++) {
			const f = frame[k];
			if (!f || excluded.has(k)) continue;
			const hit = closestSegSeg(points[i], points[i + 1], f.a, f.b);
			const segLen = len(sub(points[i + 1], points[i]));
			if (hit.s * segLen < 0.012 || (1 - hit.s) * segLen < 0.012) continue;
			worst = Math.max(worst, f.r - len(sub(hit.c1, hit.c2)));
		}
	}
	return worst;
}
