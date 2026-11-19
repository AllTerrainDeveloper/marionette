// The marionette, described as data.
//
// Everything the simulation, the stage renderer and the phone's top-down view
// know about the puppet comes from this file: rigid bodies, joints, the two
// control bars, their string handles and the strings themselves. Add a body, a
// joint or a string here (or through a Custom Rig JSON) and every layer picks
// it up; nothing below is puppet-specific code.
//
// Rest pose: standing on the floor (y = 0), facing +Z (towards the audience),
// arms hanging. The puppet's left side is +X. All bodies are axis-aligned at
// rest, so every joint's rest rotation is the identity.

const D = Math.PI / 180;

/**
 * Collision layers. Every part of the puppet collides with the floor and with
 * every other part; directly jointed neighbours are exempt (the joint handles
 * them). Set `collide: false` on a body to take it out of self-collision.
 */
export const LAYERS = { floor: 1, body: 2 };

// The rigid bodies: id, rest position of the body's origin, mass (kg).
// Their solid form — what is drawn, what collides and what strings wrap
// around — is described once, in puppet-shapes.js. Mass is spread evenly
// through that form, so centre of mass and inertia follow the real shape.
const body = (id, pos, mass) => ({ id, pos, mass });
const arm = (side, sx) => [
	body(`clavicle${side}`, [sx * 0.145, 1.33, 0], 0.18),
	body(`upperArm${side}`, [sx * 0.24, 1.19, 0], 0.36),
	body(`forearm${side}`, [sx * 0.24, 0.93, 0], 0.26),
	body(`hand${side}`, [sx * 0.24, 0.755, 0], 0.13),
];
const leg = (side, sx) => [
	body(`thigh${side}`, [sx * 0.095, 0.66, 0], 0.75),
	body(`shin${side}`, [sx * 0.095, 0.27, 0], 0.48),
	body(`foot${side}`, [sx * 0.095, 0.035, 0.05], 0.28),
];

export const BODIES = [
	body('pelvis', [0, 0.92, 0], 1.6),
	body('abdomen', [0, 1.06, 0], 1.0),
	body('chest', [0, 1.245, 0], 1.8),
	body('neck', [0, 1.4, 0], 0.18),
	body('head', [0, 1.545, 0.005], 1.0),
	...arm('L', 1),
	...arm('R', -1),
	...leg('L', 1),
	...leg('R', -1),
];

// Joints. `ball` joints take per-axis limits about the parent's X / Y / Z;
// `hinge` joints turn about `axis` between `min` and `max`.
// stiffness / damping are acceleration-based motor gains pulling towards the
// rest pose (the puppet's "muscle tone"); `torque` caps motor strength (N·m).
// `group` lets control modes scale tone per body region.
const ball = (id, a, b, anchor, min, max, stiffness, damping, torque, group) => ({
	id, type: 'ball', a, b, anchor, min: min.map((v) => v * D), max: max.map((v) => v * D), stiffness, damping, torque, group,
});
const hinge = (id, a, b, anchor, min, max, stiffness, damping, torque, group) => ({
	id, type: 'hinge', a, b, anchor, axis: [1, 0, 0], min: min * D, max: max * D, stiffness, damping, torque, group,
});

