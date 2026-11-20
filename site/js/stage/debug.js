// Debug mode for the stage. Not loaded in normal use: open the stage with
//
//     ?debug            a panel of predefined movement routines
//     ?debug=arms       ...and start one straight away (see ROUTINES for the names)
//
// A routine plays the puppet the way a phone would: it fills in the same input
// structure the phone sends (tilt, string pulls, handle drags, IK targets, joint
// poses, thumb stick) and hands it to the control layer, so everything downstream
// — mapping, gait, strings, collisions — runs exactly as in a real session.
//
// The panel also shows live measurements taken against the rendered meshes, and
// lets you switch string collisions off to compare.

import * as M from '../shared/math.js';

const { sin, cos, max, PI } = Math;
const tilt = (yaw, pitch, roll) => M.qFromYPR(yaw, pitch, roll);

/**
 * The routines. `drive(t)` returns what the phone would be doing at time t (seconds):
 * { quat, acc, stick, pulls: {stringId: metres}, handles: {handleId: [x,y,z]},
 *   ik: {effectorId: [x,y,z]}, joints: {jointId: [x,y,z]} }
 * or, with `two: true`, an array of two of those — one per phone.
 */
export const ROUTINES = [
	{
		id: 'tilt', label: 'Tilt & roll', mode: 'classic',
		about: 'The bar yaws, pitches and rolls, as if tilting the phone.',
		drive: (t) => ({ quat: tilt(sin(t * 1.1) * 0.9, sin(t * 1.7) * 0.7, cos(t * 1.3) * 0.7) }),
	},
	{
		id: 'bow', label: 'Bow & sway', mode: 'classic',
		about: 'Slow deep bows with a side-to-side sway.',
		drive: (t) => ({ quat: tilt(0, 0.75 * max(0, sin(t * 0.9)), 0.35 * sin(t * 1.8)) }),
	},
	{
		id: 'pulls', label: 'Pull strings', mode: 'classic',
		about: 'Wrist and knee strings are pulled in turn.',
		drive: (t) => ({ pulls: { wristL: 0.35 + 0.3 * sin(t * 2), wristR: 0.35 + 0.3 * cos(t * 1.6), kneeL: 0.25 + 0.2 * sin(t * 2.4), kneeR: 0.25 + 0.2 * sin(t * 2.4 + PI) } }),
	},
	{
		id: 'handles', label: 'Drag handles', mode: 'classic',
		about: 'Hand and knee handles are dragged about, as with a finger on the board.',
		drive: (t) => ({
			handles: {
				wristL: [0.2 * sin(t * 2), 0.35 + 0.25 * sin(t * 1.3), 0.1 * cos(t * 2)],
				wristR: [-0.25 * max(0, sin(t * 0.8)), 0.3 * max(0, sin(t * 0.8)), -0.15 * max(0, sin(t * 0.8))],
				kneeL: [0, 0.25 * max(0, sin(t * 3)), 0], kneeR: [0, 0.25 * max(0, -sin(t * 3)), 0],
			},
		}),
	},
	{
		id: 'arms', label: 'Cross arms', mode: 'arms',
		about: 'Each hand is sent to the far side of the body, so the arms must go around each other.',
		drive: (t) => ({ ik: { handL: [-0.45, 0.4 + 0.2 * sin(t * 2), 0.1], handR: [0.45, 0.4 + 0.2 * cos(t * 1.7), 0.1] } }),
	},
	{
		id: 'reach', label: 'Reach & clap', mode: 'arms',
		about: 'Hands reach up, out and together.',
		drive: (t) => {
			const clap = 0.5 + 0.5 * sin(t * 2.4);
			return { ik: { handL: [0.25 - 0.3 * clap, 0.45 + 0.35 * sin(t * 0.9), 0.15], handR: [-0.25 + 0.3 * clap, 0.45 + 0.35 * sin(t * 0.9 + 1), 0.15] } };
		},
	},
	{
		id: 'joints', label: 'Pose joints', mode: 'full',
		about: 'Joint targets are set directly: the head turns, an arm lifts, a knee bends.',
		drive: (t) => ({
			joints: { neckTop: [0.25 * sin(t * 1.4), 0.7 * sin(t * 0.8), 0], shoulderL: [-1.3 - 0.6 * sin(t * 1.1), 0, 0.5], elbowL: [-0.9 - 0.7 * sin(t * 2.2), 0, 0], kneeR: [0.6 + 0.6 * sin(t * 1.6), 0, 0] },
		}),
	},
	{
		id: 'walk', label: 'Walk a circle', mode: 'walk',
		about: 'The thumb stick turns slowly through every direction.',
		drive: (t) => ({ stick: [cos(t * 0.6), sin(t * 0.6)] }),
	},
	{
		id: 'pro', label: 'Two phones', mode: 'classic', two: true,
		about: 'Pro: one phone sways the main bar while the other rocks the limb bar.',
		drive: (t) => [
			{ quat: tilt(0.3 * sin(t * 0.7), 0.2 * sin(t * 1.1), 0.25 * cos(t * 0.9)) },
			{ quat: tilt(0, 0.35 * sin(t * 2.2), 0.6 * sin(t * 2.6)) },
		],
	},
	{
		id: 'chaos', label: 'Chaos', mode: 'chaos',
		about: 'Violent shaking and spinning.',
		drive: (t) => ({ quat: tilt(sin(t * 3) * 1.2, sin(t * 4.1) * 0.9, cos(t * 3.3) * 0.9), acc: [sin(t * 15) * 8, cos(t * 13) * 8, sin(t * 11) * 8] }),
	},
	{ id: 'tour', label: 'Run them all', about: 'Each routine in turn, eight seconds apiece.' },
];

