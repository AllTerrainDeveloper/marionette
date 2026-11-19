// The puppeteer's board: a lightweight top-down 3D view of the puppet, its
// strings and the control rig, drawn from the state the stage streams over
// WebRTC. No physics runs here — snapshots are buffered and interpolated.

import * as THREE from 'three';
import { BODIES, JOINTS, HANDLES, EFFECTORS, RIG_HOME } from '../shared/rig-config.js';
import { buildPuppet, posePuppet, jointWorld } from '../shared/puppet-geometry.js';
import { RigView, StringsView } from '../shared/rig-view.js';

export const DEFAULT_ORBIT = { azimuth: 0, polar: 0.2, distance: 4.0 };
const DELAY_MS = 70;       // render this far behind the newest snapshot to always have two to blend
const _v = new THREE.Vector3();
const _plane = new THREE.Plane();
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

function discTexture() {
	const size = 1024;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const g = canvas.getContext('2d');
	const c = size / 2;
	const wood = g.createRadialGradient(c, c, 20, c, c, c);
	wood.addColorStop(0, '#5a3a22'); wood.addColorStop(0.7, '#3c2415'); wood.addColorStop(1, '#22130b');
	g.fillStyle = wood; g.beginPath(); g.arc(c, c, c, 0, Math.PI * 2); g.fill();
	// Lathe-turned rings.
	for (let r = 14; r < c; r += 5 + (r % 13)) {
		g.strokeStyle = `rgba(${r % 2 ? '255,214,160' : '10,4,0'},${0.04 + ((r * 7) % 10) / 160})`;
		g.lineWidth = 1 + (r % 3);
		g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke();
	}
	// Brass inlay and degree ticks, like an instrument dial.
	g.strokeStyle = 'rgba(226,180,87,0.75)'; g.lineWidth = 5;
	g.beginPath(); g.arc(c, c, c * 0.93, 0, Math.PI * 2); g.stroke();
	g.lineWidth = 1.5; g.strokeStyle = 'rgba(226,180,87,0.4)';
	g.beginPath(); g.arc(c, c, c * 0.52, 0, Math.PI * 2); g.stroke();
	for (let i = 0; i < 72; i++) {
		const a = (i / 72) * Math.PI * 2;
		const long = i % 6 === 0;
		g.strokeStyle = `rgba(226,180,87,${long ? 0.8 : 0.4})`; g.lineWidth = long ? 3 : 1.5;
		g.beginPath();
		g.moveTo(c + Math.cos(a) * c * 0.93, c + Math.sin(a) * c * 0.93);
		g.lineTo(c + Math.cos(a) * c * (long ? 0.86 : 0.895), c + Math.sin(a) * c * (long ? 0.86 : 0.895));
		g.stroke();
	}
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

function blobTexture() {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 128;
	const g = canvas.getContext('2d');
	const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
	grad.addColorStop(0, 'rgba(0,0,0,0.6)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
	g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
	return new THREE.CanvasTexture(canvas);
}

export class BoardView {
	constructor(canvas, lowPower = false) {
		this.canvas = canvas;
		const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowPower, alpha: true, powerPreference: 'default' }));
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.1;
		renderer.setClearColor(0x000000, 0);
		this.maxRatio = lowPower ? 1.25 : 2;

		const scene = (this.scene = new THREE.Scene());
		scene.add(new THREE.HemisphereLight(0xfff1d6, 0x3a261a, 1.7));
		const key = new THREE.DirectionalLight(0xffe2b8, 3.0);
		key.position.set(1.4, 6, 3.2);
		scene.add(key);
		const rim = new THREE.DirectionalLight(0x8fb4ff, 0.9);
		rim.position.set(-2, 2.5, -3);
		scene.add(rim);

		const disc = new THREE.Mesh(new THREE.CircleGeometry(2.7, 64), new THREE.MeshStandardMaterial({ map: discTexture(), roughness: 0.6 }));
		disc.rotation.x = -Math.PI / 2;
		scene.add(disc);
		const lip = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.035, 8, 96), new THREE.MeshStandardMaterial({ color: 0xc9a14a, roughness: 0.35, metalness: 0.9 }));
		lip.rotation.x = Math.PI / 2;
		scene.add(lip);
		this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }));
		this.blob.rotation.x = -Math.PI / 2; this.blob.position.y = 0.004;
		scene.add(this.blob);

		this.puppet = buildPuppet('low');
		scene.add(this.puppet.root);
		this.rigView = new RigView({ ghost: true, knob: 0.03 });
		scene.add(this.rigView.group);
		this.strings = new StringsView({ width: 2.2, tensionColors: true });
		scene.add(this.strings.group);

		this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 40);
		this.orbit = { ...DEFAULT_ORBIT };
		this.target = new THREE.Vector3(RIG_HOME[0], 1.0, RIG_HOME[2] + 0.1);

		this.snaps = [];
		this.offset = null;
		this.state = null;
		this.pulls = new Float32Array(64);
	}

	resize(w, h) {
		const ratio = Math.min(window.devicePixelRatio || 1, this.maxRatio);
		this.renderer.setPixelRatio(ratio);
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		// Keep the control rig comfortably in view on tall and wide screens alike.
		this.camera.fov = w / h < 0.7 ? 52 : 40;
		this.camera.updateProjectionMatrix();
		this.strings.setResolution(w * ratio, h * ratio);
		this.width = w; this.height = h;
	}

	setStrings(defs) {
		this.strings.setStrings(defs);
		if (this.width) this.strings.setResolution(this.width * this.renderer.getPixelRatio(), this.height * this.renderer.getPixelRatio());
	}

	pushSnapshot(snap, now) {
		const sample = snap.time - now;
		this.offset = this.offset === null ? sample : this.offset + (sample - this.offset) * (sample > this.offset ? 0.3 : 0.02);
		this.snaps.push(snap);
		if (this.snaps.length > 12) this.snaps.shift();
	}

	/** Interpolated state for local time `now`, or null before the first snapshot. */
	sample(now) {
		const snaps = this.snaps;
		if (!snaps.length) return null;
		const at = now + this.offset - DELAY_MS;
		let b = snaps.length - 1;
		while (b > 0 && snaps[b - 1].time >= at) b--;
		const B = snaps[b];
		const A = snaps[Math.max(0, b - 1)];
		const span = B.time - A.time;
		const t = span > 0 ? Math.min(1, Math.max(0, (at - A.time) / span)) : 1;
		if (A.bodyPos.length !== B.bodyPos.length || A.handlePos.length !== B.handlePos.length || A.tension.length !== B.tension.length) return (this.state = B);
		const s = this.state && this.state !== A && this.state !== B && this.state.bodyPos.length === B.bodyPos.length && this.state.tension.length === B.tension.length
			? this.state
			: { bodyPos: new Float32Array(B.bodyPos.length), bodyQuat: new Float32Array(B.bodyQuat.length), barPos: new Float32Array(B.barPos.length), barQuat: new Float32Array(B.barQuat.length), handlePos: new Float32Array(B.handlePos.length), tension: new Float32Array(B.tension.length), ikPos: new Float32Array(B.ikPos.length) };
		const mix = (out, a, c) => { for (let i = 0; i < out.length; i++) out[i] = a[i] + (c[i] - a[i]) * t; };
		const mixQ = (out, a, c) => {
			for (let o = 0; o < out.length; o += 4) {
				const sign = a[o] * c[o] + a[o + 1] * c[o + 1] + a[o + 2] * c[o + 2] + a[o + 3] * c[o + 3] < 0 ? -1 : 1;
				const x = a[o] + (c[o] * sign - a[o]) * t, y = a[o + 1] + (c[o + 1] * sign - a[o + 1]) * t;
				const z = a[o + 2] + (c[o + 2] * sign - a[o + 2]) * t, w = a[o + 3] + (c[o + 3] * sign - a[o + 3]) * t;
				const l = Math.hypot(x, y, z, w) || 1;
				out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l; out[o + 3] = w / l;
			}
		};
		mix(s.bodyPos, A.bodyPos, B.bodyPos); mixQ(s.bodyQuat, A.bodyQuat, B.bodyQuat);
		mix(s.barPos, A.barPos, B.barPos); mixQ(s.barQuat, A.barQuat, B.barQuat);
		mix(s.handlePos, A.handlePos, B.handlePos); mix(s.tension, A.tension, B.tension); mix(s.ikPos, A.ikPos, B.ikPos);
		s.mode = B.mode; s.phones = B.phones; s.flags = B.flags; s.broken = B.broken; s.ikMask = B.ikMask; s.locks = B.locks; s.time = at;
		return (this.state = s);
	}

	updateCamera(dt, state) {
		if (state) {
			const pelvis = BODIES.findIndex((b) => b.id === 'pelvis');
			// Follow the bar and the puppet together so neither leaves the board.
			const x = (state.bodyPos[pelvis * 3] + state.barPos[0]) / 2;
			const z = (state.bodyPos[pelvis * 3 + 2] + state.barPos[2]) / 2 + 0.1;
			const k = Math.min(1, dt * 3);
			this.target.x += (x - this.target.x) * k;
			this.target.z += (z - this.target.z) * k;
			this.blob.position.x = state.bodyPos[pelvis * 3];
			this.blob.position.z = state.bodyPos[pelvis * 3 + 2];
		}
		const { azimuth, polar, distance } = this.orbit;
		const sp = Math.sin(polar), cp = Math.cos(polar), sa = Math.sin(azimuth), ca = Math.cos(azimuth);
		this.camera.position.set(this.target.x + sa * sp * distance, this.target.y + cp * distance, this.target.z + ca * sp * distance);
		// "Up" on the phone screen is "away from the puppeteer", even when looking straight down.
		this.camera.up.set(-sa * cp, sp, -ca * cp);
		this.camera.lookAt(this.target);
		this.camera.updateMatrixWorld();
	}

	render(state, time, selectedStrings) {
		if (state) {
			posePuppet(this.puppet.parts, state.bodyPos, state.bodyQuat);
			this.rigView.update(state.barPos, state.barQuat, state.handlePos);
			this.strings.update(state.bodyPos, state.bodyQuat, state.handlePos, state.tension, state.broken, time, this.pulls, selectedStrings);
		}
		this.renderer.render(this.scene, this.camera);
	}

	// ------------------------------------------------------------ helpers

	/** World point -> CSS pixel position (and whether it is in front of the camera). */
	project(x, y, z, out) {
		_v.set(x, y, z).project(this.camera);
		out.x = (_v.x * 0.5 + 0.5) * this.width;
		out.y = (-_v.y * 0.5 + 0.5) * this.height;
		out.visible = _v.z < 1;
		return out;
	}

	/** Where the ray under a screen point crosses the horizontal plane at height y. */
	planePoint(px, py, y, out = new THREE.Vector3()) {
		_ndc.set((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1);
		_ray.setFromCamera(_ndc, this.camera);
		_plane.set(_up, -y);
		return _ray.ray.intersectPlane(_plane, out);
	}

	jointPosition(index, state, out) { return jointWorld(index, state.bodyPos, state.bodyQuat, out); }

	/** World position of an IK effector's tip. */
	effectorPosition(index, state, out = new THREE.Vector3()) {
		const e = EFFECTORS[index];
		const b = BODIES.findIndex((x) => x.id === e.tipBody);
		_q.set(state.bodyQuat[b * 4], state.bodyQuat[b * 4 + 1], state.bodyQuat[b * 4 + 2], state.bodyQuat[b * 4 + 3]);
		out.set(e.tip[0], e.tip[1], e.tip[2]).applyQuaternion(_q);
		return out.set(out.x + state.bodyPos[b * 3], out.y + state.bodyPos[b * 3 + 1], out.z + state.bodyPos[b * 3 + 2]);
	}
}
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
export { JOINTS, HANDLES, EFFECTORS };
