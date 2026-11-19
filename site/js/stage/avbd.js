// Augmented Vertex Block Descent for rigid bodies.
//
// An implementation of "Augmented Vertex Block Descent" (Giles, Diaz, Yuksel,
// ACM Transactions on Graphics 44(4), SIGGRAPH 2025), following the paper and
// the first author's reference solver (avbd-demo3d, MIT licence).
//
// One implicit-Euler step is posed as a minimisation over all body positions.
// It is solved by Gauss-Seidel sweeps: each body in turn takes one Newton step
// on its own 6x6 block (the primal update), then every constraint updates its
// Lagrange multiplier and ramps its penalty stiffness (the dual update). Hard
// constraints — joints, joint limits, contacts, inextensible strings — and soft
// forces — the puppet's muscle tone — all live in that one solve, so a string
// pulling on an arm, the elbow's limit and the arm resting on a leg are
// resolved against each other rather than one after another.
//
// Everything here is plain numbers: no DOM, no Three.js, no physics engine.

const MAX_MOVE = 0.2;            // largest change of a body's position in one Newton step (m)
const MAX_TURN = 0.6;            // ... and of its orientation (rad)
const STICK_THRESHOLD = 1e-4;   // tangential drift (m) under which a contact counts as sticking

// ---------------------------------------------------------------- small maths

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function rot(q, x, y, z, out, o = 0) {
	const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
	const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
	out[o] = x + qw * tx + (qy * tz - qz * ty);
	out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
	out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

function rotInv(q, x, y, z, out, o = 0) {
	const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
	const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
	out[o] = x + qw * tx + (qy * tz - qz * ty);
	out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
	out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/** q <- normalise(q + 0.5 * (w, 0) * q): turn q by the world-frame rotation vector w. */
function turn(q, wx, wy, wz, out) {
	const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
	let x = qx + 0.5 * (wx * qw + wy * qz - wz * qy);
	let y = qy + 0.5 * (wy * qw + wz * qx - wx * qz);
	let z = qz + 0.5 * (wz * qw + wx * qy - wy * qx);
	let w = qw - 0.5 * (wx * qx + wy * qy + wz * qz);
	const n = 1 / Math.hypot(x, y, z, w);
	out[0] = x * n; out[1] = y * n; out[2] = z * n; out[3] = w * n;
}

/** The world-frame rotation vector that takes b to a (small-angle form, as in the paper). */
function rotDiff(a, b, out) {
	const bx = -b[0], by = -b[1], bz = -b[2], bw = b[3];
	const ax = a[0], ay = a[1], az = a[2], aw = a[3];
	let x = aw * bx + ax * bw + ay * bz - az * by;
	let y = aw * by - ax * bz + ay * bw + az * bx;
	let z = aw * bz + ax * by - ay * bx + az * bw;
	const w = aw * bw - ax * bx - ay * by - az * bz;
	const s = w < 0 ? -2 : 2;
	out[0] = x * s; out[1] = y * s; out[2] = z * s;
}

const J = new Float64Array(6);

/** Stamps one constraint row into a body's system: H += k * j * j^T, g += j * f. */
function addRow(H, g, lx, ly, lz, ax, ay, az, k, f) {
	J[0] = lx; J[1] = ly; J[2] = lz; J[3] = ax; J[4] = ay; J[5] = az;
	for (let r = 0; r < 6; r++) {
		const jr = J[r];
		if (jr === 0) continue;
		g[r] += jr * f;
		const kr = k * jr, o = r * 6;
		H[o] += kr * J[0]; H[o + 1] += kr * J[1]; H[o + 2] += kr * J[2];
		H[o + 3] += kr * J[3]; H[o + 4] += kr * J[4]; H[o + 5] += kr * J[5];
	}
}

/**
 * The second-order ("geometric stiffness") term of a force F acting at lever arm r,
 * lumped onto the diagonal as the paper does: column norms of r * F^T - (r . F) * I.
 */
function addGeometric(H, rx, ry, rz, fx, fy, fz) {
	const rf = rx * fx + ry * fy + rz * fz;
	const rr = rx * rx + ry * ry + rz * rz;
	H[21] += Math.sqrt(Math.max(0, rr * fx * fx - 2 * rf * rx * fx + rf * rf));
	H[28] += Math.sqrt(Math.max(0, rr * fy * fy - 2 * rf * ry * fy + rf * rf));
	H[35] += Math.sqrt(Math.max(0, rr * fz * fz - 2 * rf * rz * fz + rf * rf));
}

const L = new Float64Array(36), D = new Float64Array(6), Y = new Float64Array(6);

/** Solves the symmetric positive-definite 6x6 system A x = b by LDL^T. */
function solve6(A, b, x) {
	for (let j = 0; j < 6; j++) {
		let d = A[j * 6 + j];
		for (let k = 0; k < j; k++) d -= L[j * 6 + k] * L[j * 6 + k] * D[k];
		D[j] = d > 1e-12 ? d : 1e-12;
		for (let i = j + 1; i < 6; i++) {
			let s = A[i * 6 + j];
			for (let k = 0; k < j; k++) s -= L[i * 6 + k] * L[j * 6 + k] * D[k];
			L[i * 6 + j] = s / D[j];
		}
	}
	for (let i = 0; i < 6; i++) {
		let s = b[i];
		for (let k = 0; k < i; k++) s -= L[i * 6 + k] * Y[k];
		Y[i] = s;
	}
	for (let i = 5; i >= 0; i--) {
		let s = Y[i] / D[i];
		for (let k = i + 1; k < 6; k++) s -= L[k * 6 + i] * x[k];
		x[i] = s;
	}
}


// --------------------------------------------------------------------- bodies

export class Body {
	/**
	 * @param mass      kg
	 * @param inertia   principal moments of inertia [x, y, z]
	 * @param frame     rotation of the principal axes in the body's frame (quaternion)
	 * @param x         world position of the centre of mass
	 */
	constructor(index, mass, inertia, frame, x) {
		this.index = index;
		this.mass = mass;
		this.inertia = inertia;
		this.frame = frame;
		this.x = Float64Array.from(x);
		this.q = Float64Array.of(0, 0, 0, 1);
		this.v = new Float64Array(3);
		this.w = new Float64Array(3);
		this.prevV = new Float64Array(3);
		this.x0 = new Float64Array(3);    // start of step
		this.q0 = Float64Array.of(0, 0, 0, 1);
		this.y = new Float64Array(3);     // inertial target
		this.qy = Float64Array.of(0, 0, 0, 1);
		this.Iw = new Float64Array(9);    // world-frame inertia tensor
		this.forces = [];
	}

	/** Refreshes the world-frame inertia tensor R * diag(I) * R^T for the current orientation. */
	updateInertia() {
		const f = this.frame, q = this.q;
		// principal frame in the world: q * frame
		const x = q[3] * f[0] + q[0] * f[3] + q[1] * f[2] - q[2] * f[1];
		const y = q[3] * f[1] - q[0] * f[2] + q[1] * f[3] + q[2] * f[0];
		const z = q[3] * f[2] + q[0] * f[1] - q[1] * f[0] + q[2] * f[3];
		const w = q[3] * f[3] - q[0] * f[0] - q[1] * f[1] - q[2] * f[2];
		const R = SCRATCH_R;
		R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w);
		R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w);
		R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y);
		const I = this.inertia, Iw = this.Iw;
		for (let r = 0; r < 3; r++) {
			for (let c = r; c < 3; c++) {
				const v = R[r * 3] * I[0] * R[c * 3] + R[r * 3 + 1] * I[1] * R[c * 3 + 1] + R[r * 3 + 2] * I[2] * R[c * 3 + 2];
				Iw[r * 3 + c] = v; Iw[c * 3 + r] = v;
			}
		}
	}

	/** out = I_world^-1 * t */
	invInertia(tx, ty, tz, out) {
		const f = this.frame, q = this.q;
		const x = q[3] * f[0] + q[0] * f[3] + q[1] * f[2] - q[2] * f[1];
		const y = q[3] * f[1] - q[0] * f[2] + q[1] * f[3] + q[2] * f[0];
		const z = q[3] * f[2] + q[0] * f[1] - q[1] * f[0] + q[2] * f[3];
		const w = q[3] * f[3] - q[0] * f[0] - q[1] * f[1] - q[2] * f[2];
		SCRATCH_Q[0] = x; SCRATCH_Q[1] = y; SCRATCH_Q[2] = z; SCRATCH_Q[3] = w;
		rotInv(SCRATCH_Q, tx, ty, tz, SCRATCH_V);
		const I = this.inertia;
		rot(SCRATCH_Q, SCRATCH_V[0] / I[0], SCRATCH_V[1] / I[1], SCRATCH_V[2] / I[2], out);
	}

	/** Applies an impulse (N·s) at a world point: an instantaneous change of velocity. */
	applyImpulse(jx, jy, jz, px, py, pz) {
		const im = 1 / this.mass;
		this.v[0] += jx * im; this.v[1] += jy * im; this.v[2] += jz * im;
		const rx = px - this.x[0], ry = py - this.x[1], rz = pz - this.x[2];
		this.applyTorqueImpulse(ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx);
	}

	applyTorqueImpulse(tx, ty, tz) {
		this.invInertia(tx, ty, tz, SCRATCH_W);
		this.w[0] += SCRATCH_W[0]; this.w[1] += SCRATCH_W[1]; this.w[2] += SCRATCH_W[2];
	}

	/** Velocity of the body's material at lever arm r from its centre of mass. */
	pointVelocity(rx, ry, rz, out) {
		const w = this.w, v = this.v;
		out[0] = v[0] + w[1] * rz - w[2] * ry;
		out[1] = v[1] + w[2] * rx - w[0] * rz;
		out[2] = v[2] + w[0] * ry - w[1] * rx;
		return out;
	}
}