const STYLE = `
.dbg { position: fixed; z-index: 6; left: clamp(16px, 3vw, 44px); top: 112px; width: 252px; max-height: calc(100vh - 190px); overflow-y: auto;
	padding: 12px; border-radius: 12px; background: rgba(14, 8, 8, 0.86); border: 1px solid rgba(226, 180, 87, 0.3);
	color: #f4e9d2; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; backdrop-filter: blur(8px); }
.dbg h2 { margin: 0 0 2px; font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase; color: #e2b457; }
.dbg p { margin: 0 0 8px; color: #b9a888; }
.dbg__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-bottom: 8px; }
.dbg button { font: inherit; color: inherit; cursor: pointer; padding: 6px 4px; border-radius: 8px; border: 1px solid rgba(226, 180, 87, 0.3); background: rgba(255, 255, 255, 0.05); }
.dbg button[aria-pressed="true"] { background: #e2b457; color: #2a1708; border-color: transparent; font-weight: 700; }
.dbg label { display: flex; align-items: center; gap: 7px; margin: 3px 0; cursor: pointer; }
.dbg input { accent-color: #e2b457; }
.dbg dl { margin: 8px 0 0; padding-top: 8px; border-top: 1px solid rgba(226, 180, 87, 0.2); display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; }
.dbg dt { color: #b9a888; }
.dbg dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.dbg dd.is-bad { color: #ff9a85; }
.dbg small { display: block; margin-top: 8px; color: #8c7d63; }
`;

