// The Marionette editor: how the puppet is strung. Each link from a handle on a control bar to
// an eye on the puppet is a string (it only pulls, and hangs slack), a rod (a stiff wire that
// pushes as well) or taken off. The puppet in the viewport is the real one, on the real physics,
// restrung as you choose; a test bench moves the bars so the difference can be seen. Nothing here
// uses a phone or its sensors.
//
// What is made here is saved in this browser, and the stage and the Studio string their puppet
// from it.

import { RIG, cloneStrings } from '../shared/rig-config.js';
import { sanitizeStrings } from '../shared/modes.js';
import { MARIONETTE_PRESETS, loadMarionette, parseMarionette, saveMarionette, marionetteDocument } from '../shared/marionette.js';
import { createWorld, bootError } from '../stage/world.js';
import { OrbitCam, toScreen, pointerAt, segmentDistance } from './orbit.js';
import { el, toast, downloadJson, openJson, slider, typing, curtain } from './ui.js';

const $ = (id) => document.getElementById(id);
const veil = curtain();

/** Things to do with the control bars, to see how a stringing behaves: (add, t) => targets. */
const BENCH = [
	{ id: 'still', label: 'Hold still', about: 'The bars hang still.', run: () => {} },
	{ id: 'rock', label: 'Rock & turn', about: 'The main bar rocks from side to side and turns.', run: (add, t) => { add('main.roll', 0.38 * Math.sin(t * 1.7)); add('main.yaw', 0.6 * Math.sin(t * 0.8)); } },
	{ id: 'bow', label: 'Bow', about: 'The bar tips forward and comes down a little, again and again.', run: (add, t) => { const b = Math.max(0, Math.sin(t * 1.1)); add('main.pitch', 0.62 * b); add('main.y', -0.06 * b); } },
	{ id: 'lift', label: 'Lift & lower', about: 'The bar goes up, then below where it hangs: strings go slack, rods push.', run: (add, t) => { add('main.y', 0.2 * Math.sin(t * 1.3)); } },
	{ id: 'hands', label: 'Work the hands', about: 'The hand handles go up, forward and down past their rest.', run: (add, t) => { add('handle.wristL.y', 0.22 + 0.34 * Math.sin(t * 2)); add('handle.wristL.z', 0.16 * Math.sin(t * 1.3)); add('handle.wristR.y', 0.22 + 0.34 * Math.sin(t * 2 + 2)); add('handle.wristR.x', 0.14 * Math.sin(t * 1.6)); } },
	{ id: 'legs', label: 'March', about: 'The knee handles are lifted in turn.', run: (add, t) => { add('handle.kneeL.y', 0.26 * Math.max(0, Math.sin(t * 3.2))); add('handle.kneeR.y', 0.26 * Math.max(0, -Math.sin(t * 3.2))); } },
	{ id: 'shake', label: 'Shake', about: 'The bar is shaken hard.', run: (add, t) => { add('main.roll', 0.5 * Math.sin(t * 7)); add('main.pitch', 0.4 * Math.sin(t * 9.1)); add('main.y', 0.1 * Math.sin(t * 11)); } },
];

