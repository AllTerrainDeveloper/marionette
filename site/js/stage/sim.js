// Authoritative puppet simulation (desktop only).
//
// The dynamics are solved by Augmented Vertex Block Descent (avbd.js): rigid
// bodies, joints with limits, the muscle-tone motors, contacts with friction
// and the inextensible strings all sit in one implicit solve per step.
// Rapier is kept for geometry only — convex hulls, their mass properties and
// closest-point queries between them; it never steps the puppet.
//
// On top of the solver this file adds:
//   - the kinematic control rig (two bars with string handles),
//   - string routing around the limbs (string-path.js),
//   - two-bone IK that feeds joint-motor targets plus a gentle effector force,
//   - a procedural balance assist,
//   - guards that keep violent input from blowing the simulation up.
//
// No DOM or Three.js in here, so the same code runs in the Node stability test.

import * as M from '../shared/math.js';
import { RIG, indexById } from '../shared/rig-config.js';
import { SHAPES, surfacePoints } from '../shared/puppet-shapes.js';
import { buildWrapProxies, effectiveAttach, stringExclusions, wrapFrame, stringPath } from '../shared/string-path.js';
import { Solver, Joint, Contact, StringForce, jointAngles } from './avbd.js';

/**
 * hz / iterations: fixed step rate and solver sweeps per step.
 * alpha: stabilisation (share of existing constraint error left for later steps);
 * gamma: warm-start decay; betaLin / betaAng: penalty ramps for length and angle rows;
 * ratio: how far a penalty may ramp above its base (see avbd.js).
 * stringCollision: strings wrap around the limbs.
 *
 * These follow the authors' 3D reference solver (alpha 0.99, no separate
 * post-stabilisation pass) except that angle rows keep a fixed penalty: with the
 * puppet's very light clavicles and hands resting on their joint limits, ramping
 * those made a standing puppet fidget.
 */
export const DEFAULTS = { hz: 240, iterations: 5, postStabilize: false, alpha: 0.99, gamma: 0.99, betaLin: 1e6, betaAng: 0, ratio: 100, stringCollision: true };
export const DT = 1 / DEFAULTS.hz;

