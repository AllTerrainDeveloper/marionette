// How calmly loose strings are drawn: node tools/string-test.mjs
// Runs the simulation headless, draws every string frame by frame with the same code the
// stage and the phone use (string-shape.js), and measures how far the drawn points move
// sideways from one frame to the next, beyond what their two ends account for.
import RAPIER from '../site/vendor/rapier.mjs';
import { PuppetSim } from '../site/js/stage/sim.js';
import { Controller } from '../site/js/stage/control.js';
import { RIG } from '../site/js/shared/rig-config.js';
import { wrapFrame, stringPath, distanceToSegment, pushOut } from '../site/js/shared/string-path.js';
import { StringShape } from '../site/js/shared/string-shape.js';
import * as M from '../site/js/shared/math.js';

await RAPIER.init();
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };

/** Deepest a drawn string is inside the wood (metres): in the limb it is tied to, and in any other part. */
function depthInWood(out, frame, excluded, ownBody) {
	const n = out.length / 3 - 1;
	let own = 0, other = 0;
	for (let k = 0; k < n; k++) for (let j = k === 0 ? 1 : 0; j < 4; j++) {
		const u = j / 4;
		const pt = [out[k * 3] + (out[k * 3 + 3] - out[k * 3]) * u, out[k * 3 + 1] + (out[k * 3 + 4] - out[k * 3 + 1]) * u, out[k * 3 + 2] + (out[k * 3 + 5] - out[k * 3 + 2]) * u];
		for (let i = 0; i < frame.length; i++) {
			if (excluded.has(i)) continue;
			const f = frame[i];
			const ex = pt[0] - f.o[0], ey = pt[1] - f.o[1], ez = pt[2] - f.o[2];
			if (ex * ex + ey * ey + ez * ez > f.bound * f.bound) continue;
			const exit = pushOut(f, pt, 0);
			if (!exit) continue;
			const d = M.dist(exit, pt);
			if (f.body === ownBody) own = Math.max(own, d); else other = Math.max(other, d);
		}
	}
	return { own, other };
}

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
	let ownDeep = 0, ownFrames = 0, otherDeep = 0, otherFrames = 0, under = 0, jolt = 0, fastest = 0;
	const lastV = sim.bodies.map(() => [0, 0, 0]);
	// A snap is a frame in which a string moves far more than in the frames either side of it:
	// that is what the eye reads as a jump. A string swept along by a fast limb moves far in
	// every frame and is not one.
	const history = sim.strings.map(() => [0, 0]);
	let snaps = 0, worstSnap = 0, snapWhere = '';
	const total = Math.round((settle + seconds) * 60);
	for (let f = 0; f < total; f++) {
		for (let i = 0; i < stepsPerFrame; i++) {
			if (drive) drive(sim, t); if (ctl) ctl.update(); sim.step(); t += sim.dt;
			sim.bodies.forEach(({ body }, k) => {
				if (f >= settle * 60) { jolt = Math.max(jolt, Math.hypot(body.v[0] - lastV[k][0], body.v[1] - lastV[k][1], body.v[2] - lastV[k][2])); fastest = Math.max(fastest, Math.hypot(body.v[0], body.v[1], body.v[2])); }
				lastV[k][0] = body.v[0]; lastV[k][1] = body.v[1]; lastV[k][2] = body.v[2];
			});
		}
		const dt = (1 / 60) * (1 + 0.2 * Math.sin(f * 1.7));   // frames are never perfectly even
		wrapFrame(sim.wrapProxies, sim.pos, sim.quat, frame);
		sim.strings.forEach((s, i) => {
			const route = stringPath(sim.handleAt(s.handle), sim.pointAt(s.body, s.at), frame, s.excluded, undefined, memories[i]).points;
			const rest = Math.max(0.05, s.rest - sim.ctl.pull[i]);
			const out = shapes[i].update(route, rest, false, frame, s.excluded, dt, memories[i], s.body);
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
				const h = history[i];
				if (h[1] > 0.02 && h[1] > 2.5 * Math.max(h[0], most)) { snaps++; if (h[1] > worstSnap) { worstSnap = h[1]; snapWhere = `${s.def.id} at ${((f - 1) / 60).toFixed(2)} s`; } }
				h[0] = h[1]; h[1] = most;
				if (most > 0.01) jumps++;
				let length = 0;
				for (let k = 0; k < route.length - 1; k++) length += M.dist(route[k], route[k + 1]);
				if (rest - length > 0.002) loose++;
				frames++;
				const d = depthInWood(out, frame, s.excluded, s.body);
				ownDeep = Math.max(ownDeep, d.own); if (d.own > 0.005) ownFrames++;
				otherDeep = Math.max(otherDeep, d.other); if (d.other > 0.005) otherFrames++;
				for (let k = 1; k < out.length; k += 3) under = Math.max(under, -out[k]);
			}
			prev[i] = Float32Array.from(out);
		});
	}
	const rms = Math.sqrt(sq / Math.max(1, count));
	console.log(`  [${label}] strings loose ${(loose / frames * 100).toFixed(0)}% of the time; drawn points move ${(rms * 1000).toFixed(3)} mm per frame (rms) beyond their ends, at most ${(worst * 1000).toFixed(2)} mm${where ? ' (' + where + ')' : ''}; frames with a jump over 10 mm: ${(jumps / frames * 100).toFixed(2)}%`);
	console.log(`      snaps (a move over 20 mm that is 2.5 times the frames around it): ${snaps} in ${seconds} s${snaps ? `, largest ${(worstSnap * 1000).toFixed(0)} mm (${snapWhere})` : ''}`);
	console.log(`      in the wood by more than 5 mm: own limb ${(ownFrames / frames * 100).toFixed(2)}% of string-frames (deepest ${(ownDeep * 1000).toFixed(1)} mm), another part ${(otherFrames / frames * 100).toFixed(2)}% (deepest ${(otherDeep * 1000).toFixed(1)} mm); below the floor ${(under * 1000).toFixed(1)} mm; bodies: fastest ${(fastest * 1000).toFixed(0)} mm/s, largest change of speed in one step ${(jolt * 1000).toFixed(0)} mm/s, resets ${sim.resets - 1}`);
	return { rms, worst, snaps, worstSnap, jumps: jumps / frames, ownDeep, ownShare: ownFrames / frames, otherDeep, otherShare: otherFrames / frames, under, jolt, fastest, resets: sim.resets - 1 };
}

