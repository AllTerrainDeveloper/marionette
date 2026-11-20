// The puppet's world, as every desktop page shows it: the simulation, the control layer, the
// theatre, the puppet's meshes, the control rig and the strings, and the loop that steps the
// physics and draws a frame. The stage, the Marionette editor and the Studio are all built on
// this; what differs between them is who writes the control targets (phones, a test bench, a
// timeline) and who holds the camera.

import * as THREE from 'three';
import RAPIER from '../../vendor/rapier.mjs';
import { RIG } from '../shared/rig-config.js';
import { buildPuppet, posePuppet } from '../shared/puppet-geometry.js';
import { RigView, StringsView } from '../shared/rig-view.js';
import { PuppetSim } from './sim.js';
import { Controller } from './control.js';
import { Stage } from './scene.js';

// Physics takes what a 60 fps frame has to spare. Each level is [steps per second, solver
// sweeps, cost relative to the default]; accuracy rises with the step rate (see
// tools/solver-bench.mjs), so spare time buys smaller steps, and a busy frame gives them back.
const LEVELS = [[120, 5, 0.8], [180, 5, 0.9], [240, 5, 1], [360, 4, 1.25], [480, 4, 1.5], [720, 4, 2.15], [960, 4, 2.7]];
const FRAME_MS = 1000 / 60;
const WRAP_KEY = 'motion-puppet-wrap';   // '0': strings and rods pass through the puppet's limbs (remembered on this device)
const RESERVE_MS = 4.5;        // of each frame, left for the GPU and the browser
const PHYSICS_MAX_MS = 9;      // never spend more than this on physics, however idle the rest is

/**
 * Builds the world on a canvas. Options:
 *   rig            the puppet (defaults to the built-in rig; pass one with another string table,
 *                  or with `model` and `shapes` for another puppet on the same skeleton)
 *   size           () => [width, height] of the canvas in CSS pixels (defaults to the window)
 *   strings        options for the strings' look (see StringsView)
 *   adaptive       let the governor choose the physics step rate (default: unless ?fixed)
 *   onProgress     (text) => {} called as the world is put together
 *
 * Hooks, set on the returned world: onStep(n) after every physics step (n counts them),
 * onFrame(dt, clock) once the theatre has moved and before the frame is drawn — the place to
 * take the camera — and onSecond(fps, physicsMs) once a second.
 */
