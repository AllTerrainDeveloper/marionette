// Control configurations.
//
// Each mode is data: how much the strings, the active ragdoll ("tone"), the
// balance assist and IK contribute, which touch controls the phone shows, and
// a list of motion mappings (see mapping.js). `when: 'solo'` mappings apply
// with one phone, `when: 'pro'` with two; `dev: 1` reads the second phone.

import { cloneStrings } from './rig-config.js';

const m = (src, dst, gain = 1, opts = {}) => ({ src, dst, gain, ...opts });
const tilt = { dead: 0.02, smooth: 0.05 };

/** Tilt + shake of one phone drives one control bar. */
const barFromPhone = (bar, dev, extra = {}, gain = 1) => [
	m('ori.pitch', `${bar}.pitch`, gain, { ...tilt, clamp: [-0.8, 0.8], dev, ...extra }),
	m('ori.roll', `${bar}.roll`, gain, { ...tilt, clamp: [-0.8, 0.8], dev, ...extra }),
	m('ori.yaw', `${bar}.yaw`, gain, { ...tilt, clamp: [-1.5, 1.5], dev, ...extra }),
	m('acc.x', `${bar}.kick.x`, 1, { dead: 0.5, dev, ...extra }),
	m('acc.y', `${bar}.kick.y`, 1, { dead: 0.5, dev, ...extra }),
	m('acc.z', `${bar}.kick.z`, 1, { dead: 0.5, dev, ...extra }),
];