const SCRATCH_R = new Float64Array(9), SCRATCH_Q = new Float64Array(4), SCRATCH_V = new Float64Array(3), SCRATCH_W = new Float64Array(3);

// --------------------------------------------------------------------- solver

export class Solver {
	constructor(opts = {}) {
		this.dt = opts.dt ?? 1 / 120;
		this.iterations = opts.iterations ?? 10;
		// Stabilisation. With postStabilize (the default, as in the authors' newer reference
		// code) the main iterations leave any error already present at the start of the step
		// alone, velocities are taken from that, and one extra sweep then removes the error
		// from the positions only — so correcting drift never adds speed. Without it,
		// `stabilisation` is the paper's alpha: the share of existing error left for later.
		this.postStabilize = opts.postStabilize ?? true;
		this.stabilisation = opts.alpha ?? 0.99;
		this.alpha = 1;      // the value in force during the current sweep
		// Optionally, error already present may also be worked off inside the main
		// iterations at up to this speed (m/s, rad/s). Off by default: any such correction
		// shows up as velocity, and a puppet standing still starts to fidget.
		// A penalty starts at a stiffness comparable to the bodies' own inertia (mass / dt^2)
		// and may ramp up to this many times that.
		this.ratio = opts.ratio ?? 1000;
		this.correctLin = opts.correctLin ?? 0;
		this.correctAng = opts.correctAng ?? 0;
		this.decay = 1;      // warm-start factor for multipliers
		// Penalty ramp per unit of constraint error and iteration, for lengths and angles.
		this.betaLin = opts.betaLin ?? 1e6;
		this.betaAng = opts.betaAng ?? 300;
		// Decay of multipliers and penalties from one step to the next (warm start).
		this.gamma = opts.gamma ?? 0.99;
		// Optional release rule for one-sided constraints: on the opening side the penalty is
		// taken as at least lambda / slack, so the force is gone within that much slack
		// (metres, radians). Off by default: at 240 Hz the base penalties are stiff enough,
		// and on joint limits the rule made the multiplier flip on and off from sweep to sweep.
		this.slack = opts.slack ?? Infinity;
		this.slackAng = opts.slackAng ?? Infinity;
		// Joint-limit multipliers take only this share of each update. A limit sits between
		// two bodies that both give way to it within one sweep, so a full update overshoots
		// and the multiplier alternates high / low from sweep to sweep — the result then
		// depended on whether the number of sweeps was odd or even.
		this.limitRelax = opts.limitRelax ?? 0.35;
		this.gravity = opts.gravity ?? [0, -9.81, 0];
		this.bodies = [];
		this.active = [];
		this.H = new Float64Array(36);
		this.g = new Float64Array(6);
		this.dx = new Float64Array(6);
	}

