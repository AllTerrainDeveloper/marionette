// Small allocation-light vector / quaternion helpers shared by the simulation
// (which must run without Three.js, e.g. in the Node stability test) and the UI.
// Vectors are [x, y, z]; quaternions are [x, y, z, w].

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const TAU = Math.PI * 2;

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const addScaled = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const norm = (a) => {
	const l = len(a);
	return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const clampLen = (a, max) => {
	const l = len(a);
	return l > max ? scale(a, max / l) : a;
};

export const qIdent = () => [0, 0, 0, 1];
export const qMul = (a, b) => [
	a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
	a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
	a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
	a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qNorm = (q) => {
	const l = Math.hypot(q[0], q[1], q[2], q[3]);
	return l > 1e-9 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
};
export const qRot = (q, v) => {
	const [x, y, z, w] = q;
	const tx = 2 * (y * v[2] - z * v[1]);
	const ty = 2 * (z * v[0] - x * v[2]);
	const tz = 2 * (x * v[1] - y * v[0]);
	return [
		v[0] + w * tx + (y * tz - z * ty),
		v[1] + w * ty + (z * tx - x * tz),
		v[2] + w * tz + (x * ty - y * tx),
	];
};
export const qAxisAngle = (axis, angle) => {
	const s = Math.sin(angle / 2);
	return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
/** Yaw (Y), then pitch (X), then roll (Z) — the order a tilting control bar feels natural in. */
export const qFromYPR = (yaw, pitch, roll) =>
	qMul(qMul(qAxisAngle([0, 1, 0], yaw), qAxisAngle([1, 0, 0], pitch)), qAxisAngle([0, 0, 1], roll));
/** Inverse of qFromYPR. Returns [yaw, pitch, roll]. */
export const qToYPR = (q) => {
	const [x, y, z, w] = q;
	const m13 = 2 * (x * z + w * y);
	const m23 = 2 * (y * z - w * x);
	const m33 = 1 - 2 * (x * x + y * y);
	const m21 = 2 * (x * y + w * z);
	const m22 = 1 - 2 * (x * x + z * z);
	const pitch = Math.asin(clamp(-m23, -1, 1));
	if (Math.abs(m23) < 0.9999) return [Math.atan2(m13, m33), pitch, Math.atan2(m21, m22)];
	return [Math.atan2(-2 * (x * z - w * y), 1 - 2 * (y * y + z * z)), pitch, 0];
};
export const qSlerp = (a, b, t) => {
	let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
	let bx = b[0], by = b[1], bz = b[2], bw = b[3];
	if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
	let s0 = 1 - t, s1 = t;
	if (cos < 0.9995) {
		const th = Math.acos(cos), sn = Math.sin(th);
		s0 = Math.sin((1 - t) * th) / sn;
		s1 = Math.sin(t * th) / sn;
	}
	return qNorm([a[0] * s0 + bx * s1, a[1] * s0 + by * s1, a[2] * s0 + bz * s1, a[3] * s0 + bw * s1]);
};
/** Rotation vector (axis * angle) taking orientation `from` to `to`, shortest way. */
export const qDeltaVec = (from, to) => {
	let d = qMul(to, qConj(from));
	if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
	const s = Math.hypot(d[0], d[1], d[2]);
	if (s < 1e-7) return [0, 0, 0];
	const k = (2 * Math.atan2(s, d[3])) / s;
	return [d[0] * k, d[1] * k, d[2] * k];
};
/** Quaternion from an orthonormal basis given as columns x, y, z. */
export const qFromBasis = (x, y, z) => {
	const m00 = x[0], m10 = x[1], m20 = x[2];
	const m01 = y[0], m11 = y[1], m21 = y[2];
	const m02 = z[0], m12 = z[1], m22 = z[2];
	const tr = m00 + m11 + m22;
	let q;
	if (tr > 0) {
		const s = Math.sqrt(tr + 1) * 2;
		q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
	} else if (m00 > m11 && m00 > m22) {
		const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
		q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
	} else if (m11 > m22) {
		const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
		q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
	} else {
		const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
		q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
	}
	return qNorm(q);
};

/** Framerate-independent exponential approach factor. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
export const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
