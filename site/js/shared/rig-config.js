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

/** Collision layers. `hits` lists the layers a body collides with. */
export const LAYERS = { floor: 1, torso: 2, armL: 4, armR: 8, legL: 16, legR: 32, upper: 64 };

// id, shape, size, rest centre, mass (kg), layer, layers it hits
// box: half extents · capsule: [radius, halfHeight] along Y · ball: [radius]
export const BODIES = [
	{ id: 'pelvis', shape: 'box', size: [0.15, 0.07, 0.09], pos: [0, 0.92, 0], mass: 1.6, layer: 'torso', hits: ['floor', 'armL', 'armR'] },
	{ id: 'abdomen', shape: 'box', size: [0.125, 0.07, 0.08], pos: [0, 1.06, 0], mass: 1.0, layer: 'torso', hits: ['floor', 'armL', 'armR'] },
	{ id: 'chest', shape: 'box', size: [0.17, 0.115, 0.095], pos: [0, 1.245, 0], mass: 1.8, layer: 'torso', hits: ['floor', 'armL', 'armR'] },
	{ id: 'neck', shape: 'capsule', size: [0.04, 0.015], pos: [0, 1.4, 0], mass: 0.18, layer: 'upper', hits: ['floor'] },
	{ id: 'head', shape: 'ball', size: [0.115], pos: [0, 1.545, 0.005], mass: 1.0, layer: 'torso', hits: ['floor', 'armL', 'armR'] },

	{ id: 'clavicleL', shape: 'box', size: [0.085, 0.028, 0.03], pos: [0.145, 1.33, 0], mass: 0.18, layer: 'upper', hits: ['floor'] },
	{ id: 'upperArmL', shape: 'capsule', size: [0.04, 0.1], pos: [0.24, 1.19, 0], mass: 0.36, layer: 'upper', hits: ['floor'] },
	{ id: 'forearmL', shape: 'capsule', size: [0.034, 0.085], pos: [0.24, 0.93, 0], mass: 0.26, layer: 'armL', hits: ['floor', 'torso', 'armR', 'legL', 'legR'] },
	{ id: 'handL', shape: 'box', size: [0.022, 0.055, 0.04], pos: [0.24, 0.755, 0], mass: 0.13, layer: 'armL', hits: ['floor', 'torso', 'armR', 'legL', 'legR'] },

	{ id: 'clavicleR', shape: 'box', size: [0.085, 0.028, 0.03], pos: [-0.145, 1.33, 0], mass: 0.18, layer: 'upper', hits: ['floor'] },
	{ id: 'upperArmR', shape: 'capsule', size: [0.04, 0.1], pos: [-0.24, 1.19, 0], mass: 0.36, layer: 'upper', hits: ['floor'] },
	{ id: 'forearmR', shape: 'capsule', size: [0.034, 0.085], pos: [-0.24, 0.93, 0], mass: 0.26, layer: 'armR', hits: ['floor', 'torso', 'armL', 'legL', 'legR'] },
	{ id: 'handR', shape: 'box', size: [0.022, 0.055, 0.04], pos: [-0.24, 0.755, 0], mass: 0.13, layer: 'armR', hits: ['floor', 'torso', 'armL', 'legL', 'legR'] },

	{ id: 'thighL', shape: 'capsule', size: [0.06, 0.135], pos: [0.095, 0.66, 0], mass: 0.75, layer: 'legL', hits: ['floor', 'legR', 'armL', 'armR'] },
	{ id: 'shinL', shape: 'capsule', size: [0.047, 0.135], pos: [0.095, 0.27, 0], mass: 0.48, layer: 'legL', hits: ['floor', 'legR', 'armL', 'armR'] },
	{ id: 'footL', shape: 'box', size: [0.05, 0.035, 0.115], pos: [0.095, 0.035, 0.05], mass: 0.28, layer: 'legL', hits: ['floor', 'legR'] },

	{ id: 'thighR', shape: 'capsule', size: [0.06, 0.135], pos: [-0.095, 0.66, 0], mass: 0.75, layer: 'legR', hits: ['floor', 'legL', 'armL', 'armR'] },
	{ id: 'shinR', shape: 'capsule', size: [0.047, 0.135], pos: [-0.095, 0.27, 0], mass: 0.48, layer: 'legR', hits: ['floor', 'legL', 'armL', 'armR'] },
	{ id: 'footR', shape: 'box', size: [0.05, 0.035, 0.115], pos: [-0.095, 0.035, 0.05], mass: 0.28, layer: 'legR', hits: ['floor', 'legL'] },
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
	{ id: 'head', bar: 'main', local: [0, 0, -0.035], label: 'Head' },
	{ id: 'back', bar: 'main', local: [0, 0, -0.29], label: 'Back' },
	{ id: 'shoulderL', bar: 'main', local: [0.19, 0, 0], label: 'L shoulder' },
	{ id: 'shoulderR', bar: 'main', local: [-0.19, 0, 0], label: 'R shoulder' },
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
// frame. `slack` is added to the rest length measured in the rest pose
// (negative = pre-tensioned). k: elasticity (N/m), c: damping (N·s/m),
// max: tension ceiling (N). Strings only ever pull.
const str = (n, id, label, body, at, handle, slack, k, c, max, group) => ({
	n, id, label, body, at, handle, slack, k, c, max, group, enabled: true, breakable: false,
});

export const STRINGS = [
	str(1, 'head', 'Head', 'head', [0, 0.1, -0.045], 'head', -0.004, 9000, 90, 420, 'support'),
	str(2, 'back', 'Upper back', 'chest', [0, 0.06, -0.095], 'back', 0.012, 7000, 80, 420, 'support'),
	str(3, 'shoulderL', 'Left shoulder', 'chest', [0.15, 0.115, 0], 'shoulderL', -0.004, 9000, 90, 420, 'support'),
	str(4, 'shoulderR', 'Right shoulder', 'chest', [-0.15, 0.115, 0], 'shoulderR', -0.004, 9000, 90, 420, 'support'),
	str(5, 'wristL', 'Left wrist', 'forearmL', [0, -0.105, 0], 'wristL', 0.03, 2600, 22, 160, 'arms'),
	str(6, 'wristR', 'Right wrist', 'forearmR', [0, -0.105, 0], 'wristR', 0.03, 2600, 22, 160, 'arms'),
	str(7, 'kneeL', 'Left knee', 'thighL', [0, -0.17, 0.058], 'kneeL', 0.012, 3600, 34, 220, 'legs'),
	str(8, 'kneeR', 'Right knee', 'thighR', [0, -0.17, 0.058], 'kneeR', 0.012, 3600, 34, 220, 'legs'),
	str(9, 'ankleL', 'Left ankle', 'footL', [0, 0.035, 0.055], 'ankleL', 0.045, 2600, 24, 160, 'legs'),
	str(10, 'ankleR', 'Right ankle', 'footR', [0, 0.035, 0.055], 'ankleR', 0.045, 2600, 24, 160, 'legs'),
	str(11, 'hipL', 'Left hip', 'pelvis', [0.155, 0.03, -0.02], 'hipL', 0.015, 6000, 70, 420, 'support'),
	str(12, 'hipR', 'Right hip', 'pelvis', [-0.155, 0.03, -0.02], 'hipR', 0.015, 6000, 70, 420, 'support'),
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