	/** The part of a start-of-step error that the main iterations leave in place. */
	keepLin(c) {
		if (!this.postStabilize) return c;
		const most = this.correctLin * this.dt;
		return c > most ? c - most : c < -most ? c + most : 0;
	}

	keepAng(c) {
		if (!this.postStabilize) return c;
		const most = this.correctAng * this.dt;
		return c > most ? c - most : c < -most ? c + most : 0;
	}

	addBody(mass, inertia, frame, x) {
		const body = new Body(this.bodies.length, mass, inertia, frame, x);
		this.bodies.push(body);
		return body;
	}

	/** Advances the bodies by one step under the given forces (constraints). */
	step(forces) {
		const dt = this.dt, bodies = this.bodies, active = this.active;
		const gx = this.gravity[0], gy = this.gravity[1], gz = this.gravity[2];
		const gLen = Math.hypot(gx, gy, gz);

		this.alpha = this.postStabilize ? 1 : this.stabilisation;
		this.decay = this.postStabilize ? this.gamma : this.stabilisation * this.gamma;

		// Initialise and warm-start the forces; an inactive one drops out of this step.
		active.length = 0;
		for (const b of bodies) b.forces.length = 0;
		for (const f of forces) {
			if (!f.init(this)) continue;
			active.push(f);
			for (const i of f.bodies) if (i >= 0) bodies[i].forces.push(f);
		}

		// Inertial targets and warm-started positions.
		for (const b of bodies) {
			b.updateInertia();
			const x = b.x, v = b.v, w = b.w;
			b.y[0] = x[0] + v[0] * dt + gx * dt * dt;
			b.y[1] = x[1] + v[1] * dt + gy * dt * dt;
			b.y[2] = x[2] + v[2] * dt + gz * dt * dt;
			turn(b.q, w[0] * dt, w[1] * dt, w[2] * dt, b.qy);

			// Adaptive warm start (Vertex Block Descent): start with as much of gravity's
			// displacement as the body actually fell by last step.
			let weight = 0;
			if (gLen > 0) {
				const along = ((v[0] - b.prevV[0]) * gx + (v[1] - b.prevV[1]) * gy + (v[2] - b.prevV[2]) * gz) / (dt * gLen);
				weight = clamp(along / gLen, 0, 1);
				if (!Number.isFinite(weight)) weight = 0;
			}
			b.x0.set(x); b.q0.set(b.q);
			x[0] += v[0] * dt + gx * weight * dt * dt;
			x[1] += v[1] * dt + gy * weight * dt * dt;
			x[2] += v[2] * dt + gz * weight * dt * dt;
			b.q.set(b.qy);
		}

		for (let it = 0; it < this.iterations; it++) {
			this._primal();
			// Dual update: multipliers and penalties.
			for (let k = 0; k < active.length; k++) active[k].dual(this);
		}

		// Velocities from the change in position (BDF1).
		const dx = this.dx;
		for (const b of bodies) {
			b.prevV.set(b.v);
			b.v[0] = (b.x[0] - b.x0[0]) / dt; b.v[1] = (b.x[1] - b.x0[1]) / dt; b.v[2] = (b.x[2] - b.x0[2]) / dt;
			rotDiff(b.q, b.q0, dx);
			b.w[0] = dx[0] / dt; b.w[1] = dx[1] / dt; b.w[2] = dx[2] / dt;
		}

		// Post-stabilisation: one more sweep that removes leftover error from positions only.
		if (this.postStabilize) {
			this.alpha = 0;
			this._primal();
		}
		for (let k = 0; k < active.length; k++) if (active[k].finish) active[k].finish(this);
	}

