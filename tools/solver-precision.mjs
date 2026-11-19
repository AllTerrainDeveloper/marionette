// Precision vs a fine-step reference: node tools/solver-precision.mjs
// Runs one smooth, deterministic manoeuvre and reports how far each solver setting
// drifts from a 1920 Hz reference (RMS over all bodies), plus its cost.
import RAPIER from '../site/vendor/rapier.mjs';
import { PuppetSim } from '../site/js/stage/sim.js';
import { RIG } from '../site/js/shared/rig-config.js';
import * as M from '../site/js/shared/math.js';
await RAPIER.init();

function trajectory(opts, sampleHz = 60, seconds = 2.5) {
	const sim = new PuppetSim(RAPIER, RIG, opts);
	const dt = sim.dt;
	const setBars = (pos, quat = [0, 0, 0, 1]) => RIG.bars.forEach((b, i) => { sim.ctl.bars[i].pos = M.add(pos, M.qRot(quat, b.offset)); sim.ctl.bars[i].quat = quat; });
	setBars(M.add(RIG.home, [0, 0.3, 0]));
	for (let i = 0; i < Math.round(8 / dt); i++) sim.step();          // settle, hanging
	const samples = [];
	const per = Math.round(1 / sampleHz / dt);
	const t0 = performance.now();
	const steps = Math.round(seconds / dt);
	for (let i = 0; i < steps; i++) {
		const t = i * dt;
		const e = Math.min(1, t / 0.4);
		setBars(M.add(RIG.home, [0.35 * Math.sin(t * 3) * e, 0.3 + 0.12 * Math.sin(t * 5) * e, 0.2 * Math.sin(t * 2.2) * e]), M.qFromYPR(0.5 * Math.sin(t * 2) * e, 0.3 * Math.sin(t * 3.1) * e, 0.35 * Math.sin(t * 2.6) * e));
		sim.ctl.pull[4] = 0.35 * e * (0.5 + 0.5 * Math.sin(t * 4));
		sim.step();
		if ((i + 1) % per === 0) samples.push(Float32Array.from(sim.pos));
	}
	return { samples, ms: (performance.now() - t0) / seconds / 60 };
}
const rms = (a, b, upto) => { let s = 0, n = 0; for (let k = 0; k < upto; k++) for (let i = 0; i < a[k].length; i++) { const d = a[k][i] - b[k][i]; s += d * d; n++; } return Math.sqrt((s / n) * 3); };

const ref = trajectory({ hz: 1920, iterations: 2, stringPasses: 4, warmStart: 0.9 });
const ref2 = trajectory({ hz: 960, iterations: 2, stringPasses: 4, warmStart: 0.9 });
const variants = [
	['120 Hz x10, single pass (before)', { hz: 120, iterations: 10, stringPasses: 1, warmStart: 0 }],
	['120 Hz x10, accumulated x4 + warm', { hz: 120, iterations: 10, stringPasses: 4, warmStart: 0.9 }],
	['240 Hz x5, single pass', { hz: 240, iterations: 5, stringPasses: 1, warmStart: 0 }],
	['240 Hz x5, accumulated x4 + warm', { hz: 240, iterations: 5, stringPasses: 4, warmStart: 0.9 }],
	['240 Hz x4, accumulated x2 + warm', { hz: 240, iterations: 4, stringPasses: 2, warmStart: 0.9 }],
	['480 Hz x2, accumulated x2 + warm', { hz: 480, iterations: 2, stringPasses: 2, warmStart: 0.9 }],
	['480 Hz x3, single pass', { hz: 480, iterations: 3, stringPasses: 1, warmStart: 0 }],
];
console.log(`reference self-consistency (960 Hz vs 1920 Hz): ${(rms(ref2.samples, ref.samples, 60) * 1000).toFixed(2)} mm @1s, ${(rms(ref2.samples, ref.samples, 150) * 1000).toFixed(2)} mm @2.5s`);
const rows = variants.map(([name, opts]) => {
	const r = trajectory(opts);
	return { name, 'error @1.0 s (mm)': (rms(r.samples, ref.samples, 60) * 1000).toFixed(2), 'error @2.5 s (mm)': (rms(r.samples, ref.samples, 150) * 1000).toFixed(2), 'ms / 60Hz frame': r.ms.toFixed(3) };
});
console.table(rows);
