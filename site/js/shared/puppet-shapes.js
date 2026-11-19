// The puppet's solid form — one description, three uses.
//
// Every solid piece of the puppet is a surface of revolution: a lathe profile
// [[radius, y], ...] placed in its body's frame by a position, a rotation and a
// (possibly non-uniform) scale. A limb is a turned spindle, a joint is a turned
// ball, a hinge is a turned drum, the torso pieces are turned barrels squashed
// front to back.
//
// From this one table come:
//   - the rendered mesh        (puppet-geometry.js lathes each profile),
//   - the physics collider     (sim.js builds a convex hull of the same surface),
//   - the string collision shape (string-path.js tests strings against the same
//     profile, in the piece's own unscaled space).
// So what you see is what collides. Painted details that add no real volume
// (eyes, buttons, the bow tie, brass pins) live in puppet-geometry.js only.
//
// Pure data and maths: no Three.js, no DOM, so the simulation can use it in Node.

import { qMul, qAxisAngle, qRot, add } from './math.js';

const SIDES = 12;   // samples around the axis when turning a profile into hull points

/** A ball as a profile: a semicircle of the given radius. */
export const ball = (r, steps = 8) => {
	const pts = [];
	for (let i = 0; i <= steps; i++) {
		const a = -Math.PI / 2 + (i / steps) * Math.PI;
		pts.push([Math.max(0, Math.cos(a) * r), Math.sin(a) * r]);
	}
	pts[0][0] = 0; pts[steps][0] = 0;
	return pts;
};

/** A drum (flat-ended), optionally tapered: bottom radius, top radius, height. */
export const drum = (rBottom, rTop, h) => [[0, -h / 2], [rBottom, -h / 2], [rTop, h / 2], [0, h / 2]];

/** A rod with rounded ends: radius and half the length of its straight part. */
export const rod = (r, half, steps = 4) => {
	const pts = [];
	for (let i = 0; i <= steps; i++) { const a = -Math.PI / 2 + (i / steps) * (Math.PI / 2); pts.push([Math.cos(a) * r, -half + Math.sin(a) * r]); }
	for (let i = 0; i <= steps; i++) { const a = (i / steps) * (Math.PI / 2); pts.push([Math.cos(a) * r, half + Math.sin(a) * r]); }
	pts[0][0] = 0; pts[pts.length - 1][0] = 0;
	return pts;
};

/** A turned limb segment: rounded ends, a belly, and a decorative groove near the bottom. */
export const spindle = (half, rTop, rBottom, belly, groove = true) => {
	const pts = [[0, -half]];
	const steps = 14;
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;                       // 0 bottom … 1 top
		const y = -half + t * 2 * half;
		let r = rBottom + (rTop - rBottom) * t + belly * Math.sin(Math.PI * t) ** 0.9;
		const cap = Math.min(t, 1 - t) * 9;        // round the ends
		if (cap < 1) r *= Math.sqrt(1 - (1 - cap) ** 2) * 0.6 + 0.4;
		if (groove && Math.abs(t - 0.14) < 0.03) r *= 0.9;
		pts.push([r, y]);
	}
	pts.push([0, half]);
	return pts;
};

const euler = (rx, ry, rz) => qMul(qMul(qAxisAngle([1, 0, 0], rx), qAxisAngle([0, 1, 0], ry)), qAxisAngle([0, 0, 1], rz));
const IDENT = [0, 0, 0, 1];
const SIDEWAYS = euler(0, 0, Math.PI / 2);   // lay a profile's axis along X

/** One solid piece: profile, material name, position, rotation (quaternion), scale. */
const piece = (profile, mat, at = [0, 0, 0], opts = {}) => ({
	profile, mat, at, rot: opts.rot || IDENT, scale: opts.scale || [1, 1, 1], smooth: opts.smooth || 0,
});

/** Places pieces given in a sub-frame (like the tilted hat) into the body's frame. */
const inFrame = (origin, rot, pieces) => pieces.map((p) => ({ ...p, at: add(origin, qRot(rot, p.at)), rot: qMul(rot, p.rot) }));

const arm = (sx) => ({
	clavicle: [
		piece(rod(0.026, 0.06), 'walnut', [0, 0, 0], { rot: SIDEWAYS }),
		piece(ball(0.046), 'walnut', [sx * 0.095, 0, 0]),                       // shoulder ball
	],
	upperArm: [
		piece(spindle(0.135, 0.036, 0.03, 0.01), 'beech'),
		piece(drum(0.034, 0.034, 0.08), 'walnut', [0, -0.14, 0], { rot: SIDEWAYS }),   // elbow hinge
	],
	forearm: [
		piece(spindle(0.115, 0.03, 0.024, 0.008), 'oak'),
		piece(ball(0.026), 'walnut', [0, -0.12, 0]),                            // wrist ball
	],
	hand: [
		piece(ball(0.04), 'beech', [0, -0.005, 0], { scale: [0.5, 1.25, 0.95] }),        // palm
		piece(ball(0.016), 'beech', [sx * -0.004, 0.004, 0.036], { scale: [0.6, 1.4, 0.8] }),   // thumb
		piece(drum(0.03, 0.027, 0.022), 'paintCream', [0, 0.05, 0]),            // cuff
	],
});