	/** Primal update: one Newton step per body on its own block. */
	_primal() {
		const H = this.H, g = this.g, dx = this.dx;
		const inv = 1 / (this.dt * this.dt);
		for (const b of this.bodies) {
			H.fill(0);
			const m = b.mass * inv, Iw = b.Iw;
			H[0] = H[7] = H[14] = m;
			H[21] = Iw[0] * inv; H[22] = Iw[1] * inv; H[23] = Iw[2] * inv;
			H[27] = Iw[3] * inv; H[28] = Iw[4] * inv; H[29] = Iw[5] * inv;
			H[33] = Iw[6] * inv; H[34] = Iw[7] * inv; H[35] = Iw[8] * inv;
			g[0] = m * (b.x[0] - b.y[0]); g[1] = m * (b.x[1] - b.y[1]); g[2] = m * (b.x[2] - b.y[2]);
			rotDiff(b.q, b.qy, dx);
			g[3] = H[21] * dx[0] + H[22] * dx[1] + H[23] * dx[2];
			g[4] = H[27] * dx[0] + H[28] * dx[1] + H[29] * dx[2];
			g[5] = H[33] * dx[0] + H[34] * dx[1] + H[35] * dx[2];

			const list = b.forces;
			for (let k = 0; k < list.length; k++) list[k].primal(this, b.index, H, g);

			g[0] = -g[0]; g[1] = -g[1]; g[2] = -g[2]; g[3] = -g[3]; g[4] = -g[4]; g[5] = -g[5];
			solve6(H, g, dx);
			// A Newton step far beyond what the linearisation is good for is cut short.
			const move = Math.hypot(dx[0], dx[1], dx[2]), spin = Math.hypot(dx[3], dx[4], dx[5]);
			if (!(move + spin < Infinity)) continue;
			const sm = move > MAX_MOVE ? MAX_MOVE / move : 1, st = spin > MAX_TURN ? MAX_TURN / spin : 1;
			b.x[0] += dx[0] * sm; b.x[1] += dx[1] * sm; b.x[2] += dx[2] * sm;
			turn(b.q, dx[3] * st, dx[4] * st, dx[5] * st, b.q);
		}
	}
}

// --------------------------------------------------------------------- joints

const TWO_PI = Math.PI * 2;

/**
 * The joint angles of a relative rotation q = qA^-1 * qB: for a hinge its turn about X,
 * for a ball its rotation vector (axis * angle).
 */
export function jointAngles(q, hinge = false) {
	let x = q[0], y = q[1], z = q[2], w = q[3];
	if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
	if (hinge) return [2 * Math.atan2(x, w)];
	const sn = Math.hypot(x, y, z);
	const scale = sn > 1e-9 ? (2 * Math.atan2(sn, w)) / sn : 2;
	return [x * scale, y * scale, z * scale];
}

/**
 * A ball or hinge joint between two bodies, with angle limits and a motor.
 *
 * Rows: three hard point rows (the anchors coincide); for a hinge two more hard
 * rows (the bodies only turn about the shared X axis); then per free angle a
 * hard two-sided limit and a soft motor (a spring and damper towards a target,
 * capped at a maximum torque). Angles follow the relative rotation
 * q = qA^-1 * qB: a hinge's angle is its turn about X; a ball joint's three
 * angles are q's rotation vector (axis * angle), which has no awkward poses short
 * of a full turn. Both are followed continuously past half a turn.
 */
export class Joint {
	constructor(a, b, rA, rB, hinge, lo, hi, stiffLin, stiffAng) {
		this.bodies = [a, b];
		this.a = a; this.b = b;
		this.rA = rA; this.rB = rB;
		this.hinge = hinge;
		const n = (this.n = hinge ? 1 : 3);
		this.lo = lo.slice(); this.hi = hi.slice();
		// Penalties never decay below a stiffness comparable to the bodies' own inertia.
		this.minLin = stiffLin; this.minAng = stiffAng;
		this.kLin = [stiffLin, stiffLin, stiffLin]; this.lamLin = [0, 0, 0]; this.C0Lin = [0, 0, 0];
		this.kAng = [stiffAng, stiffAng]; this.lamAng = [0, 0]; this.C0Ang = [0, 0];
		this.kLim = new Array(n).fill(stiffAng); this.lamLim = new Array(n).fill(0); this.C0Lim = new Array(n).fill(0);
		// Motor: stiffness (N·m/rad), damping (N·m·s/rad), target angle, torque cap.
		this.mk = new Array(n).fill(0); this.mc = new Array(n).fill(0); this.mt = new Array(n).fill(0); this.mmax = 0;
		this.th0 = new Array(n).fill(0);
		// Scratch, refreshed by eval().
		this.rAw = new Float64Array(3); this.rBw = new Float64Array(3);
		this.C = new Float64Array(3);
		this.th = new Float64Array(n); this.grad = new Float64Array(n * 3);
		this.c = new Float64Array(2); this.gradC = new Float64Array(6);
		this.curve = new Float64Array(n);     // bound on each angle's second derivative
		// Start-of-step reference that keeps the angles continuous: the hinge angle, or the
		// relative rotation (with its sign) for a ball.
		this.ref = hinge ? [0] : [0, 0, 0, 1];
	}

