// Authoritative puppet simulation (desktop only).
//
// Rapier owns rigid bodies, joints, joint limits, joint motors (the active
// ragdoll) and contacts. On top of that this file adds:
//   - the kinematic control rig (two bars with string handles),
//   - tension-only strings solved as soft constraints (they pull, never push),
//   - two-bone IK that feeds joint-motor targets plus a gentle effector force,
//   - a procedural balance assist,
//   - guards that keep violent input from blowing the simulation up.
//
// No DOM or Three.js in here, so the same code runs in the Node stability test.

import * as M from '../shared/math.js';
import { RIG, LAYERS, indexById } from '../shared/rig-config.js';

/** Default fixed timestep. Many small steps with few solver iterations beat few large steps with many. */
export const DT = 1 / 240;
export const DEFAULTS = { hz: 240, iterations: 5, stringPasses: 4, warmStart: 0.9 };

const ANG = [3, 4, 5]; // Rapier JointAxis.AngX / AngY / AngZ
const MOTOR_ACCELERATION = 0;
const MAX_LINVEL = 14;
const MAX_ANGVEL = 42;

const xyz = (v) => ({ x: v[0], y: v[1], z: v[2] });

export class PuppetSim {
	constructor(RAPIER, rig = RIG, opts = {}) {
		this.R = RAPIER;
		this.rig = rig;
		this.opts = { ...DEFAULTS, ...opts };
		this.dt = 1 / this.opts.hz;
		this.bodyIx = indexById(rig.bodies);
		this.jointIx = indexById(rig.joints);
		this.handleIx = indexById(rig.handles);
		this.barIx = indexById(rig.bars);
		this.effIx = indexById(rig.effectors);

		const nb = rig.bodies.length;
		this.pos = new Float32Array(nb * 3);
		this.quat = new Float32Array(nb * 4);
		this.prevPos = new Float32Array(nb * 3);
		this.prevQuat = new Float32Array(nb * 4);
		this.handlePos = new Float32Array(rig.handles.length * 3);
		this.handleVel = new Float32Array(rig.handles.length * 3);
		this.time = 0;
		this.resets = 0;
		this.totalMass = rig.bodies.reduce((sum, b) => sum + b.mass, 0);

		this.ctl = {
			bars: rig.bars.map((b) => ({ pos: M.add(rig.home, b.offset), quat: M.qIdent() })),
			handleOffset: rig.handles.map(() => [0, 0, 0]),
			pull: new Float32Array(64),
			ik: rig.effectors.map(() => ({ w: 0, pos: [0, 0, 0] })),
			jointTarget: rig.joints.map(() => null),
			locks: rig.joints.map(() => false),
			tone: { spine: 1, head: 1, arms: 1, legs: 1 },
			balance: 0,
			stringGain: 1,
			response: 20,
			impulses: [],
		};

		this._build();
		this.setStrings(rig.strings);
		this.reset();
	}

	// ---------------------------------------------------------------- build

