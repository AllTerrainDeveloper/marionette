// Shared visuals for the control rig and its strings: wooden bars, handle
// knobs, screw eyes on the puppet and the strings themselves (fat lines that
// sag when slack and straighten when loaded). Used by both screens.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { BODIES, BARS, HANDLES, RIG_HOME } from './rig-config.js';
import { buildWrapProxies, effectiveAttach, stringExclusions, wrapFrame, stringPath, pushOut, distanceToSegment } from './string-path.js';

const SEGMENTS = 44;
const ROPE_PASSES = 14;         // relaxation sweeps per frame for a hanging string
const GRAVITY = 9.81;
const ROPE_MARGIN = 0.006;       // how far off the wood a loose string rests (m)
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();

/**
 * Bars are generated from the handle layout: a spine along Z plus one cross
 * beam per row of handles, so custom handle sets still get a sensible control.
 */
export class RigView {
	/** opts: { materials, ghost (translucent, for the phone), knob (radius) } */
	constructor(opts) {
		this.group = new THREE.Group();
		this.bars = [];
		this.knobs = [];
		this.tethers = [];
		const knobR = opts.knob || 0.016;
		const wood = opts.ghost
			? new THREE.MeshStandardMaterial({ color: 0xe9c48e, roughness: 0.6, transparent: true, opacity: 0.3, depthWrite: false })
			: opts.materials.walnut;
		BARS.forEach((bar) => {
			const g = new THREE.Group();
			const mine = HANDLES.filter((h) => h.bar === bar.id);
			const zs = mine.map((h) => h.local[2]);
			const z0 = Math.min(...zs, 0) - 0.03, z1 = Math.max(...zs, 0) + 0.03;
			const beam = (w, d, x, z) => {
				const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), wood);
				mesh.position.set(x, 0, z);
				mesh.castShadow = false;   // the control bars hang above the lights: no shadows on the stage
				g.add(mesh);
			};
			if (z1 - z0 > 0.08) beam(0.036, z1 - z0, 0, (z0 + z1) / 2);
			const rows = new Map();
			for (const h of mine) {
				const key = h.local[2].toFixed(2);
				const row = rows.get(key) || { z: h.local[2], min: 0, max: 0 };
				row.min = Math.min(row.min, h.local[0]); row.max = Math.max(row.max, h.local[0]);
				rows.set(key, row);
			}
			for (const row of rows.values()) {
				if (row.max - row.min > 0.05) beam(row.max - row.min + 0.05, 0.034, (row.min + row.max) / 2, row.z);
			}
			if (!opts.ghost) {
				// A hook to hang the control by, as on a real marionette.
				const hook = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.004, 8, 16, Math.PI * 1.5), opts.materials.brass);
				hook.position.set(0, 0.03, (z0 + z1) / 2);
				g.add(hook);
			}
			this.group.add(g);
			this.bars.push(g);
		});
		HANDLES.forEach(() => {
			const knob = new THREE.Mesh(
				new THREE.SphereGeometry(knobR, 14, 10),
				opts.ghost
					? new THREE.MeshStandardMaterial({ color: 0xffd58a, emissive: 0x6b4a12, roughness: 0.35 })
					: opts.materials.brass
			);
			knob.castShadow = false;
			this.group.add(knob);
			this.knobs.push(knob);
			// A short wire from the bar to a knob that has been pulled away from it.
			const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
			const wire = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: opts.ghost ? 0xffd58a : 0x6b5a3a, transparent: true, opacity: 0.7 }));
			wire.frustumCulled = false;
			this.group.add(wire);
			this.tethers.push(wire);
		});
	}

	/** barPos / barQuat: flat arrays for the two bars; handlePos: flat handle positions. */
	update(barPos, barQuat, handlePos) {
		this.bars.forEach((g, i) => {
			g.position.set(barPos[i * 3], barPos[i * 3 + 1], barPos[i * 3 + 2]);
			g.quaternion.set(barQuat[i * 4], barQuat[i * 4 + 1], barQuat[i * 4 + 2], barQuat[i * 4 + 3]);
		});
		HANDLES.forEach((h, i) => {
			const knob = this.knobs[i];
			knob.position.set(handlePos[i * 3], handlePos[i * 3 + 1], handlePos[i * 3 + 2]);
			const bar = this.bars[BARS.findIndex((b) => b.id === h.bar)];
			_a.set(h.local[0], h.local[1], h.local[2]).applyQuaternion(bar.quaternion).add(bar.position);
			const wire = this.tethers[i];
			const away = _a.distanceTo(knob.position) > 0.012;
			wire.visible = away;
			if (away) {
				const p = wire.geometry.attributes.position;
				p.setXYZ(0, _a.x, _a.y, _a.z);
				p.setXYZ(1, knob.position.x, knob.position.y, knob.position.z);
				p.needsUpdate = true;
			}
		});
	}
}