	eval(s) {
		const A = s.bodies[this.a], B = s.bodies[this.b];
		const rA = this.rA, rB = this.rB, rAw = this.rAw, rBw = this.rBw;
		rot(A.q, rA[0], rA[1], rA[2], rAw);
		rot(B.q, rB[0], rB[1], rB[2], rBw);
		this.C[0] = A.x[0] + rAw[0] - B.x[0] - rBw[0];
		this.C[1] = A.x[1] + rAw[1] - B.x[1] - rBw[1];
		this.C[2] = A.x[2] + rAw[2] - B.x[2] - rBw[2];

		// Relative rotation q = conj(qA) * qB, with w >= 0.
		const a = A.q, b = B.q;
		let x = a[3] * b[0] - a[0] * b[3] - a[1] * b[2] + a[2] * b[1];
		let y = a[3] * b[1] + a[0] * b[2] - a[1] * b[3] - a[2] * b[0];
		let z = a[3] * b[2] - a[0] * b[1] + a[1] * b[0] - a[2] * b[3];
		let w = a[3] * b[3] + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

		const grad = this.grad;
		if (this.hinge) {
			// With u the relative angular velocity in B's frame, dq/dt = 0.5 * q * (u, 0), so
			// d(q.i) = 0.5 * (w * e_i + e_i x v) . u and d(q.w) = -0.5 * v . u, v = (x, y, z).
			if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
			const n2 = x * x + w * w || 1e-12;
			// Angle about X: 2*atan2(x, w), kept continuous across +-180 degrees by following
			// the value it had at the start of the step.
			let t0 = 2 * Math.atan2(x, w);
			t0 += TWO_PI * Math.round((this.ref[0] - t0) / TWO_PI);
			this.th[0] = t0;
			this.curve[0] = 0.5;
			rot(b, (w * w + x * x) / n2, (w * -z + x * y) / n2, (w * y + x * z) / n2, grad, 0);
			// The other two components must stay zero.
			this.c[0] = 2 * y; this.c[1] = 2 * z;
			rot(b, z, w, -x, this.gradC, 0);
			rot(b, -y, x, w, this.gradC, 3);
			return;
		}
		// Ball: the angles are the rotation vector phi of q (axis * angle, in A's frame). It
		// is smooth all the way to a full turn, provided q keeps the sign it had at the start
		// of the step (q and -q are the same rotation, but phi continues through half a turn).
		const r = this.ref;
		if (x * r[0] + y * r[1] + z * r[2] + w * r[3] < 0) { x = -x; y = -y; z = -z; w = -w; }
		this.qx = x; this.qy = y; this.qz = z; this.qw = w;
		const sn = Math.hypot(x, y, z);
		const angle = Math.min(2 * Math.atan2(sn, w), 5.6);
		const scale = sn > 1e-9 ? angle / sn : 2;
		const px = x * scale, py = y * scale, pz = z * scale;
		this.th[0] = px; this.th[1] = py; this.th[2] = pz;
		// d(phi) = (I + 0.5*[phi]x + c*[phi]x^2) applied row-wise to the relative rotation in
		// A's frame, c = 1/angle^2 - cot(angle/2) / (2*angle): the inverse left Jacobian of SO(3).
		const c = angle > 1e-3 ? 1 / (angle * angle) - 1 / (2 * angle * Math.tan(angle / 2)) : 1 / 12;
		const pp = px * px + py * py + pz * pz;
		// row i: e_i + 0.5 * (phi x e_i) + c * (phi * phi_i - e_i * |phi|^2)
		rot(a, 1 + c * (px * px - pp), 0.5 * pz + c * py * px, -0.5 * py + c * pz * px, grad, 0);
		rot(a, -0.5 * pz + c * px * py, 1 + c * (py * py - pp), 0.5 * px + c * pz * py, grad, 3);
		rot(a, 0.5 * py + c * px * pz, -0.5 * px + c * py * pz, 1 + c * (pz * pz - pp), grad, 6);
		this.curve[0] = this.curve[1] = this.curve[2] = 0.5 + 0.25 * angle;
	}

	init(s) {
		const decay = s.decay;
		this.eval(s);
		if (this.hinge) this.ref[0] = this.th[0];
		else { this.ref[0] = this.qx; this.ref[1] = this.qy; this.ref[2] = this.qz; this.ref[3] = this.qw; }
		for (let r = 0; r < 3; r++) {
			this.C0Lin[r] = s.keepLin(this.C[r]);
			this.lamLin[r] *= decay;
			this.kLin[r] = clamp(this.kLin[r] * s.gamma, this.minLin, this.minLin * s.ratio);
		}
		if (this.hinge) {
			for (let r = 0; r < 2; r++) {
				this.C0Ang[r] = s.keepAng(this.c[r]);
				this.lamAng[r] *= decay;
				this.kAng[r] = clamp(this.kAng[r] * s.gamma, this.minAng, this.minAng * s.ratio);
			}
		}
		for (let r = 0; r < this.n; r++) {
			const th = this.th[r];
			this.th0[r] = th;
			this.C0Lim[r] = s.keepAng(th > this.hi[r] ? th - this.hi[r] : th < this.lo[r] ? th - this.lo[r] : 0);
			this.lamLim[r] *= decay;
			this.kLim[r] = clamp(this.kLim[r] * s.gamma, this.minAng, this.minAng * s.ratio);
		}
		return true;
	}

	/** Limit force on angle r: pushes back only when the angle is past a bound. */
	_limit(s, r) {
		const th = this.th[r], lam = this.lamLim[r], c0 = this.C0Lim[r];
		let k = (this._k = this.kLim[r]);
		const up = th - this.hi[r] - (c0 > 0 ? s.alpha * c0 : 0);
		if (lam > 0 && up < 0) k = this._k = Math.max(k, lam / s.slackAng);
		const fu = k * up + lam;
		if (fu > 0) { this._err = up; return fu; }
		const down = th - this.lo[r] - (c0 < 0 ? s.alpha * c0 : 0);
		k = this._k = lam < 0 && down > 0 ? Math.max(this.kLim[r], -lam / s.slackAng) : this.kLim[r];
		const fl = k * down + lam;
		if (fl < 0) { this._err = down; return fl; }
		this._err = 0;
		return 0;
	}