	_build() {
		const R = this.R;
		const rig = this.rig;
		const world = (this.world = new R.World({ x: 0, y: -rig.gravity, z: 0 }));
		world.timestep = this.dt;
		world.integrationParameters.numSolverIterations = this.opts.iterations;

		const groups = (layer, hits) => {
			const filter = hits.reduce((mask, name) => mask | LAYERS[name], 0);
			return ((LAYERS[layer] << 16) | filter) >>> 0;
		};

		const floor = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
		world.createCollider(
			R.ColliderDesc.cuboid(30, 0.5, 30).setFriction(0.9).setRestitution(0.05).setCollisionGroups(((LAYERS.floor << 16) | 0xffff) >>> 0),
			floor
		);

		this.bodies = rig.bodies.map((def) => {
			const body = world.createRigidBody(
				R.RigidBodyDesc.dynamic()
					.setTranslation(def.pos[0], def.pos[1], def.pos[2])
					.setLinearDamping(0.2)
					.setAngularDamping(0.8)
					.setCanSleep(false)
			);
			let collider;
			let inertia;
			const m = def.mass;
			if (def.shape === 'box') {
				const [hx, hy, hz] = def.size;
				collider = R.ColliderDesc.cuboid(hx, hy, hz);
				inertia = [(m / 3) * (hy * hy + hz * hz), (m / 3) * (hx * hx + hz * hz), (m / 3) * (hx * hx + hy * hy)];
			} else if (def.shape === 'capsule') {
				const [r, hh] = def.size;
				collider = R.ColliderDesc.capsule(hh, r);
				const h = 2 * hh + r;
				const side = (m * (3 * r * r + h * h)) / 12;
				inertia = [side, 0.5 * m * r * r, side];
			} else {
				const r = def.size[0];
				collider = R.ColliderDesc.ball(r);
				inertia = [0.4 * m * r * r, 0.4 * m * r * r, 0.4 * m * r * r];
			}
			const isFoot = def.id.startsWith('foot');
			collider
				.setMass(m)
				.setFriction(isFoot ? 1.1 : 0.55)
				.setRestitution(0.08)
				.setCollisionGroups(groups(def.layer, def.hits));
			world.createCollider(collider, body);
			return { def, body, invMass: 1 / m, invInertia: inertia.map((v) => 1 / v) };
		});

		this.joints = rig.joints.map((def) => {
			const a = this.bodyIx[def.a];
			const b = this.bodyIx[def.b];
			const anchorA = M.sub(def.anchor, rig.bodies[a].pos);
			const anchorB = M.sub(def.anchor, rig.bodies[b].pos);
			const data =
				def.type === 'hinge'
					? R.JointData.revolute(xyz(anchorA), xyz(anchorB), xyz(def.axis))
					: R.JointData.spherical(xyz(anchorA), xyz(anchorB));
			const joint = world.createImpulseJoint(data, this.bodies[a].body, this.bodies[b].body, true);
			joint.setContactsEnabled(false);
			const raw = joint.rawSet;
			const axes = def.type === 'hinge' ? [ANG[0]] : ANG;
			axes.forEach((axis, i) => {
				const lo = def.type === 'hinge' ? def.min : def.min[i];
				const hi = def.type === 'hinge' ? def.max : def.max[i];
				raw.jointSetLimits(joint.handle, axis, lo, hi);
				raw.jointConfigureMotorModel(joint.handle, axis, MOTOR_ACCELERATION);
				raw.jointSetMotorMaxForce(joint.handle, axis, def.torque);
			});
			return { def, joint, raw, axes, a, b, anchorA, anchorB, applied: null, ik: null, lockTarget: null };
		});

		this.effectors = rig.effectors.map((def) => {
			const root = this.joints[this.jointIx[def.root]];
			const mid = this.joints[this.jointIx[def.mid]];
			const tipBody = this.bodyIx[def.tipBody];
			const tipRest = M.add(rig.bodies[tipBody].pos, def.tip);
			return {
				def, root, mid, tipBody,
				anchorBody: this.bodyIx[def.anchor],
				l1: M.dist(root.def.anchor, mid.def.anchor),
				l2: M.dist(mid.def.anchor, tipRest),
				rest: tipRest,
			};
		});

		this.bars = rig.bars.map((b) => ({ pos: M.add(rig.home, b.offset), vel: [0, 0, 0], quat: M.qIdent() }));
		this.handleOff = rig.handles.map(() => [0, 0, 0]);
	}

	/** Replaces the string table (mode switch, custom rig, add / remove strings). */
	setStrings(defs) {
		const rig = this.rig;
		this.strings = [];
		for (const def of defs) {
			const body = this.bodyIx[def.body];
			const handle = this.handleIx[def.handle];
			if (body === undefined || handle === undefined) continue;
			const hdef = rig.handles[handle];
			const bar = rig.bars[this.barIx[hdef.bar]];
			const restHandle = M.add(M.add(rig.home, bar.offset), hdef.local);
			const restAttach = M.add(rig.bodies[body].pos, def.at);
			const rest = Number.isFinite(def.length) ? def.length : M.dist(restHandle, restAttach) + (def.slack || 0);
			this.strings.push({ def, body, handle, rest, tension: 0, lambda: 0, broken: false, over: 0 });
		}
		this.tension = new Float32Array(this.strings.length);
	}