/** Rest length of a string, computed exactly as the simulation does. */
export function stringRestLength(def, at = def.at) {
	if (Number.isFinite(def.length)) return def.length;
	const h = HANDLES.find((x) => x.id === def.handle);
	const body = BODIES.find((x) => x.id === def.body);
	const bar = BARS.find((x) => x.id === h.bar);
	return Math.hypot(
		RIG_HOME[0] + bar.offset[0] + h.local[0] - body.pos[0] - at[0],
		RIG_HOME[1] + bar.offset[1] + h.local[1] - body.pos[1] - at[1],
		RIG_HOME[2] + bar.offset[2] + h.local[2] - body.pos[2] - at[2]
	) + (def.slack || 0);
}

export class StringsView {
	/**
	 * opts: { width (px), color, tensionColors (bool), eyeMaterial, parts (puppet part groups) }
	 */
	constructor(opts) {
		this.opts = opts;
		this.group = new THREE.Group();
		this.items = [];
		this.resolution = new THREE.Vector2(1024, 768);
		this.proxies = buildWrapProxies(BODIES);
		this.frame = [];
	}

	setResolution(w, h) {
		this.resolution.set(w, h);
		for (const item of this.items) item.line.material.resolution.copy(this.resolution);
	}

	/** Rebuilds lines and screw eyes for a new string table. */
	setStrings(defs) {
		for (const item of this.items) {
			this.group.remove(item.line);
			item.line.geometry.dispose();
			item.line.material.dispose();
			if (item.eye) item.eye.parent.remove(item.eye);
		}
		this.items = [];
		for (const def of defs) {
			const body = BODIES.findIndex((b) => b.id === def.body);
			const handle = HANDLES.findIndex((h) => h.id === def.handle);
			if (body < 0 || handle < 0) continue;
			// Where the string is tied: on the surface of the wood, exactly as in the simulation.
			const tie = effectiveAttach(def, BODIES, this.proxies);
			const geometry = new LineGeometry();
			geometry.setPositions(new Float32Array((SEGMENTS + 1) * 3));
			const material = new LineMaterial({
				color: this.opts.color ?? 0xe8dcc2, linewidth: this.opts.width || 1.4, transparent: true, opacity: 0.92,
				resolution: this.resolution, dashed: false,
			});
			const line = new Line2(geometry, material);
			line.frustumCulled = false;
			this.group.add(line);
			let eye = null;
			if (this.opts.eyeMaterial && this.opts.parts) {
				eye = new THREE.Mesh(new THREE.TorusGeometry(0.011, 0.003, 6, 12), this.opts.eyeMaterial);
				eye.position.set(tie[0], tie[1], tie[2]);
				eye.name = 'screw-eye';
				eye.rotation.y = Math.PI / 2;
				this.opts.parts[body].add(eye);
			}
			this.items.push({ def, body, handle, line, eye, tie, rest: stringRestLength(def, tie), excluded: stringExclusions(def, tie, BODIES, this.proxies), attach: new THREE.Vector3(), top: new THREE.Vector3(), points: null, rope: new Float32Array((SEGMENTS + 1) * 3), last: new Float32Array((SEGMENTS + 1) * 3), live: false });
		}
	}