export const JOINTS = [
	ball('waist', 'pelvis', 'abdomen', [0, 0.99, 0], [-15, -20, -14], [26, 20, 14], 110, 14, 40, 'spine'),
	ball('spine', 'abdomen', 'chest', [0, 1.13, 0], [-15, -24, -17], [28, 24, 17], 110, 14, 40, 'spine'),
	ball('neckBase', 'chest', 'neck', [0, 1.365, 0], [-22, -28, -17], [28, 28, 17], 90, 11, 14, 'head'),
	ball('neckTop', 'neck', 'head', [0, 1.435, 0], [-28, -46, -22], [34, 46, 22], 70, 9, 14, 'head'),

	ball('clavicleL', 'chest', 'clavicleL', [0.06, 1.33, 0], [-6, -14, -8], [6, 14, 17], 260, 24, 20, 'arms'),
	ball('shoulderL', 'clavicleL', 'upperArmL', [0.24, 1.33, 0], [-165, -75, -20], [58, 75, 150], 5, 4.2, 12, 'arms'),
	hinge('elbowL', 'upperArmL', 'forearmL', [0.24, 1.05, 0], -143, 0, 3, 2.8, 8, 'arms'),
	ball('wristL', 'forearmL', 'handL', [0.24, 0.81, 0], [-50, -18, -28], [50, 18, 28], 30, 8, 3, 'arms'),

	ball('clavicleR', 'chest', 'clavicleR', [-0.06, 1.33, 0], [-6, -14, -17], [6, 14, 8], 260, 24, 20, 'arms'),
	ball('shoulderR', 'clavicleR', 'upperArmR', [-0.24, 1.33, 0], [-165, -75, -150], [58, 75, 20], 5, 4.2, 12, 'arms'),
	hinge('elbowR', 'upperArmR', 'forearmR', [-0.24, 1.05, 0], -143, 0, 3, 2.8, 8, 'arms'),
	ball('wristR', 'forearmR', 'handR', [-0.24, 0.81, 0], [-50, -18, -28], [50, 18, 28], 30, 8, 3, 'arms'),

	ball('hipL', 'pelvis', 'thighL', [0.095, 0.855, 0], [-108, -28, -14], [34, 28, 56], 7, 5, 30, 'legs'),
	hinge('kneeL', 'thighL', 'shinL', [0.095, 0.465, 0], 0, 138, 5, 3.6, 20, 'legs'),
	ball('ankleL', 'shinL', 'footL', [0.095, 0.08, 0], [-32, -12, -14], [44, 12, 14], 50, 9, 8, 'legs'),

	ball('hipR', 'pelvis', 'thighR', [-0.095, 0.855, 0], [-108, -28, -56], [34, 28, 14], 7, 5, 30, 'legs'),
	hinge('kneeR', 'thighR', 'shinR', [-0.095, 0.465, 0], 0, 138, 5, 3.6, 20, 'legs'),
	ball('ankleR', 'shinR', 'footR', [-0.095, 0.08, 0], [-32, -12, -14], [44, 12, 14], 50, 9, 8, 'legs'),
];

/** Rest position of the main control bar (world). */
export const RIG_HOME = [0, 2.42, 0];

// Two wooden bars. In solo play the limb bar is carried by the main bar; with
// two phones ("Pro") each puppeteer holds one bar, like a two-handed control.
export const BARS = [
	{ id: 'main', label: 'Main bar', offset: [0, 0, 0] },
	{ id: 'limb', label: 'Limb bar', offset: [0, -0.02, 0.32] },
];

// String handles: where a string leaves a bar, in bar-local coordinates.
export const HANDLES = [
	{ id: 'head', bar: 'main', local: [0, 0, 0.005], label: 'Head' },
	{ id: 'back', bar: 'main', local: [0, 0, -0.29], label: 'Back' },
	{ id: 'shoulderL', bar: 'main', local: [0.19, 0, -0.06], label: 'L shoulder' },
	{ id: 'shoulderR', bar: 'main', local: [-0.19, 0, -0.06], label: 'R shoulder' },
	{ id: 'wristL', bar: 'limb', local: [0.37, 0, 0.09], label: 'L hand' },
	{ id: 'wristR', bar: 'limb', local: [-0.37, 0, 0.09], label: 'R hand' },
	{ id: 'kneeL', bar: 'limb', local: [0.21, 0, 0], label: 'L knee' },
	{ id: 'kneeR', bar: 'limb', local: [-0.21, 0, 0], label: 'R knee' },
	{ id: 'ankleL', bar: 'limb', local: [0.1, 0, 0.17], label: 'L foot' },
	{ id: 'ankleR', bar: 'limb', local: [-0.1, 0, 0.17], label: 'R foot' },
	{ id: 'hipL', bar: 'main', local: [0.25, 0, -0.11], label: 'L hip' },
	{ id: 'hipR', bar: 'main', local: [-0.25, 0, -0.11], label: 'R hip' },
];

// The twelve default strings. `at` is the attachment point in the body's local
// frame. A point inside the wood is moved out to the surface, where the screw
// eye would be: straight out from the piece's axis, or along `out` if given. `slack` is added to the rest length measured in the rest pose
// (negative = pre-tensioned). max: tension ceiling (N) — beyond it the string
// gives. Strings do not stretch and only ever pull. (k and c, an elasticity and a
// damping, are left from the earlier springy strings and are no longer used.)
const str = (n, id, label, body, at, handle, slack, k, c, max, group) => ({
	n, id, label, body, at, handle, slack, k, c, max, group, enabled: true, breakable: false,
});