export async function createWorld(canvas, options = {}) {
	await RAPIER.init();
	if (options.onProgress) options.onProgress('Stringing the puppet…');
	const rig = options.rig || RIG;
	const sim = new PuppetSim(RAPIER, rig);
	const controller = new Controller(sim, rig);
	let wrap = true;
	try { wrap = localStorage.getItem(WRAP_KEY) !== '0'; } catch { /* private mode: they wrap */ }
	sim.opts.stringCollision = wrap;
	// Let the puppet come to rest on its strings before anyone sees it.
	for (let i = 0; i < sim.opts.hz * 4; i++) { controller.update(); sim.step(); }

	const stage = new Stage(canvas);
	const puppet = buildPuppet('high', undefined, rig.model);
	stage.scene.add(puppet.root);
	const rigView = new RigView({ materials: puppet.materials });
	stage.scene.add(rigView.group);
	const strings = new StringsView({ width: 1.5, color: 0xeadfc6, eyeMaterial: puppet.materials.brass, parts: puppet.parts, shapes: rig.shapes, ...options.strings });
	strings.wrap = wrap;
	stage.scene.add(strings.group);
	const stringLoads = [];
	let shownStrings = null;

	const size = options.size || (() => [window.innerWidth, window.innerHeight]);
	const resize = () => {
		const [w, h] = size();
		if (!(w > 0 && h > 0)) return;
		stage.resize(w, h);
		strings.setResolution(w * stage.size[2], h * stage.size[2]);
	};

	const nb = rig.bodies.length;
	const ipos = new Float32Array(nb * 3);
	const iquat = new Float32Array(nb * 4);
	const barPos = new Float32Array(rig.bars.length * 3);
	const barQuat = new Float32Array(rig.bars.length * 4);
	const tensionNorm = new Float32Array(64);

	let level = LEVELS.findIndex((l) => l[0] === sim.opts.hz);
	if (level < 0) level = 2;
	let maxSteps = 1;
	function setLevel(next) {
		level = next;
		sim.setRate(LEVELS[level][0], LEVELS[level][1]);
		maxSteps = Math.ceil(sim.opts.hz / 10);
	}
	setLevel(level);
	let physEma = 0, otherEma = 3, overFor = 0, roomFor = 0, cooling = 2;
	/** Once a frame: move to a cheaper level if physics overran its share, to a finer one if there is room. */
	function govern(dt, physicsMs, workMs) {
		if (dt > 0.05) return;      // a hitch or a hidden tab says nothing about the budget
		physEma += (physicsMs - physEma) * 0.08;
		otherEma += (workMs - physicsMs - otherEma) * 0.08;
		if (!tuning.adaptive) return;
		const budget = Math.min(PHYSICS_MAX_MS, Math.max(0.8, FRAME_MS - RESERVE_MS - otherEma));
		tuning.budget = budget;
		cooling -= dt;
		overFor = physEma > budget ? overFor + dt : 0;
		const next = level + 1 < LEVELS.length ? physEma * (LEVELS[level + 1][2] / LEVELS[level][2]) : Infinity;
		roomFor = next < budget * 0.7 && cooling <= 0 ? roomFor + dt : 0;
		if (overFor > 0.3 && level > 0) {
			physEma *= LEVELS[level - 1][2] / LEVELS[level][2];
			setLevel(level - 1);
			overFor = 0; roomFor = 0; cooling = 3;
		} else if (roomFor > 1.2) {
			physEma = next;
			setLevel(level + 1);
			roomFor = 0; cooling = 1.5;
		}
	}
	// timeScale slows or stops time (0 freezes the puppet where it is). adaptive: let the governor above choose the step rate.
	const tuning = { timeScale: 1, adaptive: options.adaptive ?? !new URLSearchParams(location.search).has('fixed'), budget: 0, get level() { return level; }, levels: LEVELS, setLevel: (i) => setLevel(Math.max(0, Math.min(LEVELS.length - 1, i))), govern };

	const chest = sim.bodyIx.chest;
	let last = performance.now();
	let acc = 0, steps = 0, frames = 0, fpsAt = last, physMs = 0;

	const world = {
		THREE, rig, sim, controller, stage, puppet, rigView, strings, tuning, ipos, iquat,
		clock: 0,
		/** Strings to pick out (a Set of indices), where the strings are drawn with tension colours. */
		selected: null,
		onStep: null, onFrame: null, onSecond: null,
		resize,
		/** Rest pose, strings laid out afresh and untangled. */
		reset() {
			controller.reset();
			strings.relay();
			sim.setKnots(null);
		},
		/** Do strings catch on the puppet's limbs and wrap round them? Off: every string and rod runs straight through the wood. */
		get wrap() { return wrap; },
		setWrap(on, remember = true) {
			wrap = !!on;
			sim.opts.stringCollision = wrap;
			strings.wrap = wrap;
			sim.strings.forEach((s) => { s.memory.vias = null; s.nodes = s.base = null; });
			strings.relay();
			if (remember) try { localStorage.setItem(WRAP_KEY, wrap ? '1' : '0'); } catch { /* not remembered */ }
		},
		/** Ties a cut or snapped string again, as Reset does for all of them, leaving the puppet where it is. */
		retie(index) {
			const s = sim.strings[index];
			if (!s) return;
			s.broken = false; s.over = 0; s.tension = 0; s.force.release();
			s.memory.vias = null; s.nodes = s.base = null; s.knots = null;
			const item = strings.items[index];
			if (item) item.shape.live = false;
		},
		/** Restrings the puppet with another table of strings and rods. */
		setStrings(defs) {
			controller.setRigStrings(defs);
			world.rig = controller.rig;
		},
		start() {
			stage.update(0.016, 0, { x: 0, y: 1.25, z: 0 });
			if (world.onFrame) world.onFrame(0.016, 0);
			stage.render(0.016);
			requestAnimationFrame((now) => { last = now; frame(now); });
		},
	};

	function frame(now) {
		requestAnimationFrame(frame);
		const dt = Math.min(0.1, (now - last) / 1000);
		last = now;
		world.clock += dt;
		acc += dt * tuning.timeScale;
		const t0 = performance.now();
		let n = 0;
		while (acc >= sim.dt && n < maxSteps) {
			controller.update();
			sim.step();
			acc -= sim.dt;
			n++;
			steps++;
			if (world.onStep) world.onStep(steps);
		}
		if (n === maxSteps) acc = 0;
		const physicsMs = performance.now() - t0;
		physMs += physicsMs;

		// Render between the last two physics states.
		const a = acc / sim.dt;
		for (let i = 0; i < nb * 3; i++) ipos[i] = sim.prevPos[i] + (sim.pos[i] - sim.prevPos[i]) * a;
		for (let i = 0; i < nb; i++) {
			const o = i * 4;
			const p = sim.prevQuat, q = sim.quat;
			const sign = p[o] * q[o] + p[o + 1] * q[o + 1] + p[o + 2] * q[o + 2] + p[o + 3] * q[o + 3] < 0 ? -1 : 1;
			const x = p[o] + (q[o] * sign - p[o]) * a, y = p[o + 1] + (q[o + 1] * sign - p[o + 1]) * a;
			const z = p[o + 2] + (q[o + 2] * sign - p[o + 2]) * a, w = p[o + 3] + (q[o + 3] * sign - p[o + 3]) * a;
			const l = Math.hypot(x, y, z, w) || 1;
			iquat[o] = x / l; iquat[o + 1] = y / l; iquat[o + 2] = z / l; iquat[o + 3] = w / l;
		}
		posePuppet(puppet.parts, ipos, iquat);
		sim.bars.forEach((bar, i) => { barPos.set(bar.pos, i * 3); barQuat.set(bar.quat, i * 4); });
		rigView.update(barPos, barQuat, sim.handlePos);

		if (shownStrings !== sim.strings) {
			shownStrings = sim.strings;
			strings.setStrings(sim.strings.map((s) => s.def), sim.strings.map((s) => s.memory));
			// No size yet when the page was opened with no room to draw in (a hidden tab): resize() sets it later.
			if (stage.size) strings.setResolution(stage.size[0] * stage.size[2], stage.size[1] * stage.size[2]);
		}
		let brokenMask = 0;
		sim.strings.forEach((s, i) => { tensionNorm[i] = sim.tension[i] / s.def.max; if (s.broken) brokenMask |= 1 << i; });
		strings.update(ipos, iquat, sim.handlePos, tensionNorm, brokenMask, world.clock, sim.ctl.pull, world.selected);
		sim.setStringLoads(strings.loads(stringLoads));
		if (strings.tangles.enabled) sim.setKnots(strings.knots());

		stage.update(dt, world.clock, { x: ipos[chest * 3], y: ipos[chest * 3 + 1], z: ipos[chest * 3 + 2] });
		if (world.onFrame) world.onFrame(dt, world.clock);
		stage.render(dt);
		if (stage.adapt(dt * 1000)) resize();
		govern(dt, physicsMs, performance.now() - t0);

		frames++;
		if (now - fpsAt > 1000) {
			if (world.onSecond) world.onSecond(Math.round((frames * 1000) / (now - fpsAt)), physMs / frames);
			frames = 0; fpsAt = now; physMs = 0;
		}
	}

	resize();
	return world;
}

/** What to tell someone when the world could not be built. */
export const bootError = (err) => (/webgl|context/i.test(String(err && err.message))
	? 'This browser could not start WebGL, which the stage needs. Try a recent Chrome, Edge, Firefox or Safari.'
	: `The stage could not be set up: ${err && err.message ? err.message : err}`);
