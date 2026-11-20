// Keyframe animation for the Studio: tracks, keys, easing and Bezier paths.
//
// An animation is plain data — { name, duration, fps, tracks: { trackId: [key, ...] } } — and a
// key is { t, v: [one number per channel], ease: [x1, y1, x2, y2], curve }. Nothing in here
// poses a bone: sampling a track gives the same targets a phone or a one-tap move would give the
// control layer (bar travel and tilt, string-handle offsets), and the simulation does the rest.
// The camera track is the exception: it is the camera.
//
// Two kinds of in-between:
//   - every channel is eased: `ease` is a CSS-style cubic Bezier timing curve for the stretch
//     from that key to the next;
//   - where something travels through space (the camera, what it looks at, a bar), the way
//     between keys is always a cubic Bezier curve through them, never a straight line with
//     corners. `curve` scales how round the path is at that key (0 = a corner).
//
// No DOM and no Three.js in here, so it runs in Node tests as well.

import { BARS, HANDLES } from './rig-config.js';

export const ANIMATION_VERSION = 1;

/** Timing curves by name: cubic-bezier(x1, y1, x2, y2), as in CSS. */
export const EASES = {
	linear: { label: 'Linear', curve: [0, 0, 1, 1] },
	inOut: { label: 'Ease in-out', curve: [0.42, 0, 0.58, 1] },
	in: { label: 'Ease in', curve: [0.42, 0, 1, 1] },
	out: { label: 'Ease out', curve: [0, 0, 0.58, 1] },
	swift: { label: 'Swift out', curve: [0.2, 0.8, 0.2, 1] },
	back: { label: 'Overshoot', curve: [0.34, 1.56, 0.64, 1] },
	anticipate: { label: 'Anticipate', curve: [0.36, 0, 0.66, -0.56] },
};
export const DEFAULT_EASE = EASES.inOut.curve;

const ch = (id, label, key, min, max, step = 0.01) => ({ id, label, key, min, max, step });
const travel = (prefix, reach, lo, hi) => [
	ch('x', 'Side', `${prefix}.x`, -reach, reach), ch('y', 'Height', `${prefix}.y`, lo, hi), ch('z', 'Depth', `${prefix}.z`, -reach, reach),
];
const tilt = (prefix, yaw) => [
	ch('yaw', 'Turn', `${prefix}.yaw`, -yaw, yaw), ch('pitch', 'Tip', `${prefix}.pitch`, -1.3, 1.3), ch('roll', 'Rock', `${prefix}.roll`, -1.3, 1.3),
];

/** Where the camera sits when nothing is keyed: the stage's own view. */
export const CAMERA_REST = [0, 1.5, 5.8, 0, 1.32, 0, 31];

/**
 * The tracks. `channels[n].key` is the control-layer target the channel adds to (see control.js);
 * `paths` lists the channel triples that are positions in space and so travel on Bezier curves.
 */
export const TRACKS = [
	{
		id: 'camera', label: 'Camera', kind: 'camera', rest: CAMERA_REST, paths: [[0, 1, 2], [3, 4, 5]],
		channels: [
			ch('px', 'Side', null, -8, 8), ch('py', 'Height', null, 0.1, 6), ch('pz', 'Depth', null, -2.4, 12),
			ch('tx', 'Aim side', null, -3, 3), ch('ty', 'Aim height', null, 0, 3.2), ch('tz', 'Aim depth', null, -2.6, 3),
			ch('fov', 'Lens', null, 12, 70, 0.5),
		],
	},
	...BARS.map((bar, index) => ({
		id: bar.id, label: bar.label, kind: 'bar', bar: index, rest: [0, 0, 0, 0, 0, 0], paths: [[0, 1, 2]],
		channels: index === 0 ? [...travel('main', 1.6, -0.7, 0.9), ...tilt('main', 3.1)] : [...travel(bar.id, 0.6, -0.6, 0.6), ...tilt(bar.id, 1.3)],
	})),
	...HANDLES.map((h, index) => ({
		id: `handle.${h.id}`, label: h.label, kind: 'handle', handle: index, bar: BARS.findIndex((b) => b.id === h.bar), rest: [0, 0, 0], paths: [],
		channels: [ch('x', 'Side', `handle.${h.id}.x`, -0.7, 0.7), ch('y', 'Lift', `handle.${h.id}.y`, -0.5, 0.8), ch('z', 'Depth', `handle.${h.id}.z`, -0.7, 0.7)],
	})),
];
export const trackById = (id) => TRACKS.find((track) => track.id === id);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, lo, hi, fallback) => (Number.isFinite(+v) ? clamp(+v, lo, hi) : fallback);