	primal(s, i, H, g) {
		this.eval(s);
		const isA = i === this.a;
		const sign = isA ? 1 : -1;
		const r = isA ? this.rAw : this.rBw;
		const al = s.alpha;

		// Point rows: C = pA - pB. Row k has gradient e_k (A) / -e_k (B) and r x e_k about the centre of mass.
		const f0 = this.kLin[0] * (this.C[0] - al * this.C0Lin[0]) + this.lamLin[0];
		const f1 = this.kLin[1] * (this.C[1] - al * this.C0Lin[1]) + this.lamLin[1];
		const f2 = this.kLin[2] * (this.C[2] - al * this.C0Lin[2]) + this.lamLin[2];
		addRow(H, g, sign, 0, 0, 0, sign * r[2], -sign * r[1], this.kLin[0], f0);
		addRow(H, g, 0, sign, 0, -sign * r[2], 0, sign * r[0], this.kLin[1], f1);
		addRow(H, g, 0, 0, sign, sign * r[1], -sign * r[0], 0, this.kLin[2], f2);
		addGeometric(H, sign * r[0], sign * r[1], sign * r[2], f0, f1, f2);

		// Angular rows: gradients are with respect to B's rotation; A sees the opposite.
		// An angle is a curved function of the bodies' rotations. As for the point rows, that
		// curvature times the row's force is lumped onto the diagonal; without it a light body
		// carrying a large limit torque is over-corrected.
		const as = -sign;
		let lump = 0;
		if (this.hinge) {
			const gc = this.gradC;
			for (let k = 0; k < 2; k++) {
				const f = this.kAng[k] * (this.c[k] - al * this.C0Ang[k]) + this.lamAng[k];
				addRow(H, g, 0, 0, 0, as * gc[k * 3], as * gc[k * 3 + 1], as * gc[k * 3 + 2], this.kAng[k], f);
				lump += 0.5 * Math.abs(f);
			}
		}
		const gr = this.grad, dt = s.dt;
		for (let k = 0; k < this.n; k++) {
			let f = this._limit(s, k);
			let stiff = f !== 0 ? this._k : 0;
			if (this.mk[k] > 0 || this.mc[k] > 0) {
				const th = this.th[k];
				const raw = this.mk[k] * (th - this.mt[k]) + (this.mc[k] * (th - this.th0[k])) / dt;
				f += clamp(raw, -this.mmax, this.mmax);
				stiff += this.mk[k] + this.mc[k] / dt;
			}
			if (stiff === 0) continue;
			addRow(H, g, 0, 0, 0, as * gr[k * 3], as * gr[k * 3 + 1], as * gr[k * 3 + 2], stiff, f);
			lump += this.curve[k] * Math.abs(f);
		}
		H[21] += lump; H[28] += lump; H[35] += lump;
	}

	dual(s) {
		this.eval(s);
		const al = s.alpha;
		for (let r = 0; r < 3; r++) {
			const C = this.C[r] - al * this.C0Lin[r];
			this.lamLin[r] = this.kLin[r] * C + this.lamLin[r];
			this.kLin[r] = Math.min(this.kLin[r] + s.betaLin * Math.abs(C), this.minLin * s.ratio);
		}
		if (this.hinge) {
			for (let r = 0; r < 2; r++) {
				const C = this.c[r] - al * this.C0Ang[r];
				this.lamAng[r] = this.kAng[r] * C + this.lamAng[r];
				this.kAng[r] = Math.min(this.kAng[r] + s.betaAng * Math.abs(C), this.minAng * s.ratio);
			}
		}
		for (let r = 0; r < this.n; r++) {
			const f = this._limit(s, r);
			this.lamLim[r] = this.lamLim[r] + (f - this.lamLim[r]) * s.limitRelax;
			if (f !== 0) this.kLim[r] = Math.min(this.kLim[r] + s.betaAng * Math.abs(this._err), this.minAng * s.ratio);
		}
	}

	/** Scales every penalty by r: used when the time step changes (penalties go with 1 / dt^2). */
	rescale(r) {
		this.minLin *= r; this.minAng *= r;
		for (let i = 0; i < 3; i++) this.kLin[i] *= r;
		for (let i = 0; i < 2; i++) this.kAng[i] *= r;
		for (let i = 0; i < this.n; i++) this.kLim[i] *= r;
	}

	/** Forgets multipliers and ramped penalties. */
	reset() {
		this.kLin.fill(this.minLin); this.lamLin.fill(0);
		this.kAng.fill(this.minAng); this.lamAng.fill(0);
		this.kLim.fill(this.minAng); this.lamLim.fill(0);
		if (this.hinge) this.ref[0] = 0;
		else { this.ref[0] = this.ref[1] = this.ref[2] = 0; this.ref[3] = 1; }
	}

	/** Distance between the two anchor points right now (0 for a perfect joint). */
	gap(s) {
		this.eval(s);
		return Math.hypot(this.C[0], this.C[1], this.C[2]);
	}
}

// ------------------------------------------------------------------- contacts

/**
 * One frictional contact point between two bodies, or between a body and the
 * fixed world (b = -1, rB a world point).
 *
 * Three rows in the contact's own basis: the normal row may only push the
 * bodies apart (force <= 0), the two tangent rows are friction, limited to the
 * Coulomb cone. A contact may start separated (C0 > 0): then it does nothing
 * until the bodies would cross within the step, which is what stops fast limbs
 * from tunnelling through each other.
 */
export class Contact {
	constructor(a, b, startStiffness) {
		this.bodies = [a, b];
		this.a = a; this.b = b;
		this.rA = new Float64Array(3);
		this.rB = new Float64Array(3);
		this.n = new Float64Array(3); this.t1 = new Float64Array(3); this.t2 = new Float64Array(3);
		this.mu = 0.5;
		this.kMin = startStiffness;
		this.k = [startStiffness, startStiffness, startStiffness];
		this.lam = [0, 0, 0];
		this.C0 = [0, 0, 0];
		this.stick = false;
		this.used = true;
		this.d = new Float64Array(3);
		this.rAw = new Float64Array(3); this.rBw = new Float64Array(3);
		this.F = new Float64Array(3); this.Cv = new Float64Array(3);
	}