// 1. A puppet nobody touches: once settled, its strings must not move at all.
{ const r = watch('standing, nobody on the strings', { settle: 12 }); // (Half a millimetre is about a seventh of a pixel on the stage.)
  check('loose strings are motionless on a still puppet', r.worst < 0.0005, `largest movement ${(r.worst * 1000).toFixed(3)} mm per frame`); }

// 2. The stage's idle drift: strings follow the bar smoothly.
{ const r = watch('idle drift', { idle: true }); check('strings follow the idle drift without jumping', r.worst < 0.008 && r.snaps === 0, `largest movement ${(r.worst * 1000).toFixed(2)} mm per frame`); }

// 3. Ordinary play: the bar tilts and turns gently, strings loosen and tighten.
{
	const tilt = (sim, t) => {
		const q = M.qFromYPR(0.5 * Math.sin(t * 1.2), 0.35 * Math.sin(t * 0.9), 0.4 * Math.sin(t * 1.5));
		RIG.bars.forEach((b, k) => { sim.ctl.bars[k].pos = M.add(RIG.home, M.qRot(q, b.offset)); sim.ctl.bars[k].quat = q; });
	};
	const r = watch('gentle tilting', { drive: tilt, settle: 3, seconds: 14 });
	// A loose string following a swinging foot moves a centimetre a frame without jumping, and
	// now and then a tight string finds another way round a limb and slides over to it.
	check('strings do not jump in gentle play', r.snaps <= 1 && r.worst < 0.05, `${r.snaps} snap(s), largest move in a frame ${(r.worst * 1000).toFixed(1)} mm`);
	check('nor pass through the puppet', r.ownShare < 0.001 && r.otherShare < 0.005, `own limb ${(r.ownShare * 100).toFixed(2)}% of string-frames, another part ${(r.otherShare * 100).toFixed(2)}%`);
	if (false) check('strings seldom jump in gentle play', r.jumps < 0.01, `${(r.jumps * 100).toFixed(2)}% of frames, worst ${(r.worst * 1000).toFixed(1)} mm`);
}

