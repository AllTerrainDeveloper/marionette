// Control layer (desktop): turns what the puppeteers do into targets for the
// simulation. Phone input goes through the data-driven mapping engine; this
// file only composes the results — control bars, string handles, IK targets,
// the procedural gait, scripted flourishes and the idle "attract" animation.
//
// It never sets bone rotations. Everything it produces is a string handle
// position, a string pull, an IK target, a joint-motor target or a force.

import * as M from '../shared/math.js';
import { RIG } from '../shared/rig-config.js';
import { modeById, modeIndex, defaultCustomRig, sanitizeCustomRig, stringsForMode } from '../shared/modes.js';
import { Mapper } from '../shared/mapping.js';

const KICK_GAIN = 2.5;      // phone acceleration -> bar acceleration
const KICK_SPRING = 60;
const KICK_DAMPING = 11;
const WALK_SPEED = 0.85;    // m/s at full stick
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Scripted flourishes, expressed as additions to mapping targets over time. */
const GESTURES = {
	bow: { dur: 2.4, run: (add, u, env) => { add('main.pitch', 0.62 * env); add('main.y', -0.07 * env); } },
	wave: {
		dur: 2.8,
		run: (add, u, env, t, ik) => {
			if (ik) {
				add('ik.handL.y', 0.55 * env); add('ik.handL.x', (0.1 + 0.1 * Math.sin(t * 11)) * env);
			} else {
				add('handle.wristL.y', 0.52 * env);
				add('handle.wristL.x', 0.13 * Math.sin(t * 11) * env);
			}
		},
	},
	clap: {
		dur: 1.8,
		run: (add, u, env) => {
			const beat = Math.abs(Math.sin(u * Math.PI * 4));
			add('ik.handL.x', -0.2 * beat * env); add('ik.handR.x', 0.2 * beat * env);
			add('ik.handL.y', 0.12 * env); add('ik.handR.y', 0.12 * env);
			add('ik.handL.z', 0.08 * env); add('ik.handR.z', 0.08 * env);
		},
	},
	jig: {
		dur: 3.2,
		run: (add, u, env, t) => {
			const s = Math.sin(t * 6.5);
			add('handle.kneeL.y', 0.2 * Math.max(0, s) * env); add('handle.kneeR.y', 0.2 * Math.max(0, -s) * env);
			add('main.roll', 0.09 * s * env); add('main.y', 0.03 * Math.abs(s) * env);
		},
	},
	greet: {
		dur: 3.2,
		run: (add, u, env, t) => {
			add('main.pitch', 0.42 * Math.sin(Math.min(1, u * 2.2) * Math.PI));
			if (u > 0.4) { const e = Math.sin(((u - 0.4) / 0.6) * Math.PI); add('handle.wristR.y', 0.5 * e); add('handle.wristR.x', 0.12 * Math.sin(t * 11) * e); }
		},
	},
};

class Gait {
	constructor(sim, rig) {
		this.sim = sim;
		this.rig = rig;
		this.vel = [0, 0];
		this.swing = -1;
		this.s = 0;
		this.feet = [
			{ eff: sim.effIx.footL, side: 0.095, knee: 'kneeL', wrist: 'wristR', pos: [0, 0, 0], start: [0, 0, 0] },
			{ eff: sim.effIx.footR, side: -0.095, knee: 'kneeR', wrist: 'wristL', pos: [0, 0, 0], start: [0, 0, 0] },
		];
		this.lean = 0; this.sway = 0; this.bob = 0;
	}

	/** Where a foot belongs: under the hips (the real pelvis, not the bar), plus a lead when moving. */
	home(foot, root, heading, lead = [0, 0]) {
		const c = Math.cos(heading), s = Math.sin(heading);
		const pelvis = this.sim.bodyPos(this.sim.bodyIx.pelvis);
		const bx = M.lerp(this.rig.home[0] + root[0], pelvis[0], 0.7);
		const bz = M.lerp(this.rig.home[2] + root[1], pelvis[2], 0.7);
		return [bx + c * foot.side + lead[0], 0.035, bz - s * foot.side + lead[1]];
	}