	/** Puts the puppet back in its rest pose under the main bar and re-ties broken strings. */
	reset() {
		const c = this.ctl;
		const rig = this.rig;
		this.bars.forEach((bar, i) => {
			bar.pos = [...c.bars[i].pos];
			bar.quat = [...c.bars[i].quat];
			bar.vel = [0, 0, 0];
		});
		const dx = this.bars[0].pos[0] - rig.home[0];
		const dz = this.bars[0].pos[2] - rig.home[2];
		const zero = { x: 0, y: 0, z: 0 };
		this.bodies.forEach(({ def, body }) => {
			body.setTranslation({ x: def.pos[0] + dx, y: def.pos[1], z: def.pos[2] + dz }, true);
			body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
			body.setLinvel(zero, true);
			body.setAngvel(zero, true);
		});
		this.strings.forEach((s) => { s.broken = false; s.over = 0; s.tension = 0; s.lambda = 0; });
		this.handleOff.forEach((o, i) => { o[0] = c.handleOffset[i][0]; o[1] = c.handleOffset[i][1]; o[2] = c.handleOffset[i][2]; });
		this._placeHandles(0);
		this._readBack(true);
		this.resets++;
	}

	restring() {
		this.strings.forEach((s) => { s.broken = false; s.over = 0; });
	}

	// ----------------------------------------------------------------- step

	step() {
		this._updateRig(this.dt);
		this._solveIK();
		this._applyMotors();
		this._applyStrings(this.dt);
		this._applyEffectorForces(this.dt);
		this._applyBalance(this.dt);
		this._applyImpulses();
		this.world.step();
		this._readBack(false);
		this.time += this.dt;
	}

	bodyPos(i) { const p = this.pos; i *= 3; return [p[i], p[i + 1], p[i + 2]]; }
	bodyQuat(i) { const q = this.quat; i *= 4; return [q[i], q[i + 1], q[i + 2], q[i + 3]]; }
	handleAt(i) { const p = this.handlePos; i *= 3; return [p[i], p[i + 1], p[i + 2]]; }
	/** World position of a point given in a body's local frame. */
	pointAt(body, local) { return M.add(this.bodyPos(body), M.qRot(this.bodyQuat(body), local)); }

	_updateRig(dt) {
		const c = this.ctl;
		const w = c.response;
		this.bars.forEach((bar, i) => {
			const target = c.bars[i];
			for (let k = 0; k < 3; k++) {
				bar.vel[k] += (w * w * (target.pos[k] - bar.pos[k]) - 2 * w * bar.vel[k]) * dt;
			}
			bar.vel = M.clampLen(bar.vel, 9);
			bar.pos = M.addScaled(bar.pos, bar.vel, dt);
			bar.quat = M.qSlerp(bar.quat, target.quat, M.damp(w * 0.9, dt));
		});
		const f = M.damp(28, dt);
		this.handleOff.forEach((o, i) => {
			const t = c.handleOffset[i];
			o[0] += (t[0] - o[0]) * f; o[1] += (t[1] - o[1]) * f; o[2] += (t[2] - o[2]) * f;
		});
		this._placeHandles(dt);
	}

	_placeHandles(dt) {
		const rig = this.rig;
		rig.handles.forEach((h, i) => {
			const bar = this.bars[this.barIx[h.bar]];
			const p = M.add(bar.pos, M.qRot(bar.quat, M.add(h.local, this.handleOff[i])));
			const j = i * 3;
			if (dt > 0) {
				const v = M.clampLen([(p[0] - this.handlePos[j]) / dt, (p[1] - this.handlePos[j + 1]) / dt, (p[2] - this.handlePos[j + 2]) / dt], 14);
				this.handleVel[j] = v[0]; this.handleVel[j + 1] = v[1]; this.handleVel[j + 2] = v[2];
			} else {
				this.handleVel[j] = this.handleVel[j + 1] = this.handleVel[j + 2] = 0;
			}
			this.handlePos[j] = p[0]; this.handlePos[j + 1] = p[1]; this.handlePos[j + 2] = p[2];
		});
	}

	// -------------------------------------------------------------- strings

	_pointVel(body, r) {
		const lv = body.linvel();
		const av = body.angvel();
		return [
			lv.x + av.y * r[2] - av.z * r[1],
			lv.y + av.z * r[0] - av.x * r[2],
			lv.z + av.x * r[1] - av.y * r[0],
		];
	}

	/** Inverse effective mass of a body at offset r from its centre, along unit direction n. */
	_invMassAt(i, r, n) {
		const b = this.bodies[i];
		const q = this.bodyQuat(i);
		const local = M.qRot(M.qConj(q), M.cross(r, n));
		return b.invMass + local[0] * local[0] * b.invInertia[0] + local[1] * local[1] * b.invInertia[1] + local[2] * local[2] * b.invInertia[2];
	}