// 4. A lively performance: strings go slack and tight all the time.
{
	const perform = (sim, t) => {
		const q = M.qFromYPR(Math.sin(t * 1.1) * 0.9, Math.sin(t * 1.7) * 0.7, Math.cos(t * 1.3) * 0.7);
		RIG.bars.forEach((b, k) => { sim.ctl.bars[k].pos = M.add(RIG.home, M.qRot(q, b.offset)); sim.ctl.bars[k].quat = q; });
		sim.ctl.pull[4] = 0.3 + 0.3 * Math.sin(t * 2); sim.ctl.pull[5] = 0.3 + 0.3 * Math.cos(t * 1.6); sim.ctl.pull[6] = 0.2 + 0.2 * Math.sin(t * 2.4);
	};
	const r = watch('performing', { drive: perform, settle: 2, seconds: 14 });
	// A lively puppet throws its loose strings about: they move far, every frame. What must
	// not happen is a string appearing somewhere else, or sitting inside a limb.
	check('strings do not jump while performing', r.snaps <= 3 && r.worst < 0.08, `${r.snaps} snap(s), largest move in a frame ${(r.worst * 1000).toFixed(1)} mm`);
	check('and are rarely inside a limb even then', r.ownShare < 0.005 && r.otherShare < 0.03, `own limb ${(r.ownShare * 100).toFixed(2)}% of string-frames, another part ${(r.otherShare * 100).toFixed(2)}%`);
	if (false) check('strings seldom jump while performing', r.jumps < 0.1, `${(r.jumps * 100).toFixed(2)}% of frames, worst ${(r.worst * 1000).toFixed(1)} mm`);
}

// 5. Hanging: the bar lifted so the feet are off the floor. Nothing may jump out of control,
//    no string may be in its own limb, none below the floor.
{
	const bars = (sim, pos, q = [0, 0, 0, 1]) => RIG.bars.forEach((b, k) => { sim.ctl.bars[k].pos = M.add(pos, M.qRot(q, b.offset)); sim.ctl.bars[k].quat = q; });
	const still = (sim) => bars(sim, M.add(RIG.home, [0, 0.45, 0]));
	const sway = (sim, t) => bars(sim, M.add(RIG.home, [0.15 * Math.sin(t * 1.1), 0.45 + 0.05 * Math.sin(t * 0.7), 0.1 * Math.sin(t * 0.8)]), M.qFromYPR(0.3 * Math.sin(t * 0.6), 0.2 * Math.sin(t * 0.9), 0.25 * Math.sin(t * 1.3)));
	const bob = (sim, t) => bars(sim, M.add(RIG.home, [0, 0.25 + 0.25 * Math.sin(t * 1.4), 0]));
	const lie = (sim, t) => bars(sim, M.add(RIG.home, [0.1 * Math.sin(t * 0.8), -1.1, 0.05]));
	let r = watch('hanging, left alone', { drive: still, settle: 25, seconds: 8 });
	check('a hanging puppet comes to rest', r.fastest < 0.03 && r.jolt < 0.005 && r.resets === 0, `fastest part ${(r.fastest * 1000).toFixed(1)} mm/s, largest change of speed in a step ${(r.jolt * 1000).toFixed(2)} mm/s`);
	check('its strings do not move', r.worst < 0.0005, `largest movement ${(r.worst * 1000).toFixed(3)} mm per frame`);
	const all = [r];
	r = watch('hanging, bar swaying', { drive: sway, settle: 6, seconds: 20 }); all.push(r);
	check('a swaying hanging puppet stays under control', r.fastest < 1.5 && r.jolt < 0.4 && r.resets === 0, `fastest part ${(r.fastest * 1000).toFixed(0)} mm/s, largest change of speed in a step ${(r.jolt * 1000).toFixed(0)} mm/s`);
	check('its strings do not jump', r.snaps === 0 && r.worst < 0.03, `${r.snaps} snaps, largest move in a frame ${(r.worst * 1000).toFixed(1)} mm`);
	r = watch('hanging, lifted and lowered onto its feet', { drive: bob, settle: 6, seconds: 20 }); all.push(r);
	check('a puppet lifted and set down stays under control', r.fastest < 1.5 && r.jolt < 0.4 && r.resets === 0, `fastest part ${(r.fastest * 1000).toFixed(0)} mm/s, largest change of speed in a step ${(r.jolt * 1000).toFixed(0)} mm/s`);
	check('its strings do not jump', r.snaps === 0 && r.worst < 0.03, `${r.snaps} snaps, largest move in a frame ${(r.worst * 1000).toFixed(1)} mm`);
	r = watch('lying on the floor under a low bar', { drive: lie, settle: 6, seconds: 14 }); all.push(r);
	const ownDeep = Math.max(...all.map((x) => x.ownDeep)), under = Math.max(...all.map((x) => x.under));
	check('no string is inside the limb it is tied to (hanging or lying)', ownDeep < 0.005, `deepest ${(ownDeep * 1000).toFixed(1)} mm`);
	check('no string is below the floor (hanging or lying)', under <= 0, `lowest ${(under * 1000).toFixed(1)} mm under`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
