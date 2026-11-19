// Compares solver settings on the same hard scenario: node tools/solver-bench.mjs
// A folded-up puppet under a low, tilting bar with two strings being pulled — joints,
// limits, contacts and strings all fight. Reports how well each setting holds them.
import RAPIER from '../site/vendor/rapier.mjs';
import { PuppetSim } from '../site/js/stage/sim.js';
import { RIG } from '../site/js/shared/rig-config.js';
import * as M from '../site/js/shared/math.js';

await RAPIER.init();

const variants = [
	['120 Hz x 6', { hz: 120, iterations: 6 }],
	['120 Hz x 10', { hz: 120, iterations: 10 }],
	['180 Hz x 5', { hz: 180, iterations: 5 }],
	['240 Hz x 4', { hz: 240, iterations: 4 }],
	['240 Hz x 5 (default)', {}],
	['240 Hz x 8', { iterations: 8 }],
	['360 Hz x 4', { hz: 360, iterations: 4 }],
	['360 Hz x 5', { hz: 360, iterations: 5 }],
	['480 Hz x 4', { hz: 480, iterations: 4 }],
	['480 Hz x 5', { hz: 480, iterations: 5 }],
	['720 Hz x 4', { hz: 720, iterations: 4 }],
	['960 Hz x 4', { hz: 960, iterations: 4 }],
];

function drive(sim, t) {
	const q = M.qFromYPR(Math.sin(t * 0.9) * 1.6, 0.75 * Math.sin(t * 1.3), 0.7 * Math.sin(t * 1.1 + 1));
	RIG.bars.forEach((b, k) => {
		sim.ctl.bars[k].pos = M.add(M.add(RIG.home, [0.25 * Math.sin(t * 0.7), -0.45 + 0.25 * Math.sin(t * 1.7), 0.2 * Math.cos(t * 0.8)]), M.qRot(q, b.offset));
		sim.ctl.bars[k].quat = q;
	});
	sim.ctl.pull[4] = 0.4 + 0.3 * Math.sin(t * 2.1);
	sim.ctl.pull[7] = 0.35 + 0.3 * Math.sin(t * 1.6);
}

const mm = (v) => `${(v * 1000).toFixed(1)} mm`;
for (const [label, opts] of variants) {
	const sim = new PuppetSim(RAPIER, RIG, opts);
	const hz = sim.opts.hz;
	// Standing still first: how calm is it?
	for (let i = 0; i < hz * 5; i++) sim.step();
	let rest = 0;
	for (let i = 0; i < hz * 2; i++) { sim.step(); rest = Math.max(rest, sim.maxSpeed()); }
	let gap = 0, overlap = 0, limit = 0;
	const steps = hz * 14;
	const t0 = performance.now();
	for (let i = 0; i < steps; i++) {
		drive(sim, i * sim.dt);
		sim.step();
		gap = Math.max(gap, sim.jointGap());
		for (const j of sim.joints) for (let n = 0; n < j.force.n; n++) limit = Math.max(limit, j.force.th[n] - j.force.hi[n], j.force.lo[n] - j.force.th[n]);
		if (i % Math.round(hz / 30) === 0) overlap = Math.max(overlap, sim.deepestOverlap().depth);
	}
	const ms = (performance.now() - t0) / steps;
	console.log(`${label.padEnd(30)} at rest ${(rest * 1000).toFixed(0).padStart(4)} mm/s | joint gap ${mm(gap).padStart(8)} | past a limit ${(limit * 57.3).toFixed(1).padStart(5)} deg | limb overlap ${mm(overlap).padStart(8)} | resets ${sim.resets - 1} | ${(ms * hz / 60).toFixed(2)} ms per 60 Hz frame`);
}
