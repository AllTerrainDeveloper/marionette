// Scripted flourishes ("moves"), shared by both screens.
//
// The stage plays them (control.js adds their output to the mapping targets);
// the phone lists them as one-tap buttons. One table, so the two cannot drift.
//
// A move never poses a bone. `run(add, u, env, t, ik)` only adds to the targets
// the mapping engine already understands — bar tilt and travel, string handles,
// string pulls, IK targets and joint-motor targets — and the simulation does
// the rest. `u` runs 0 → 1 over `dur` seconds, `env` is a soft 0 → 1 → 0 bell,
// `t` is the stage clock and `ik` says the mode already drives the hands by IK.
//
// Sides: the rig's L / R are the puppet's own. It faces the audience, so its
// left hand (+x) is on the RIGHT of both screens. Labels use the audience's
// left and right, because that is what the person tapping the button sees.

import { BODIES } from './rig-config.js';
import { modeById } from './modes.js';

const ease = (x) => x * x * (3 - 2 * x);
/** 0 → 1 → 0 with a flat top: rises over the first `a` of the move, falls over the last `b`. */
const plateau = (u, a = 0.2, b = a) => ease(Math.max(0, Math.min(1, u / a, (1 - u) / b)));
/** A burst of `n` swings inside the window u0..u1 (zero outside it). */
const swing = (u, u0, u1, n) => (u > u0 && u < u1 ? Math.sin(((u - u0) / (u1 - u0)) * Math.PI * 2 * n) * Math.sin(((u - u0) / (u1 - u0)) * Math.PI) : 0);

// Arms & Hands holds the hands forward and up; poses below are measured from the hanging hand.
const HELD = modeById('arms').ikBase;

/** Steers a hand by IK to `x, y, z` from where it hangs at rest (puppet frame), blended in by `w`. */
function reach(add, hand, x, y, z, w, ik) {
	const base = ik ? HELD[hand] : [0, 0, 0];
	add(`ik.${hand}.x`, (x - base[0]) * w); add(`ik.${hand}.y`, (y - base[1]) * w); add(`ik.${hand}.z`, (z - base[2]) * w);
}

/** A raised, fluttering hand: by its wrist string, or by IK where the mode drives hands that way. */
function wave(add, side, w, t, ik) {
	const out = side === 'L' ? 1 : -1;
	if (ik) {
		add(`ik.hand${side}.y`, 0.55 * w); add(`ik.hand${side}.x`, out * (0.1 + 0.1 * Math.sin(t * 11)) * w);
	} else {
		add(`handle.wrist${side}.y`, 0.52 * w);
		add(`handle.wrist${side}.x`, 0.13 * Math.sin(t * 11) * w);
	}
}

// A marionette's neck is close to limp, so its motors alone turn the head far too slowly to read.
const HEAD = BODIES.find((b) => b.id === 'head');
const HEAD_INERTIA = 0.4 * HEAD.mass * HEAD.size[0] ** 2;

/**
 * Turns the head to `yawAt(u)` (radians, + = towards the puppet's left): the neck motors get the
 * angle as their target, and the head gets the nudge that movement needs (inertia × angular
 * acceleration), so it arrives on time and stops when the turn does.
 */
function turnHead(add, yawAt, u, dur) {
	const h = 0.01;
	const yaw = yawAt(u);
	add('joint.neckTop.y', 0.65 * yaw); add('joint.neckBase.y', 0.35 * yaw);
	add('torque.head.y', (HEAD_INERTIA * (yawAt(u + h) - 2 * yaw + yawAt(u - h))) / (h * dur) ** 2);
}

/** Arm straight out to one side (dir +1 = the puppet's left), head and shoulders turned to follow it. */
function point(add, dir, u, dur, ik) {
	const w = plateau(u, 0.22);
	reach(add, dir > 0 ? 'handL' : 'handR', dir * 0.52, 0.64, 0.06, w, ik);
	turnHead(add, (v) => dir * 0.4 * plateau(v, 0.22), u, dur);
	add('main.yaw', dir * 0.22 * w); add('main.roll', dir * -0.06 * w);
}