	/**
	 * pos / quat: body transforms, handlePos: handle positions,
	 * tension: 0..1 per string (fraction of its maximum), brokenMask: bit per string,
	 * pulls: optional metres of pull per string, selected: optional Set of indices.
	 *
	 * A taut string is drawn along its route round the limbs. A slack one is not on that
	 * route at all — nothing presses it against the wood — so it is a little rope of its
	 * own: a chain of points with the string's full length, pinned only at its two ends,
	 * that hangs, swings and folds under gravity and rests on the puppet only where it
	 * actually falls against it. A snapped one is pinned at the handle only.
	 */
	update(pos, quat, handlePos, tension, brokenMask, time, pulls, selected) {
		// Route every string around the limbs exactly as the simulation does.
		// (`wrap = false` draws plain straight strings — debug mode uses it to compare.)
		const frame = this.wrap === false ? NO_PIECES : wrapFrame(this.proxies, pos, quat, this.frame);
		const dt = Math.min(1 / 30, Math.max(0, time - (this.lastTime ?? time)));
		this.lastTime = time;
		const N = SEGMENTS;
		this.items.forEach((item, i) => {
			const { def, body, handle, line, rope, last } = item;
			const broken = !!(brokenMask & (1 << i));
			line.visible = def.enabled !== false;
			if (!line.visible) { item.live = false; return; }
			_q.set(quat[body * 4], quat[body * 4 + 1], quat[body * 4 + 2], quat[body * 4 + 3]);
			_a.set(item.tie[0], item.tie[1], item.tie[2]).applyQuaternion(_q);
			_a.set(_a.x + pos[body * 3], _a.y + pos[body * 3 + 1], _a.z + pos[body * 3 + 2]);
			_b.set(handlePos[handle * 3], handlePos[handle * 3 + 1], handlePos[handle * 3 + 2]);
			item.attach.copy(_a); item.top.copy(_b);

			// The taut route, worked out on the very transforms being drawn, so it lies on the
			// surface that is on screen (a route from an earlier physics step would sink into it).
			const pts = stringPath([_b.x, _b.y, _b.z], [_a.x, _a.y, _a.z], frame, item.excluded).points;
			item.points = pts;
			const legs = pts.length - 1;
			let length = 0;
			const along = [0];
			for (let k = 0; k < legs; k++) {
				length += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1], pts[k + 1][2] - pts[k][2]);
				along.push(length);
			}
			const rest = Math.max(0.05, item.rest - (pulls ? pulls[i] || 0 : 0));
			const t = tension[i] || 0;
			const slack = rest - length;

			// Where the chain's points sit when the string is taut: evenly along the route.
			const taut = _taut;
			let leg = 0;
			for (let k = 0; k <= N; k++) {
				const d = (k / N) * length;
				while (leg < legs - 1 && along[leg + 1] < d) leg++;
				const span = along[leg + 1] - along[leg] || 1;
				const u = Math.min(1, Math.max(0, (d - along[leg]) / span));
				const p = pts[leg], q = pts[leg + 1];
				taut[k * 3] = p[0] + (q[0] - p[0]) * u; taut[k * 3 + 1] = p[1] + (q[1] - p[1]) * u; taut[k * 3 + 2] = p[2] + (q[2] - p[2]) * u;
			}

			const hanging = broken || (slack > 0.002 && t < 0.004);
			if (!hanging || !item.live || dt <= 0) {
				// Taut (or first frame): the chain lies on the route, at rest.
				if (!hanging || !item.live) { rope.set(taut); last.set(taut); }
				item.live = true;
			} else {
				// Verlet step: every free point keeps its momentum and falls.
				const first = 1, end = broken ? N : N - 1;
				const keep = 1 - Math.min(0.5, 2.2 * dt);
				for (let k = first; k <= end; k++) {
					const o = k * 3;
					for (let c = 0; c < 3; c++) {
						const now = rope[o + c];
						rope[o + c] = now + (now - last[o + c]) * keep - (c === 1 ? GRAVITY * dt * dt : 0);
						last[o + c] = now;
					}
				}
				// Then the string's length is enforced: no link may be longer than its share.
				const link = (broken ? Math.min(rest, 1.2) : rest) / N;
				// The pieces of the puppet this string could be touching.
				const near = _near;
				near.length = 0;
				const reach = 0.06 + Math.max(0, slack);
				for (let k = 0; k < frame.length; k++) {
					const f = frame[k];
					if (item.excluded.has(k)) continue;
					if (distanceToSegment(f.o, pts[0], pts[legs]) < f.bound + reach) near.push(f);
				}
				for (let pass = 0; pass < ROPE_PASSES; pass++) {
					rope[0] = _b.x; rope[1] = _b.y; rope[2] = _b.z;
					if (!broken) { rope[N * 3] = _a.x; rope[N * 3 + 1] = _a.y; rope[N * 3 + 2] = _a.z; }
					for (let k = 0; k < N; k++) {
						const o = k * 3;
						const dx = rope[o + 3] - rope[o], dy = rope[o + 4] - rope[o + 1], dz = rope[o + 5] - rope[o + 2];
						const l = Math.hypot(dx, dy, dz);
						if (l <= link || l < 1e-9) continue;
						const fixedA = k === 0, fixedB = !broken && k === N - 1;
						const share = fixedA ? 0 : fixedB ? 1 : 0.5;
						const f = (l - link) / l;
						rope[o] += dx * f * share; rope[o + 1] += dy * f * share; rope[o + 2] += dz * f * share;
						rope[o + 3] -= dx * f * (1 - share); rope[o + 4] -= dy * f * (1 - share); rope[o + 5] -= dz * f * (1 - share);
					}
					// It cannot be inside the wood: a point that is gets moved to the surface, and
					// loses the speed it had into it.
					if (near.length && (pass % 3 === 2 || pass === ROPE_PASSES - 1)) {
						for (let k = first; k <= end; k++) {
							const o = k * 3;
							_p[0] = rope[o]; _p[1] = rope[o + 1]; _p[2] = rope[o + 2];
							for (let n = 0; n < near.length; n++) {
								const f = near[n];
								const ex = _p[0] - f.o[0], ey = _p[1] - f.o[1], ez = _p[2] - f.o[2];
								if (ex * ex + ey * ey + ez * ez > (f.bound + 0.01) * (f.bound + 0.01)) continue;
								const out = pushOut(f, _p, ROPE_MARGIN);
								if (!out) continue;
								last[o] += out[0] - _p[0]; last[o + 1] += out[1] - _p[1]; last[o + 2] += out[2] - _p[2];
								_p[0] = out[0]; _p[1] = out[1]; _p[2] = out[2];
							}
							rope[o] = _p[0]; rope[o + 1] = _p[1]; rope[o + 2] = _p[2];
						}
					}
				}
				// It lies on the floor rather than passing through it.
				for (let k = 1; k <= end; k++) if (rope[k * 3 + 1] < 0.004) rope[k * 3 + 1] = 0.004;
				// Close to taut, ease onto the route so the change from hanging to straight has no jump.
				if (!broken && slack < 0.02) {
					const w = 1 - slack / 0.02;
					for (let k = 3; k < N * 3; k++) rope[k] += (taut[k] - rope[k]) * w;
				}
			}

			const data = line.geometry.attributes.instanceStart.data;
			const arr = data.array;
			for (let k = 0; k < N; k++) {
				const o = k * 6, r = k * 3;
				arr[o] = rope[r]; arr[o + 1] = rope[r + 1]; arr[o + 2] = rope[r + 2];
				arr[o + 3] = rope[r + 3]; arr[o + 4] = rope[r + 4]; arr[o + 5] = rope[r + 5];
			}
			data.needsUpdate = true;

			const mat = line.material;
			const isSelected = selected && selected.has(i);
			if (this.opts.tensionColors) {
				// Cool and dim when slack, warm when carrying load, red near the limit.
				if (broken) _c.setRGB(0.5, 0.2, 0.2);
				else if (t < 0.004) _c.setRGB(0.42, 0.5, 0.62);
				else _c.setRGB(1, 0.92 - t * 0.75, 0.72 - Math.min(1, t * 1.6) * 0.6);
				if (isSelected) _c.lerp(_white, 0.45);
				mat.color.copy(_c);
				mat.opacity = t < 0.004 && !isSelected ? 0.55 : 1;
				mat.linewidth = (this.opts.width || 2) * (isSelected ? 2.1 : 1 + t * 0.9);
			} else {
				mat.opacity = broken ? 0.4 : 0.9;
			}
		});
	}
}
const _white = new THREE.Color(1, 1, 1);
const NO_PIECES = [];
const _taut = new Float32Array((SEGMENTS + 1) * 3);
const _near = [];
const _p = [0, 0, 0];