const MAX_LINVEL = 14;
const MAX_ANGVEL = 42;
const LINEAR_DAMPING = 0.15;      // air drag, 1/s
const ANGULAR_DAMPING = 0.6;
const CONTACT_REACH = 0.03;       // contacts are created this far ahead of touching (m)
const FLOOR_FRICTION = { foot: 1.0, other: 0.7 };
const BODY_FRICTION = 0.35;
const ANGULAR_LEVER = 0.1;        // typical lever arm (m): sets the base stiffness of angle rows
const REEL_SPEED = 2;            // fastest a string is taken in when shortened or re-tied (m/s)

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
		this.com = new Float32Array(nb * 3);
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

		this.wrapProxies = buildWrapProxies(rig.bodies);
		this._wrapFrame = [];
		this._noBodies = [];
		this._v = [0, 0, 0];
		this._build();
		this.setStrings(rig.strings);
		this.reset();
	}

	// ---------------------------------------------------------------- build

	_build() {
		const R = this.R;
		const rig = this.rig;
		const dt = this.dt;
		const o = this.opts;
		// Geometry only: this world is never stepped.
		const world = (this.world = new R.World({ x: 0, y: 0, z: 0 }));
		const solver = (this.solver = new Solver({
			dt, iterations: o.iterations, alpha: o.alpha, postStabilize: o.postStabilize, gamma: o.gamma, betaLin: o.betaLin, betaAng: o.betaAng, slack: o.slack, slackAng: o.slackAng, correctLin: o.correctLin, correctAng: o.correctAng, ratio: o.ratio, gravity: [0, -rig.gravity, 0],
		}));

		// Each body's colliders are convex hulls of the same turned pieces that are drawn
		// (puppet-shapes.js). Mass is spread evenly through them, so the centre of mass and
		// the inertia tensor are those of the real shape.
		this.pieces = [];
		this.bodies = rig.bodies.map((def, index) => {
			const rb = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(def.pos[0], def.pos[1], def.pos[2]).setCanSleep(false));
			const shapes = [];
			for (const piece of SHAPES[def.id] || []) {
				const points = surfacePoints(piece);
				const desc = R.ColliderDesc.convexHull(new Float32Array(points));
				if (!desc) continue;
				shapes.push({ collider: world.createCollider(desc.setDensity(1), rb), points });
			}
			rb.recomputeMassPropertiesFromColliders();
			const density = def.mass / rb.mass();
			for (const shape of shapes) shape.collider.setDensity(density);
			rb.recomputeMassPropertiesFromColliders();
			const com = rb.localCom();
			const inertia = rb.principalInertia();
			const frame = rb.principalInertiaLocalFrame();
			const localCom = [com.x, com.y, com.z];
			rb.setBodyType(R.RigidBodyType.KinematicPositionBased, false);

			const body = solver.addBody(def.mass, [inertia.x, inertia.y, inertia.z], [frame.x, frame.y, frame.z, frame.w], M.add(def.pos, localCom));
			const isFoot = def.id.startsWith('foot');
			let reach = 0;
			for (const shape of shapes) {
				// Hull vertices relative to the centre of mass, and a bounding sphere around them.
				const n = shape.points.length / 3;
				const verts = new Float64Array(n * 3);
				const centre = [0, 0, 0];
				for (let k = 0; k < n * 3; k++) { verts[k] = shape.points[k] - localCom[k % 3]; centre[k % 3] += verts[k] / n; }
				let radius = 0;
				for (let k = 0; k < n; k++) radius = Math.max(radius, Math.hypot(verts[k * 3] - centre[0], verts[k * 3 + 1] - centre[1], verts[k * 3 + 2] - centre[2]));
				reach = Math.max(reach, M.len(centre) + radius);
				this.pieces.push({ index: this.pieces.length, body: index, collider: shape.collider, verts, count: n, centre, radius, floorMu: isFoot ? FLOOR_FRICTION.foot : FLOOR_FRICTION.other, world: [0, 0, 0] });
			}
			return { def, rb, body, localCom, reach, collide: def.collide !== false };
		});

		const jointed = new Set();
		const invAbout = (i, axis) => { const out = [0, 0, 0]; this.bodies[i].body.invInertia(axis[0], axis[1], axis[2], out); return M.dot(out, axis); };
		this.joints = rig.joints.map((def) => {
			const a = this.bodyIx[def.a];
			const b = this.bodyIx[def.b];
			jointed.add(a < b ? a * 64 + b : b * 64 + a);
			const anchorA = M.sub(def.anchor, rig.bodies[a].pos);
			const anchorB = M.sub(def.anchor, rig.bodies[b].pos);
			const hinge = def.type === 'hinge';
			const lo = hinge ? [def.min] : def.min;
			const hi = hinge ? [def.max] : def.max;
			// The inertia the two bodies present to a torque about each joint axis. Motor gains
			// are given per unit of it ("acceleration based"), so tone feels alike on a heavy
			// thigh and a light hand.
			const inertia = lo.map((_, n) => 1 / (invAbout(a, [n === 0 ? 1 : 0, n === 1 ? 1 : 0, n === 2 ? 1 : 0]) + invAbout(b, [n === 0 ? 1 : 0, n === 1 ? 1 : 0, n === 2 ? 1 : 0])));
			const mass = 1 / (1 / rig.bodies[a].mass + 1 / rig.bodies[b].mass);
			const force = new Joint(
				a, b, M.sub(anchorA, this.bodies[a].localCom), M.sub(anchorB, this.bodies[b].localCom), hinge, lo, hi,
				mass / (dt * dt), Math.max(Math.min(...inertia), mass * (o.angularLever || ANGULAR_LEVER) ** 2) / (dt * dt)
			);
			force.mmax = def.torque;
			return { def, force, inertia, lo, hi, a, b, anchorA, anchorB, ik: null, lockTarget: null };
		});

		// Which pieces may touch: every pair of parts that are not directly jointed.
		this.pairs = [];
		for (let i = 0; i < this.bodies.length; i++) {
			for (let j = i + 1; j < this.bodies.length; j++) {
				if (jointed.has(i * 64 + j) || !this.bodies[i].collide || !this.bodies[j].collide) continue;
				const list = [];
				for (const pa of this.pieces) if (pa.body === i) for (const pb of this.pieces) if (pb.body === j) list.push([pa, pb]);
				const mass = 1 / (1 / rig.bodies[i].mass + 1 / rig.bodies[j].mass);
				this.pairs.push({ i, j, list, reach: this.bodies[i].reach + this.bodies[j].reach + CONTACT_REACH, stiffness: mass / (dt * dt) });
			}
		}
		this.contacts = new Map();
		this.forces = [];
		this._hit = null;
		this._picked = [];

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
			// The string is tied to a screw eye on the surface, not to a point inside the wood.
			const at = effectiveAttach(def, rig.bodies, this.wrapProxies);
			const restAttach = M.add(rig.bodies[body].pos, at);
			const rest = Number.isFinite(def.length) ? def.length : M.dist(restHandle, restAttach) + (def.slack || 0);
			const excluded = stringExclusions(def, at, rig.bodies, this.wrapProxies);
			const force = new StringForce(rig.bodies[body].mass / (this.dt * this.dt));
			this.strings.push({ def, body, handle, at, rest, excluded, force, local: M.sub(at, this.bodies[body].localCom), tension: 0, broken: false, over: 0, path: null });
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
		this.bodies.forEach(({ def, body, localCom }) => {
			body.x[0] = def.pos[0] + dx + localCom[0]; body.x[1] = def.pos[1] + localCom[1]; body.x[2] = def.pos[2] + dz + localCom[2];
			body.q[0] = body.q[1] = body.q[2] = 0; body.q[3] = 1;
			body.v.fill(0); body.w.fill(0); body.prevV.fill(0);
		});
		this.contacts.clear();
		for (const j of this.joints) j.force.reset();
		this.strings.forEach((s) => { s.broken = false; s.over = 0; s.tension = 0; s.force.release(); });
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
		const dt = this.dt;
		this._updateRig(dt);
		this._solveIK();
		this._applyMotors();
		this._applyEffectorForces(dt);
		this._applyBalance(dt);
		this._applyImpulses();

		const forces = this.forces;
		forces.length = 0;
		for (const j of this.joints) forces.push(j.force);
		this._routeStrings(forces);
		this._collide(forces);
		this.solver.step(forces);

		this._afterStrings(dt);
		this._readBack(false);
		this.time += dt;
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

	/** Velocity of body i's material at the world point p. */
	_pointVel(i, p) {
		const b = this.bodies[i].body;
		return b.pointVelocity(p[0] - b.x[0], p[1] - b.x[1], p[2] - b.x[2], [0, 0, 0]);
	}

	bodyCom(i) { const p = this.com; i *= 3; return [p[i], p[i + 1], p[i + 2]]; }

	/**
	 * Strings are inextensible and only ever pull: one hard, one-sided constraint on
	 * the length of the string's path, solved with everything else (avbd.js).
	 *
	 * Strings collide with the puppet. A string is a polyline handle -> via points
	 * -> attachment, where each via point rests on the surface of a limb the
	 * straight line would have cut through (string-path.js). A via point is a
	 * frictionless pulley, so a limb deflects the string and the string presses on
	 * the limb.
	 */
	_routeStrings(forces) {
		const c = this.ctl;
		const gain = c.stringGain;
		const frame = this.opts.stringCollision ? wrapFrame(this.wrapProxies, this.pos, this.quat, this._wrapFrame) : this._noBodies;
		this.strings.forEach((s, i) => {
			s.path = null;
			if (!s.def.enabled || s.broken || gain < 0.001) { s.force.release(); return; }
			const attach = M.add(this.bodyPos(s.body), M.qRot(this.bodyQuat(s.body), s.at));
			const path = stringPath(this.handleAt(s.handle), attach, frame, s.excluded);
			if (path.length < 1e-6) { s.force.release(); return; }
			s.path = path;
			const pts = path.points;
			const n = pts.length - 1;
			const nodes = [];
			for (let k = 1; k < n; k++) {
				const body = path.bodies[k];
				nodes.push({ body, local: M.qRot(M.qConj(this.bodyQuat(body)), M.sub(pts[k], this.bodyCom(body))) });
			}
			nodes.push({ body: s.body, local: s.local });
			// A string that is suddenly much too short (pulled in, or tied back on while the
			// puppet lies on the floor) is taken in at a finite speed rather than in one step.
			const target = Math.max(0.05, s.rest - c.pull[i]);
			const from = s.force.active ? s.force.rest : path.length;
			const rest = from > target ? Math.max(target, from - REEL_SPEED * this.dt) : target;
			// How much the handle's own motion and the reeling-in lengthen the path this step.
			const h = s.handle * 3, d = M.norm(M.sub(pts[1], pts[0]));
			const fresh = -(this.handleVel[h] * d[0] + this.handleVel[h + 1] * d[1] + this.handleVel[h + 2] * d[2]) * this.dt + (from > rest ? from - rest : 0);
			s.force.route(this.handleAt(s.handle), nodes, rest, s.def.max * gain, fresh);
			forces.push(s.force);
		});
	}

	_afterStrings(dt) {
		this.strings.forEach((s, i) => {
			s.tension = s.force.active ? s.force.tension : 0;
			this.tension[i] = s.tension;
			if (s.def.breakable && s.force.active && s.tension >= s.force.max * 0.98) {
				s.over += dt;
				if (s.over > 0.2) s.broken = true;
			} else {
				s.over = 0;
			}
		});
	}

	// ------------------------------------------------------------- contacts

	/** Pushes the solver's body poses into the geometry world. */
	_syncGeometry() {
		const t = this._t || (this._t = { x: 0, y: 0, z: 0 });
		const r = this._r || (this._r = { x: 0, y: 0, z: 0, w: 1 });
		for (const { rb, body, localCom } of this.bodies) {
			const c = M.qRot(body.q, localCom);
			t.x = body.x[0] - c[0]; t.y = body.x[1] - c[1]; t.z = body.x[2] - c[2];
			r.x = body.q[0]; r.y = body.q[1]; r.z = body.q[2]; r.w = body.q[3];
			rb.setTranslation(t, false);
			rb.setRotation(r, false);
		}
		this.world.propagateModifiedBodyPositionsToColliders();
	}

	/**
	 * Finds this step's contacts. A contact is created a little before the surfaces
	 * touch and only starts pushing if they would cross during the step, so fast
	 * limbs cannot pass through each other between two steps.
	 */
	_collide(forces) {
		const contacts = this.contacts;
		for (const c of contacts.values()) c.used = false;
		this._syncGeometry();

		// Piece centres in the world.
		for (const p of this.pieces) {
			const b = this.bodies[p.body].body;
			const w = M.qRot(b.q, p.centre);
			p.world[0] = b.x[0] + w[0]; p.world[1] = b.x[1] + w[1]; p.world[2] = b.x[2] + w[2];
		}

		// Floor (the plane y = 0): the lowest hull vertices of each piece near it.
		const stiffness = (i) => this.rig.bodies[i].mass / (this.dt * this.dt);
		for (const p of this.pieces) {
			if (p.world[1] - p.radius > CONTACT_REACH) continue;
			const b = this.bodies[p.body].body;
			const picked = this._lowest(p, b);
			for (const vi of picked) {
				const key = 100000 + p.index * 1024 + vi;
				let c = contacts.get(key);
				const o = vi * 3;
				if (!c) {
					c = new Contact(p.body, -1, stiffness(p.body));
					c.setNormal(0, 1, 0);
					c.rA[0] = p.verts[o]; c.rA[1] = p.verts[o + 1]; c.rA[2] = p.verts[o + 2];
					c.mu = p.floorMu;
					contacts.set(key, c);
				}
				if (!c.stick) {
					// Not held by static friction: friction acts against this step's sliding only.
					const w = M.qRot(b.q, [p.verts[o], p.verts[o + 1], p.verts[o + 2]]);
					c.rB[0] = b.x[0] + w[0]; c.rB[1] = 0; c.rB[2] = b.x[2] + w[2];
				}
				c.used = true;
			}
		}

		// Puppet against itself: closest points between the hulls of nearby pieces.
		this._hit = this._hit || new this.R.ShapeContact(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
		const v = this._v;
		for (const pair of this.pairs) {
			const A = this.bodies[pair.i].body, B = this.bodies[pair.j].body;
			const dx = A.x[0] - B.x[0], dy = A.x[1] - B.x[1], dz = A.x[2] - B.x[2];
			if (dx * dx + dy * dy + dz * dz > pair.reach * pair.reach) continue;
			for (const [pa, pb] of pair.list) {
				const ex = pa.world[0] - pb.world[0], ey = pa.world[1] - pb.world[1], ez = pa.world[2] - pb.world[2];
				const reach = pa.radius + pb.radius + CONTACT_REACH;
				if (ex * ex + ey * ey + ez * ez > reach * reach) continue;
				const hit = pa.collider.contactCollider(pb.collider, CONTACT_REACH, this._hit);
				if (!hit) continue;
				const key = pa.index * 64 + pb.index;
				let c = contacts.get(key);
				if (!c) {
					c = new Contact(pair.i, pair.j, pair.stiffness);
					c.mu = BODY_FRICTION;
					contacts.set(key, c);
				}
				// The normal points from B to A; contact points are stored in each body's own frame.
				c.setNormal(-hit.normal1.x, -hit.normal1.y, -hit.normal1.z);
				rotInvInto(A.q, hit.point1.x - A.x[0], hit.point1.y - A.x[1], hit.point1.z - A.x[2], c.rA);
				rotInvInto(B.q, hit.point2.x - B.x[0], hit.point2.y - B.x[1], hit.point2.z - B.x[2], c.rB);
				c.depth = -hit.distance;
				c.used = true;
			}
		}

		for (const [key, c] of contacts) {
			if (c.used) forces.push(c); else contacts.delete(key);
		}
	}

	/**
	 * Up to four hull vertices of a piece at or near the floor. Vertices that carried a
	 * contact last step are kept while they stay near the floor, so a resting foot keeps
	 * the same contacts (and their forces) from step to step; the deepest vertex is always
	 * included, and the rest are chosen well apart.
	 */
	_lowest(p, b) {
		const q = b.q;
		// Second row of the rotation matrix: world height of a local vector.
		const rx = 2 * (q[0] * q[1] + q[2] * q[3]), ry = 1 - 2 * (q[0] * q[0] + q[2] * q[2]), rz = 2 * (q[1] * q[2] - q[0] * q[3]);
		const verts = p.verts, near = this._near || (this._near = []);
		const height = (k) => b.x[1] + rx * verts[k * 3] + ry * verts[k * 3 + 1] + rz * verts[k * 3 + 2];
		near.length = 0;
		let deepest = -1, low = Infinity;
		for (let k = 0; k < p.count; k++) {
			const y = height(k);
			if (y > CONTACT_REACH) continue;
			near.push(k);
			if (y < low) { low = y; deepest = k; }
		}
		const picked = this._picked;
		picked.length = 0;
		const kept = p.kept || (p.kept = []);
		if (deepest < 0) { kept.length = 0; return picked; }
		let lowestKept = Infinity;
		for (const k of kept) {
			const y = height(k);
			if (y > CONTACT_REACH) continue;
			picked.push(k);
			lowestKept = Math.min(lowestKept, y);
		}
		const apart = (k) => {
			let d = Infinity;
			for (const m of picked) {
				const ax = verts[k * 3] - verts[m * 3], ay = verts[k * 3 + 1] - verts[m * 3 + 1], az = verts[k * 3 + 2] - verts[m * 3 + 2];
				d = Math.min(d, ax * ax + ay * ay + az * az);
			}
			return d;
		};
		// The deepest vertex joins if it is clearly deeper than anything kept; it replaces its nearest neighbour when full.
		if (low < lowestKept - 0.0005 && !picked.includes(deepest)) {
			if (picked.length >= 4) {
				let nearest = 0, best = Infinity;
				picked.forEach((m, n) => {
					const ax = verts[deepest * 3] - verts[m * 3], ay = verts[deepest * 3 + 1] - verts[m * 3 + 1], az = verts[deepest * 3 + 2] - verts[m * 3 + 2];
					const d = ax * ax + ay * ay + az * az;
					if (d < best) { best = d; nearest = n; }
				});
				picked[nearest] = deepest;
			} else {
				picked.push(deepest);
			}
		}
		while (picked.length < 4) {
			let best = -1, far = 0.012 * 0.012;
			for (const k of near) {
				const d = apart(k);
				if (d > far) { far = d; best = k; }
			}
			if (best < 0) break;
			picked.push(best);
		}
		kept.length = 0;
		for (const k of picked) kept.push(k);
		return picked;
	}

	// ------------------------------------------------------------- IK + motors

	_relQuat(j) {
		let q = M.qMul(M.qConj(this.bodyQuat(j.a)), this.bodyQuat(j.b));
		if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
		return q;
	}

	/** Current joint angles: a hinge's turn about X, or a ball joint's rotation vector. */
	jointAngles(j) {
		return jointAngles(this._relQuat(j), j.def.type === 'hinge');
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
			root.ik = { w: target.w, target: jointAngles(q) };
			e.mid.ik = { w: target.w, target: [e.def.bend * flex] };
		});
	}

	_applyMotors() {
		const c = this.ctl;
		this.joints.forEach((j, i) => {
			const def = j.def;
			const force = j.force;
			const tone = c.tone[def.group] ?? 1;
			let target;
			let k = def.stiffness * tone;
			let d = def.damping * tone;

			if (c.locks[i]) {
				// Locking narrows the joint's limits to its current pose: a hard stop, not a stiff spring.
				if (!j.lockTarget) j.lockTarget = this.jointAngles(j);
				target = j.lockTarget;
				k = 900; d = 60;
			} else {
				j.lockTarget = null;
				if (j.ik) {
					target = j.ik.target;
					k += 260 * j.ik.w; d += 28 * j.ik.w;
				} else if (c.jointTarget[i]) {
					target = c.jointTarget[i];
					k += 240; d += 26;
				}
			}

			for (let n = 0; n < force.n; n++) {
				const lo = j.lockTarget ? j.lockTarget[n] - 0.015 : j.lo[n];
				const hi = j.lockTarget ? j.lockTarget[n] + 0.015 : j.hi[n];
				force.lo[n] = lo; force.hi[n] = hi;
				force.mt[n] = target ? M.clamp(target[n] || 0, lo, hi) : 0;
				force.mk[n] = k * j.inertia[n];
				force.mc[n] = d * j.inertia[n];
			}
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
			const p = this.pointAt(e.tipBody, e.def.tip);
			const S = this.pointAt(e.root.a, e.root.anchorA);
			const rel = M.sub(this._pointVel(e.tipBody, p), this._pointVel(e.anchorBody, S));
			let F = M.scale(M.sub(M.scale(M.sub(target.pos, p), w0 * w0), M.scale(rel, 1.8 * w0)), e.def.mass * target.w);
			F = M.clampLen(F, e.def.force * target.w);
			const J = M.scale(F, dt);
			tip.applyImpulse(J[0], J[1], J[2], p[0], p[1], p[2]);
			anchor.applyImpulse(-J[0], -J[1], -J[2], S[0], S[1], S[2]);
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
			const av = body.w;
			const inertia = def.mass * 0.05;
			const torque = M.clampLen([
				inertia * (70 * err[0] - 12 * av[0]),
				inertia * (70 * err[1] - 12 * av[1]),
				inertia * (70 * err[2] - 12 * av[2]),
			], 26);
			body.applyTorqueImpulse(torque[0] * amount * dt, torque[1] * amount * dt, torque[2] * amount * dt);
		}
		// Calm the pendulum swing under the bar.
		const chest = this.bodies[this.bodyIx.chest].body;
		const bar = this.bars[0].vel;
		const drag = (this.totalMass * 1.3 * amount * dt) / chest.mass;
		chest.v[0] -= (chest.v[0] - bar[0]) * drag;
		chest.v[2] -= (chest.v[2] - bar[2]) * drag;
	}

	_applyImpulses() {
		const list = this.ctl.impulses;
		for (const item of list) {
			const i = typeof item.body === 'number' ? item.body : this.bodyIx[item.body];
			const body = this.bodies[i] && this.bodies[i].body;
			if (!body) continue;
			if (item.impulse) { const J = M.clampLen(item.impulse, 6); body.applyImpulse(J[0], J[1], J[2], body.x[0], body.x[1], body.x[2]); }
			if (item.torque) { const T = M.clampLen(item.torque, 1.5); body.applyTorqueImpulse(T[0], T[1], T[2]); }
		}
		list.length = 0;
	}

	/**
	 * How far any two parts of the puppet currently overlap, in metres (0 when none do),
	 * and which pair is worst. For tests and on-stage diagnostics.
	 */
	deepestOverlap() {
		this._syncGeometry();
		let depth = 0, pair = null;
		for (const item of this.pairs) {
			const A = this.bodies[item.i].body, B = this.bodies[item.j].body;
			const dx = A.x[0] - B.x[0], dy = A.x[1] - B.x[1], dz = A.x[2] - B.x[2];
			if (dx * dx + dy * dy + dz * dz > item.reach * item.reach) continue;
			for (const [pa, pb] of item.list) {
				const hit = pa.collider.contactCollider(pb.collider, 0, this._hit);
				if (hit && -hit.distance > depth) { depth = -hit.distance; pair = [this.rig.bodies[item.i].id, this.rig.bodies[item.j].id]; }
			}
		}
		return { depth, pair };
	}

	/** Largest gap between any joint's two anchor points, in metres. */
	jointGap() {
		let gap = 0;
		for (const j of this.joints) gap = Math.max(gap, j.force.gap(this.solver));
		return gap;
	}

	/** Speed of the fastest body, m/s. */
	maxSpeed() {
		let m = 0;
		for (const { body } of this.bodies) m = Math.max(m, Math.hypot(body.v[0], body.v[1], body.v[2]));
		return m;
	}

	// ----------------------------------------------------------- read back

	_readBack(snap) {
		this.prevPos.set(this.pos);
		this.prevQuat.set(this.quat);
		const dt = this.dt;
		const lin = 1 / (1 + dt * LINEAR_DAMPING), ang = 1 / (1 + dt * ANGULAR_DAMPING);
		let broken = false;
		this.bodies.forEach(({ body, localCom }, i) => {
			const x = body.x, q = body.q;
			if (!Number.isFinite(x[0] + x[1] + x[2] + q[0] + q[3]) || Math.abs(x[0]) > 40 || Math.abs(x[1]) > 40 || Math.abs(x[2]) > 40) {
				broken = true;
				return;
			}
			const c = M.qRot(q, localCom);
			this.pos[i * 3] = x[0] - c[0]; this.pos[i * 3 + 1] = x[1] - c[1]; this.pos[i * 3 + 2] = x[2] - c[2];
			this.quat[i * 4] = q[0]; this.quat[i * 4 + 1] = q[1]; this.quat[i * 4 + 2] = q[2]; this.quat[i * 4 + 3] = q[3];
			this.com[i * 3] = x[0]; this.com[i * 3 + 1] = x[1]; this.com[i * 3 + 2] = x[2];
			if (snap) return;
			const v = body.v, w = body.w;
			const ls = Math.hypot(v[0], v[1], v[2]);
			const sl = ls > MAX_LINVEL ? (MAX_LINVEL / ls) * lin : lin;
			v[0] *= sl; v[1] *= sl; v[2] *= sl;
			const as = Math.hypot(w[0], w[1], w[2]);
			const sa = as > MAX_ANGVEL ? (MAX_ANGVEL / as) * ang : ang;
			w[0] *= sa; w[1] *= sa; w[2] *= sa;
		});
		if (snap) { this.prevPos.set(this.pos); this.prevQuat.set(this.quat); }
		if (broken && !snap) this.reset();
	}
}

/** out = conj(q) * v * q */
function rotInvInto(q, x, y, z, out) {
	const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
	const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
	out[0] = x + qw * tx + (qy * tz - qz * ty);
	out[1] = y + qw * ty + (qz * tx - qx * tz);
	out[2] = z + qw * tz + (qx * ty - qy * tx);
}