// ------------------------------------------------------------------- easing

/**
 * The value of a cubic-bezier(x1, y1, x2, y2) timing curve at progress u (0..1): the curve runs
 * from (0, 0) to (1, 1) through the two control points, x is time and y is how far along. y may
 * leave 0..1 (an overshoot or a wind-up); x1 and x2 are kept in 0..1 so time never runs backwards.
 */
export function easeAt(curve, u) {
	if (u <= 0) return 0;
	if (u >= 1) return 1;
	const x1 = curve[0], y1 = curve[1], x2 = curve[2], y2 = curve[3];
	if (x1 === y1 && x2 === y2) return u;
	// Solve x(s) = u for the curve parameter s: Newton, then bisection if that wanders off.
	const ax = 3 * x1 - 3 * x2 + 1, bx = 3 * x2 - 6 * x1, cx = 3 * x1;
	const xAt = (s) => ((ax * s + bx) * s + cx) * s;
	let s = u;
	for (let i = 0; i < 6; i++) {
		const err = xAt(s) - u;
		if (Math.abs(err) < 1e-6) break;
		const slope = (3 * ax * s + 2 * bx) * s + cx;
		if (Math.abs(slope) < 1e-6) break;
		s -= err / slope;
	}
	if (!(s >= 0 && s <= 1) || Math.abs(xAt(s) - u) > 1e-4) {
		let lo = 0, hi = 1;
		for (let i = 0; i < 40; i++) { s = (lo + hi) / 2; if (xAt(s) < u) lo = s; else hi = s; }
	}
	const ay = 3 * y1 - 3 * y2 + 1, by = 3 * y2 - 6 * y1, cy = 3 * y1;
	return ((ay * s + by) * s + cy) * s;
}

export const cleanEase = (ease) => (Array.isArray(ease) && ease.length === 4 && ease.every((v) => Number.isFinite(+v))
	? [num(ease[0], 0, 1, 0), num(ease[1], -2, 3, 0), num(ease[2], 0, 1, 1), num(ease[3], -2, 3, 1)]
	: [...DEFAULT_EASE]);

/** The name of a timing curve, if it is one of the presets. */
export function easeName(ease) {
	for (const [id, preset] of Object.entries(EASES)) if (preset.curve.every((v, i) => Math.abs(v - ease[i]) < 1e-3)) return id;
	return null;
}

// ---------------------------------------------------------------- sampling

/** Which stretch of a sorted key list holds time t: index of the key at or before it (-1 before the first). */
export function keyBefore(keys, t) {
	let lo = 0, hi = keys.length - 1, found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (keys[mid].t <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
	}
	return found;
}

/**
 * The four control points of the Bezier curve a path takes from key i to key i + 1, for one of
 * the track's position triples: [P0, C1, C2, P3]. The tangent at a key points from the key before
 * it to the key after it (so the path runs smoothly through every key), scaled by that key's `curve`.
 */
export function pathControls(keys, i, triple, out = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]) {
	const a = keys[i], b = keys[i + 1];
	const before = keys[i - 1] || a, after = keys[i + 2] || b;
	const ka = (a.curve ?? 1) / (keys[i - 1] ? 6 : 3), kb = (b.curve ?? 1) / (keys[i + 2] ? 6 : 3);
	for (let n = 0; n < 3; n++) {
		const c = triple[n];
		out[0][n] = a.v[c];
		out[1][n] = a.v[c] + (b.v[c] - before.v[c]) * ka;
		out[2][n] = b.v[c] - (after.v[c] - a.v[c]) * kb;
		out[3][n] = b.v[c];
	}
	return out;
}

const _controls = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];

/**
 * A track's values at time t, into `out` (one number per channel). Null when the track has no
 * keys. Before the first key and after the last the track holds that key's values.
 */