export const STRINGS = [
	// The head hangs from the crown of its hat, straight above its centre of mass.
	{ ...str(1, 'head', 'Head', 'head', [0, 0.1, 0], 'head', 0.002, 9000, 90, 160, 'support'), out: [0, 1, 0] },
	str(2, 'back', 'Upper back', 'chest', [0, 0.06, -0.08], 'back', 0.012, 7000, 80, 160, 'support'),
	str(3, 'shoulderL', 'Left shoulder', 'chest', [0.11, 0.07, -0.05], 'shoulderL', -0.006, 9000, 90, 160, 'support'),
	str(4, 'shoulderR', 'Right shoulder', 'chest', [-0.11, 0.07, -0.05], 'shoulderR', -0.006, 9000, 90, 160, 'support'),
	str(5, 'wristL', 'Left wrist', 'forearmL', [0, -0.09, 0.01], 'wristL', 0.03, 2600, 22, 60, 'arms'),
	str(6, 'wristR', 'Right wrist', 'forearmR', [0, -0.09, 0.01], 'wristR', 0.03, 2600, 22, 60, 'arms'),
	str(7, 'kneeL', 'Left knee', 'thighL', [0, -0.14, 0.02], 'kneeL', 0.012, 3600, 34, 80, 'legs'),
	str(8, 'kneeR', 'Right knee', 'thighR', [0, -0.14, 0.02], 'kneeR', 0.012, 3600, 34, 80, 'legs'),
	{ ...str(9, 'ankleL', 'Left ankle', 'footL', [0, 0, 0.05], 'ankleL', 0.045, 2600, 24, 60, 'legs'), out: [0, 1, 0] },
	{ ...str(10, 'ankleR', 'Right ankle', 'footR', [0, 0, 0.05], 'ankleR', 0.045, 2600, 24, 60, 'legs'), out: [0, 1, 0] },
	str(11, 'hipL', 'Left hip', 'pelvis', [0.12, 0.03, -0.02], 'hipL', 0.015, 6000, 70, 160, 'support'),
	str(12, 'hipR', 'Right hip', 'pelvis', [-0.12, 0.03, -0.02], 'hipR', 0.015, 6000, 70, 160, 'support'),
];

// IK end effectors: a two-bone chain (root joint → mid joint → tip) whose tip
// can be steered by a target. `pole` biases the bend direction (root-body frame).
export const EFFECTORS = [
	{ id: 'handL', label: 'L hand', root: 'shoulderL', mid: 'elbowL', tipBody: 'handL', tip: [0, -0.02, 0], anchor: 'chest', pole: [0.35, -0.5, -0.8], bend: -1, mass: 0.75, force: 55 },
	{ id: 'handR', label: 'R hand', root: 'shoulderR', mid: 'elbowR', tipBody: 'handR', tip: [0, -0.02, 0], anchor: 'chest', pole: [-0.35, -0.5, -0.8], bend: -1, mass: 0.75, force: 55 },
	{ id: 'footL', label: 'L foot', root: 'hipL', mid: 'kneeL', tipBody: 'footL', tip: [0, 0, -0.05], anchor: 'pelvis', pole: [0.05, 0, 1], bend: 1, mass: 1.5, force: 110 },
	{ id: 'footR', label: 'R foot', root: 'hipR', mid: 'kneeR', tipBody: 'footR', tip: [0, 0, -0.05], anchor: 'pelvis', pole: [-0.05, 0, 1], bend: 1, mass: 1.5, force: 110 },
];

export const RIG = {
	gravity: 9.81,
	bodies: BODIES,
	joints: JOINTS,
	bars: BARS,
	handles: HANDLES,
	strings: STRINGS,
	effectors: EFFECTORS,
	home: RIG_HOME,
	/** The stage area the control rig may travel over (x, z). */
	bounds: { x: [-1.6, 1.6], z: [-0.9, 1.0] },
};

export const indexById = (list) => Object.fromEntries(list.map((item, i) => [item.id, i]));

/** Deep-copies the string table so a mode or custom rig can edit it freely. */
export const cloneStrings = (strings = STRINGS) => strings.map((s) => ({ ...s, at: [...s.at] }));

/** Rest world position of a string's attachment point. */
export function restAttach(string, bodies = BODIES) {
	const body = bodies.find((b) => b.id === string.body);
	return [body.pos[0] + string.at[0], body.pos[1] + string.at[1], body.pos[2] + string.at[2]];
}

/** Rest world position of a handle. */
export function restHandle(handle, bars = BARS, home = RIG_HOME) {
	const bar = bars.find((b) => b.id === handle.bar);
	return [
		home[0] + bar.offset[0] + handle.local[0],
		home[1] + bar.offset[1] + handle.local[1],
		home[2] + bar.offset[2] + handle.local[2],
	];
}
