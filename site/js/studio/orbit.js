// A hand-held camera for the workbench pages: drag to go round what it looks at, right-drag (or
// shift-drag) to slide sideways, wheel to come closer. And the bits of picking the pages share.

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _plane = new THREE.Plane();
const _ndc = new THREE.Vector2();

export class OrbitCam {
	constructor(dom, { position = [0, 1.5, 5.8], target = [0, 1.32, 0], fov = 31 } = {}) {
		this.dom = dom;
		this.target = new THREE.Vector3();
		this.position = new THREE.Vector3();
		this.fov = fov;
		this.enabled = true;
		/** (event) => true to keep this press for something else (picking, dragging a handle). */
		this.intercept = null;
		/** Called while the user moves the camera, and once when they let go. */
		this.onChange = null;
		this.onEnd = null;
		this.set(position, target);
		this._drag = null;
		dom.addEventListener('pointerdown', (e) => this._down(e));
		dom.addEventListener('pointermove', (e) => this._move(e));
		dom.addEventListener('pointerup', (e) => this._up(e));
		dom.addEventListener('pointercancel', (e) => this._up(e));
		dom.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
		dom.addEventListener('contextmenu', (e) => e.preventDefault());
	}

	/** Puts the camera at `position`, looking at `target` (arrays or vectors). */
	set(position, target, fov) {
		this.position.set(position[0] ?? position.x, position[1] ?? position.y, position[2] ?? position.z);
		this.target.set(target[0] ?? target.x, target[1] ?? target.y, target[2] ?? target.z);
		if (fov) this.fov = fov;
		_v.subVectors(this.position, this.target);
		this.distance = Math.max(0.3, _v.length());
		this.yaw = Math.atan2(_v.x, _v.z);
		this.pitch = Math.asin(Math.max(-1, Math.min(1, _v.y / this.distance)));
	}

	_place() {
		const c = Math.cos(this.pitch);
		this.position.set(this.target.x + Math.sin(this.yaw) * c * this.distance, this.target.y + Math.sin(this.pitch) * this.distance, this.target.z + Math.cos(this.yaw) * c * this.distance);
		if (this.position.y < 0.1) this.position.y = 0.1;   // never under the boards
	}

	apply(camera) {
		camera.position.copy(this.position);
		if (camera.fov !== this.fov) { camera.fov = this.fov; camera.updateProjectionMatrix(); }
		camera.lookAt(this.target);
		camera.updateMatrixWorld();   // so that anything projected before the frame is drawn uses this view, not the last one
	}

	_down(e) {
		if (!this.enabled || (this.intercept && this.intercept(e))) return;
		this.dom.setPointerCapture(e.pointerId);
		this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey, moved: false };
		this.dom.classList.add('is-dragging');
	}

	_move(e) {
		const d = this._drag;
		if (!d || d.id !== e.pointerId) return;
		const dx = e.clientX - d.x, dy = e.clientY - d.y;
		d.x = e.clientX; d.y = e.clientY;
		if (!dx && !dy) return;
		d.moved = true;
		if (d.pan) {
			// Slide the camera and what it looks at together, in the plane of the picture.
			_v.subVectors(this.target, this.position).normalize();
			_right.crossVectors(_v, _up.set(0, 1, 0)).normalize();
			_up.crossVectors(_right, _v);
			const k = (this.distance * Math.tan((this.fov * Math.PI) / 360) * 2) / this.dom.clientHeight;
			this.target.addScaledVector(_right, -dx * k).addScaledVector(_up, dy * k);
			this.target.y = Math.max(0, this.target.y);
		} else {
			this.yaw -= dx * 0.006;
			this.pitch = Math.max(-0.35, Math.min(1.5, this.pitch + dy * 0.006));
		}
		this._place();
		if (this.onChange) this.onChange();
	}

	_up(e) {
		const d = this._drag;
		if (!d || d.id !== e.pointerId) return;
		this._drag = null;
		this.dom.classList.remove('is-dragging');
		if (d.moved && this.onEnd) this.onEnd();
	}

	_wheel(e) {
		if (!this.enabled) return;
		e.preventDefault();
		this.distance = Math.max(0.5, Math.min(16, this.distance * Math.exp(e.deltaY * 0.0012)));
		this._place();
		if (this.onChange) this.onChange();
		clearTimeout(this._wheelEnd);
		this._wheelEnd = setTimeout(() => { if (this.onEnd) this.onEnd(); }, 220);
	}
}

/** Where a world point is on the canvas, in CSS pixels from its corner: [x, y, in front of the camera?]. */
export function toScreen(point, camera, dom, out = [0, 0, false]) {
	_v.set(point[0] ?? point.x, point[1] ?? point.y, point[2] ?? point.z).project(camera);
	out[0] = (_v.x * 0.5 + 0.5) * dom.clientWidth;
	out[1] = (-_v.y * 0.5 + 0.5) * dom.clientHeight;
	out[2] = _v.z > -1 && _v.z < 1;
	return out;
}

/** The pointer's position on the canvas, in CSS pixels from its corner. */
export function pointerAt(e, dom) {
	const r = dom.getBoundingClientRect();
	return [e.clientX - r.left, e.clientY - r.top];
}

/**
 * Where the pointer's ray meets the plane through `through` that faces the camera — how a drag
 * on a flat screen moves something in the world. Null if it misses.
 */
export function dragPoint(e, camera, dom, through, out = new THREE.Vector3()) {
	const [x, y] = pointerAt(e, dom);
	_ndc.set((x / dom.clientWidth) * 2 - 1, -(y / dom.clientHeight) * 2 + 1);
	_ray.setFromCamera(_ndc, camera);
	camera.getWorldDirection(_v);
	_plane.setFromNormalAndCoplanarPoint(_v, through);
	return _ray.ray.intersectPlane(_plane, out);
}

/** Distance in pixels from a point to the segment a-b, all on the canvas. */
export function segmentDistance(p, a, b) {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	const l = dx * dx + dy * dy;
	const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
	return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
