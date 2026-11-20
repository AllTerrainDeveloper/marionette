// Rods (stiff links that push as well as pull) and the saved stringing: node tools/rod-test.mjs
import RAPIER from '../site/vendor/rapier.mjs';
import { PuppetSim } from '../site/js/stage/sim.js';
import { Controller } from '../site/js/stage/control.js';
import { RIG, cloneStrings } from '../site/js/shared/rig-config.js';
import { sanitizeStrings, sanitizeCustomRig, defaultCustomRig } from '../site/js/shared/modes.js';
import { MARIONETTE_PRESETS, parseMarionette, marionetteDocument } from '../site/js/shared/marionette.js';
import * as M from '../site/js/shared/math.js';

await RAPIER.init();
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const mm = (v) => `${(v * 1000).toFixed(1)} mm`;

function world(strings) {
	const rig = { ...RIG, strings };
	const sim = new PuppetSim(RAPIER, rig);
	const ctl = new Controller(sim, rig);
	const targets = new Map();
	ctl.director = (add) => { for (const [key, value] of targets) add(key, value); };
	const run = (seconds, each) => { let fastest = 0; for (let i = 0; i < Math.round(seconds / sim.dt); i++) { if (each) each(i * sim.dt); ctl.update(); sim.step(); fastest = Math.max(fastest, sim.maxSpeed()); } return fastest; };
	const link = (id) => sim.strings.find((s) => s.def.id === id);
	/** How far a link's ends are from being its rest length apart (+ = too long). */
	const error = (id) => { const s = link(id); return M.dist(sim.handleAt(s.handle), sim.pointAt(s.body, s.at)) - s.rest; };
	return { sim, ctl, targets, run, link, error };
}
const preset = (id) => MARIONETTE_PRESETS.find((p) => p.id === id).strings();

// 1. The data: a rod survives every way a string table travels.
{
	const table = preset('sicilian');
	const clean = sanitizeStrings(JSON.parse(JSON.stringify(table)), RIG);
	check('sanitising keeps rods as rods', clean.filter((s) => s.kind === 'rod').map((s) => s.id).join() === 'head,wristL,wristR', clean.filter((s) => s.kind === 'rod').map((s) => s.id).join());
	check('... and strings as strings', clean.every((s) => s.kind === 'rod' || s.kind === undefined) && clean.length === 12);
	check('... and which way a screw eye stands', clean.find((s) => s.id === 'head').out.join() === '0,1,0' && !('out' in clean.find((s) => s.id === 'back')));
	check('an unknown kind is a string', sanitizeStrings([{ ...table[1], kind: 'girder' }], RIG)[0].kind === undefined);
	check('a link to a body that does not exist is dropped', sanitizeStrings([{ ...table[1], body: 'tail' }], RIG).length === 0);
	check('two links never share an id', new Set(sanitizeStrings([table[1], table[1], table[1]], RIG).map((s) => s.id)).size === 3);
	const custom = defaultCustomRig();
	custom.strings[0].kind = 'rod';
	check('a custom rig keeps its rods over the wire', sanitizeCustomRig(JSON.parse(JSON.stringify(custom)), RIG).strings[0].kind === 'rod');
	const doc = parseMarionette(JSON.parse(JSON.stringify(marionetteDocument('Test', table))));
	check('a marionette document round trips', doc && doc.name === 'Test' && doc.strings.length === 12 && doc.strings[0].kind === 'rod');
	check('rubbish is not a marionette', parseMarionette({ strings: [{ body: 'x' }] }) === null && parseMarionette('no') === null && parseMarionette(null) === null);
	check('the default table has no rods', cloneStrings().every((s) => s.kind === undefined));
}

// 2. A string goes slack when its handle comes down; a rod does not.
{
	const loose = world(preset('strings'));
	const stiff = world(preset('sicilian'));
	for (const w of [loose, stiff]) {
		w.run(4);
		w.targets.set('handle.wristL.y', -0.12); w.targets.set('handle.wristL.z', 0.22);   // the hand's handle: forward and down
		w.run(3);
	}
	check('a lowered string hangs slack', loose.error('wristL') < -0.03, `${mm(loose.error('wristL'))} from its length`);
	check('a rod keeps its length when pushed', Math.abs(stiff.error('wristL')) < 0.004, `${mm(stiff.error('wristL'))} from its length`);
	const tie = (w) => w.sim.pointAt(w.sim.bodyIx.forearmL, w.link('wristL').at);
	check('... and moves the arm a slack string leaves alone', M.dist(tie(stiff), tie(loose)) > 0.03, `tie point ${mm(M.dist(tie(stiff), tie(loose)))} from where the string leaves it`);
	check('... and says it is pushing', stiff.link('wristL').push === true && !loose.link('wristL').push);
	check('... while the string beside it is still a string', stiff.link('kneeL').rod === false && stiff.link('wristL').rod === true);
	check('a pushing rod carries load', stiff.sim.tension[stiff.sim.strings.indexOf(stiff.link('wristL'))] > 0.05, `${stiff.sim.tension[stiff.sim.strings.indexOf(stiff.link('wristL'))].toFixed(2)} N`);
}

