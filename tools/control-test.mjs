// Headless test of the control layer + protocol: node tools/control-test.mjs
import RAPIER from '../site/vendor/rapier.mjs';
import { PuppetSim } from '../site/js/stage/sim.js';
import { Controller } from '../site/js/stage/control.js';
import { RIG } from '../site/js/shared/rig-config.js';
import { MODES, defaultCustomRig } from '../site/js/shared/modes.js';
import { encodeInput, decodeInput, encodeState, decodeState } from '../site/js/shared/protocol.js';
import * as M from '../site/js/shared/math.js';

await RAPIER.init();
const sim = new PuppetSim(RAPIER);
const DT = sim.dt;
const ctl = new Controller(sim);
const ix = sim.bodyIx;
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const fmt = (v) => v.map((n) => n.toFixed(2)).join(', ');
let seq = 0;
const input = (o = {}) => ({ seq: seq++, sensors: true, calibrated: true, quat: [0, 0, 0, 1], gyro: [0, 0, 0], acc: [0, 0, 0], stick: [0, 0], handles: new Map(), pulls: new Map(), ik: new Map(), joints: new Map(), ...o });
const send = (slot, o) => ctl.setInput(slot, decodeInput(encodeInput(input(o))));
function run(seconds, each) { let peak = 0; for (let i = 0; i < Math.round(seconds / DT); i++) { if (each) each(i * DT); ctl.update(); sim.step(); const h = sim.bodyPos(ix.head); peak = Math.max(peak, Math.hypot(h[0], h[1], h[2])); } return peak; }
const head = () => sim.bodyPos(ix.head);

// Protocol round trip.
const packed = decodeInput(encodeInput(input({ quat: M.qFromYPR(0.3, -0.2, 0.5), acc: [1.5, -9, 3], stick: [0.5, -1], handles: new Map([[4, [0.1, 0.2, -0.3]]]), pulls: new Map([[2, 0.3]]), ik: new Map([[1, [0.05, 0.4, 0.1]]]), joints: new Map([[5, [0.5, -0.25, 1]]]) })));
check('input packet round trip', Math.abs(packed.acc[1] + 9) < 0.01 && Math.abs(packed.handles.get(4)[2] + 0.3) < 0.002 && Math.abs(packed.pulls.get(2) - 0.3) < 0.005 && Math.abs(packed.joints.get(5)[0] - 0.5) < 0.03 && packed.stick[1] === -1);
const state = () => ({ seq: 7, time: sim.time * 1000, mode: ctl.modeIndex, phones: ctl.phones, bodyPos: sim.pos, bodyQuat: sim.quat, bars: sim.bars, handlePos: sim.handlePos, tension: [...sim.tension], tensionMax: sim.strings.map((s) => s.def.max), broken: sim.strings.map((s) => s.broken), ik: sim.ctl.ik, locks: sim.ctl.locks });
const buf = encodeState(state());
const back = decodeState(buf);
check('state packet round trip', back && back.bodyPos.length === sim.pos.length && Math.abs(back.bodyPos[ix.head * 3 + 1] - sim.pos[ix.head * 3 + 1]) < 0.002 && back.handlePos.length === sim.handlePos.length, `${buf.byteLength} bytes`);
check('state packet fits one datagram', buf.byteLength < 1100, `${buf.byteLength} bytes`);

// Idle attract animation.
run(25);
check('idle animation stays on stage', sim.resets === 1 && Math.abs(head()[1] - 1.54) < 0.25 && Math.abs(head()[0]) < 0.5, `head ${fmt(head())}`);

// One phone, every mode, with lively input.
ctl.connect(0);
for (const mode of MODES) {
	ctl.setMode(mode.id);
	if (mode.custom) ctl.setCustom(defaultCustomRig());
	const before = sim.resets;
	run(8, (t) => send(0, {
		quat: M.qFromYPR(Math.sin(t * 1.3) * 0.8, Math.sin(t * 2.1) * 0.6, Math.cos(t * 1.7) * 0.6),
		gyro: [Math.sin(t * 5) * 4, Math.cos(t * 4) * 4, Math.sin(t * 6) * 4],
		acc: [Math.sin(t * 14) * 9, Math.cos(t * 17) * 9, Math.sin(t * 12) * 9],
		stick: [Math.sin(t * 0.7), Math.cos(t * 0.5)],
		handles: new Map([[4, [0.1 * Math.sin(t * 3), 0.3 + 0.2 * Math.sin(t * 2), 0]]]),
		pulls: new Map([[6, 0.3 + 0.3 * Math.sin(t * 2.5)]]),
		ik: mode.ik ? new Map([[1, [0.1, 0.4 + 0.2 * Math.sin(t * 3), 0.2]]]) : new Map(),
		joints: mode.jointControl ? new Map([[sim.jointIx.neckTop, [0.3 * Math.sin(t * 2), 0.5, 0]]]) : new Map(),
	}));
	check(`mode "${mode.id}" is stable under lively input`, sim.resets === before && head()[1] > 0.05 && head()[1] < 3.6, `head ${fmt(head())} root ${fmt(ctl.root)}`);
}