	reset(root, heading) {
		this.vel = [0, 0]; this.swing = -1; this.s = 0;
		for (const foot of this.feet) foot.pos = this.home(foot, root, heading);
	}

	/** Advances the walk. Mutates ctrl.root / ctrl.heading and writes knee lifts through `add`. */
	update(dt, wx, wz, ctrl, add) {
		const mag = Math.hypot(wx, wz);
		if (mag > 1) { wx /= mag; wz /= mag; }
		const f = M.damp(5, dt);
		this.vel[0] += (wx * WALK_SPEED - this.vel[0]) * f;
		this.vel[1] += (wz * WALK_SPEED - this.vel[1]) * f;
		const speed = Math.hypot(this.vel[0], this.vel[1]);
		const n = speed / WALK_SPEED;
		const b = this.rig.bounds;
		ctrl.root[0] = M.clamp(ctrl.root[0] + this.vel[0] * dt, b.x[0], b.x[1]);
		ctrl.root[1] = M.clamp(ctrl.root[1] + this.vel[1] * dt, b.z[0], b.z[1]);
		if (speed > 0.08) {
			const diff = wrapAngle(Math.atan2(this.vel[0], this.vel[1]) - ctrl.heading);
			ctrl.heading += M.clamp(diff, -4.5 * dt, 4.5 * dt);
		}

		const stepTime = M.lerp(0.38, 0.24, n);
		const lead = [this.vel[0] * stepTime * 1.15, this.vel[1] * stepTime * 1.15];
		if (this.swing < 0) {
			// Lift whichever foot has fallen furthest from where it should be.
			let worst = -1, worstDist = speed > 0.05 ? 0.03 : 0.11;
			this.feet.forEach((foot, i) => {
				const h = this.home(foot, ctrl.root, ctrl.heading, lead);
				const d = Math.hypot(foot.pos[0] - h[0], foot.pos[2] - h[2]);
				if (d > worstDist) { worst = i; worstDist = d; }
			});
			if (worst >= 0) {
				this.swing = worst; this.s = 0;
				const e = this.sim.effectors[this.feet[worst].eff];
				this.feet[worst].start = this.sim.pointAt(e.tipBody, e.def.tip);
			}
		}
		let lift = 0;
		if (this.swing >= 0) {
			const foot = this.feet[this.swing];
			this.s = Math.min(1, this.s + dt / stepTime);
			const land = this.home(foot, ctrl.root, ctrl.heading, lead);
			const k = M.smoothstep(this.s);
			lift = Math.sin(Math.PI * this.s);
			foot.pos = [M.lerp(foot.start[0], land[0], k), 0.035 + (0.09 + 0.07 * n) * lift, M.lerp(foot.start[2], land[2], k)];
			add(`handle.${foot.knee}.y`, 0.15 * lift);
			add(`handle.${foot.wrist}.z`, 0.1 * lift * n);
			const dir = this.swing === 0 ? -1 : 1;
			this.sway += (dir * 0.05 * lift - this.sway) * M.damp(10, dt);
			if (this.s >= 1) { foot.pos = [land[0], 0.035, land[2]]; this.swing = -1; }
		} else {
			this.sway += (0 - this.sway) * M.damp(6, dt);
		}
		this.lean += (0.17 * n - this.lean) * M.damp(4, dt);
		this.bob = -0.02 * lift * n;
	}
}

export class Controller {
	constructor(sim, rig = RIG) {
		this.sim = sim;
		this.rig = rig;
		this.devices = [null, null];
		this.mapper = new Mapper();
		this.acc = new Map();
		this.kick = rig.bars.map(() => ({ pos: [0, 0, 0], vel: [0, 0, 0] }));
		this.root = [0, 0];
		this.heading = 0;
		this.t = 0;
		this.dropUntil = 0;
		this.relaxUntil = 0;
		this.gestures = [];
		this.nextIdle = 6;
		this.locks = new Set();
		this.custom = defaultCustomRig();
		this.gait = new Gait(sim, rig);
		this.gait.reset(this.root, this.heading);
		this.setMode('classic');
	}

	get phones() { return (this.devices[0] ? 1 : 0) + (this.devices[1] ? 1 : 0); }
	get modeIndex() { return modeIndex(this.mode.id); }

