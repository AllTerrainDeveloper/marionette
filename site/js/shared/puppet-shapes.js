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

// --- other puppets on the same skeleton ---------------------------------------
//
// A model is another table of solid pieces for the same nineteen bodies and eighteen joints:
// the joints stay where they are, so every stringing, every control mode and every animation
// works on every model. What changes is what is drawn, what collides and what a string wraps
// round — all three, because all three are built from this table.

/** An arm from a few numbers: [upper arm, forearm] spindles, joint sizes and materials. */
const armOf = (sx, o) => ({
	clavicle: [
		piece(rod(o.clavicle || 0.026, 0.06), o.joint, [0, 0, 0], { rot: SIDEWAYS }),
		piece(ball(o.shoulder), o.shoulderMat || o.joint, [sx * 0.095, 0, 0], { scale: o.shoulderScale || [1, 1, 1] }),
	],
	upperArm: [
		piece(spindle(0.135, ...o.upper, o.groove !== false), o.upperMat),
		piece(drum(o.elbow, o.elbow, o.elbowWidth || 0.08), o.hingeMat || o.joint, [0, -0.14, 0], { rot: SIDEWAYS }),
	],
	forearm: [
		piece(spindle(0.115, ...o.fore, o.groove !== false), o.foreMat),
		piece(ball(o.wrist), o.joint, [0, -0.12, 0]),
	],
	hand: [
		piece(ball(o.palm), o.handMat, [0, -0.005, 0], { scale: [0.5, 1.25, 0.95] }),
		piece(ball(o.palm * 0.4), o.handMat, [sx * -0.004, 0.004, o.palm * 0.9], { scale: [0.6, 1.4, 0.8] }),
		piece(drum(...o.cuff), o.cuffMat, [0, 0.05, 0]),
	],
});

/** A leg likewise; `shoe` is the list of pieces of the foot. */
const legOf = (o) => ({
	thigh: [
		piece(ball(o.hip), o.joint, [0, 0.192, 0]),
		piece(spindle(0.185, ...o.thigh, o.groove !== false), o.thighMat),
		piece(drum(o.knee, o.knee, o.kneeWidth || 0.1), o.hingeMat || o.joint, [0, -0.195, 0], { rot: SIDEWAYS }),
	],
	shin: [
		piece(spindle(0.175, ...o.shin, o.groove !== false), o.shinMat),
		piece(ball(o.ankle), o.joint, [0, -0.185, 0]),
	],
	foot: o.shoe,
});

const limbs = (armOpts, legOpts) => {
	const l = armOf(1, armOpts), r = armOf(-1, armOpts), a = legOf(legOpts), b = legOf(legOpts);
	return {
		clavicleL: l.clavicle, upperArmL: l.upperArm, forearmL: l.forearm, handL: l.hand,
		clavicleR: r.clavicle, upperArmR: r.upperArm, forearmR: r.forearm, handR: r.hand,
		thighL: a.thigh, shinL: a.shin, footL: a.foot,
		thighR: b.thigh, shinR: b.shin, footR: b.foot,
	};
};