export const MODES = [
	{
		id: 'classic',
		label: 'Classic',
		title: 'Classic Marionette',
		blurb: 'Your phone is the wooden crossbar. Tilt it to move head, shoulders and balance; drag the knobs to work arms and legs.',
		tone: { spine: 1, head: 1, arms: 1, legs: 1 },
		balance: 0.22, stringGain: 1, response: 20,
		stick: 'Rock leg bar',
		actions: [{ id: 'bow', label: 'Bow' }, { id: 'wave', label: 'Wave' }],
		mappings: [
			...barFromPhone('main', 0),
			m('stick.x', 'limb.roll', 0.55, { when: 'solo', smooth: 0.06 }),
			m('stick.y', 'limb.pitch', -0.45, { when: 'solo', smooth: 0.06 }),
			...barFromPhone('limb', 1, { when: 'pro' }),
		],
	},
	{
		id: 'full',
		label: 'Full Body',
		title: 'Full Body',
		blurb: 'Every region is live. Tap a joint and drag to pose it, drag the round targets to place hands and feet, or pull any string.',
		tone: { spine: 1.7, head: 1.4, arms: 1.2, legs: 1.5 },
		balance: 0.5, stringGain: 1, response: 18,
		ik: ['handL', 'handR', 'footL', 'footR'],
		jointControl: true,
		stick: 'Rock leg bar',
		actions: [{ id: 'bow', label: 'Bow' }, { id: 'relax', label: 'Relax' }],
		mappings: [
			...barFromPhone('main', 0, {}, 0.7),
			m('stick.x', 'limb.roll', 0.5, { when: 'solo', smooth: 0.06 }),
			m('stick.y', 'limb.pitch', -0.4, { when: 'solo', smooth: 0.06 }),
			...barFromPhone('limb', 1, { when: 'pro' }, 0.8),
		],
	},
	{
		id: 'arms',
		label: 'Arms & Hands',
		title: 'Arms & Hands',
		blurb: 'Conduct with your phone: tilt up to raise the hands, roll to trade them. Drag the round targets to place each hand. With two phones, each one is a hand.',
		tone: { spine: 4, head: 2.4, arms: 1, legs: 4 },
		balance: 0.9, stringGain: 1, response: 18,
		ik: ['handL', 'handR'],
		ikAlways: ['handL', 'handR'],
		ikBase: { handL: [0.03, 0.22, 0.22], handR: [-0.03, 0.22, 0.22] },
		actions: [{ id: 'wave', label: 'Wave' }, { id: 'clap', label: 'Clap' }],
		mappings: [
			m('ori.pitch', 'ik.handL.y', -0.95, { ...tilt, clamp: [-0.3, 0.75], when: 'solo' }),
			m('ori.pitch', 'ik.handR.y', -0.95, { ...tilt, clamp: [-0.3, 0.75], when: 'solo' }),
			m('ori.roll', 'ik.handL.y', -0.6, { ...tilt, clamp: [-0.4, 0.4], when: 'solo' }),
			m('ori.roll', 'ik.handR.y', 0.6, { ...tilt, clamp: [-0.4, 0.4], when: 'solo' }),
			m('ori.yaw', 'main.yaw', 0.8, { ...tilt, clamp: [-1, 1], when: 'solo' }),
			m('ori.pitch', 'ik.handL.y', -1, { ...tilt, clamp: [-0.3, 0.8], when: 'pro', dev: 0 }),
			m('ori.roll', 'ik.handL.x', -0.6, { ...tilt, clamp: [-0.35, 0.35], when: 'pro', dev: 0 }),
			m('ori.yaw', 'ik.handL.z', 0.5, { ...tilt, clamp: [-0.25, 0.3], when: 'pro', dev: 0 }),
			m('ori.pitch', 'ik.handR.y', -1, { ...tilt, clamp: [-0.3, 0.8], when: 'pro', dev: 1 }),
			m('ori.roll', 'ik.handR.x', -0.6, { ...tilt, clamp: [-0.35, 0.35], when: 'pro', dev: 1 }),
			m('ori.yaw', 'ik.handR.z', -0.5, { ...tilt, clamp: [-0.25, 0.3], when: 'pro', dev: 1 }),
			m('acc.y', 'main.kick.y', 0.5, { dead: 0.8 }),
		],
	},
	{
		id: 'walk',
		label: 'Walking',
		title: 'Walking',
		blurb: 'Steer with the thumb stick, or simply lean the phone the way you want to go. The puppet plants its feet and tries to keep up.',
		tone: { spine: 2.2, head: 1.6, arms: 0.8, legs: 1.2 },
		balance: 0.8, stringGain: 1, response: 16,
		gait: true,
		stringsOff: ['ankleL', 'ankleR'],
		stick: 'Walk',
		actions: [{ id: 'hop', label: 'Hop' }, { id: 'bow', label: 'Bow' }],
		mappings: [
			m('stick.x', 'walk.x', 1),
			m('stick.y', 'walk.z', -1),
			m('ori.roll', 'walk.x', -1.6, { dead: 0.14, clamp: [-1, 1], smooth: 0.08, when: 'solo' }),
			m('ori.pitch', 'walk.z', 1.6, { dead: 0.14, clamp: [-1, 1], smooth: 0.08, when: 'solo' }),
			m('acc.y', 'main.kick.y', 0.6, { dead: 0.8 }),
			...barFromPhone('main', 1, { when: 'pro' }, 0.6),
		],
	},
	{
		id: 'chaos',
		label: 'Chaos',
		title: 'Chaos Mode',
		blurb: 'No safety net. Shake, spin and yank the phone: every motion is amplified into the strings. Nothing is pre-animated.',
		tone: { spine: 0.25, head: 0.25, arms: 0.25, legs: 0.25 },
		balance: 0, stringGain: 1.25, response: 34,
		actions: [{ id: 'drop', label: 'Drop!' }, { id: 'yank', label: 'Yank' }],
		mappings: [
			m('ori.pitch', 'main.pitch', 1.6, { clamp: [-1.3, 1.3], smooth: 0.02 }),
			m('ori.roll', 'main.roll', 1.6, { clamp: [-1.3, 1.3], smooth: 0.02 }),
			m('ori.yaw', 'main.yaw', 1.6, { clamp: [-3, 3], smooth: 0.02 }),
			m('acc.x', 'main.kick.x', 3.2), m('acc.y', 'main.kick.y', 3.2), m('acc.z', 'main.kick.z', 3.2),
			m('gyro.x', 'torque.chest.x', 0.5), m('gyro.y', 'torque.chest.y', 0.5), m('gyro.z', 'torque.chest.z', 0.5),
			m('shake', 'chaos', 1),
			m('ori.pitch', 'limb.pitch', 1.6, { clamp: [-1.3, 1.3], dev: 1, when: 'pro' }),
			m('ori.roll', 'limb.roll', 1.6, { clamp: [-1.3, 1.3], dev: 1, when: 'pro' }),
			m('acc.x', 'limb.kick.x', 3.2, { dev: 1, when: 'pro' }), m('acc.y', 'limb.kick.y', 3.2, { dev: 1, when: 'pro' }), m('acc.z', 'limb.kick.z', 3.2, { dev: 1, when: 'pro' }),
			m('shake', 'chaos', 1, { dev: 1, when: 'pro' }),
		],
	},
	{
		id: 'custom',
		label: 'Custom Rig',
		title: 'Custom Rig',
		blurb: 'Build your own control: choose strings, tune them, and wire any phone input to any part of the puppet. Saved in this browser as JSON.',
		custom: true,
		tone: { spine: 1, head: 1, arms: 1, legs: 1 },
		balance: 0.22, stringGain: 1, response: 20,
		ik: ['handL', 'handR', 'footL', 'footR'],
		jointControl: true,
		stick: 'Stick',
		actions: [{ id: 'bow', label: 'Bow' }],
		mappings: [...barFromPhone('main', 0), ...barFromPhone('limb', 1, { when: 'pro' })],
	},
];

export const modeById = (id) => MODES.find((mode) => mode.id === id) || MODES[0];
export const modeIndex = (id) => Math.max(0, MODES.findIndex((mode) => mode.id === id));