	/**
	 * Tension-only strings as soft unilateral distance constraints.
	 *
	 * Each string keeps an accumulated impulse (its dual variable) that is warm
	 * started from the previous step and refined over a few Gauss-Seidel passes,
	 * with the total clamped to [0, max tension]. This is the accumulated /
	 * warm-started dual update of Augmented Vertex Block Descent (Giles, Diaz,
	 * Yuksel, SIGGRAPH 2025) written in velocity form with Catto's soft-constraint
	 * coefficients, so it layers on Rapier's own substepping (TGS-soft) solver.
	 * A slack string gets a speculative bound instead, so it comes taut without a
	 * one-step snap.
	 */
	_applyStrings(dt) {
		const c = this.ctl;
		const gain = c.stringGain;
		const { stringPasses, warmStart } = this.opts;
		const active = this._active || (this._active = []);
		active.length = 0;

		this.strings.forEach((s, i) => {
			s.tension = 0;
			this.tension[i] = 0;
			if (!s.def.enabled || s.broken || gain < 0.001) { s.lambda = 0; return; }
			const centre = this.bodyPos(s.body);
			const r = M.qRot(this.bodyQuat(s.body), s.def.at);
			const p = M.add(centre, r);
			const h = this.handleAt(s.handle);
			const d = M.dist(h, p);
			if (d < 1e-6) { s.lambda = 0; return; }
			const n = M.scale(M.sub(h, p), 1 / d);
			const j = s.handle * 3;
			const k = s.def.k * gain;
			const soft = s.def.c * gain + dt * k;
			s.i = i; s.r = r; s.p = p; s.n = n;
			s.vh = [this.handleVel[j], this.handleVel[j + 1], this.handleVel[j + 2]];
			s.w = this._invMassAt(s.body, r, n);
			s.gamma = 1 / (dt * soft);
			s.maxImpulse = s.def.max * gain * dt;
			const stretch = d - Math.max(0.05, s.rest - c.pull[i]);
			// Taut: pull back with the spring's bias. Slack: only stop it overshooting its length this step.
			s.bias = stretch > 0 ? (((dt * k) / soft) * stretch) / dt : stretch / dt;
			s.acc = 0;
			if (stretch > 0 && warmStart > 0 && s.lambda > 0) {
				s.acc = Math.min(s.lambda * warmStart, s.maxImpulse);
				this.bodies[s.body].body.applyImpulseAtPoint(xyz(M.scale(n, s.acc)), xyz(p), true);
			}
			active.push(s);
		});

		for (let pass = 0; pass < stringPasses; pass++) {
			for (const s of active) {
				const body = this.bodies[s.body].body;
				const lengthening = M.dot(M.sub(s.vh, this._pointVel(body, s.r)), s.n);
				const next = M.clamp(s.acc + (lengthening + s.bias - s.gamma * s.acc) / (s.w + s.gamma), 0, s.maxImpulse);
				const delta = next - s.acc;
				if (delta !== 0) body.applyImpulseAtPoint(xyz(M.scale(s.n, delta)), xyz(s.p), true);
				s.acc = next;
			}
		}

		for (const s of active) {
			s.lambda = s.acc;
			s.tension = s.acc / dt;
			this.tension[s.i] = s.tension;
			if (s.def.breakable && s.acc >= s.maxImpulse * 0.98) {
				s.over += dt;
				if (s.over > 0.2) s.broken = true;
			} else {
				s.over = 0;
			}
		}
	}

	// ------------------------------------------------------------- IK + motors

	_relQuat(j) {
		let q = M.qMul(M.qConj(this.bodyQuat(j.a)), this.bodyQuat(j.b));
		if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
		return q;
	}

	/** Current joint angles in the convention Rapier's motors use. */
	jointAngles(j) {
		const q = this._relQuat(j);
		if (j.def.type === 'hinge') return [2 * Math.atan2(q[0], q[3])];
		return [2 * Math.asin(M.clamp(q[0], -1, 1)), 2 * Math.asin(M.clamp(q[1], -1, 1)), 2 * Math.asin(M.clamp(q[2], -1, 1))];
	}

