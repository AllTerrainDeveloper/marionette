// Wire protocol between the stage (desktop) and a puppeteer's phone.
//
// Two WebRTC data channels per phone:
//   "rt"  — unreliable, unordered: compact binary packets, sent many times a
//           second. Every packet is a complete state, so a lost or late one is
//           simply skipped (sequence numbers discard stale arrivals).
//   "ctl" — reliable, ordered: small JSON messages for things that must not be
//           lost (mode changes, custom rigs, locks, actions, calibration).

export const PROTOCOL_VERSION = 1;
export const PKT_INPUT = 1;
export const PKT_STATE = 2;

const POS = 1000;   // metres -> millimetres (int16: ±32 m)
const QUAT = 32767;
const GYRO = 1000;  // rad/s
const ACC = 400;    // m/s²
const JOINT = 40;   // rad -> int8 (±3.1 rad)
const PULL_MAX = 0.75;

const i16 = (v) => Math.max(-32767, Math.min(32767, Math.round(v)));
const i8 = (v) => Math.max(-127, Math.min(127, Math.round(v)));

/** True when sequence number `a` is newer than `b` (wrapping uint16). */
export const seqNewer = (a, b) => ((a - b) & 0xffff) < 0x8000 && a !== b;

// ------------------------------------------------------------------ input

/**
 * Phone -> stage. `input`:
 *   { seq, sensors, calibrated, quat[4], gyro[3], acc[3], stick[2],
 *     handles: Map<index,[x,y,z]>, pulls: Map<index,metres>,
 *     ik: Map<index,[x,y,z]>, joints: Map<index,[x,y,z]> }
 */
export function encodeInput(input) {
	const size = 4 + 8 + 6 + 6 + 2 + 4 + input.handles.size * 7 + input.pulls.size * 2 + input.ik.size * 7 + input.joints.size * 4;
	const dv = new DataView(new ArrayBuffer(size));
	let o = 0;
	dv.setUint8(o++, PKT_INPUT);
	dv.setUint8(o++, (input.sensors ? 1 : 0) | (input.calibrated ? 2 : 0));
	dv.setUint16(o, input.seq & 0xffff); o += 2;
	for (let k = 0; k < 4; k++, o += 2) dv.setInt16(o, i16(input.quat[k] * QUAT));
	for (let k = 0; k < 3; k++, o += 2) dv.setInt16(o, i16(input.gyro[k] * GYRO));
	for (let k = 0; k < 3; k++, o += 2) dv.setInt16(o, i16(input.acc[k] * ACC));
	dv.setInt8(o++, i8(input.stick[0] * 127));
	dv.setInt8(o++, i8(input.stick[1] * 127));
	dv.setUint8(o++, input.handles.size);
	for (const [index, v] of input.handles) {
		dv.setUint8(o++, index);
		for (let k = 0; k < 3; k++, o += 2) dv.setInt16(o, i16(v[k] * POS));
	}
	dv.setUint8(o++, input.pulls.size);
	for (const [index, metres] of input.pulls) {
		dv.setUint8(o++, index);
		dv.setUint8(o++, Math.max(0, Math.min(255, Math.round((metres / PULL_MAX) * 255))));
	}
	dv.setUint8(o++, input.ik.size);
	for (const [index, v] of input.ik) {
		dv.setUint8(o++, index);
		for (let k = 0; k < 3; k++, o += 2) dv.setInt16(o, i16(v[k] * POS));
	}
	dv.setUint8(o++, input.joints.size);
	for (const [index, v] of input.joints) {
		dv.setUint8(o++, index);
		for (let k = 0; k < 3; k++) dv.setInt8(o++, i8(v[k] * JOINT));
	}
	return dv.buffer;
}

export function decodeInput(buffer) {
	const dv = new DataView(buffer);
	if (dv.byteLength < 30 || dv.getUint8(0) !== PKT_INPUT) return null;
	try {
		let o = 1;
		const flags = dv.getUint8(o++);
		const input = {
			sensors: !!(flags & 1), calibrated: !!(flags & 2),
			seq: dv.getUint16(o), quat: [0, 0, 0, 1], gyro: [0, 0, 0], acc: [0, 0, 0], stick: [0, 0],
			handles: new Map(), pulls: new Map(), ik: new Map(), joints: new Map(),
		};
		o += 2;
		for (let k = 0; k < 4; k++, o += 2) input.quat[k] = dv.getInt16(o) / QUAT;
		for (let k = 0; k < 3; k++, o += 2) input.gyro[k] = dv.getInt16(o) / GYRO;
		for (let k = 0; k < 3; k++, o += 2) input.acc[k] = dv.getInt16(o) / ACC;
		input.stick[0] = dv.getInt8(o++) / 127;
		input.stick[1] = dv.getInt8(o++) / 127;
		for (let n = dv.getUint8(o++); n > 0; n--) {
			const index = dv.getUint8(o++);
			input.handles.set(index, [dv.getInt16(o) / POS, dv.getInt16(o + 2) / POS, dv.getInt16(o + 4) / POS]);
			o += 6;
		}
		for (let n = dv.getUint8(o++); n > 0; n--) {
			const index = dv.getUint8(o++);
			input.pulls.set(index, (dv.getUint8(o++) / 255) * PULL_MAX);
		}
		for (let n = dv.getUint8(o++); n > 0; n--) {
			const index = dv.getUint8(o++);
			input.ik.set(index, [dv.getInt16(o) / POS, dv.getInt16(o + 2) / POS, dv.getInt16(o + 4) / POS]);
			o += 6;
		}
		for (let n = dv.getUint8(o++); n > 0; n--) {
			const index = dv.getUint8(o++);
			input.joints.set(index, [dv.getInt8(o) / JOINT, dv.getInt8(o + 1) / JOINT, dv.getInt8(o + 2) / JOINT]);
			o += 3;
		}
		return input;
	} catch {
		return null; // Truncated or malformed packet.
	}
}