/** The string table in force for a mode (both screens must agree on it). */
export function stringsForMode(mode, custom, rigStrings) {
	let strings = mode.custom && custom ? custom.strings : cloneStrings(rigStrings);
	if (mode.stringsOff) strings = strings.map((s) => (mode.stringsOff.includes(s.id) ? { ...s, enabled: false } : s));
	return strings;
}

export const CUSTOM_VERSION = 1;

/** A fresh, fully serialisable custom rig (the JSON users save, export and import). */
export function defaultCustomRig() {
	const base = modeById('custom');
	return {
		version: CUSTOM_VERSION,
		name: 'My rig',
		tone: { ...base.tone },
		balance: base.balance,
		stringGain: base.stringGain,
		response: base.response,
		strings: cloneStrings(),
		mappings: base.mappings.map((x) => ({ ...x })),
		groups: [],
	};
}

const num = (v, lo, hi, fallback) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : fallback);

/**
 * Validates an untrusted string table (from storage, import or the network). Each entry is a
 * string or, with `kind: 'rod'`, a rod: a stiff wire that pushes as well as pulls.
 */
export function sanitizeStrings(list, rig) {
	const bodies = new Set(rig.bodies.map((b) => b.id));
	const handles = new Set(rig.handles.map((h) => h.id));
	const seen = new Set();
	return (Array.isArray(list) ? list : []).slice(0, 24).filter((s) => s && bodies.has(s.body) && handles.has(s.handle)).map((s, i) => {
		let id = String(s.id || `s${i + 1}`).replace(/[^\w-]/g, '').slice(0, 24) || `s${i + 1}`;
		while (seen.has(id)) id = `${id.slice(0, 20)}_${i + 1}`;
		seen.add(id);
		const clean = {
			n: i + 1,
			id,
			label: String(s.label || `String ${i + 1}`).slice(0, 32),
			body: s.body,
			handle: s.handle,
			at: [0, 1, 2].map((k) => num(s.at && s.at[k], -0.4, 0.4, 0)),
			slack: num(s.slack, -0.2, 0.6, 0.02),
			k: num(s.k, 200, 14000, 3000),
			c: num(s.c, 2, 200, 30),
			max: num(s.max, 20, 600, 200),
			group: String(s.group || 'custom').slice(0, 24),
			enabled: s.enabled !== false,
			breakable: !!s.breakable,
		};
		if (s.kind === 'rod') clean.kind = 'rod';
		// Which way the screw eye stands off the wood, where the table says so.
		if (Array.isArray(s.out) && s.out.length === 3 && s.out.every((v) => Number.isFinite(+v)) && Math.hypot(...s.out) > 0.5) clean.out = s.out.map((v) => num(v, -1, 1, 0));
		return clean;
	});
}

/** Validates untrusted custom-rig JSON (from storage, import or the network) into a safe rig. */
export function sanitizeCustomRig(input, rig) {
	const out = defaultCustomRig();
	if (!input || typeof input !== 'object') return out;
	const handles = new Set(rig.handles.map((h) => h.id));
	out.name = String(input.name || out.name).slice(0, 40);
	for (const key of Object.keys(out.tone)) out.tone[key] = num(input.tone && input.tone[key], 0, 6, out.tone[key]);
	out.balance = num(input.balance, 0, 1, out.balance);
	out.stringGain = num(input.stringGain, 0, 1.5, out.stringGain);
	out.response = num(input.response, 6, 40, out.response);
	if (Array.isArray(input.strings)) out.strings = sanitizeStrings(input.strings, rig);
	if (Array.isArray(input.mappings)) {
		out.mappings = input.mappings.slice(0, 48).filter((x) => x && typeof x.src === 'string' && typeof x.dst === 'string').map((x) => {
			const clean = { src: x.src.slice(0, 32), dst: x.dst.slice(0, 48), gain: num(x.gain, -8, 8, 1) };
			if (x.dead !== undefined) clean.dead = num(x.dead, 0, 5, 0);
			if (x.smooth !== undefined) clean.smooth = num(x.smooth, 0, 2, 0);
			if (x.range !== undefined) clean.range = num(x.range, 0.01, 20, 1);
			if (Array.isArray(x.clamp)) clean.clamp = [num(x.clamp[0], -20, 20, -1), num(x.clamp[1], -20, 20, 1)];
			if (typeof x.curve === 'string') clean.curve = x.curve.slice(0, 12);
			if (x.invert) clean.invert = true;
			if (x.dev === 1) clean.dev = 1;
			if (x.when === 'solo' || x.when === 'pro') clean.when = x.when;
			return clean;
		});
	}
	if (Array.isArray(input.groups)) {
		out.groups = input.groups.slice(0, 12).map((g) => ({
			name: String((g && g.name) || 'Group').slice(0, 24),
			handles: Array.isArray(g && g.handles) ? g.handles.filter((h) => handles.has(h)).slice(0, 16) : [],
		}));
	}
	return out;
}