	_solveIK() {
		const c = this.ctl;
		this.joints.forEach((j) => { j.ik = null; });
		this.effectors.forEach((e, i) => {
			const target = c.ik[i];
			if (!(target.w > 0.001)) return;
			const root = e.root;
			const S = this.pointAt(root.a, root.anchorA);
			let tv = M.sub(target.pos, S);
			let tl = M.len(tv);
			if (tl < 1e-4) { tv = [0, -1, 0]; tl = 1; }
			const t = M.scale(tv, 1 / tl);
			const d = M.clamp(tl, Math.abs(e.l1 - e.l2) + 0.02, e.l1 + e.l2 - 0.004);
			const cosA = M.clamp((e.l1 * e.l1 + d * d - e.l2 * e.l2) / (2 * e.l1 * d), -1, 1);
			const sinA = Math.sqrt(1 - cosA * cosA);

			const pole = M.qRot(this.bodyQuat(e.anchorBody), e.def.pole);
			let side = M.sub(pole, M.scale(t, M.dot(pole, t)));
			if (M.len(side) < 1e-3) side = M.cross(t, [1, 0, 0]);
			side = M.norm(side);

			const u = M.norm(M.addScaled(M.scale(t, cosA), side, sinA));
			const elbow = M.addScaled(S, u, e.l1);
			const f = M.norm(M.sub(M.addScaled(S, t, d), elbow));
			let perp = M.sub(f, M.scale(u, M.dot(f, u)));
			if (M.len(perp) < 1e-3) perp = M.scale(M.sub(side, M.scale(u, M.dot(side, u))), -1);
			perp = M.norm(perp);

			const y = M.scale(u, -1);
			const z = M.scale(perp, e.def.bend < 0 ? 1 : -1);
			const x = M.cross(y, z);
			let q = M.qMul(M.qConj(this.bodyQuat(root.a)), M.qFromBasis(x, y, z));
			if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
			const flex = Math.acos(M.clamp(M.dot(u, f), -1, 1));
			root.ik = { w: target.w, target: [2 * Math.asin(M.clamp(q[0], -1, 1)), 2 * Math.asin(M.clamp(q[1], -1, 1)), 2 * Math.asin(M.clamp(q[2], -1, 1))] };
			e.mid.ik = { w: target.w, target: [e.def.bend * flex] };
		});
	}

	_applyMotors() {
		const c = this.ctl;
		this.joints.forEach((j, i) => {
			const def = j.def;
			const tone = c.tone[def.group] ?? 1;
			let target;
			let k = def.stiffness * tone;
			let d = def.damping * tone;

			if (c.locks[i]) {
				if (!j.lockTarget) {
					// Locking narrows the joint's limits to its current pose: a hard stop, not a stiff spring.
					j.lockTarget = this.jointAngles(j);
					j.axes.forEach((axis, n) => j.raw.jointSetLimits(j.joint.handle, axis, j.lockTarget[n] - 0.015, j.lockTarget[n] + 0.015));
				}
				target = j.lockTarget;
				k = 900; d = 60;
			} else {
				if (j.lockTarget) {
					j.axes.forEach((axis, n) => j.raw.jointSetLimits(j.joint.handle, axis, def.type === 'hinge' ? def.min : def.min[n], def.type === 'hinge' ? def.max : def.max[n]));
				}
				j.lockTarget = null;
				if (j.ik) {
					target = j.ik.target;
					k += 260 * j.ik.w; d += 28 * j.ik.w;
				} else if (c.jointTarget[i]) {
					target = c.jointTarget[i];
					k += 240; d += 26;
				}
			}

			const prev = j.applied;
			j.axes.forEach((axis, n) => {
				const lo = def.type === 'hinge' ? def.min : def.min[n];
				const hi = def.type === 'hinge' ? def.max : def.max[n];
				const t = target ? M.clamp(target[n] || 0, lo, hi) : 0;
				if (prev && Math.abs(prev.t[n] - t) < 1e-4 && prev.k === k && prev.d === d) return;
				j.raw.jointConfigureMotorPosition(j.joint.handle, axis, t, k, d);
				if (!j.applied) j.applied = { t: [0, 0, 0], k: 0, d: 0 };
				j.applied.t[n] = t;
			});
			if (j.applied) { j.applied.k = k; j.applied.d = d; }
		});
	}