// Walking: push the stick right for 4 s; the puppet must travel with its feet under it.
ctl.reset(); ctl.setMode('walk'); run(2, () => send(0, {}));
const x0 = sim.bodyPos(ix.pelvis)[0];
let minHead = 9;
run(4, () => { send(0, { stick: [1, 0] }); minHead = Math.min(minHead, head()[1]); });
const pel = sim.bodyPos(ix.pelvis);
check('walks where the stick points', pel[0] - x0 > 1.2, `travelled ${(pel[0] - x0).toFixed(2)} m`);
check('stays upright while walking', minHead > 1.25, `lowest head ${minHead.toFixed(2)} m`);
const fl = sim.bodyPos(ix.footL), fr = sim.bodyPos(ix.footR);
check('feet stay under the body', Math.abs((fl[0] + fr[0]) / 2 - pel[0]) < 0.45 && Math.min(fl[1], fr[1]) < 0.12, `feet x ${fl[0].toFixed(2)}, ${fr[0].toFixed(2)} pelvis x ${pel[0].toFixed(2)}`);

// Two phones ("Pro"): the second phone rolls the limb bar on its own.
ctl.reset(); ctl.setMode('classic'); ctl.connect(1);
run(3, () => { send(0, {}); send(1, { quat: M.qFromYPR(0, 0, 0.6) }); });
const mainRoll = M.qToYPR(sim.bars[0].quat)[2], limbRoll = M.qToYPR(sim.bars[1].quat)[2];
check('second phone drives the limb bar independently', Math.abs(mainRoll) < 0.05 && Math.abs(limbRoll - 0.6) < 0.08, `main ${mainRoll.toFixed(2)} limb ${limbRoll.toFixed(2)}`);
const kneeL = sim.bodyPos(ix.shinL)[1], kneeR = sim.bodyPos(ix.shinR)[1];
check('rolling the limb bar lifts one leg', Math.abs(sim.bodyPos(ix.footL)[1] - sim.bodyPos(ix.footR)[1]) > 0.03, `shin heights ${kneeL.toFixed(3)} / ${kneeR.toFixed(3)}`);

// Arms mode with two phones: each phone is a hand.
ctl.setMode('arms');
run(3, () => { send(0, { quat: M.qFromYPR(0, -0.6, 0) }); send(1, {}); });
const hl = sim.bodyPos(ix.handL)[1], hr = sim.bodyPos(ix.handR)[1];
check('each phone raises its own hand', hl - hr > 0.25, `left ${hl.toFixed(2)} right ${hr.toFixed(2)}`);

// Self-collision: drive each hand hard at the far side of the body, swapping over and over,
// so the arms have to go around each other and the torso rather than through.
{
	ctl.setMode('arms');
	let worst = 0, pair = null, samples = 0, deep = 0;
	run(10, (t) => {
		const swing = Math.sin(t * 2.2);
		send(0, { ik: new Map([[sim.effIx.handL, [-0.5 - 0.1 * swing, 0.3 + 0.25 * Math.sin(t * 3.1), 0.05]], [sim.effIx.handR, [0.5 + 0.1 * swing, 0.3 + 0.25 * Math.cos(t * 2.7), 0.05]]]) });
		send(1, {});
		if (Math.round(t / DT) % 6 === 0) { const o = sim.deepestOverlap(); samples++; if (o.depth > 0.012) deep++; if (o.depth > worst) { worst = o.depth; pair = o.pair; } }
	});
	check('limbs do not pass through each other or the body', worst < 0.03 && deep / samples < 0.02, `deepest overlap ${(worst * 1000).toFixed(1)} mm (${pair ? pair.join(' / ') : 'none'}), over 12 mm in ${((deep / samples) * 100).toFixed(1)}% of samples`);
}

// Locks.
ctl.setMode('classic'); ctl.setLocks([sim.jointIx.elbowL]);
run(2, () => { send(0, {}); send(1, {}); });
{ const J = sim.joints[sim.jointIx.elbowL]; const now = sim.jointAngles(J)[0]; check('joint lock holds', Math.abs(now - J.lockTarget[0]) < 0.12, `angle ${now.toFixed(3)} locked at ${J.lockTarget[0].toFixed(3)}`); }

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
