// Headless stability test for the puppet simulation: node tools/sim-test.mjs
import RAPIER from '../site/vendor/rapier.mjs';
import { PuppetSim } from '../site/js/stage/sim.js';
import { RIG } from '../site/js/shared/rig-config.js';
import * as M from '../site/js/shared/math.js';

await RAPIER.init();
const sim = new PuppetSim(RAPIER);
const DT = sim.dt;
const ix = sim.bodyIx;
const home = RIG.home;
let failures = 0;
const fmt = (v) => v.map((n) => n.toFixed(3)).join(', ');

function setBars(pos, quat = [0, 0, 0, 1]) {
	RIG.bars.forEach((b, i) => {
		sim.ctl.bars[i].pos = M.add(pos, M.qRot(quat, b.offset));
		sim.ctl.bars[i].quat = quat;
	});
}
function run(seconds, each) {
	let maxSpeed = 0;
	const steps = Math.round(seconds / DT);
	for (let i = 0; i < steps; i++) {
		if (each) each(i * DT);
		sim.step();
		for (const b of sim.bodies) { const v = b.body.linvel(); maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z)); }
	}
	return maxSpeed;
}
function drift(seconds = 1) {
	const before = Float32Array.from(sim.pos);
	run(seconds);
	let worst = 0;
	for (let i = 0; i < before.length; i += 3) worst = Math.max(worst, Math.hypot(sim.pos[i] - before[i], sim.pos[i + 1] - before[i + 1], sim.pos[i + 2] - before[i + 2]));
	return worst;
}
function speedNow() { let m = 0; for (const b of sim.bodies) { const v = b.body.linvel(); m = Math.max(m, Math.hypot(v.x, v.y, v.z)); } return m; }
function check(name, ok, detail = '') { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); }
function report(label) {
	const t = [...sim.tension].map((v) => v.toFixed(0)).join(' ');
	console.log(`  [${label}] pelvis ${fmt(sim.bodyPos(ix.pelvis))} head ${fmt(sim.bodyPos(ix.head))} footL ${fmt(sim.bodyPos(ix.footL))} handL ${fmt(sim.bodyPos(ix.handL))}\n    tension ${t}  speed ${speedNow().toFixed(3)}`);
}

// 1. Standing at rest under the bar.
run(12); report('rest');
{ const d = drift(); check('settles at rest', d < 0.008, `drift ${(d * 1000).toFixed(2)} mm/s`); }
check('stands upright', Math.abs(sim.bodyPos(ix.head)[1] - 1.545) < 0.06 && Math.abs(sim.bodyPos(ix.head)[0]) < 0.03, fmt(sim.bodyPos(ix.head)));
check('support strings carry load', sim.tension[0] + sim.tension[2] + sim.tension[3] > 5);

// 2. Lift off the floor: the puppet must dangle, strings carrying the full weight.
setBars(M.add(home, [0, 0.45, 0])); run(5); report('lifted');
const carried = [...sim.tension].reduce((a, b) => a + b, 0);
check('dangles when lifted', sim.bodyPos(ix.footL)[1] > 0.3, `foot y ${sim.bodyPos(ix.footL)[1].toFixed(3)}`);
check('strings carry the weight', Math.abs(carried - sim.totalMass * 9.81) < 25, `${carried.toFixed(1)} N vs ${(sim.totalMass * 9.81).toFixed(1)} N`);
{ run(4); const d = drift(); check('calm while hanging', d < 0.1, `drift ${(d * 1000).toFixed(1)} mm/s`); }

// 3. Tilt the bar: shoulders must follow.
setBars(M.add(home, [0, 0.2, 0]), M.qFromYPR(0, 0, 0.5)); run(4); report('rolled');
const cq = sim.bodyQuat(ix.chest);
check('chest follows bar roll', Math.abs(M.qToYPR(cq)[2]) > 0.12, `chest roll ${M.qToYPR(cq)[2].toFixed(3)}`);