	_applyEffectorForces(dt) {
		const c = this.ctl;
		const w0 = 13;
		this.effectors.forEach((e, i) => {
			const target = c.ik[i];
			if (!(target.w > 0.001)) return;
			const tip = this.bodies[e.tipBody].body;
			const anchor = this.bodies[e.anchorBody].body;
			const r = M.qRot(this.bodyQuat(e.tipBody), e.def.tip);
			const p = M.add(this.bodyPos(e.tipBody), r);
			const S = this.pointAt(e.root.a, e.root.anchorA);
			const rel = M.sub(this._pointVel(tip, r), this._pointVel(anchor, M.sub(S, this.bodyPos(e.anchorBody))));
			let F = M.scale(M.sub(M.scale(M.sub(target.pos, p), w0 * w0), M.scale(rel, 1.8 * w0)), e.def.mass * target.w);
			F = M.clampLen(F, e.def.force * target.w);
			const J = M.scale(F, dt);
			tip.applyImpulseAtPoint(xyz(J), xyz(p), true);
			anchor.applyImpulseAtPoint(xyz(M.scale(J, -1)), xyz(S), true);
		});
	}

	_applyBalance(dt) {
		const amount = this.ctl.balance;
		if (amount < 0.001) return;
		const heading = M.qToYPR(this.bars[0].quat)[0];
		const upright = M.qAxisAngle([0, 1, 0], heading);
		for (const id of ['pelvis', 'chest']) {
			const i = this.bodyIx[id];
			const { body, def } = this.bodies[i];
			const err = M.qDeltaVec(this.bodyQuat(i), upright);
			const av = body.angvel();
			const inertia = def.mass * 0.05;
			const torque = M.clampLen([
				inertia * (70 * err[0] - 12 * av.x),
				inertia * (70 * err[1] - 12 * av.y),
				inertia * (70 * err[2] - 12 * av.z),
			], 26);
			body.applyTorqueImpulse(xyz(M.scale(torque, amount * dt)), true);
		}
		// Calm the pendulum swing under the bar.
		const chest = this.bodies[this.bodyIx.chest].body;
		const lv = chest.linvel();
		const bar = this.bars[0].vel;
		const drag = this.totalMass * 1.3 * amount * dt;
		chest.applyImpulse({ x: -(lv.x - bar[0]) * drag, y: 0, z: -(lv.z - bar[2]) * drag }, true);
	}

	_applyImpulses() {
		const list = this.ctl.impulses;
		for (const item of list) {
			const i = typeof item.body === 'number' ? item.body : this.bodyIx[item.body];
			const body = this.bodies[i] && this.bodies[i].body;
			if (!body) continue;
			if (item.impulse) body.applyImpulse(xyz(M.clampLen(item.impulse, 6)), true);
			if (item.torque) body.applyTorqueImpulse(xyz(M.clampLen(item.torque, 1.5)), true);
		}
		list.length = 0;
	}

	// ----------------------------------------------------------- read back

	_readBack(snap) {
		this.prevPos.set(this.pos);
		this.prevQuat.set(this.quat);
		let broken = false;
		this.bodies.forEach(({ body }, i) => {
			const t = body.translation();
			const r = body.rotation();
			if (!Number.isFinite(t.x + t.y + t.z + r.x + r.w) || Math.abs(t.x) > 40 || Math.abs(t.y) > 40 || Math.abs(t.z) > 40) {
				broken = true;
				return;
			}
			this.pos[i * 3] = t.x; this.pos[i * 3 + 1] = t.y; this.pos[i * 3 + 2] = t.z;
			this.quat[i * 4] = r.x; this.quat[i * 4 + 1] = r.y; this.quat[i * 4 + 2] = r.z; this.quat[i * 4 + 3] = r.w;
			const lv = body.linvel();
			const ls = Math.hypot(lv.x, lv.y, lv.z);
			if (ls > MAX_LINVEL) { const s = MAX_LINVEL / ls; body.setLinvel({ x: lv.x * s, y: lv.y * s, z: lv.z * s }, true); }
			const av = body.angvel();
			const as = Math.hypot(av.x, av.y, av.z);
			if (as > MAX_ANGVEL) { const s = MAX_ANGVEL / as; body.setAngvel({ x: av.x * s, y: av.y * s, z: av.z * s }, true); }
		});
		if (snap) { this.prevPos.set(this.pos); this.prevQuat.set(this.quat); }
		if (broken && !snap) this.reset();
	}
}