async function boot() {
	const saved = loadMarionette();
	const doc = { name: saved ? saved.name : 'My marionette', strings: saved ? saved.strings : cloneStrings() };
	const view = $('view'), canvas = $('stage');
	const world = await createWorld(canvas, {
		rig: { ...RIG, strings: doc.strings },
		size: () => [view.clientWidth, view.clientHeight],
		strings: { width: 2, tensionColors: true },
		onProgress: veil.say,
	});
	const { sim, controller, stage } = world;
	new ResizeObserver(world.resize).observe(view);

	// --------------------------------------------------------------- state
	let selected = 0;
	let bench = BENCH[0], benchAt = 0;
	world.selected = new Set([selected]);
	controller.director = (add) => bench.run(add, controller.t - benchAt);

	const camera = new OrbitCam(canvas, { position: [0.9, 1.75, 5.2], target: [0, 1.5, 0] });
	world.onFrame = () => { camera.apply(stage.camera); placeTag(); };

	const kindOf = (s) => (s.enabled === false ? 'off' : s.kind === 'rod' ? 'rod' : 'string');
	const bodyLabel = (id) => id.replace(/([a-z])([A-Z])$/, '$1 $2').replace(/ L$/, ', left').replace(/ R$/, ', right').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
	const handle = (id) => RIG.handles.find((h) => h.id === id);

	let applyTimer = 0;
	/** The table changed: restring the puppet (in a moment, so a dragged slider does not restring sixty times a second) and save. */
	function changed(now = false) {
		clearTimeout(applyTimer);
		const apply = () => {
			doc.strings = sanitizeStrings(doc.strings, RIG);
			world.setStrings(doc.strings);
			const isDefault = JSON.stringify(doc.strings) === JSON.stringify(sanitizeStrings(cloneStrings(), RIG)) && doc.name === 'My marionette';
			const ok = saveMarionette(isDefault ? null : marionetteDocument(doc.name, doc.strings));
			const rods = doc.strings.filter((s) => kindOf(s) === 'rod').length, strings = doc.strings.filter((s) => kindOf(s) === 'string').length;
			$('saved').textContent = !ok ? 'This browser would not save it' : isDefault ? 'The default stringing' : `Saved here · ${strings} string${strings === 1 ? '' : 's'}, ${rods} rod${rods === 1 ? '' : 's'} · the stage and the Studio use it`;
		};
		if (now) apply(); else applyTimer = setTimeout(apply, 140);
	}

	function select(index) {
		selected = Math.max(0, Math.min(doc.strings.length - 1, index));
		world.selected = new Set(doc.strings.length ? [selected] : []);
		renderList();
		renderDetail();
	}

	function setKind(index, kind) {
		const s = doc.strings[index];
		s.enabled = kind !== 'off';
		if (kind === 'rod') { s.kind = 'rod'; s.breakable = false; } else if (kind === 'string') delete s.kind;
		changed(true);
		select(index);
	}

	// ---------------------------------------------------------------- panel
	const side = $('side');
	const listEl = el('ul.links');
	const detailEl = el('div');
	const benchAbout = el('p.note');
	const benchButtons = BENCH.map((b) => el('button.btn', { type: 'button', text: b.label, title: b.about, 'aria-pressed': 'false', onclick: () => setBench(b) }));
	function setBench(b) {
		bench = b; benchAt = controller.t;
		benchButtons.forEach((button, i) => button.setAttribute('aria-pressed', BENCH[i] === b));
		benchAbout.textContent = b.about;
	}

	side.append(
		el('section', {},
			el('h2', { text: 'Start from' }),
			el('div.row', {}, MARIONETTE_PRESETS.map((p) => el('button.btn', { type: 'button', text: p.label, title: p.about, onclick: () => { doc.strings = p.strings(); changed(true); select(0); toast(`${p.label}: ${p.about}`); } }))),
			el('dl.legend', { style: 'margin-top:12px' },
				el('div', {}, el('i'), el('span', { text: 'String — only pulls; hangs slack and wraps round a limb.' })),
				el('div', {}, el('i.rod'), el('span', { text: 'Rod — a stiff wire: pushes as well as pulls, never slack.' })))),
		el('section', {},
			el('h2', { text: 'Links' }),
			listEl,
			el('div.row', { style: 'margin-top:10px' }, el('button.btn', { type: 'button', text: '+ Add a link', onclick: addLink }))),
		el('section', {}, el('h2', { text: 'Selected link' }), detailEl),
		el('section', {},
			el('h2', { text: 'Try it' }),
			el('div.row', {}, benchButtons),
			benchAbout),
	);

	const loadBars = [];
	function renderList() {
		loadBars.length = 0;
		listEl.replaceChildren(...doc.strings.map((s, i) => {
			const kind = kindOf(s);
			const bar = el('i');
			loadBars.push(bar);
			const seg = el('div.seg', { role: 'group', 'aria-label': `${s.label}: what it is` }, ['string', 'rod', 'off'].map((k) => el('button', {
				type: 'button', text: k === 'string' ? 'String' : k === 'rod' ? 'Rod' : 'Off', 'data-kind': k, 'aria-pressed': String(kind === k),
				onclick: (e) => { e.stopPropagation(); setKind(i, k); },
			})));
			return el(`li.link${i === selected ? '.is-selected' : ''}${kind === 'off' ? '.is-off' : ''}`, { onclick: () => select(i) },
				el('span.link__n', { text: i + 1 }),
				el('div.link__name', {}, el('b', { text: s.label }), el('small', { text: `${handle(s.handle).label} handle → ${bodyLabel(s.body)}` }), el('div.link__load', {}, bar)),
				seg);
		}));
	}

	function renderDetail() {
		const s = doc.strings[selected];
		if (!s) { detailEl.replaceChildren(el('p.empty', { text: 'No links. Add one, or start from a preset.' })); return; }
		const kind = kindOf(s);
		const option = (value, label, current) => el('option', { value, text: label, selected: value === current });
		const pick = (label, options, current, set) => el('label.field.field--wide', {}, el('span', { text: label }),
			el('select', { onchange: (e) => { set(e.target.value); changed(true); select(selected); } }, options.map(([value, text]) => option(value, text, current))));
		const tie = [0, 1, 2].map((n) => el('input.num', {
			type: 'number', step: 0.01, min: -0.4, max: 0.4, value: s.at[n], 'aria-label': `Tie point ${'xyz'[n]}`,
			onchange: (e) => { s.at[n] = Math.max(-0.4, Math.min(0.4, +e.target.value || 0)); changed(true); },
		}));
		detailEl.replaceChildren(
			el('label.field.field--wide', {}, el('span', { text: 'Name' }), el('input', { type: 'text', maxLength: 32, value: s.label, oninput: (e) => { s.label = e.target.value; }, onchange: () => { changed(true); renderList(); } })),
			pick('Hangs from', RIG.handles.map((h) => [h.id, `${h.label} · ${RIG.bars.find((b) => b.id === h.bar).label.toLowerCase()}`]), s.handle, (v) => { s.handle = v; }),
			pick('Tied to', RIG.bodies.map((b) => [b.id, bodyLabel(b.id)]), s.body, (v) => { s.body = v; s.at = [0, 0, 0]; delete s.out; }),
			el('label.field.field--wide', {}, el('span', { text: 'Tie point (m)', title: 'Where on that part, from its origin. A point inside the wood is moved out to the surface.' }), el('div.triple', {}, tie)),
			kind === 'rod'
				? el('p.note', { text: 'A rod is as long as the distance it spans at rest: it has no slack to set.' })
				: slider('Slack', { min: -0.05, max: 0.3, step: 0.002, value: s.slack, format: (v) => `${(v * 100).toFixed(1)} cm`, oninput: (v) => { s.slack = v; changed(); } }).row,
			slider(kind === 'rod' ? 'Strength' : 'Gives at', { min: 20, max: 600, step: 5, value: s.max, format: (v) => `${v.toFixed(0)} N`, oninput: (v) => { s.max = v; changed(); } }).row,
			kind === 'string' && el('label.check', {}, el('input', { type: 'checkbox', checked: !!s.breakable, onchange: (e) => { s.breakable = e.target.checked; changed(true); } }), 'Snaps if held at its limit'),
			el('div.row', { style: 'margin-top:10px' }, el('button.btn.btn--danger', { type: 'button', text: 'Remove this link', onclick: () => { doc.strings.splice(selected, 1); changed(true); select(selected); } })),
		);
	}

	function addLink() {
		if (doc.strings.length >= 24) { toast('Twenty-four links is the most a marionette here can carry'); return; }
		const n = doc.strings.length + 1;
		doc.strings.push({ n, id: `link${Date.now() % 100000}`, label: `Link ${n}`, body: 'chest', handle: 'back', at: [0, 0.06, -0.08], slack: 0.02, k: 3000, c: 30, max: 160, group: 'custom', enabled: true, breakable: false });
		changed(true);
		select(doc.strings.length - 1);
	}

	// What each link is carrying, a few times a second: a bar under its name (steel while a rod pushes).
	setInterval(() => {
		sim.strings.forEach((s, i) => {
			const bar = loadBars[i];
			if (!bar) return;
			bar.style.width = `${Math.min(100, (sim.tension[i] / s.def.max) * 100 * 2.5).toFixed(0)}%`;
			bar.classList.toggle('is-push', !!s.push);
		});
	}, 120);

	// ------------------------------------------------------------- viewport
	const tag = $('tag');
	const _a = [0, 0, false], _b = [0, 0, false];
	/** The link under the pointer: the nearest drawn string or rod within a few pixels. */
	function linkAt(e) {
		const p = pointerAt(e, canvas);
		let best = -1, least = 9;
		world.strings.items.forEach((item, i) => {
			if (!item.points || !item.line.visible) return;
			for (let k = 0; k < item.points.length - 1; k++) {
				toScreen(item.points[k], stage.camera, canvas, _a); toScreen(item.points[k + 1], stage.camera, canvas, _b);
				if (!_a[2] || !_b[2]) continue;
				const d = segmentDistance(p, _a, _b);
				if (d < least) { least = d; best = i; }
			}
		});
		return best;
	}
	let pressed = null;
	canvas.addEventListener('pointerdown', (e) => { pressed = [e.clientX, e.clientY]; });
	canvas.addEventListener('pointerup', (e) => {
		if (!pressed || Math.hypot(e.clientX - pressed[0], e.clientY - pressed[1]) > 4) return;   // that was a drag of the camera
		const hit = linkAt(e);
		if (hit >= 0) { select(hit); listEl.children[hit].scrollIntoView({ block: 'nearest' }); }
	});
	canvas.addEventListener('pointermove', (e) => { if (!e.buttons) canvas.classList.toggle('is-over', linkAt(e) >= 0); });

	/** A name tag half way along the selected link. */
	function placeTag() {
		const item = world.strings.items[selected], s = doc.strings[selected];
		if (!item || !s || !item.line.visible || !item.top) { tag.hidden = true; return; }
		const mid = [(item.top.x + item.attach.x) / 2, (item.top.y + item.attach.y) / 2, (item.top.z + item.attach.z) / 2];
		toScreen(mid, stage.camera, canvas, _a);
		tag.hidden = !_a[2];
		tag.style.left = `${_a[0]}px`; tag.style.top = `${_a[1]}px`;
		const live = sim.strings[selected];
		tag.textContent = `${s.label} · ${kindOf(s)}${live && live.push ? ' · pushing' : ''}`;
	}

	// -------------------------------------------------------------- buttons
	const nameInput = $('name');
	nameInput.value = doc.name;
	nameInput.addEventListener('change', () => { doc.name = nameInput.value.trim().slice(0, 40) || 'My marionette'; nameInput.value = doc.name; changed(true); });
	$('btn-reset').addEventListener('click', () => { world.reset(); toast('Puppet reset'); });
	$('btn-slow').addEventListener('click', (e) => { const on = world.tuning.timeScale === 1; world.tuning.timeScale = on ? 0.25 : 1; e.currentTarget.setAttribute('aria-pressed', on); });
	$('btn-view').addEventListener('click', () => camera.set([0, 1.6, 5.8], [0, 1.45, 0]));
	$('btn-export').addEventListener('click', () => downloadJson(doc.name, marionetteDocument(doc.name, doc.strings)));
	$('btn-import').addEventListener('click', () => openJson((data) => {
		const next = parseMarionette(data);
		if (!next) { toast('That file holds no strings or rods this puppet can use'); return; }
		doc.name = next.name; doc.strings = next.strings; nameInput.value = doc.name;
		changed(true); select(0);
		toast(`Loaded “${doc.name}”`);
	}));
	$('btn-default').addEventListener('click', () => {
		doc.name = 'My marionette'; doc.strings = cloneStrings(); nameInput.value = doc.name;
		changed(true); select(0); world.reset();
		toast('Back to the twelve default strings');
	});
	window.addEventListener('keydown', (e) => {
		if (typing(e) || e.metaKey || e.ctrlKey) return;
		if (e.key === 'r') $('btn-reset').click();
		if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1); }
		if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1); }
		const s = doc.strings[selected];
		if (s && e.key === 's') setKind(selected, 'string');
		if (s && e.key === 'd') setKind(selected, 'rod');
		if (s && e.key === 'x') setKind(selected, 'off');
	});

	setBench(BENCH[0]);
	select(0);
	changed(true);
	// Handy for the browser console and automated checks.
	window.motionPuppet = { ...world, world, doc, camera, select, setKind, setBench: (id) => setBench(BENCH.find((b) => b.id === id) || BENCH[0]) };
	world.start();
	veil.open();
}

boot().catch((err) => { console.error(err); veil.fail(bootError(err)); });