// 4. Pull the left wrist string: the hand must rise.
setBars(home); run(3);
const handBefore = sim.bodyPos(ix.handL)[1];
sim.ctl.pull[4] = 0.5; run(3); report('wrist pulled');
check('wrist string lifts the hand', sim.bodyPos(ix.handL)[1] - handBefore > 0.3, `rise ${(sim.bodyPos(ix.handL)[1] - handBefore).toFixed(3)}`);
sim.ctl.pull[4] = 0;

// 5. Violent shaking for 12 seconds.
const maxShake = run(12, (t) => {
	setBars(
		M.add(home, [Math.sin(t * 19) * 0.9, 0.3 + Math.sin(t * 27) * 0.5, Math.cos(t * 23) * 0.7]),
		M.qFromYPR(Math.sin(t * 9) * 2, Math.sin(t * 17) * 1.1, Math.cos(t * 13) * 1.1)
	);
	if (Math.round(t / DT) % 7 === 0) sim.ctl.impulses.push({ body: 'chest', impulse: [Math.sin(t * 91) * 5, 3, Math.cos(t * 77) * 5], torque: [1, -1, 1] });
});
report('shaken');
check('survives violent shaking without reset', sim.resets === 1, `resets ${sim.resets}, peak speed ${maxShake.toFixed(1)}`);
let joined = 0;
for (const j of sim.joints) joined = Math.max(joined, M.dist(sim.pointAt(j.a, j.anchorA), sim.pointAt(j.b, j.anchorB)));
check('joints stay assembled', joined < 0.08, `worst gap ${joined.toFixed(4)} m`);

// 6. Recovery.
sim.ctl.balance = 0.3; setBars(home); run(6); report('recovered');
{ run(6); const d = drift(); sim.ctl.balance = 0; check('recovers to standing', d < 0.06 && Math.abs(sim.bodyPos(ix.head)[1] - 1.545) < 0.08, `drift ${(d * 1000).toFixed(1)} mm/s head y ${sim.bodyPos(ix.head)[1].toFixed(3)}`); }

// 7. IK: reach the right hand up and forward.
const e = sim.effIx.handR;
sim.ctl.ik[e] = { w: 1, pos: [-0.35, 1.5, 0.3] };
sim.ctl.tone = { spine: 3, head: 2, arms: 1, legs: 3 }; sim.ctl.balance = 0.8;
run(3); report('ik');
const tipR = sim.pointAt(ix.handR, RIG.effectors[e].tip);
check('IK hand reaches target', M.dist(tipR, [-0.35, 1.5, 0.3]) < 0.1, `error ${M.dist(tipR, [-0.35, 1.5, 0.3]).toFixed(3)} m`);
sim.ctl.ik[e].w = 0;

// 8. Slack everything: collapse to the floor without exploding.
sim.ctl.stringGain = 0; sim.ctl.balance = 0; sim.ctl.tone = { spine: 0.3, head: 0.3, arms: 0.3, legs: 0.3 };
const maxDrop = run(5); report('dropped');
check('collapses calmly when dropped', speedNow() < 0.3 && sim.bodyPos(ix.chest)[1] < 0.6 && sim.bodyPos(ix.chest)[1] > 0.03, `chest y ${sim.bodyPos(ix.chest)[1].toFixed(3)} peak ${maxDrop.toFixed(1)}`);
sim.ctl.stringGain = 1; sim.ctl.tone = { spine: 1, head: 1, arms: 1, legs: 1 };
run(6); report('re-strung');
check('stands back up when re-strung', sim.bodyPos(ix.head)[1] > 1.4, `head y ${sim.bodyPos(ix.head)[1].toFixed(3)}`);

// Timing.
const t0 = performance.now(); run(5); const ms = (performance.now() - t0) / (5 / DT);
console.log(`
${ms.toFixed(3)} ms per physics step (${(ms * sim.opts.hz / 60).toFixed(2)} ms per 60 Hz frame)`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