// ------------------------------------------------------------------ state

/**
 * Stage -> phone. `state`:
 *   { seq, time (ms), mode (index), phones, bodyPos Float32Array(n*3),
 *     bodyQuat Float32Array(n*4), bars: [{pos,quat}], handlePos Float32Array(h*3),
 *     tension: number[] (N), tensionMax: number[] (N), broken: bool[],
 *     ik: [{w,pos}], locks: bool[] }
 */
export function encodeState(state) {
	const nb = state.bodyPos.length / 3;
	const nh = state.handlePos.length / 3;
	const ns = state.tension.length;
	const ni = state.ik.length;
	const size = 16 + nb * 14 + state.bars.length * 14 + nh * 6 + ns + 4 + 1 + ni * 6 + 4;
	const dv = new DataView(new ArrayBuffer(size));
	let o = 0;
	dv.setUint8(o++, PKT_STATE);
	dv.setUint8(o++, state.mode);
	dv.setUint16(o, state.seq & 0xffff); o += 2;
	dv.setUint32(o, state.time >>> 0); o += 4;
	dv.setUint8(o++, state.phones);
	dv.setUint8(o++, nb);
	dv.setUint8(o++, state.bars.length);
	dv.setUint8(o++, nh);
	dv.setUint8(o++, ns);
	dv.setUint8(o++, ni);
	dv.setUint8(o++, state.locks.length);
	dv.setUint8(o++, state.flags || 0);
	for (let i = 0; i < nb; i++) {
		for (let k = 0; k < 3; k++, o += 2) dv.setInt16(o, i16(state.bodyPos[i * 3 + k] * POS));
		for (let k = 0; k < 4; k++, o += 2) dv.setInt16(o, i16(state.bodyQuat[i * 4 + k] * QUAT));
	}
	for (const bar of state.bars) {
		for (let k = 0; k < 3; k++, o += 2) dv.setInt16(o, i16(bar.pos[k] * POS));
		for (let k = 0; k < 4; k++, o += 2) dv.setInt16(o, i16(bar.quat[k] * QUAT));
	}
	for (let i = 0; i < nh * 3; i++, o += 2) dv.setInt16(o, i16(state.handlePos[i] * POS));
	let broken = 0;
	for (let i = 0; i < ns; i++) {
		const t = state.tensionMax[i] > 0 ? state.tension[i] / state.tensionMax[i] : 0;
		dv.setUint8(o++, Math.max(0, Math.min(255, Math.round(t * 255))));
		if (state.broken[i]) broken |= 1 << i;
	}
	dv.setUint32(o, broken >>> 0); o += 4;
	let mask = 0;
	state.ik.forEach((t, i) => { if (t.w > 0.001) mask |= 1 << i; });
	dv.setUint8(o++, mask);
	for (const t of state.ik) for (let k = 0; k < 3; k++, o += 2) dv.setInt16(o, i16(t.pos[k] * POS));
	let locks = 0;
	state.locks.forEach((locked, i) => { if (locked) locks |= 1 << i; });
	dv.setUint32(o, locks >>> 0);
	return dv.buffer;
}

export function decodeState(buffer) {
	const dv = new DataView(buffer);
	if (dv.byteLength < 16 || dv.getUint8(0) !== PKT_STATE) return null;
	try {
		let o = 1;
		const s = { mode: dv.getUint8(o++), seq: dv.getUint16(o), time: dv.getUint32(o + 2) };
		o += 6;
		s.phones = dv.getUint8(o++);
		const nb = dv.getUint8(o++);
		const nbar = dv.getUint8(o++);
		const nh = dv.getUint8(o++);
		const ns = dv.getUint8(o++);
		const ni = dv.getUint8(o++);
		const nj = dv.getUint8(o++);
		s.flags = dv.getUint8(o++);
		s.bodyPos = new Float32Array(nb * 3);
		s.bodyQuat = new Float32Array(nb * 4);
		for (let i = 0; i < nb; i++) {
			for (let k = 0; k < 3; k++, o += 2) s.bodyPos[i * 3 + k] = dv.getInt16(o) / POS;
			for (let k = 0; k < 4; k++, o += 2) s.bodyQuat[i * 4 + k] = dv.getInt16(o) / QUAT;
		}
		s.barPos = new Float32Array(nbar * 3);
		s.barQuat = new Float32Array(nbar * 4);
		for (let i = 0; i < nbar; i++) {
			for (let k = 0; k < 3; k++, o += 2) s.barPos[i * 3 + k] = dv.getInt16(o) / POS;
			for (let k = 0; k < 4; k++, o += 2) s.barQuat[i * 4 + k] = dv.getInt16(o) / QUAT;
		}
		s.handlePos = new Float32Array(nh * 3);
		for (let i = 0; i < nh * 3; i++, o += 2) s.handlePos[i] = dv.getInt16(o) / POS;
		s.tension = new Float32Array(ns);
		for (let i = 0; i < ns; i++) s.tension[i] = dv.getUint8(o++) / 255;
		s.broken = dv.getUint32(o); o += 4;
		s.ikMask = dv.getUint8(o++);
		s.ikPos = new Float32Array(ni * 3);
		for (let i = 0; i < ni * 3; i++, o += 2) s.ikPos[i] = dv.getInt16(o) / POS;
		s.locks = dv.getUint32(o);
		s.jointCount = nj;
		return s;
	} catch {
		return null;
	}
}
