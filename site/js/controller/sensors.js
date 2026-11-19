// Phone motion sensors: orientation, rotation rate and linear acceleration,
// re-expressed in the stage's coordinate frame and relative to a calibrated
// neutral pose.
//
// Frames. The device frame is x → right edge, y → top edge, z → out of the
// screen. Calibration assumes the phone is held flat like a tray with its top
// edge pointing at the stage, so a device vector (x, y, z) is (x, z, -y) on
// stage: right stays right, "screen up" is up, "top of phone" is "into the scene".
// The phone then behaves exactly like the wooden control bar it stands in for.

import { qMul, qConj, qNorm, qRot, qAxisAngle } from '../shared/math.js';

const RAD = Math.PI / 180;
const toStage = (v) => [v[0], v[2], -v[1]];

export class Sensors {
	constructor() {
		this.available = false;       // have we ever received real orientation data?
		this.calibrated = false;
		this.device = [0, 0, 0, 1];   // absolute device orientation
		this.neutral = [0, 0, 0, 1];
		this.quat = [0, 0, 0, 1];     // relative orientation, stage frame
		this.gyro = [0, 0, 0];        // rad/s, stage frame
		this.acc = [0, 0, 0];         // m/s² without gravity, stage frame
		this.tilt = [0, 0];           // raw beta, gamma in degrees (for the bubble level)
		this.spin = 0;                // how fast the orientation is changing (rad/s), for "hold still"
		this._gravity = [0, 0, 0];
		this._lastQ = null;
		this._lastT = 0;
		this._onOrientation = this._onOrientation.bind(this);
		this._onMotion = this._onMotion.bind(this);
	}

	/** iOS needs an explicit, user-initiated permission prompt. Returns 'granted' | 'denied' | 'unsupported'. */
	async requestPermission() {
		if (typeof DeviceOrientationEvent === 'undefined') return 'unsupported';
		try {
			if (typeof DeviceOrientationEvent.requestPermission === 'function') {
				const a = await DeviceOrientationEvent.requestPermission();
				let b = 'granted';
				if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
					b = await DeviceMotionEvent.requestPermission();
				}
				if (a !== 'granted' || b !== 'granted') return 'denied';
			}
		} catch {
			return 'denied';
		}
		return 'granted';
	}

	start() {
		window.addEventListener('deviceorientation', this._onOrientation);
		window.addEventListener('devicemotion', this._onMotion);
	}

	stop() {
		window.removeEventListener('deviceorientation', this._onOrientation);
		window.removeEventListener('devicemotion', this._onMotion);
	}

	/** Feeds one orientation sample (degrees). Public so tests can drive the controller without hardware. */
	feedOrientation(alpha, beta, gamma, now = performance.now()) {
		// Intrinsic Z (alpha) – X (beta) – Y (gamma), as specified for DeviceOrientationEvent.
		const q = qNorm(qMul(qMul(qAxisAngle([0, 0, 1], alpha * RAD), qAxisAngle([1, 0, 0], beta * RAD)), qAxisAngle([0, 1, 0], gamma * RAD)));
		if (this._lastQ && now > this._lastT) {
			const d = qMul(qConj(this._lastQ), q);
			const angle = 2 * Math.atan2(Math.hypot(d[0], d[1], d[2]), Math.abs(d[3]));
			const rate = angle / ((now - this._lastT) / 1000);
			this.spin += (rate - this.spin) * 0.3;
		}
		this._lastQ = q; this._lastT = now;
		this.device = q;
		this.tilt = [beta, gamma];
		this.available = true;
		this._update();
	}

	_update() {
		let rel = qMul(qConj(this.neutral), this.device);
		if (rel[3] < 0) rel = rel.map((v) => -v);
		this.rel = rel;
		const v = toStage(rel);
		this.quat = [v[0], v[1], v[2], rel[3]];
	}

	_onOrientation(e) {
		if (e.alpha === null || e.beta === null || e.gamma === null) return;
		this.feedOrientation(e.alpha, e.beta, e.gamma);
	}

	_onMotion(e) {
		const rr = e.rotationRate;
		// Browsers report rotationRate.alpha/beta/gamma about the device x / y / z axes.
		if (rr && rr.alpha !== null) this.gyro = toStage(qRot(this.rel || [0, 0, 0, 1], [rr.alpha * RAD, rr.beta * RAD, rr.gamma * RAD]));
		let a = null;
		if (e.acceleration && e.acceleration.x !== null) {
			a = [e.acceleration.x, e.acceleration.y, e.acceleration.z];
		} else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x !== null) {
			// No fused linear acceleration: subtract a slowly tracked gravity estimate.
			const g = e.accelerationIncludingGravity;
			const raw = [g.x, g.y, g.z];
			for (let i = 0; i < 3; i++) this._gravity[i] += (raw[i] - this._gravity[i]) * 0.08;
			a = [raw[0] - this._gravity[0], raw[1] - this._gravity[1], raw[2] - this._gravity[2]];
		}
		if (a) this.acc = toStage(qRot(this.rel || [0, 0, 0, 1], a));
	}

	/** Makes the current pose the neutral one. */
	calibrate() {
		this.neutral = [...this.device];
		this.calibrated = true;
		this._update();
	}
}