const leg = () => ({
	thigh: [
		piece(ball(0.062), 'walnut', [0, 0.192, 0]),                            // hip ball
		piece(spindle(0.185, 0.058, 0.044, 0.012), 'oak'),
		piece(drum(0.045, 0.045, 0.1), 'walnut', [0, -0.195, 0], { rot: SIDEWAYS }),     // knee hinge
	],
	shin: [
		piece(spindle(0.175, 0.042, 0.03, 0.012), 'beech'),
		piece(ball(0.034), 'walnut', [0, -0.185, 0]),                           // ankle ball
	],
	foot: [
		piece(drum(0.058, 0.058, 0.016), 'dark', [0, -0.027, 0], { scale: [0.85, 1, 2] }),   // sole
		piece(ball(0.05), 'paintRed', [0, -0.004, 0.02], { scale: [0.98, 0.62, 2.05] }),     // shoe
		piece(ball(0.047), 'paintRed', [0, 0, 0.082], { scale: [1, 0.8, 1] }),               // toe cap
	],
});

const HAT = { at: [0.012, 0.108, 0.006], rot: euler(-0.12, 0, -0.2) };

const armL = arm(1), armR = arm(-1), legL = leg(), legR = leg();

/** Solid pieces per rigid body, keyed by body id (see rig-config.js). */
export const SHAPES = {
	pelvis: [
		piece([[0, -0.075], [0.07, -0.07], [0.118, -0.03], [0.125, 0.02], [0.105, 0.06], [0.06, 0.075], [0, 0.078]], 'oak', [0, 0, 0], { scale: [1.22, 1, 0.74] }),
		piece(ball(0.052), 'walnut', [0, 0.07, 0]),                             // waist ball
	],
	abdomen: [
		piece([[0, -0.07], [0.06, -0.066], [0.098, -0.03], [0.108, 0.01], [0.1, 0.05], [0.06, 0.07], [0, 0.072]], 'beech', [0, 0, 0], { scale: [1.16, 1, 0.76] }),
	],
	chest: [
		piece([[0, -0.118], [0.07, -0.112], [0.11, -0.08], [0.134, -0.02], [0.142, 0.04], [0.128, 0.09], [0.08, 0.114], [0, 0.118]], 'paintTeal', [0, 0, 0], { scale: [1.2, 1, 0.68] }),
		piece(ball(0.05), 'walnut', [0, -0.118, 0]),
		piece(ball(0.04), 'walnut', [0, 0.118, 0]),
	],
	neck: [
		piece([[0, -0.05], [0.03, -0.048], [0.036, -0.02], [0.03, 0.02], [0.034, 0.045], [0, 0.05]], 'walnut'),
	],
	head: [
		piece(ball(0.115, 12), 'beech', [0, 0, 0], { scale: [0.96, 1.06, 0.98], smooth: 1 }),            // skull
		piece(ball(0.085), 'beech', [0, -0.055, 0.012], { scale: [0.95, 0.8, 0.95] }),                   // jaw
		piece(ball(0.022), 'oak', [0.108, 0, 0], { scale: [0.45, 1, 0.8] }),                             // ears
		piece(ball(0.022), 'oak', [-0.108, 0, 0], { scale: [0.45, 1, 0.8] }),
		piece(ball(0.021), 'paintRed', [0, -0.014, 0.118]),                                              // nose
		...inFrame(HAT.at, HAT.rot, [
			piece(drum(0.1, 0.1, 0.008), 'felt'),                                                         // hat brim
			piece(drum(0.066, 0.058, 0.075), 'felt', [0, 0.04, 0]),                                       // hat crown
		]),
	],
	clavicleL: armL.clavicle, upperArmL: armL.upperArm, forearmL: armL.forearm, handL: armL.hand,
	clavicleR: armR.clavicle, upperArmR: armR.upperArm, forearmR: armR.forearm, handR: armR.hand,
	thighL: legL.thigh, shinL: legL.shin, footL: legL.foot,
	thighR: legR.thigh, shinR: legR.shin, footR: legR.foot,
};

/** The hat's frame, for the painted band that sits on it. */
export const HAT_FRAME = HAT;

/** Points on a piece's surface, in its body's frame: the input to a convex hull. */
export function surfacePoints(p, sides = SIDES) {
	const out = [];
	for (const [r, y] of p.profile) {
		const ring = r < 1e-4 ? 1 : sides;
		for (let i = 0; i < ring; i++) {
			const a = (i / ring) * Math.PI * 2;
			const local = [Math.cos(a) * r * p.scale[0], y * p.scale[1], Math.sin(a) * r * p.scale[2]];
			const v = add(p.at, qRot(p.rot, local));
			out.push(v[0], v[1], v[2]);
		}
	}
	return out;
}

/** The profile as a radius-by-height table with strictly increasing heights. */
export function radiusTable(profile) {
	const table = [];
	for (const [r, y] of profile) {
		const last = table[table.length - 1];
		if (last && Math.abs(last[0] - y) < 1e-7) last[1] = Math.max(last[1], r);
		else table.push([y, r]);
	}
	return table;
}

/** Radius of the turned surface at height y (0 above and below it). */
export function radiusAt(table, y) {
	const n = table.length;
	if (y < table[0][0] || y > table[n - 1][0]) return 0;
	let i = 1;
	while (i < n - 1 && table[i][0] < y) i++;
	const [y0, r0] = table[i - 1], [y1, r1] = table[i];
	return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0 || 1);
}
