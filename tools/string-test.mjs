// How calmly loose strings are drawn: node tools/string-test.mjs
// Runs the simulation headless, draws every string frame by frame with the same code the
// stage and the phone use (string-shape.js), and measures how far the drawn points move
// sideways from one frame to the next, beyond what their two ends account for.
import RAPIER from '../site/vendor/rapier.mjs';
import { PuppetSim } from '../site/js/stage/sim.js';
import { Controller } from '../site/js/stage/control.js';
import { RIG } from '../site/js/shared/rig-config.js';
import { wrapFrame, stringPath, distanceToSegment } from '../site/js/shared/string-path.js';
import { StringShape } from '../site/js/shared/string-shape.js';
import * as M from '../site/js/shared/math.js';

await RAPIER.init();
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };

function watch(label, { idle = false, drive = null, settle = 8, seconds = 10 }) {
	const sim = new PuppetSim(RAPIER);
	const ctl = idle ? new Controller(sim) : null;
	if (ctl) ctl.nextIdle = 1e9;   // the drifting bar only, no scripted moves
	const shapes = sim.strings.map(() => new StringShape());
	const prev = sim.strings.map(() => null);
	const memories = sim.strings.map(() => ({}));
	const frame = [];
	const carried = new Float32Array(45 * 3);
	const stepsPerFrame = sim.opts.hz / 60;
	let t = 0, sq = 0, count = 0, worst = 0, where = '', jumps = 0, loose = 0, frames = 0;
	const total = Math.round((settle + seconds) * 60);
	for (let f = 0; f < total; f++) {
		for (let i = 0; i < stepsPerFrame; i++) { if (drive) drive(sim, t); if (ctl) ctl.update(); sim.step(); t += sim.dt; }
		const dt = (1 / 60) * (1 + 0.2 * Math.sin(f * 1.7));   // frames are never perfectly even
		wrapFrame(sim.wrapProxies, sim.pos, sim.quat, frame);
		sim.strings.forEach((s, i) => {
			const route = stringPath(sim.handleAt(s.handle), sim.pointAt(s.body, s.at), frame, s.excluded, undefined, memories[i]).points;
			const rest = Math.max(0.05, s.rest - sim.ctl.pull[i]);
			const out = shapes[i].update(route, rest, false, frame, s.excluded, dt);
			const n = out.length / 3 - 1;
			if (prev[i] && f >= settle * 60) {
				const a = prev[i];
				let most = 0;
				// Carry last frame's string along with its two ends, then see how far each point of
				// the new string lies from that curve. Points sliding along an unchanged string do
				// not count; the string moving sideways does.
				const was = carried;
				for (let k = 0; k <= n; k++) {
					const u = k / n;
					for (let c = 0; c < 3; c++) was[k * 3 + c] = a[k * 3 + c] + (out[c] - a[c]) * (1 - u) + (out[n * 3 + c] - a[n * 3 + c]) * u;
				}
				for (let k = 1; k < n; k++) {
					let d = Infinity;
					for (let j = 0; j < n; j++) d = Math.min(d, distanceToSegment([out[k * 3], out[k * 3 + 1], out[k * 3 + 2]], [was[j * 3], was[j * 3 + 1], was[j * 3 + 2]], [was[j * 3 + 3], was[j * 3 + 4], was[j * 3 + 5]]));
					most = Math.max(most, d);
					sq += d * d; count++;
				}
				if (most > worst) { worst = most; where = `${s.def.id} at ${(f / 60).toFixed(1)} s`; }
				if (most > 0.01) jumps++;
				let length = 0;
				for (let k = 0; k < route.length - 1; k++) length += M.dist(route[k], route[k + 1]);
				if (rest - length > 0.002) loose++;
				frames++;
			}
			prev[i] = Float32Array.from(out);
		});
	}
	const rms = Math.sqrt(sq / Math.max(1, count));
	console.log(`  [${label}] strings loose ${(loose / frames * 100).toFixed(0)}% of the time; drawn points move ${(rms * 1000).toFixed(3)} mm per frame (rms) beyond their ends, at most ${(worst * 1000).toFixed(2)} mm${where ? ' (' + where + ')' : ''}; frames with a jump over 10 mm: ${(jumps / frames * 100).toFixed(2)}%`);
	return { rms, worst, jumps: jumps / frames };
}

// 1. A puppet nobody touches: once settled, its strings must not move at all.
{ const r = watch('standing, nobody on the strings', { settle: 12 }); // (Half a millimetre is about a seventh of a pixel on the stage.)
  check('loose strings are motionless on a still puppet', r.worst < 0.0005, `largest movement ${(r.worst * 1000).toFixed(3)} mm per frame`); }

// 2. The stage's idle drift: strings follow the bar smoothly.
{ const r = watch('idle drift', { idle: true }); check('strings follow the idle drift without jitter', r.worst < 0.002, `largest movement ${(r.worst * 1000).toFixed(2)} mm per frame`); }

// 3. Ordinary play: the bar tilts and turns gently, strings loosen and tighten.
{
	const tilt = (sim, t) => {
		const q = M.qFromYPR(0.5 * Math.sin(t * 1.2), 0.35 * Math.sin(t * 0.9), 0.4 * Math.sin(t * 1.5));
		RIG.bars.forEach((b, k) => { sim.ctl.bars[k].pos = M.add(RIG.home, M.qRot(q, b.offset)); sim.ctl.bars[k].quat = q; });
	};
	const r = watch('gentle tilting', { drive: tilt, settle: 3, seconds: 14 });
	// A loose string following a swinging foot moves a centimetre a frame without jumping, and
	// now and then a tight string finds another way round a limb and slides over to it.
	check('strings do not jump in gentle play', r.jumps < 0.01 && r.worst < 0.05, `${(r.jumps * 100).toFixed(2)}% of frames, worst ${(r.worst * 1000).toFixed(1)} mm`);
}

// 4. A lively performance: strings go slack and tight all the time.
{
	const perform = (sim, t) => {
		const q = M.qFromYPR(Math.sin(t * 1.1) * 0.9, Math.sin(t * 1.7) * 0.7, Math.cos(t * 1.3) * 0.7);
		RIG.bars.forEach((b, k) => { sim.ctl.bars[k].pos = M.add(RIG.home, M.qRot(q, b.offset)); sim.ctl.bars[k].quat = q; });
		sim.ctl.pull[4] = 0.3 + 0.3 * Math.sin(t * 2); sim.ctl.pull[5] = 0.3 + 0.3 * Math.cos(t * 1.6); sim.ctl.pull[6] = 0.2 + 0.2 * Math.sin(t * 2.4);
	};
	const r = watch('performing', { drive: perform, settle: 2, seconds: 14 });
	// Not zero: a lively puppet throws its loose strings about, and a tight string wound round
	// several limbs changes route abruptly. Before the chain was carried with its ends and the
	// drawing eased, a quarter of all frames had such a jump.
	check('strings seldom jump while performing', r.jumps < 0.1, `${(r.jumps * 100).toFixed(2)}% of frames, worst ${(r.worst * 1000).toFixed(1)} mm`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
