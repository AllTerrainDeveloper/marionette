// The puppets and the ways to string them: node tools/marionette-test.mjs
// Every model on every traditional stringing must be a puppet that stands, keeps still, can be
// thrown about and comes back; and the saved document must carry both through storage and files.
import RAPIER from '../site/vendor/rapier.mjs';
import { PuppetSim } from '../site/js/stage/sim.js';
import { Controller } from '../site/js/stage/control.js';
import { RIG, cloneStrings } from '../site/js/shared/rig-config.js';
import { sanitizeStrings } from '../site/js/shared/modes.js';
import { MODELS, DEFAULT_MODEL, SHAPES, modelById } from '../site/js/shared/puppet-shapes.js';
import { buildWrapProxies, effectiveAttach } from '../site/js/shared/string-path.js';
import { MARIONETTE_PRESETS, MARIONETTE_VERSION, parseMarionette, marionetteDocument, rigForModel, presetOf } from '../site/js/shared/marionette.js';

await RAPIER.init();
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const mm = (v) => `${(v * 1000).toFixed(1)} mm`;
const kind = (s) => (s.enabled === false ? 'off' : s.kind === 'rod' ? 'rod' : 'string');
const count = (table, k) => table.filter((s) => kind(s) === k).length;

// 1. The data.
{
	check('there are three puppets and eight stringings', MODELS.length === 3 && MARIONETTE_PRESETS.length === 8, `${MODELS.length} models, ${MARIONETTE_PRESETS.length} presets`);
	check('the first model is the gentleman the rig was made for', MODELS[0].id === DEFAULT_MODEL && MODELS[0].shapes === SHAPES && modelById('nobody').id === DEFAULT_MODEL);
	for (const model of MODELS) {
		const missing = RIG.bodies.filter((b) => !(model.shapes[b.id] && model.shapes[b.id].length)).map((b) => b.id);
		check(`${model.id}: every body has solid pieces`, missing.length === 0 && Object.keys(model.shapes).length === RIG.bodies.length, missing.join());
		const lowest = Math.min(...['footL', 'footR'].map((id) => Math.min(...model.shapes[id].map((p) => p.at[1] + Math.min(...p.profile.map(([, y]) => y)) * p.scale[1])) + RIG.bodies.find((b) => b.id === id).pos[1]));
		check(`${model.id}: its soles are on the floor`, Math.abs(lowest) < 0.004, mm(lowest));
		// A tie point is moved out of the wood on this model's own surface.
		const proxies = buildWrapProxies(RIG.bodies, model.shapes);
		const head = effectiveAttach(cloneStrings()[0], RIG.bodies, proxies);
		check(`${model.id}: the head string is tied on top of its head`, head[1] > 0.1 && head[1] < 0.24 && Math.hypot(head[0], head[2]) < 0.03, `eye at ${head.map((v) => v.toFixed(3))}`);
	}
	const ids = new Set();
	for (const p of MARIONETTE_PRESETS) {
		const table = p.strings(), clean = sanitizeStrings(table, RIG);
		ids.add(p.id);
		check(`${p.id}: survives sanitising whole`, clean.length === table.length && clean.every((s, i) => kind(s) === kind(table[i]) && s.id === table[i].id) && count(clean, 'off') < clean.length, `${count(clean, 'string')} strings, ${count(clean, 'rod')} rods, ${count(clean, 'off')} off`);
		check(`${p.id}: is recognised as itself`, presetOf(p.strings()).id === p.id && typeof p.tradition === 'string' && p.about.length > 20 && p.feel.length > 10);
	}
	check('no two stringings share an id or a table', ids.size === MARIONETTE_PRESETS.length && new Set(MARIONETTE_PRESETS.map((p) => JSON.stringify(p.strings()))).size === MARIONETTE_PRESETS.length);
	const changed = MARIONETTE_PRESETS[0].strings(); changed[4].slack = 0.0153;
	check('a stringing changed by hand is nobody’s', presetOf(changed) === null);
	check('a preset hands out a fresh table every time', MARIONETTE_PRESETS[0].strings()[4].slack !== 0.0153);
	const expected = { strings: [12, 0], beginner: [7, 0], headRod: [10, 1], sicilian: [8, 3], liege: [0, 1], kathputli: [4, 0], burmese: [15, 0], yoke: [7, 2] };
	for (const p of MARIONETTE_PRESETS) check(`${p.id}: ${expected[p.id][0]} strings and ${expected[p.id][1]} rods`, count(p.strings(), 'string') === expected[p.id][0] && count(p.strings(), 'rod') === expected[p.id][1]);

	const doc = parseMarionette(JSON.parse(JSON.stringify(marionetteDocument('Orlando', MARIONETTE_PRESETS.find((p) => p.id === 'sicilian').strings(), 'knight'))));
	check('a document carries its model', doc && doc.model === 'knight' && doc.name === 'Orlando' && doc.strings.filter((s) => s.kind === 'rod').length === 3);
	check('... and says which version wrote it', marionetteDocument('x', cloneStrings()).version === MARIONETTE_VERSION && marionetteDocument('x', cloneStrings()).model === DEFAULT_MODEL);
	check('an older document with no model is the gentleman', parseMarionette({ version: 1, name: 'Old', strings: cloneStrings() }).model === DEFAULT_MODEL);
	check('... and so is one that names a puppet there is not', parseMarionette({ name: 'Odd', model: 'dragon', strings: cloneStrings() }).model === DEFAULT_MODEL);
	const rig = rigForModel('ballerina');
	check('a model’s rig is the same skeleton in other wood', rig.model === 'ballerina' && rig.shapes === modelById('ballerina').shapes && rig.bodies === RIG.bodies && rig.joints === RIG.joints && rig.strings === RIG.strings);
}