export function sampleTrack(track, keys, t, out = []) {
	if (!keys || !keys.length) return null;
	const n = track.channels.length;
	const i = keyBefore(keys, t);
	if (i < 0 || keys.length === 1) { for (let c = 0; c < n; c++) out[c] = keys[0].v[c]; return out; }
	if (i >= keys.length - 1) { for (let c = 0; c < n; c++) out[c] = keys[keys.length - 1].v[c]; return out; }
	const a = keys[i], b = keys[i + 1];
	const e = easeAt(a.ease || DEFAULT_EASE, (t - a.t) / (b.t - a.t));
	for (let c = 0; c < n; c++) out[c] = a.v[c] + (b.v[c] - a.v[c]) * e;
	for (const triple of track.paths) {
		const p = pathControls(keys, i, triple, _controls);
		const f = 1 - e, w0 = f * f * f, w1 = 3 * f * f * e, w2 = 3 * f * e * e, w3 = e * e * e;
		for (let k = 0; k < 3; k++) out[triple[k]] = w0 * p[0][k] + w1 * p[1][k] + w2 * p[2][k] + w3 * p[3][k];
	}
	// A path may swing wide of its keys; an overshooting ease may too. Never beyond what the rig allows.
	for (let c = 0; c < n; c++) out[c] = clamp(out[c], track.channels[c].min, track.channels[c].max);
	return out;
}

const _values = [];

/**
 * Hands every puppet track's targets at time t to the control layer: add(key, value), exactly as a
 * one-tap move does. `held` (optional, Map of trackId -> values) replaces a track's keyed values —
 * what the editor is holding in place while something is being dragged or tried out.
 */
export function driveTargets(anim, t, add, held = null) {
	for (const track of TRACKS) {
		if (track.kind === 'camera') continue;
		const values = (held && held.get(track.id)) || sampleTrack(track, anim.tracks[track.id], t, _values);
		if (!values) continue;
		for (let c = 0; c < track.channels.length; c++) add(track.channels[c].key, values[c]);
	}
}

/** The camera at time t: [px, py, pz, tx, ty, tz, fov]. The stage's own view when nothing is keyed. */
export function sampleCamera(anim, t, out = []) {
	const track = TRACKS[0];
	return sampleTrack(track, anim.tracks.camera, t, out) || track.rest.slice();
}

// ----------------------------------------------------------------- editing

export function newAnimation(name = 'Untitled') {
	return { version: ANIMATION_VERSION, name, duration: 8, fps: 30, tracks: {} };
}

/** A time on the animation's frame grid, inside the animation. */
export const snapTime = (anim, t) => clamp(Math.round(t * anim.fps) / anim.fps, 0, anim.duration);

/**
 * Sets a key: `values` at time t on a track. A key already on that frame is replaced (keeping
 * its timing curve unless one is given); otherwise the new key takes the ease of the key before it.
 */
export function setKey(anim, trackId, t, values, ease = null) {
	const track = trackById(trackId);
	if (!track) return null;
	const keys = anim.tracks[trackId] || (anim.tracks[trackId] = []);
	t = snapTime(anim, t);
	const v = track.channels.map((c, n) => num(values[n], c.min, c.max, track.rest[n]));
	const same = keys.find((k) => Math.abs(k.t - t) < 0.5 / anim.fps);
	if (same) { same.v = v; if (ease) same.ease = cleanEase(ease); return same; }
	const i = keyBefore(keys, t);
	const key = { t, v, ease: cleanEase(ease || (i >= 0 ? keys[i].ease : DEFAULT_EASE)), curve: 1 };
	keys.splice(i + 1, 0, key);
	return key;
}

export function removeKey(anim, trackId, key) {
	const keys = anim.tracks[trackId];
	if (!keys) return;
	const i = keys.indexOf(key);
	if (i >= 0) keys.splice(i, 1);
	if (!keys.length) delete anim.tracks[trackId];
}

/** Moves a key in time. It cannot pass onto another key's frame (it stops a frame short of it). */
export function moveKey(anim, trackId, key, t) {
	const keys = anim.tracks[trackId];
	if (!keys || !keys.includes(key)) return;
	t = snapTime(anim, t);
	const frame = 1 / anim.fps;
	while (keys.some((k) => k !== key && Math.abs(k.t - t) < frame / 2)) t += t >= key.t ? -frame : frame;
	key.t = clamp(t, 0, anim.duration);
	keys.sort((a, b) => a.t - b.t);
}