	connect(slot) {
		this.devices[slot] = { input: null, ypr: [0, 0, 0], shake: 0, seq: -1 };
		this.mapper.reset();
	}

	disconnect(slot) {
		this.devices[slot] = null;
		this.mapper.reset();
	}

	setInput(slot, input) {
		const d = this.devices[slot];
		if (!d || !input) return;
		d.input = input;
		d.seq = input.seq;
		d.ypr = input.sensors ? M.qToYPR(M.qNorm(input.quat)) : [0, 0, 0];
		d.shake += (Math.hypot(input.acc[0], input.acc[1], input.acc[2]) - d.shake) * 0.25;
	}

	setMode(id) {
		this.mode = modeById(id);
		this._activate();
		this.gait.reset(this.root, this.heading);
		return this.mode.id;
	}

	setCustom(json) {
		this.custom = sanitizeCustomRig(json, this.rig);
		if (this.mode.custom) this._activate();
	}

	_activate() {
		const mode = this.mode;
		const cfg = mode.custom ? { ...mode, ...this.custom, id: mode.id, custom: true } : mode;
		this.cfg = cfg;
		this.sim.setStrings(stringsForMode(mode, this.custom, this.rig.strings));
		this.stringIx = Object.fromEntries(this.sim.strings.map((s, i) => [s.def.id, i]));
		this.mapper.reset();
	}

	setLocks(indices) {
		this.locks = new Set(indices);
		this.sim.ctl.locks = this.rig.joints.map((_, i) => this.locks.has(i));
	}

	play(id) {
		if (GESTURES[id]) this.gestures.push({ id, t: 0 });
	}

	action(id) {
		switch (id) {
			case 'hop': this.kick.forEach((k) => { k.vel[1] += 2.7; }); break;
			case 'yank': this.kick.forEach((k) => { k.vel[1] += 4.6; }); break;
			case 'drop': this.dropUntil = this.t + 1.3; break;
			case 'relax': this.relaxUntil = this.t + 2.6; break;
			case 'restring': this.sim.restring(); break;
			case 'reset': this.reset(); break;
			default: this.play(id);
		}
	}

	reset() {
		this.root = [0, 0];
		this.heading = 0;
		this.kick.forEach((k) => { k.pos = [0, 0, 0]; k.vel = [0, 0, 0]; });
		this.gestures.length = 0;
		this.dropUntil = this.relaxUntil = 0;
		this.mapper.reset();
		this.gait.reset(this.root, this.heading);
		this.update();
		this.sim.reset();
	}

	_source(d, src) {
		const i = d.input;
		if (!i) return 0;
		switch (src) {
			case 'ori.pitch': return d.ypr[1];
			case 'ori.roll': return d.ypr[2];
			case 'ori.yaw': return d.ypr[0];
			case 'gyro.x': return i.gyro[0];
			case 'gyro.y': return i.gyro[1];
			case 'gyro.z': return i.gyro[2];
			case 'acc.x': return i.acc[0];
			case 'acc.y': return i.acc[1];
			case 'acc.z': return i.acc[2];
			case 'shake': return d.shake;
			case 'stick.x': return i.stick[0];
			case 'stick.y': return i.stick[1];
			default: return 0;
		}
	}

	_idle(add) {
		const t = this.t;
		add('main.roll', 0.1 * Math.sin(t * 0.8) + 0.035 * Math.sin(t * 2.1 + 1));
		add('main.pitch', 0.06 * Math.sin(t * 0.55 + 2));
		add('main.yaw', 0.32 * Math.sin(t * 0.21));
		add('main.y', 0.015 * Math.sin(t * 1.6));
		add('limb.roll', 0.12 * Math.sin(t * 0.47 + 0.6));
		if (t > this.nextIdle) {
			this.play(['wave', 'jig', 'bow', 'wave'][Math.floor(t / 9) % 4]);
			this.nextIdle = t + 9 + ((t * 7.3) % 5);
		}
	}