export function startDebug(app, initial) {
	const { sim, controller, stage, slots, puppet, strings, tuning, THREE } = app;
	const css = document.createElement('style');
	css.textContent = STYLE;
	document.head.append(css);

	// ------------------------------------------------------------ driving
	const virtual = new Set();     // controller slots this panel is standing in for
	let routine = null;            // the routine being played (never the tour itself)
	let touring = false;
	let startedAt = 0;
	let seq = 0;

	const byId = (id) => ROUTINES.find((r) => r.id === id);
	const playable = ROUTINES.filter((r) => r.drive);

	/** Turns a routine's friendly description into the structure a phone sends. */
	function toInput(d = {}) {
		const map = (obj, index, fix = (v) => v) => {
			const out = new Map();
			for (const [id, value] of Object.entries(obj || {})) if (index[id] !== undefined) out.set(index[id], fix(value));
			return out;
		};
		return {
			seq: seq++, sensors: true, calibrated: true,
			quat: d.quat || [0, 0, 0, 1], gyro: d.gyro || [0, 0, 0], acc: d.acc || [0, 0, 0], stick: d.stick || [0, 0],
			handles: map(d.handles, sim.handleIx), pulls: map(d.pulls, controller.stringIx),
			ik: map(d.ik, sim.effIx), joints: map(d.joints, sim.jointIx),
		};
	}

	function hold(slot) {
		if (controller.devices[slot]) return;
		controller.connect(slot);
		virtual.add(slot);
	}

	function release() {
		for (const slot of virtual) if (!slots[slot].link.open) controller.disconnect(slot);
		virtual.clear();
	}

	function play(next) {
		release();
		routine = next;
		startedAt = sim.time;
		stats.reset();
		if (next) {
			hold(0);
			if (next.two) hold(1);
			controller.setMode(next.mode);
		} else {
			touring = false;
			controller.setMode('classic');
		}
		app.refreshHud();
		render();
	}

	function start(id) {
		const chosen = byId(id);
		if (!chosen) return;
		touring = !chosen.drive;
		play(touring ? playable[0] : chosen);
	}

	function drive() {
		requestAnimationFrame(drive);
		if (!routine) return;
		const t = sim.time - startedAt;
		if (touring && t > 8) { play(playable[(playable.indexOf(routine) + 1) % playable.length]); touring = true; return; }
		const d = routine.drive(t);
		if (routine.two) { controller.setInput(0, toInput(d[0])); controller.setInput(1, toInput(d[1])); }
		else controller.setInput(0, toInput(d));
	}

	// ------------------------------------------------------- measurements
	// Strings are measured against the solid meshes that are actually drawn.
	const solids = [];
	puppet.root.traverse((o) => { if (o.isMesh && o.userData.solid) solids.push(o); });
	const ray = new THREE.Raycaster();
	const partOf = (o) => { let p = o; while (p && !p.name) p = p.parent; return p ? p.name : '?'; };

	function stringInsideWood() {
		puppet.root.updateMatrixWorld(true);
		let worst = 0, where = '';
		for (const item of strings.items) {
			if (!item.points || item.def.enabled === false || item.rod) continue;   // a rod is not kept out of the wood: it is not counted
			for (let k = 0; k < item.points.length - 1; k++) {
				const p = new THREE.Vector3(...item.points[k]), q = new THREE.Vector3(...item.points[k + 1]);
				const L = p.distanceTo(q);
				if (L < 0.02) continue;
				const dir = q.clone().sub(p).divideScalar(L);
				ray.set(p, dir); ray.far = L;
				const entries = ray.intersectObjects(solids, false);
				if (!entries.length) continue;
				ray.set(q, dir.clone().negate()); ray.far = L;
				const exits = ray.intersectObjects(solids, false);
				for (const hit of entries) {
					const exit = exits.find((e) => e.object === hit.object);
					if (!exit) continue;
					const inside = L - exit.distance - hit.distance;
					if (inside > worst) { worst = inside; where = `${item.def.id} in ${partOf(hit.object)}`; }
				}
			}
		}
		return { worst, where };
	}

	const stats = {
		reset() { this.samples = 0; this.cut = 0; this.worstString = 0; this.worstStringAt = ''; this.worstOverlap = 0; this.worstOverlapAt = ''; },
	};
	stats.reset();

	// ---------------------------------------------------------------- panel
	const panel = document.createElement('aside');
	panel.className = 'dbg';
	panel.innerHTML = `
		<h2>Debug</h2>
		<p data-about>Pick a routine. It plays the puppet exactly as a phone would.</p>
		<div class="dbg__grid" data-routines></div>
		<div class="dbg__grid"><button type="button" data-stop>Stop</button><button type="button" data-reset>Reset puppet</button></div>
		<label><input type="checkbox" data-wrap checked> String collisions</label>
		<label><input type="checkbox" data-slow> Slow motion (¼ speed)</label>
		<label><input type="checkbox" data-close> Close-up camera</label>
		<label><input type="checkbox" data-tickets> Hide pairing tickets</label>
		<dl>
			<dt>Strings wrapping</dt><dd data-wrapped>0</dd>
			<dt>String in wood, now</dt><dd data-cut>0 mm</dd>
			<dt>… worst so far</dt><dd data-cut-worst>0 mm</dd>
			<dt>… over 15 mm</dt><dd data-cut-share>0%</dd>
			<dt>Limb overlap, now</dt><dd data-overlap>0 mm</dd>
			<dt>… worst so far</dt><dd data-overlap-worst>0 mm</dd>
		</dl>
		<small data-where></small>
		<small>Start one from the address bar: <b>?debug=arms</b></small>`;
	document.body.append(panel);
	const $ = (sel) => panel.querySelector(sel);

	const buttons = new Map();
	for (const r of ROUTINES) {
		const b = document.createElement('button');
		b.type = 'button'; b.textContent = r.label; b.title = r.about;
		b.addEventListener('click', () => start(r.id));
		$('[data-routines]').append(b);
		buttons.set(r.id, b);
	}

	function render() {
		for (const [id, b] of buttons) b.setAttribute('aria-pressed', (touring ? id === 'tour' : !!routine && routine.id === id));
		$('[data-about]').textContent = routine ? `${touring ? 'Tour — ' : ''}${routine.label}: ${routine.about}` : 'Pick a routine. It plays the puppet exactly as a phone would.';
	}

	$('[data-stop]').addEventListener('click', () => play(null));
	$('[data-reset]').addEventListener('click', () => { controller.reset(); stats.reset(); });
	$('[data-wrap]').addEventListener('change', (e) => {
		sim.opts.stringCollision = e.target.checked;
		strings.wrap = e.target.checked;
		stats.reset();
		app.toast(e.target.checked ? 'String collisions on' : 'String collisions off — strings pass through the wood');
	});
	$('[data-slow]').addEventListener('change', (e) => { tuning.timeScale = e.target.checked ? 0.25 : 1; });
	const wide = stage.distance;
	$('[data-close]').addEventListener('change', (e) => { stage.distance = e.target.checked ? 2.6 : wide; });
	$('[data-tickets]').addEventListener('change', (e) => { document.getElementById('pairing').style.display = e.target.checked ? 'none' : ''; });
	document.getElementById('fps').hidden = false;

	const mm = (v) => `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} mm`;
	setInterval(() => {
		if (document.hidden) return;
		const cut = stringInsideWood();
		const overlap = sim.deepestOverlap();
		stats.samples++;
		if (cut.worst > 0.015) stats.cut++;
		if (cut.worst > stats.worstString) { stats.worstString = cut.worst; stats.worstStringAt = cut.where; }
		if (overlap.depth > stats.worstOverlap) { stats.worstOverlap = overlap.depth; stats.worstOverlapAt = overlap.pair.join(' / '); }
		const wrapped = sim.strings.filter((s) => s.path && s.path.points.length > 2);
		$('[data-wrapped]').textContent = wrapped.length ? `${wrapped.length} (${wrapped.map((s) => s.def.id).join(', ')})` : '0';
		$('[data-cut]').textContent = mm(cut.worst);
		$('[data-cut]').classList.toggle('is-bad', cut.worst > 0.015);
		$('[data-cut-worst]').textContent = mm(stats.worstString);
		$('[data-cut-share]').textContent = `${((stats.cut / stats.samples) * 100).toFixed(0)}% of ${stats.samples}`;
		$('[data-overlap]').textContent = mm(overlap.depth);
		$('[data-overlap]').classList.toggle('is-bad', overlap.depth > 0.012);
		$('[data-overlap-worst]').textContent = mm(stats.worstOverlap);
		$('[data-where]').textContent = [stats.worstStringAt && `Worst string: ${stats.worstStringAt}.`, stats.worstOverlapAt && `Worst overlap: ${stats.worstOverlapAt}.`].filter(Boolean).join(' ');
	}, 250);

	render();
	requestAnimationFrame(drive);
	if (initial) start(initial);
	app.debug = { start, stop: () => play(null), routines: ROUTINES, stats };
	window.motionPuppet.debug = app.debug;
}