/** Changes the length of the animation. Keys beyond a shorter end are brought back to it. */
export function setDuration(anim, seconds) {
	anim.duration = num(seconds, 0.5, 600, anim.duration);
	for (const [id, keys] of Object.entries(anim.tracks)) {
		const kept = [];
		for (const key of keys) {
			key.t = Math.min(key.t, anim.duration);
			if (kept.length && Math.abs(kept[kept.length - 1].t - key.t) < 0.5 / anim.fps) kept[kept.length - 1] = key;   // the later one wins
			else kept.push(key);
		}
		anim.tracks[id] = kept;
	}
}

/** Validates untrusted animation JSON (from storage or a file) into a safe animation. */
export function sanitizeAnimation(input) {
	const out = newAnimation();
	if (!input || typeof input !== 'object') return out;
	out.name = String(input.name || out.name).slice(0, 60);
	out.duration = num(input.duration, 0.5, 600, out.duration);
	out.fps = Math.round(num(input.fps, 12, 60, out.fps));
	if (!input.tracks || typeof input.tracks !== 'object') return out;
	for (const track of TRACKS) {
		const list = input.tracks[track.id];
		if (!Array.isArray(list)) continue;
		const keys = [];
		for (const k of list.slice(0, 2000)) {
			if (!k || !Array.isArray(k.v) || !Number.isFinite(+k.t)) continue;
			keys.push({
				t: Math.round(clamp(+k.t, 0, out.duration) * out.fps) / out.fps,
				v: track.channels.map((c, n) => num(k.v[n], c.min, c.max, track.rest[n])),
				ease: cleanEase(k.ease),
				curve: num(k.curve, 0, 2, 1),
			});
		}
		keys.sort((a, b) => a.t - b.t);
		const kept = keys.filter((k, i) => i === keys.length - 1 || keys[i + 1].t - k.t > 0.5 / out.fps);
		if (kept.length) out.tracks[track.id] = kept;
	}
	return out;
}

/** How many keys an animation holds, all tracks together. */
export const keyCount = (anim) => Object.values(anim.tracks).reduce((sum, keys) => sum + keys.length, 0);

/** A short piece to start from: a bow, a wave, a little kick, and a camera that comes round to watch. */
export function demoAnimation() {
	const anim = newAnimation('Bow and wave');
	anim.duration = 10;
	const key = (track, t, v, ease) => setKey(anim, track, t, v, EASES[ease || 'inOut'].curve);
	key('camera', 0, [0, 1.5, 5.8, 0, 1.32, 0, 31]);
	key('camera', 3.6, [-1.7, 1.25, 4.3, 0, 1.15, 0, 31]);
	key('camera', 7, [1.5, 1.75, 3.7, 0.12, 1.36, 0, 27]);
	key('camera', 10, [0, 1.5, 5.8, 0, 1.32, 0, 31]);
	key('main', 0, [0, 0, 0, 0, 0, 0]);
	key('main', 1.2, [0, 0, 0, 0, 0, 0]);
	key('main', 2.6, [0, -0.06, 0.05, 0, 0.6, 0]);
	key('main', 3.4, [0, -0.06, 0.05, 0, 0.6, 0], 'out');
	key('main', 4.6, [0, 0, 0, 0, 0, 0]);
	key('main', 7.6, [0, 0, 0, 0.35, 0, 0.06]);
	key('main', 10, [0, 0, 0, 0, 0, 0]);
	key('handle.wristL', 4.4, [0, 0, 0], 'swift');
	key('handle.wristL', 5.3, [0.05, 0.52, 0.04]);
	for (let n = 0; n < 5; n++) key('handle.wristL', 5.7 + n * 0.4, [n % 2 ? -0.1 : 0.16, 0.52, 0.04]);
	key('handle.wristL', 8.4, [0, 0, 0]);
	key('handle.kneeR', 8, [0, 0, 0], 'back');
	key('handle.kneeR', 8.6, [0, 0.26, 0.05], 'out');
	key('handle.kneeR', 9.4, [0, 0, 0]);
	return anim;
}