	/** Runs once per physics step, before sim.step(). */
	update() {
		const dt = this.sim.dt;
		this.t += dt;
		const { sim, rig, cfg, acc } = this;
		const c = sim.ctl;
		acc.clear();
		const add = (key, value) => { if (value) acc.set(key, (acc.get(key) || 0) + value); };
		const g = (key) => acc.get(key) || 0;

		const devices = this.devices.filter(Boolean);
		const pro = devices.length >= 2;
		if (devices.length === 0) {
			this._idle(add);
		} else {
			cfg.mappings.forEach((m, index) => {
				if ((m.when === 'solo' && pro) || (m.when === 'pro' && !pro)) return;
				const d = devices[m.dev || 0];
				if (!d) return;
				add(m.dst, this.mapper.apply(m, index, this._source(d, m.src), dt));
			});
		}

		this.gestures = this.gestures.filter((gesture) => {
			const def = GESTURES[gesture.id];
			gesture.t += dt;
			const u = gesture.t / def.dur;
			if (u >= 1) return false;
			def.run(add, u, Math.sin(u * Math.PI) ** 2, this.t, !!cfg.ikAlways);
			return true;
		});

		// Locomotion.
		const gaitOn = !!cfg.gait && devices.length > 0;
		if (gaitOn) this.gait.update(dt, g('walk.x'), g('walk.z'), this, add);
		const lean = gaitOn ? this.gait.lean + g('walk.lean') : 0;
		const sway = gaitOn ? this.gait.sway : 0;
		const bob = gaitOn ? this.gait.bob : 0;

		// Bar "kick": phone acceleration shoves the bars, a spring brings them home.
		rig.bars.forEach((bar, i) => {
			const k = this.kick[i];
			const a = [g(`${bar.id}.kick.x`), g(`${bar.id}.kick.y`), g(`${bar.id}.kick.z`)];
			for (let n = 0; n < 3; n++) {
				k.vel[n] += (a[n] * KICK_GAIN - KICK_SPRING * k.pos[n] - KICK_DAMPING * k.vel[n]) * dt;
				k.pos[n] += k.vel[n] * dt;
			}
			k.pos = M.clampLen(k.pos, 0.75);
		});

		// Control bars.
		const home = rig.home;
		const yawQ = M.qAxisAngle([0, 1, 0], this.heading);
		const base = [home[0] + this.root[0], home[1], home[2] + this.root[1]];
		const mainQ = M.qFromYPR(this.heading + g('main.yaw'), g('main.pitch') + lean, g('main.roll') + sway);
		let mainPos = M.add(M.add(base, M.qRot(yawQ, [g('main.x'), 0, g('main.z')])), this.kick[0].pos);
		mainPos[1] += g('main.y') + bob;
		mainPos = [
			M.clamp(mainPos[0], rig.bounds.x[0] - 0.4, rig.bounds.x[1] + 0.4),
			M.clamp(mainPos[1], home[1] - 0.7, home[1] + 0.9),
			M.clamp(mainPos[2], rig.bounds.z[0] - 0.4, rig.bounds.z[1] + 0.4),
		];
		c.bars[0].pos = mainPos;
		c.bars[0].quat = mainQ;

		const limbOffset = rig.bars[1].offset;
		const limbTilt = M.qFromYPR(g('limb.yaw'), g('limb.pitch'), g('limb.roll'));
		const limbMove = M.add([g('limb.x'), g('limb.y'), g('limb.z')], this.kick[1].pos);
		if (pro) {
			// Two puppeteers: the limb bar is its own free-floating control.
			c.bars[1].quat = M.qMul(yawQ, limbTilt);
			c.bars[1].pos = M.add(M.add([mainPos[0], base[1] + bob, mainPos[2]], M.qRot(yawQ, limbOffset)), limbMove);
		} else {
			c.bars[1].quat = M.qMul(mainQ, limbTilt);
			c.bars[1].pos = M.add(M.add(mainPos, M.qRot(mainQ, limbOffset)), limbMove);
		}

		// String handles and string pulls.
		rig.handles.forEach((h, i) => {
			const off = [g(`handle.${h.id}.x`), g(`handle.${h.id}.y`), g(`handle.${h.id}.z`)];
			for (const d of devices) {
				const v = d.input && d.input.handles.get(i);
				if (v) { off[0] += v[0]; off[1] += v[1]; off[2] += v[2]; }
			}
			c.handleOffset[i] = [M.clamp(off[0], -0.7, 0.7), M.clamp(off[1], -0.5, 0.8), M.clamp(off[2], -0.7, 0.7)];
		});
		sim.strings.forEach((s, i) => {
			let pull = g(`pull.${s.def.id}`);
			for (const d of devices) pull = Math.max(pull, (d.input && d.input.pulls.get(i)) || 0);
			c.pull[i] = M.clamp(pull, 0, 0.75);
		});

		// IK targets.
		const floorOrigin = [home[0] + this.root[0], 0, home[2] + this.root[1]];
		const wf = M.damp(7, dt);
		sim.effectors.forEach((e, i) => {
			const id = e.def.id;
			const foot = gaitOn && this.gait.feet.find((x) => x.eff === i);
			let active = !!foot || (cfg.ikAlways && cfg.ikAlways.includes(id)) || acc.has(`ik.${id}.x`) || acc.has(`ik.${id}.y`) || acc.has(`ik.${id}.z`);
			const local = [e.rest[0] - home[0], e.rest[1], e.rest[2] - home[2]];
			const basePose = cfg.ikBase && cfg.ikBase[id];
			if (basePose) { local[0] += basePose[0]; local[1] += basePose[1]; local[2] += basePose[2]; }
			local[0] += g(`ik.${id}.x`); local[1] += g(`ik.${id}.y`); local[2] += g(`ik.${id}.z`);
			for (const d of devices) {
				const v = d.input && d.input.ik.get(i);
				if (v) { active = true; local[0] += v[0]; local[1] += v[1]; local[2] += v[2]; }
			}
			const target = c.ik[i];
			target.w += ((active ? 1 : 0) - target.w) * wf;
			if (!active) return;
			if (foot) {
				target.pos = [...foot.pos];
			} else {
				const p = M.add(floorOrigin, M.qRot(yawQ, local));
				p[1] = Math.max(0.03, p[1]);
				target.pos = p;
			}
		});

		// Manual joint targets (Full Body / Custom).
		rig.joints.forEach((j, i) => {
			let t = null;
			for (const d of devices) {
				const v = d.input && d.input.joints.get(i);
				if (v) t = t ? M.add(t, v) : [...v];
			}
			for (const [n, axis] of ['x', 'y', 'z'].entries()) {
				const key = `joint.${j.id}.${axis}`;
				if (acc.has(key)) { t = t || [0, 0, 0]; t[n] += g(key); }
			}
			c.jointTarget[i] = t;
		});

		// Direct forces (Chaos / Custom).
		for (const body of ['chest', 'pelvis', 'head']) {
			const F = [g(`force.${body}.x`), g(`force.${body}.y`), g(`force.${body}.z`)];
			const T = [g(`torque.${body}.x`), g(`torque.${body}.y`), g(`torque.${body}.z`)];
			if (F[0] || F[1] || F[2] || T[0] || T[1] || T[2]) c.impulses.push({ body, impulse: M.scale(F, dt), torque: M.scale(T, dt) });
		}
		const chaos = g('chaos');
		if (chaos > 2.5 && Math.random() < chaos * dt * 1.6) {
			const pick = rig.bodies[Math.floor(Math.random() * rig.bodies.length)];
			const power = Math.min(0.14 * chaos, 2.6) * pick.mass;
			c.impulses.push({ body: pick.id, impulse: [(Math.random() - 0.5) * 2 * power, Math.random() * power, (Math.random() - 0.5) * 2 * power] });
		}

		// Influence of each system for this mode.
		const relax = this.t < this.relaxUntil ? 0.15 : 1;
		const toneScale = Math.max(0, 1 + g('tone')) * relax;
		c.tone = { spine: cfg.tone.spine * toneScale, head: cfg.tone.head * toneScale, arms: cfg.tone.arms * toneScale, legs: cfg.tone.legs * toneScale };
		c.balance = cfg.balance * relax;
		c.stringGain = this.t < this.dropUntil ? 0 : cfg.stringGain;
		c.response = cfg.response;
	}
}