// The ballerina: slight limbs, a bodice, a tutu that is really there (a hand resting on it
// stays on it), hair in a bun, satin pointe shoes.
const BALLERINA = {
	pelvis: [
		piece([[0, -0.075], [0.06, -0.07], [0.1, -0.03], [0.106, 0.02], [0.09, 0.06], [0.05, 0.075], [0, 0.078]], 'paintPink', [0, 0, 0], { scale: [1.2, 1, 0.74] }),
		piece(ball(0.046), 'beech', [0, 0.07, 0]),
		piece([[0, -0.012], [0.11, -0.014], [0.182, -0.005], [0.188, 0.002], [0.11, 0.013], [0, 0.012]], 'tulle', [0, 0.012, 0]),      // tutu
		piece([[0, -0.01], [0.1, -0.012], [0.158, -0.004], [0.162, 0.002], [0.1, 0.011], [0, 0.01]], 'tulleDeep', [0, -0.012, 0]),   // its under-layer
	],
	abdomen: [
		piece([[0, -0.07], [0.05, -0.066], [0.08, -0.03], [0.084, 0.01], [0.082, 0.05], [0.052, 0.07], [0, 0.072]], 'paintPink', [0, 0, 0], { scale: [1.12, 1, 0.74] }),
	],
	chest: [
		piece([[0, -0.118], [0.058, -0.112], [0.09, -0.08], [0.112, -0.02], [0.124, 0.04], [0.114, 0.09], [0.07, 0.114], [0, 0.118]], 'paintPink', [0, 0, 0], { scale: [1.16, 1, 0.66] }),
		piece(ball(0.044), 'beech', [0, -0.118, 0]),
		piece(ball(0.036), 'beech', [0, 0.118, 0]),
	],
	neck: [
		piece([[0, -0.05], [0.024, -0.048], [0.027, -0.02], [0.024, 0.02], [0.027, 0.045], [0, 0.05]], 'beech'),
	],
	head: [
		piece(ball(0.106, 12), 'beech', [0, 0, 0], { scale: [0.95, 1.08, 0.98], smooth: 1 }),         // skull
		piece(ball(0.074), 'beech', [0, -0.056, 0.014], { scale: [0.92, 0.8, 0.94] }),                // jaw
		piece(ball(0.014), 'beech', [0, -0.016, 0.106]),                                              // nose
		piece(ball(0.11, 10), 'hair', [0, 0.02, -0.016], { scale: [0.98, 1.02, 0.98], smooth: 1 }),   // hair, swept back
		piece(ball(0.046), 'hair', [0, 0.092, -0.066]),                                               // bun
	],
	...limbs({
		joint: 'beech', shoulder: 0.038, upper: [0.028, 0.023, 0.006], upperMat: 'beech', elbow: 0.026, elbowWidth: 0.062,
		fore: [0.023, 0.018, 0.005], foreMat: 'beech', wrist: 0.02, palm: 0.034, handMat: 'beech', cuff: [0.022, 0.02, 0.012], cuffMat: 'paintPink', groove: false,
	}, {
		joint: 'tights', hip: 0.054, thigh: [0.046, 0.034, 0.01], thighMat: 'tights', knee: 0.036, kneeWidth: 0.08,
		shin: [0.034, 0.023, 0.012], shinMat: 'tights', ankle: 0.027, groove: false,
		shoe: [
			piece(drum(0.046, 0.046, 0.012), 'satin', [0, -0.029, 0], { scale: [0.8, 1, 2.05] }),          // sole
			piece(ball(0.042), 'satin', [0, -0.006, 0.018], { scale: [0.92, 0.6, 2.1] }),                   // slipper
			piece(ball(0.034), 'satin', [0, -0.004, 0.086], { scale: [0.95, 0.72, 1] }),                    // the box of the toe
		],
	}),
};

