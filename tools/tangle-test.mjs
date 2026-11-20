// Strings catching on each other (the optional tangling): node tools/tangle-test.mjs
import RAPIER from '../site/vendor/rapier.mjs';
import { PuppetSim } from '../site/js/stage/sim.js';
import { wrapFrame, stringPath } from '../site/js/shared/string-path.js';
import { StringShape } from '../site/js/shared/string-shape.js';
import { Tangles, withKnots } from '../site/js/shared/string-tangle.js';
import * as M from '../site/js/shared/math.js';

await RAPIER.init();
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };

// 1. Two taut strings in empty space. A hangs straight down; B runs across in front of it and
//    is then carried backwards, through where A is.
function cross(enabled) {
	const tangles = new Tangles();
	tangles.enabled = enabled;
	const A = new StringShape(), B = new StringShape();
	const strings = [{ shape: A, active: true, tension: 10 }, { shape: B, active: true, tension: 10 }];
	const none = [], nothing = new Set();
	let knots = [[], []];
	const lengthOf = (r) => { let l = 0; for (let k = 0; k < r.length - 1; k++) l += M.dist(r[k], r[k + 1]); return l; };
	for (let f = 0; f < 240; f++) {
		const z = -0.1 + Math.min(0.4, f * 0.004);   // B's two ends: from 10 cm in front of A to 30 cm behind it
		const routeA = withKnots([[0, 2, 0], [0, 1, 0]], enabled ? knots[0] : null);
		const routeB = withKnots([[-0.5, 1.5, z], [0.5, 1.5, z]], enabled ? knots[1] : null);
		A.update(routeA, lengthOf(routeA), false, none, nothing, 1 / 60);
		B.update(routeB, lengthOf(routeB), false, none, nothing, 1 / 60);
		knots = tangles.update(strings).map((list) => list.map((k) => ({ at: k.at.slice() })));
	}
	// Where B is as it passes A's line (x = 0), and how far A has been pulled out of its line.
	let zAtA = 0, best = Infinity, bent = 0;
	for (let k = 0; k <= B.n; k++) { const d = Math.abs(B.out[k * 3]); if (d < best) { best = d; zAtA = B.out[k * 3 + 2]; } }
	let zOfA = 0;
	for (let k = 0; k <= A.n; k++) { bent = Math.max(bent, Math.abs(A.out[k * 3 + 2])); if (Math.abs(A.out[k * 3 + 1] - 1.5) < 0.03) zOfA = A.out[k * 3 + 2]; }
	return { zAtA, zOfA, bent, knots: knots[0].length + knots[1].length };
}
{
	const off = cross(false), on = cross(true);
	check('with tangling off, one string passes through another', off.zAtA > 0.25 && off.bent < 0.005 && off.knots === 0, `B ends up ${(off.zAtA * 100).toFixed(1)} cm behind A's line, A is bent ${(off.bent * 1000).toFixed(1)} mm`);
	// (What is drawn follows the chains through the usual checks, so at the crossing the two
	// drawn strings touch: within a few millimetres of each other, not 30 cm apart.)
	check('with tangling on, it catches on it instead', Math.abs(on.zAtA - on.zOfA) < 0.008 && on.knots === 2, `where they cross, the two drawn strings are ${(Math.abs(on.zOfA - on.zAtA) * 1000).toFixed(1)} mm apart, and each string is held there (${on.knots} holds)`);
	check('and drags it along', on.bent > 0.03, `A is pulled ${(on.bent * 100).toFixed(1)} cm out of its line`);
}

// 2. The puppet itself: with tangling on and nobody playing, nothing touches and nothing moves.
{
	const sim = new PuppetSim(RAPIER);
	for (let i = 0; i < sim.opts.hz * 6; i++) sim.step();
	const tangles = new Tangles();
	tangles.enabled = true;
	const shapes = sim.strings.map(() => new StringShape());
	const frame = [];
	let contacts = 0, held = 0, moved = 0;
	const before = [];
	for (let f = 0; f < 600; f++) {
		for (let i = 0; i < sim.opts.hz / 60; i++) sim.step();
		wrapFrame(sim.wrapProxies, sim.pos, sim.quat, frame);
		sim.strings.forEach((s, i) => {
			const route = stringPath(sim.handleAt(s.handle), sim.pointAt(s.body, s.at), frame, s.excluded, undefined, s.memory).points;
			if (f === 540) before[i] = Float32Array.from(shapes[i].out);
			shapes[i].update(route, s.rest, false, frame, s.excluded, 1 / 60, s.memory, s.body);
		});
		const knots = tangles.update(sim.strings.map((s, i) => ({ shape: shapes[i], active: true, tension: sim.tension[i] })));
		contacts = Math.max(contacts, tangles.contacts);
		held += knots.reduce((a, list) => a + list.length, 0);
	}
	shapes.forEach((shape, i) => { for (let k = 0; k < shape.out.length; k++) moved = Math.max(moved, Math.abs(shape.out[k] - before[i][k])); });
	check('a standing puppet\'s strings do not touch each other', contacts === 0 && held === 0, `${contacts} pair(s) of links touching, ${held} hold(s)`);
	check('and stay as still as without it', moved < 0.003, `largest movement in a second ${(moved * 1000).toFixed(2)} mm`);

	// 3. In the physics, a string held somewhere off its line is that much shorter: it pulls.
	const i = sim.strings.findIndex((s) => s.def.id === 'head');
	const average = (seconds) => { let t = 0, n = 0; for (let k = 0; k < sim.opts.hz * seconds; k++) { sim.step(); if (k > sim.opts.hz) { t += sim.tension[i]; n++; } } return t / n; };
	const plain = average(3);
	const a = sim.handleAt(sim.strings[i].handle), b = sim.pointAt(sim.strings[i].body, sim.strings[i].at);
	const at = [(a[0] + b[0]) / 2 + 0.12, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
	const all = sim.strings.map(() => null);
	all[i] = [{ at }];
	sim.setKnots(all);
	const held2 = average(3);
	sim.setKnots(null);
	const after = average(3);
	check('a string held off its line pulls harder, and lets go again', held2 > plain + 1 && Math.abs(after - plain) < 0.5 * Math.max(1, plain) && sim.resets === 1, `head string ${plain.toFixed(1)} N, held 12 cm aside ${held2.toFixed(1)} N, released ${after.toFixed(1)} N`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
