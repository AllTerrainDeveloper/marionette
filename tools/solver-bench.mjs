// A/B benchmark of solver settings: node tools/solver-bench.mjs
// Compares the original single-pass string impulse at 120 Hz x 10 iterations with the
// accumulated, warm-started string solve and smaller steps.
import RAPIER from '../site/vendor/rapier.mjs';
import { PuppetSim } from '../site/js/stage/sim.js';
import { RIG } from '../site/js/shared/rig-config.js';
import * as M from '../site/js/shared/math.js';

await RAPIER.init();
const variants = [
	['120 Hz x10, single pass (before)', { hz: 120, iterations: 10, stringPasses: 1, warmStart: 0 }],
	['120 Hz x10, accumulated x4 + warm start', { hz: 120, iterations: 10, stringPasses: 4, warmStart: 0.9 }],
	['240 Hz x5, single pass', { hz: 240, iterations: 5, stringPasses: 1, warmStart: 0 }],
	['240 Hz x5, accumulated x4 + warm start', { hz: 240, iterations: 5, stringPasses: 4, warmStart: 0.9 }],
	['240 Hz x4, accumulated x3 + warm start', { hz: 240, iterations: 4, stringPasses: 3, warmStart: 0.9 }],
	['480 Hz x2, accumulated x2 + warm start', { hz: 480, iterations: 2, stringPasses: 2, warmStart: 0.9 }],
];
const rows = [];
for (const [name, opts] of variants) {
	const sim = new PuppetSim(RAPIER, RIG, opts);
	const dt = sim.dt;
	const setBars = (pos, quat = [0, 0, 0, 1]) => RIG.bars.forEach((b, i) => { sim.ctl.bars[i].pos = M.add(pos, M.qRot(quat, b.offset)); sim.ctl.bars[i].quat = quat; });
	const gap = () => { let g = 0; for (const j of sim.joints) g = Math.max(g, M.dist(sim.pointAt(j.a, j.anchorA), sim.pointAt(j.b, j.anchorB))); return g; };
	const stretchErr = () => { // how far loaded strings are stretched beyond what their own spring would allow
		let worst = 0;
		sim.strings.forEach((s, i) => {
			const d = M.dist(sim.handleAt(s.handle), sim.pointAt(s.body, s.def.at));
			const over = d - s.rest;
			if (over > 0 && sim.tension[i] < s.def.max * 0.95) worst = Math.max(worst, over - sim.tension[i] / s.def.k);
		});
		return worst;
	};
	// 1. Static accuracy: hang freely; ideal support = weight, ideal jitter = 0.
	setBars(M.add(RIG.home, [0, 0.45, 0]));
	for (let i = 0; i < 10 / dt; i++) sim.step();
	let jitter = 0, load = 0, n = 0; const ref = sim.bodyPos(sim.bodyIx.chest)[1];
	let lo = Infinity, hi = -Infinity;
	for (let i = 0; i < 2 / dt; i++) { sim.step(); const y = sim.bodyPos(sim.bodyIx.chest)[1]; lo = Math.min(lo, y); hi = Math.max(hi, y); load += [...sim.tension].reduce((a, b) => a + b, 0); n++; }
	jitter = hi - lo;
	const loadErr = Math.abs(load / n - sim.totalMass * RIG.gravity) / (sim.totalMass * RIG.gravity);
	// 2. Dynamic accuracy under violent shaking.
	let worstGap = 0, worstStretch = 0, sumGap = 0, m = 0;
	const t0 = performance.now();
	const steps = Math.round(12 / dt);
	for (let i = 0; i < steps; i++) {
		const t = i * dt;
		setBars(M.add(RIG.home, [Math.sin(t * 19) * 0.9, 0.3 + Math.sin(t * 27) * 0.5, Math.cos(t * 23) * 0.7]), M.qFromYPR(Math.sin(t * 9) * 2, Math.sin(t * 17) * 1.1, Math.cos(t * 13) * 1.1));
		sim.step();
		const g = gap(); worstGap = Math.max(worstGap, g); sumGap += g; m++;
		worstStretch = Math.max(worstStretch, stretchErr());
	}
	const ms = (performance.now() - t0) / 12 / 60; // per 60 Hz frame, incl. metric overhead
	// 3. Pure cost per rendered frame.
	const t1 = performance.now();
	for (let i = 0; i < 6 / dt; i++) sim.step();
	const cost = (performance.now() - t1) / 6 / 60;
	rows.push({ name, 'hang jitter (mm)': (jitter * 1000).toFixed(3), 'load error (%)': (loadErr * 100).toFixed(2), 'worst joint gap (mm)': (worstGap * 1000).toFixed(2), 'mean joint gap (mm)': ((sumGap / m) * 1000).toFixed(3), 'string overshoot (mm)': (worstStretch * 1000).toFixed(1), 'ms / 60Hz frame': cost.toFixed(3), resets: sim.resets - 1 });
}
console.table(rows);