	/** Sets the contact normal (pointing from B to A) and builds tangents for it. */
	setNormal(nx, ny, nz) {
		const n = this.n, t1 = this.t1, t2 = this.t2;
		n[0] = nx; n[1] = ny; n[2] = nz;
		if (Math.abs(nx) > Math.abs(nz)) { t1[0] = -ny; t1[1] = nx; t1[2] = 0; } else { t1[0] = 0; t1[1] = -nz; t1[2] = ny; }
		const l = 1 / Math.hypot(t1[0], t1[1], t1[2]);
		t1[0] *= l; t1[1] *= l; t1[2] *= l;
		t2[0] = ny * t1[2] - nz * t1[1]; t2[1] = nz * t1[0] - nx * t1[2]; t2[2] = nx * t1[1] - ny * t1[0];
	}

	/** Separation of the two contact points in the contact basis. */
	eval(s) {
		const A = s.bodies[this.a], d = this.d, rA = this.rA, rB = this.rB;
		rot(A.q, rA[0], rA[1], rA[2], this.rAw);
		d[0] = A.x[0] + this.rAw[0]; d[1] = A.x[1] + this.rAw[1]; d[2] = A.x[2] + this.rAw[2];
		if (this.b >= 0) {
			const B = s.bodies[this.b];
			rot(B.q, rB[0], rB[1], rB[2], this.rBw);
			d[0] -= B.x[0] + this.rBw[0]; d[1] -= B.x[1] + this.rBw[1]; d[2] -= B.x[2] + this.rBw[2];
		} else {
			d[0] -= rB[0]; d[1] -= rB[1]; d[2] -= rB[2];
		}
		const n = this.n, t1 = this.t1, t2 = this.t2, C = this.Cv;
		C[0] = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
		C[1] = t1[0] * d[0] + t1[1] * d[1] + t1[2] * d[2];
		C[2] = t2[0] * d[0] + t2[1] * d[1] + t2[2] * d[2];
	}

	init(s) {
		this.eval(s);
		const decay = s.decay;
		// Only penetration that already exists is eased out gently; a gap is used as it is.
		this.C0[0] = s.keepLin(Math.min(this.Cv[0], 0)); this.C0[1] = this.Cv[1]; this.C0[2] = this.Cv[2];
		for (let r = 0; r < 3; r++) {
			this.lam[r] *= decay;
			this.k[r] = clamp(this.k[r] * s.gamma, this.kMin, this.kMin * s.ratio);
		}
		return true;
	}

	/** Contact force in the contact basis, clamped to "push only" and to the friction cone. */
	force(s) {
		this.eval(s);
		const C = this.Cv, F = this.F, al = s.alpha;
		C[0] -= al * this.C0[0]; C[1] -= al * this.C0[1]; C[2] -= al * this.C0[2];
		const kn = (this.kn = C[0] > 0 ? Math.max(this.k[0], -this.lam[0] / s.slack) : this.k[0]);
		F[0] = Math.min(kn * C[0] + this.lam[0], 0);
		F[1] = this.k[1] * C[1] + this.lam[1];
		F[2] = this.k[2] * C[2] + this.lam[2];
		const bound = -F[0] * this.mu;
		const mag = Math.hypot(F[1], F[2]);
		this.sliding = mag > bound;
		if (this.sliding && mag > 0) { F[1] *= bound / mag; F[2] *= bound / mag; }
	}

	primal(s, i, H, g) {
		this.force(s);
		const F = this.F;
		if (F[0] === 0) return;   // not touching: no force, no stiffness
		const isA = i === this.a;
		const sign = isA ? 1 : -1;
		const r = isA ? this.rAw : this.rBw;
		const rows = [this.n, this.t1, this.t2];
		for (let k = 0; k < 3; k++) {
			const j = rows[k];
			const lx = sign * j[0], ly = sign * j[1], lz = sign * j[2];
			addRow(H, g, lx, ly, lz, r[1] * lz - r[2] * ly, r[2] * lx - r[0] * lz, r[0] * ly - r[1] * lx, k === 0 ? this.kn : this.k[k], F[k]);
		}
	}

	dual(s) {
		this.force(s);
		const F = this.F, C = this.Cv;
		this.lam[0] = F[0]; this.lam[1] = F[1]; this.lam[2] = F[2];
		if (F[0] < 0) this.k[0] = Math.min(this.k[0] + s.betaLin * Math.abs(C[0]), this.kMin * s.ratio);
		if (!this.sliding) {
			this.k[1] = Math.min(this.k[1] + s.betaLin * Math.abs(C[1]), this.kMin * s.ratio);
			this.k[2] = Math.min(this.k[2] + s.betaLin * Math.abs(C[2]), this.kMin * s.ratio);
		}
		this.stick = F[0] < 0 && !this.sliding && Math.hypot(C[1], C[2]) < STICK_THRESHOLD;
	}
}

// -------------------------------------------------------------------- strings

/**
 * An inextensible string from a fixed point (the handle on the control bar)
 * over any number of via points on bodies to an attachment point on a body.
 *
 * One hard, one-sided row on the total length of that polyline:
 * C = length - rest <= 0, with tension clamp(k*C + lambda, 0, max). A slack
 * string does nothing at all; a taut one cannot stretch. Each via point is a
 * frictionless pulley, so tension T presses on the wrapped body with
 * T * (d_in - d_out) and pulls the attachment back along the last segment.
 */
export class StringForce {
	constructor(startStiffness) {
		this.bodies = [];
		this.kMin = startStiffness;
		this.k = startStiffness;
		this.lam = 0;
		this.active = false;
		this.handle = new Float64Array(3);
		this.count = 0;                       // nodes after the handle
		this.nodeBody = [];
		this.local = new Float64Array(0);     // node positions in their body's centre-of-mass frame
		this.world = new Float64Array(0);     // handle + nodes, world
		this.lever = new Float64Array(0);     // node lever arms, world
		this.grad = new Float64Array(0);      // d(length)/d(node)
		this.rest = 1;
		this.max = Infinity;
		this.residual = 0;                    // over-length left at the end of the step
		this.fresh = 0;                       // over-length added this step by the handle and by reeling in
		this.C0 = 0;
		this.length = 0;
		this.tension = 0;
	}