/** A forward kick: the knee string cocks the leg, the foot target snaps it out (dir +1 = the puppet's left leg). */
function kick(add, dir, u) {
	const side = dir > 0 ? 'L' : 'R';
	const cock = plateau(u, 0.3, 0.3);
	const snap = Math.sin(Math.min(1, Math.max(0, (u - 0.28) / 0.5)) * Math.PI) ** 2;
	add(`handle.knee${side}.y`, 0.2 * cock);
	add(`ik.foot${side}.y`, 0.1 * cock + 0.3 * snap); add(`ik.foot${side}.z`, -0.1 * cock * (1 - snap) + 0.46 * snap);
	add(`ik.foot${side}.x`, dir * 0.1 * snap);   // a touch outwards, so it reads from the front row too
	add('main.roll', dir * -0.07 * cock); add('main.pitch', -0.1 * snap);
}

export const GESTURES = {
	bow: { label: 'Bow', dur: 2.4, run: (add, u, env) => { add('main.pitch', 0.62 * env); add('main.y', -0.07 * env); } },
	greet: {
		label: 'Hello',
		dur: 3.2,
		run: (add, u, env, t) => {
			add('main.pitch', 0.42 * Math.sin(Math.min(1, u * 2.2) * Math.PI));
			if (u > 0.4) { const e = Math.sin(((u - 0.4) / 0.6) * Math.PI); add('handle.wristR.y', 0.5 * e); add('handle.wristR.x', 0.12 * Math.sin(t * 11) * e); }
		},
	},
	wave: { label: 'Wave', dur: 2.8, run: (add, u, env, t, ik) => wave(add, 'L', env, t, ik) },
	waveR: { label: 'Other hand', dur: 2.8, run: (add, u, env, t, ik) => wave(add, 'R', env, t, ik) },
	cheer: {
		label: 'Cheer',
		dur: 3,
		run: (add, u, env, t, ik) => {
			const w = plateau(u, 0.22);
			const shake = 0.06 * Math.sin(t * 13) * w;
			if (ik) {
				reach(add, 'handL', 0.1 + shake, 0.92, 0.05, w, ik); reach(add, 'handR', -0.1 + shake, 0.92, 0.05, w, ik);
			} else {
				for (const side of ['L', 'R']) { add(`handle.wrist${side}.y`, 0.74 * w); add(`handle.wrist${side}.z`, -0.36 * w); add(`handle.wrist${side}.x`, shake); }
			}
			add('main.y', 0.05 * Math.abs(Math.sin(t * 6.5)) * w); add('main.pitch', -0.08 * w);
		},
	},
	clap: {
		label: 'Clap',
		dur: 1.8,
		run: (add, u, env) => {
			const beat = Math.abs(Math.sin(u * Math.PI * 4));
			add('ik.handL.x', -0.2 * beat * env); add('ik.handR.x', 0.2 * beat * env);
			add('ik.handL.y', 0.12 * env); add('ik.handR.y', 0.12 * env);
			add('ik.handL.z', 0.08 * env); add('ik.handR.z', 0.08 * env);
		},
	},
	nod: {
		label: 'Nod yes',
		dur: 2.2,
		run: (add, u) => {
			const dip = 0.5 + 0.5 * -Math.cos(u * Math.PI * 6);   // three dips
			const w = plateau(u, 0.12);
			add('joint.neckTop.x', 0.5 * dip * w); add('joint.neckBase.x', 0.3 * dip * w);
			add('handle.head.y', -0.035 * dip * w); add('handle.head.z', 0.05 * dip * w);
		},
	},
	headshake: {
		label: 'Shake no',
		dur: 2.4,
		run(add, u) { turnHead(add, (v) => 0.6 * swing(v, 0.04, 0.96, 3), u, this.dur); },
	},
	shrug: {
		label: 'Shrug',
		dur: 2.2,
		run: (add, u, env, t, ik) => {
			const w = plateau(u, 0.3);
			reach(add, 'handL', 0.16, 0.26, 0.14, w, ik); reach(add, 'handR', -0.16, 0.26, 0.14, w, ik);
			add('joint.clavicleL.z', 0.3 * w); add('joint.clavicleR.z', -0.3 * w);
			add('handle.shoulderL.y', 0.03 * w); add('handle.shoulderR.y', 0.03 * w);
			add('joint.neckTop.z', 0.22 * w); add('joint.neckTop.x', 0.12 * w);
		},
	},
	salute: {
		label: 'Salute',
		dur: 2.6,
		run: (add, u, env, t, ik) => {
			const w = plateau(u, 0.2, 0.16);
			reach(add, 'handR', 0.13, 0.86, 0.1, w, ik);
			add('main.y', 0.025 * w); add('joint.neckTop.x', -0.1 * w);
		},
	},
	pointL: { label: 'Point left', dur: 2.6, run(add, u, env, t, ik) { point(add, -1, u, this.dur, ik); } },
	pointR: { label: 'Point right', dur: 2.6, run(add, u, env, t, ik) { point(add, 1, u, this.dur, ik); } },
	kickL: { label: 'Kick left', dur: 1.7, run: (add, u) => kick(add, -1, u) },
	kickR: { label: 'Kick right', dur: 1.7, run: (add, u) => kick(add, 1, u) },
	hips: {
		label: 'Hands on hips',
		dur: 3,
		run: (add, u, env, t, ik) => {
			const w = plateau(u, 0.2);
			reach(add, 'handL', -0.05, 0.2, 0.03, w, ik); reach(add, 'handR', 0.05, 0.2, 0.03, w, ik);
			add('main.roll', 0.07 * Math.sin(u * Math.PI * 4) * w); add('joint.neckTop.z', 0.15 * Math.sin(u * Math.PI * 4) * w);
		},
	},
	curtsy: {
		label: 'Curtsy',
		dur: 2.8,
		run: (add, u, env, t, ik) => {
			add('main.y', -0.14 * env); add('main.pitch', 0.16 * env);
			add('ik.footR.z', -0.18 * env); add('ik.footR.x', 0.05 * env);
			reach(add, 'handL', 0.2, 0.12, 0.04, env, ik); reach(add, 'handR', -0.2, 0.12, 0.04, env, ik);
			add('joint.neckTop.x', 0.25 * env);
		},
	},
	jig: {
		label: 'Jig',
		dur: 3.2,
		run: (add, u, env, t) => {
			const s = Math.sin(t * 6.5);
			add('handle.kneeL.y', 0.2 * Math.max(0, s) * env); add('handle.kneeR.y', 0.2 * Math.max(0, -s) * env);
			add('main.roll', 0.09 * s * env); add('main.y', 0.03 * Math.abs(s) * env);
		},
	},
	twist: {
		label: 'Twist',
		dur: 3.6,
		run: (add, u, env, t, ik) => {
			const w = plateau(u, 0.18);
			const s = Math.sin(t * 7);
			add('main.yaw', 0.5 * s * w); add('limb.yaw', -0.55 * s * w);
			add('main.y', -0.05 * w + 0.025 * Math.abs(s) * w);
			if (ik) {
				reach(add, 'handL', 0, 0.3 + 0.08 * s, 0.2, w, ik); reach(add, 'handR', 0, 0.3 - 0.08 * s, 0.2, w, ik);
			} else {
				add('handle.wristL.y', (0.3 + 0.1 * s) * w); add('handle.wristR.y', (0.3 - 0.1 * s) * w);
			}
		},
	},
};

/** What the phone lists, in dock order. On a tall phone the strip has two rows, so neighbours here stack as a pair. */
export const GESTURE_LIST = Object.entries(GESTURES).map(([id, g]) => ({ id, label: g.label }));