// The knight: a paladin of the Sicilian Opera dei Pupi, in plate from crest to sabaton.
const KNIGHT = {
	pelvis: [
		piece([[0, -0.075], [0.07, -0.07], [0.118, -0.03], [0.125, 0.02], [0.105, 0.06], [0.06, 0.075], [0, 0.078]], 'steel', [0, 0, 0], { scale: [1.22, 1, 0.76] }),
		piece(ball(0.052), 'iron', [0, 0.07, 0]),
		piece(drum(0.142, 0.118, 0.085), 'steel', [0, -0.03, 0], { scale: [1.18, 1, 0.84] }),         // the skirt of plates
		piece(drum(0.127, 0.127, 0.022), 'brass', [0, 0.03, 0], { scale: [1.2, 1, 0.8] }),            // sword belt
	],
	abdomen: [
		piece([[0, -0.07], [0.06, -0.066], [0.1, -0.03], [0.11, 0.01], [0.104, 0.05], [0.06, 0.07], [0, 0.072]], 'steel', [0, 0, 0], { scale: [1.16, 1, 0.78] }),
	],
	chest: [
		piece([[0, -0.118], [0.07, -0.112], [0.112, -0.08], [0.14, -0.02], [0.148, 0.04], [0.13, 0.09], [0.08, 0.114], [0, 0.118]], 'steel', [0, 0, 0], { scale: [1.2, 1, 0.76] }),
		piece(ball(0.05), 'iron', [0, -0.118, 0]),
		piece(ball(0.04), 'iron', [0, 0.118, 0]),
	],
	neck: [
		piece([[0, -0.05], [0.036, -0.048], [0.046, -0.02], [0.036, 0.02], [0.04, 0.045], [0, 0.05]], 'steel'),   // gorget
	],
	head: [
		piece(ball(0.118, 12), 'steel', [0, 0, 0], { scale: [0.96, 1.08, 1], smooth: 1 }),            // helm
		piece(ball(0.09), 'steel', [0, -0.055, 0.016], { scale: [0.95, 0.82, 1] }),                   // bevor
		piece(ball(0.03), 'steel', [0, -0.012, 0.108], { scale: [0.7, 0.8, 1.1] }),                   // the visor's snout
		piece(ball(0.034), 'brass', [0, 0.118, -0.014], { scale: [0.34, 0.62, 2.5] }),                // crest
		piece(ball(0.05), 'paintRed', [0, 0.15, -0.092], { scale: [0.5, 1.5, 1] }),                   // plume
	],
	...limbs({
		joint: 'iron', clavicle: 0.028, shoulder: 0.06, shoulderMat: 'steel', shoulderScale: [1, 0.86, 1.04],
		upper: [0.04, 0.034, 0.01], upperMat: 'steel', elbow: 0.039, hingeMat: 'brass',
		fore: [0.035, 0.028, 0.01], foreMat: 'steel', wrist: 0.027, palm: 0.043, handMat: 'steel', cuff: [0.036, 0.03, 0.03], cuffMat: 'steel',
	}, {
		joint: 'iron', hip: 0.062, thigh: [0.062, 0.048, 0.012], thighMat: 'steel', knee: 0.05, hingeMat: 'brass',
		shin: [0.047, 0.034, 0.014], shinMat: 'steel', ankle: 0.035,
		shoe: [
			piece(drum(0.058, 0.058, 0.016), 'iron', [0, -0.027, 0], { scale: [0.85, 1, 2] }),              // sole
			piece(ball(0.05), 'steel', [0, -0.004, 0.02], { scale: [0.98, 0.64, 2.05] }),                   // sabaton
			piece(ball(0.04), 'steel', [0, -0.006, 0.096], { scale: [0.8, 0.66, 1.25] }),                   // its pointed toe
		],
	}),
};

/**
 * The puppets there are to choose from. They share the skeleton in rig-config.js; `shapes` is
 * the table everything solid is built from, and puppet-geometry.js paints each one's details.
 */
export const MODELS = [
	{ id: 'gentleman', label: 'The Gentleman', about: 'Turned beech and oak, a teal waistcoat, a felt hat worn at an angle.', shapes: SHAPES },
	{ id: 'ballerina', label: 'The Ballerina', about: 'Slight limbs, a tutu that is really there, hair in a bun and satin pointe shoes.', shapes: BALLERINA },
	{ id: 'knight', label: 'The Knight', about: 'A paladin of the Sicilian puppet theatre, in plate from plumed helm to sabaton.', shapes: KNIGHT },
];
export const DEFAULT_MODEL = MODELS[0].id;

/** The model with that id, or the first one (the gentleman) if there is none. */
export const modelById = (id) => MODELS.find((m) => m.id === id) || MODELS[0];

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