	/**
	 * Lays the string out for this step: nodes are [{ body, local: [x, y, z] }], attachment last.
	 * A node with body -1 is a fixed place in the world (`local` is that place): the string
	 * bends there as round a pulley nothing can move — where another string holds it.
	 */
	route(handle, nodes, rest, max, fresh = 0) {
		this.active = true;
		this.fresh = fresh;
		this.handle[0] = handle[0]; this.handle[1] = handle[1]; this.handle[2] = handle[2];
		const n = (this.count = nodes.length);
		if (this.local.length < n * 3) {
			this.local = new Float64Array(n * 3);
			this.lever = new Float64Array(n * 3);
			this.grad = new Float64Array(n * 3);
			this.world = new Float64Array((n + 1) * 3);
		}
		this.nodeBody.length = n;
		this.bodies.length = 0;
		for (let k = 0; k < n; k++) {
			const node = nodes[k];
			this.nodeBody[k] = node.body;
			this.local[k * 3] = node.local[0]; this.local[k * 3 + 1] = node.local[1]; this.local[k * 3 + 2] = node.local[2];
			if (node.body >= 0 && !this.bodies.includes(node.body)) this.bodies.push(node.body);
		}
		this.rest = rest;
		this.max = max;
	}

	release() {
		this.active = false;
		this.lam = 0; this.tension = 0; this.residual = 0;
		this.k = this.kMin;
	}

	eval(s) {
		const n = this.count, world = this.world, lever = this.lever, grad = this.grad, local = this.local;
		world[0] = this.handle[0]; world[1] = this.handle[1]; world[2] = this.handle[2];
		for (let k = 0; k < n; k++) {
			const o = k * 3;
			if (this.nodeBody[k] < 0) { lever[o] = lever[o + 1] = lever[o + 2] = 0; world[o + 3] = local[o]; world[o + 4] = local[o + 1]; world[o + 5] = local[o + 2]; continue; }
			const B = s.bodies[this.nodeBody[k]];
			rot(B.q, local[o], local[o + 1], local[o + 2], lever, o);
			world[o + 3] = B.x[0] + lever[o]; world[o + 4] = B.x[1] + lever[o + 1]; world[o + 5] = B.x[2] + lever[o + 2];
		}
		// Length, and its gradient with respect to each node: d_in - d_out (d_in alone at the end).
		let length = 0, px = 0, py = 0, pz = 0;
		for (let k = 0; k < n; k++) {
			const o = k * 3;
			let dx = world[o + 3] - world[o], dy = world[o + 4] - world[o + 1], dz = world[o + 5] - world[o + 2];
			const l = Math.hypot(dx, dy, dz);
			length += l;
			const il = l > 1e-9 ? 1 / l : 0;
			dx *= il; dy *= il; dz *= il;
			grad[o] = dx; grad[o + 1] = dy; grad[o + 2] = dz;
			if (k > 0) { grad[o - 3] -= dx; grad[o - 2] -= dy; grad[o - 1] -= dz; }
			px = dx; py = dy; pz = dz;
		}
		this.length = length;
	}

	init(s) {
		if (!this.active) return false;
		// Over-length present before the bodies move. The part that comes from the handle
		// moving away or the string being taken in this step (`fresh`) is real and is
		// followed at once; the rest — left over from the last step, or from the string's
		// path having just changed — is eased out.
		this.eval(s);
		this.C0 = s.keepLin(Math.max(0, this.length - this.rest - Math.max(0, this.fresh)));
		this.lam *= s.decay;
		this.k = clamp(this.k * s.gamma, this.kMin, this.kMin * s.ratio);
		return true;
	}

	primal(s, i, H, g) {
		this.eval(s);
		const C = this.length - this.rest - s.alpha * this.C0;
		const k = C < 0 ? Math.max(this.k, this.lam / s.slack) : this.k;
		const f = clamp(k * C + this.lam, 0, this.max);
		if (f <= 0) return;   // slack
		const grad = this.grad, lever = this.lever;
		let lx = 0, ly = 0, lz = 0, ax = 0, ay = 0, az = 0;
		for (let k = 0; k < this.count; k++) {
			if (this.nodeBody[k] !== i) continue;
			const o = k * 3;
			const gx = grad[o], gy = grad[o + 1], gz = grad[o + 2];
			const rx = lever[o], ry = lever[o + 1], rz = lever[o + 2];
			lx += gx; ly += gy; lz += gz;
			ax += ry * gz - rz * gy; ay += rz * gx - rx * gz; az += rx * gy - ry * gx;
			addGeometric(H, rx, ry, rz, f * gx, f * gy, f * gz);
		}
		addRow(H, g, lx, ly, lz, ax, ay, az, k, f);
	}

	dual(s) {
		this.eval(s);
		const raw = this.length - this.rest;
		const C = raw - s.alpha * this.C0;
		const f = clamp((C < 0 ? Math.max(this.k, this.lam / s.slack) : this.k) * C + this.lam, 0, this.max);
		this.lam = f;
		if (f > 0 && f < this.max) this.k = Math.min(this.k + s.betaLin * Math.abs(C), this.kMin * s.ratio);
		this.tension = f;
	}

	/** Records the over-length left once the step is over: next step's starting error. */
	finish(s) {
		this.eval(s);
		this.residual = this.length - this.rest;
	}
}

export const _internals = { rot, rotInv, turn, rotDiff, solve6 };