// 3. A head rod keeps its length with the bar lowered (the puppet folds under it) and lifts like a string.
{
	const stiff = world(preset('headRod'));
	for (const w of [stiff]) { w.run(4); w.targets.set('main.y', -0.12); w.run(3); }
	check('a head rod keeps its length under a lowered bar', Math.abs(stiff.error('head')) < 0.006, mm(stiff.error('head')));
	stiff.targets.set('main.y', 0.3);
	stiff.run(3);
	check('... and lifts the puppet off the floor like any string', stiff.sim.bodyPos(stiff.sim.bodyIx.footL)[1] > 0.15, `foot at ${stiff.sim.bodyPos(stiff.sim.bodyIx.footL)[1].toFixed(3)}`);
}

// 4. Rods stay calm: at rest, thrown about, dropped, and through a reset.
{
	const w = world(preset('sicilian'));
	w.run(6);
	const at = Float32Array.from(w.sim.pos);
	w.run(1);
	let drift = 0;
	for (let i = 0; i < at.length; i += 3) drift = Math.max(drift, Math.hypot(w.sim.pos[i] - at[i], w.sim.pos[i + 1] - at[i + 1], w.sim.pos[i + 2] - at[i + 2]));
	check('a puppet on rods stands still', drift < 0.008, `${mm(drift)} in a second`);
	let worst = 0;
	const fastest = w.run(10, (t) => {
		w.targets.set('main.roll', 0.7 * Math.sin(t * 3)); w.targets.set('main.pitch', 0.6 * Math.sin(t * 4.1)); w.targets.set('main.yaw', Math.sin(t * 2.2));
		w.targets.set('handle.wristL.y', 0.3 * Math.sin(t * 5)); w.targets.set('handle.wristR.x', 0.3 * Math.sin(t * 6)); w.targets.set('main.y', 0.2 * Math.sin(t * 2.7));
		worst = Math.max(worst, Math.abs(w.error('head')));
	});
	check('... survives being thrown about', w.sim.resets === 1 && fastest < 14.5 && w.sim.jointGap() < 0.02, `fastest part ${fastest.toFixed(1)} m/s, joints ${mm(w.sim.jointGap())} apart`);
	check('... the head rod never far from its length', worst < 0.03, `worst ${mm(worst)}`);
	w.targets.clear();
	w.ctl.action('drop');
	w.run(2.5);
	w.ctl.reset();
	w.run(3);
	check('... and stands again after a drop and a reset', Math.abs(w.sim.bodyPos(w.sim.bodyIx.head)[1] - 1.545) < 0.06 && Math.abs(w.error('head')) < 0.004, `head at ${w.sim.bodyPos(w.sim.bodyIx.head)[1].toFixed(3)}`);
	w.ctl.setRigStrings(preset('strings'));
	w.run(3);
	check('restrung with plain strings while running', w.sim.strings.every((s) => !s.rod) && Math.abs(w.sim.bodyPos(w.sim.bodyIx.head)[1] - 1.545) < 0.06 && w.sim.resets === 2);
	w.sim.setRate(480, 4);
	w.ctl.setRigStrings(preset('headRod'));
	w.run(3);
	check('a rod holds at another step rate', Math.abs(w.error('head')) < 0.004 && Math.abs(w.sim.bodyPos(w.sim.bodyIx.head)[1] - 1.545) < 0.06, mm(w.error('head')));
}

// 5. A director stands in for the idle animation, and steps aside for a phone.
{
	const w = world(preset('strings'));
	w.run(20);
	check('a director silences the idle animation', w.ctl.gestures.length === 0);
	w.ctl.director = null;
	w.run(8);
	check('... which comes back when the director leaves', w.ctl.gestures.length > 0 || w.ctl.nextIdle > 6);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll rod checks passed');
process.exit(failures ? 1 : 0);