// 2. Every puppet, on every stringing: stands, keeps still, is thrown about, comes back.
for (const model of MODELS) {
	for (const p of MARIONETTE_PRESETS) {
		const rig = { ...rigForModel(model.id), strings: p.strings() };
		const sim = new PuppetSim(RAPIER, rig);
		const ctl = new Controller(sim, rig);
		const targets = new Map();
		ctl.director = (add) => { for (const [key, value] of targets) add(key, value); };
		const run = (seconds, each) => { let fastest = 0; for (let i = 0; i < Math.round(seconds / sim.dt); i++) { if (each) each(i * sim.dt); ctl.update(); sim.step(); fastest = Math.max(fastest, sim.maxSpeed()); } return fastest; };
		const y = (id) => sim.bodyPos(sim.bodyIx[id])[1];
		run(6);
		const at = Float32Array.from(sim.pos);
		run(1);
		let drift = 0;
		for (let i = 0; i < at.length; i += 3) drift = Math.max(drift, Math.hypot(sim.pos[i] - at[i], sim.pos[i + 1] - at[i + 1], sim.pos[i + 2] - at[i + 2]));
		const name = `${model.id} on ${p.id}`;
		check(`${name}: stands and keeps still`, Math.abs(y('head') - 1.545) < 0.03 && Math.abs(y('chest') - 1.245) < 0.03 && y('footL') < 0.06 && y('footR') < 0.06 && drift < 0.02, `head ${y('head').toFixed(3)}, ${mm(drift)} in a second`);
		const fastest = run(8, (t) => {
			targets.set('main.roll', 0.5 * Math.sin(t * 3)); targets.set('main.pitch', 0.4 * Math.sin(t * 4.1)); targets.set('main.yaw', 0.8 * Math.sin(t * 2.2));
			targets.set('main.y', 0.15 * Math.sin(t * 2.7)); targets.set('handle.wristL.y', 0.3 * Math.sin(t * 5)); targets.set('handle.kneeR.y', 0.2 * Math.sin(t * 3.3));
		});
		check(`${name}: survives being thrown about`, sim.resets === 1 && fastest < 14.5 && sim.jointGap() < 0.02, `fastest part ${fastest.toFixed(1)} m/s, joints ${mm(sim.jointGap())} apart`);
		targets.clear();
		ctl.reset();
		run(3);
		check(`${name}: stands again after a reset`, Math.abs(y('head') - 1.545) < 0.03 && y('footL') < 0.06, `head ${y('head').toFixed(3)}`);
	}
}

// 3. Restringing a running puppet from one tradition to the next.
{
	const rig = { ...rigForModel('knight'), strings: MARIONETTE_PRESETS[0].strings() };
	const sim = new PuppetSim(RAPIER, rig);
	const ctl = new Controller(sim, rig);
	ctl.director = () => {};
	const run = (seconds) => { for (let i = 0; i < Math.round(seconds / sim.dt); i++) { ctl.update(); sim.step(); } };
	run(3);
	let ok = true;
	for (const p of MARIONETTE_PRESETS) {
		ctl.setRigStrings(sanitizeStrings(p.strings(), RIG));
		run(2);
		const on = p.strings().filter((s) => s.enabled !== false).length;
		ok = ok && sim.strings.filter((s) => s.def.enabled !== false).length === on && Math.abs(sim.bodyPos(sim.bodyIx.head)[1] - 1.545) < 0.04 && ctl.rig.model === 'knight' && ctl.rig.shapes === rig.shapes;
	}
	check('one puppet restrung through all eight, still standing and still itself', ok && sim.jointGap() < 0.02, `joints ${mm(sim.jointGap())} apart`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll marionette checks passed');
process.exit(failures ? 1 : 0);
