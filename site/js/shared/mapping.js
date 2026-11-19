// Motion mapping engine.
//
// A mapping is plain data: it reads one input source, shapes it (dead zone,
// response curve, sensitivity, clamp, smoothing, inversion) and adds the result
// to one output target. Control modes are just lists of mappings, so new
// behaviour never needs new code paths — and the Custom Rig editor on the
// phone edits these same objects.
//
//   { src: 'ori.roll', dst: 'main.roll', gain: 1, dead: 0.02, range: 1,
//     curve: 'linear', clamp: [-0.8, 0.8], smooth: 0.06, invert: false,
//     dev: 0, when: 'solo' | 'pro' | undefined }

import { clamp, damp } from './math.js';

export const CURVES = {
	linear: (n) => n,
	soft: (n) => n * Math.abs(n),
	cubic: (n) => n * n * n,
	expo: (n) => Math.sign(n) * (Math.exp(3 * Math.abs(n)) - 1) / (Math.exp(3) - 1),
	snap: (n) => (Math.abs(n) > 0.5 ? Math.sign(n) : 0),
};

/** Input sources a phone provides (per device). */
export const SOURCES = [
	['ori.pitch', 'Tilt forward / back'],
	['ori.roll', 'Tilt left / right'],
	['ori.yaw', 'Twist (compass)'],
	['gyro.x', 'Spin rate: pitch'],
	['gyro.y', 'Spin rate: twist'],
	['gyro.z', 'Spin rate: roll'],
	['acc.x', 'Push left / right'],
	['acc.y', 'Push up / down'],
	['acc.z', 'Push toward / away'],
	['shake', 'Shake energy'],
	['stick.x', 'Thumb stick ↔'],
	['stick.y', 'Thumb stick ↕'],
];

/** Output targets the desktop understands. String / handle / joint targets are generated from the rig. */
export function listTargets(rig) {
	const out = [];
	for (const bar of ['main', 'limb']) {
		for (const a of ['pitch', 'roll', 'yaw']) out.push([`${bar}.${a}`, `${bar} bar ${a}`]);
		for (const a of ['x', 'y', 'z']) out.push([`${bar}.${a}`, `${bar} bar move ${a}`]);
		for (const a of ['x', 'y', 'z']) out.push([`${bar}.kick.${a}`, `${bar} bar impulse ${a}`]);
	}
	for (const s of rig.strings) out.push([`pull.${s.id}`, `string: ${s.label}`]);
	for (const h of rig.handles) for (const a of ['x', 'y', 'z']) out.push([`handle.${h.id}.${a}`, `handle ${h.label} ${a}`]);
	for (const e of rig.effectors) for (const a of ['x', 'y', 'z']) out.push([`ik.${e.id}.${a}`, `IK ${e.label} ${a}`]);
	for (const j of rig.joints) for (const a of j.type === 'hinge' ? ['x'] : ['x', 'y', 'z']) out.push([`joint.${j.id}.${a}`, `joint ${j.id} ${a}`]);
	for (const b of ['chest', 'pelvis', 'head']) for (const a of ['x', 'y', 'z']) {
		out.push([`force.${b}.${a}`, `force on ${b} ${a}`]);
		out.push([`torque.${b}.${a}`, `torque on ${b} ${a}`]);
	}
	out.push(['walk.x', 'walk ↔'], ['walk.z', 'walk ↕'], ['walk.lean', 'walk lean'], ['chaos', 'random jolts'], ['tone', 'muscle tone']);
	return out;
}

export class Mapper {
	constructor() {
		this.state = new Map();
	}

	reset() {
		this.state.clear();
	}

	/** Shapes one raw source value through mapping `m`. `key` identifies the smoothing state. */
	apply(m, key, raw, dt) {
		let v = Number.isFinite(raw) ? raw : 0;
		if (m.invert) v = -v;
		const dead = m.dead || 0;
		const mag = Math.abs(v);
		v = mag <= dead ? 0 : Math.sign(v) * (mag - dead);
		const range = m.range || 1;
		const n = v / range;
		const curve = CURVES[m.curve] || CURVES.linear;
		const shaped = Math.abs(n) <= 1 ? curve(n) : Math.sign(n) * (1 + (Math.abs(n) - 1));
		let out = shaped * range * (m.gain ?? 1);
		if (m.clamp) out = clamp(out, m.clamp[0], m.clamp[1]);
		if (m.smooth > 0) {
			const prev = this.state.get(key) ?? out;
			out = prev + (out - prev) * damp(1 / m.smooth, dt);
			this.state.set(key, out);
		}
		return out;
	}
}
