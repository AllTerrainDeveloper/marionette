// The Marionette editor: which puppet it is and how it is strung. Each link from a handle on a
// control bar to an eye on the puppet is a string (it only pulls, and hangs slack), a rod (a
// stiff wire that pushes as well) or taken off. The puppet in the viewport is the real one, on
// the real physics, restrung as you choose; a test bench moves the bars so the difference can
// be seen. Nothing here uses a phone or its sensors.
//
// What is made here is saved in this browser, and the stage and the Studio build and string
// their puppet from it.

import { RIG, cloneStrings, restAttach, restHandle } from '../shared/rig-config.js';
import { sanitizeStrings } from '../shared/modes.js';
import { MODELS, DEFAULT_MODEL } from '../shared/puppet-shapes.js';
import { MARIONETTE_PRESETS, DEFAULT_NAME, loadMarionette, parseMarionette, saveMarionette, marionetteDocument, rigForModel, presetOf } from '../shared/marionette.js';
import { createWorld, bootError } from '../stage/world.js';
import { OrbitCam, toScreen, pointerAt, segmentDistance } from './orbit.js';
import { el, toast, downloadJson, openJson, slider, typing, curtain } from './ui.js';

const $ = (id) => document.getElementById(id);
const veil = curtain();
const UI_KEY = 'motion-puppet-editor-ui';
const MAX_LINKS = 24;

/** Things to do with the control bars, to see how a stringing behaves: (add, t) => targets. */
const BENCH = [
	{ id: 'still', label: 'Hold still', about: 'The bars hang still.', run: () => {} },
	{ id: 'rock', label: 'Rock & turn', about: 'The main bar rocks from side to side and turns.', run: (add, t) => { add('main.roll', 0.38 * Math.sin(t * 1.7)); add('main.yaw', 0.6 * Math.sin(t * 0.8)); } },
	{ id: 'bow', label: 'Bow', about: 'The bar tips forward and comes down a little, again and again.', run: (add, t) => { const b = Math.max(0, Math.sin(t * 1.1)); add('main.pitch', 0.62 * b); add('main.y', -0.06 * b); } },
	{ id: 'lift', label: 'Lift & lower', about: 'The bar goes up, then below where it hangs: strings go slack, rods push.', run: (add, t) => { add('main.y', 0.2 * Math.sin(t * 1.3)); } },
	{ id: 'hands', label: 'Hands', about: 'The hand handles go up, forward and down past their rest.', run: (add, t) => { add('handle.wristL.y', 0.22 + 0.34 * Math.sin(t * 2)); add('handle.wristL.z', 0.16 * Math.sin(t * 1.3)); add('handle.wristR.y', 0.22 + 0.34 * Math.sin(t * 2 + 2)); add('handle.wristR.x', 0.14 * Math.sin(t * 1.6)); } },
	{ id: 'legs', label: 'March', about: 'The knee handles are lifted in turn.', run: (add, t) => { add('handle.kneeL.y', 0.26 * Math.max(0, Math.sin(t * 3.2))); add('handle.kneeR.y', 0.26 * Math.max(0, -Math.sin(t * 3.2))); } },
	{ id: 'walk', label: 'Walk about', about: 'The bars are carried from side to side, turning at each end, the knees lifted in step.', run: (add, t) => { add('main.x', 0.55 * Math.sin(t * 0.6)); add('main.yaw', 0.9 * Math.cos(t * 0.6)); add('main.roll', 0.12 * Math.sin(t * 3.2)); add('handle.kneeL.y', 0.2 * Math.max(0, Math.sin(t * 3.2))); add('handle.kneeR.y', 0.2 * Math.max(0, -Math.sin(t * 3.2))); } },
	{ id: 'shake', label: 'Shake', about: 'The bar is shaken hard.', run: (add, t) => { add('main.roll', 0.5 * Math.sin(t * 7)); add('main.pitch', 0.4 * Math.sin(t * 9.1)); add('main.y', 0.1 * Math.sin(t * 11)); } },
];

const VIEWS = [
	{ id: 'front', label: 'Front', title: 'The audience’s view (1)', position: [0, 1.6, 5.8], target: [0, 1.45, 0] },
	{ id: 'side', label: 'Side', title: 'From the wings (2)', position: [5.6, 1.6, 0.4], target: [0, 1.45, 0] },
	{ id: 'above', label: 'Above', title: 'The puppeteer’s view, down the strings (3)', position: [0, 6.4, 1.6], target: [0, 1.5, 0.1] },
	{ id: 'bars', label: 'Bars', title: 'Close on the control bars and their handles (4)', position: [0.5, 3.1, 2.1], target: [0, 2.36, 0.12] },
];

const SHORTCUTS = [
	['↑ ↓', 'Next / previous link'], ['S', 'Make it a string'], ['D', 'Make it a rod'], ['X', 'Take it off'],
	['⌘Z', 'Undo'], ['⇧⌘Z', 'Redo'], ['⌘D', 'Duplicate the link'], ['M', 'Mirror it to the other side'], ['Del', 'Remove the link'],
	['/', 'Find a link'], ['1 – 4', 'Front, side, above, bars'], ['R', 'Reset the puppet'], ['Space', 'Slow motion'], ['?', 'This list'],
];

const kindOf = (s) => (s.enabled === false ? 'off' : s.kind === 'rod' ? 'rod' : 'string');
const KIND_LABEL = { string: 'String', rod: 'Rod', off: 'Off' };
const bodyLabel = (id) => id.replace(/([a-z])([A-Z])$/, '$1 $2').replace(/ L$/, ', left').replace(/ R$/, ', right').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const handleOf = (id) => RIG.handles.find((h) => h.id === id);
/** The same thing on the puppet's other side ("wristL" → "wristR"), or null if it has no sides. */
const twin = (id) => (/[a-z]L$/.test(id) ? `${id.slice(0, -1)}R` : /[a-z]R$/.test(id) ? `${id.slice(0, -1)}L` : null);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function loadUi() { try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { return {}; } }
const ui = { closed: [], filter: 'all', ...loadUi() };
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* private mode */ } };

// ------------------------------------------------------------------ drawings

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
	const node = document.createElementNS(SVG, tag);
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
	node.append(...children);
	return node;
}
const bodyPos = (id) => RIG.bodies.find((b) => b.id === id).pos;
/** Front view, a little from above so the bar's depth shows: metres → drawing units. */
const flat = ([x, y, z]) => [50 + x * 74, 196 - (y + z * 0.22) * 74];
const BONES = [['pelvis', 'chest'], ['chest', 'neck'], ['clavicleL', 'clavicleR'], ['clavicleL', 'upperArmL'], ['upperArmL', 'forearmL'], ['forearmL', 'handL'], ['clavicleR', 'upperArmR'], ['upperArmR', 'forearmR'], ['forearmR', 'handR'], ['pelvis', 'thighL'], ['thighL', 'shinL'], ['shinL', 'footL'], ['pelvis', 'thighR'], ['thighR', 'shinR'], ['shinR', 'footR']];

/** A small drawing of a stringing: the puppet, its two bars, a line for every string, a heavier one for every rod. */
function diagram(strings) {
	const line = (a, b, cls) => svg('line', { x1: a[0].toFixed(1), y1: a[1].toFixed(1), x2: b[0].toFixed(1), y2: b[1].toFixed(1), class: cls });
	const root = svg('svg', { viewBox: '0 0 100 200', class: 'diagram', 'aria-hidden': 'true' });
	for (const bar of RIG.bars) {
		const xs = RIG.handles.filter((h) => h.bar === bar.id).map((h) => restHandle(h));
		const left = xs.reduce((a, b) => (a[0] < b[0] ? a : b)), right = xs.reduce((a, b) => (a[0] > b[0] ? a : b));
		const z = RIG.home[2] + bar.offset[2], y = RIG.home[1] + bar.offset[1];
		root.append(line(flat([left[0] - 0.04, y, z]), flat([right[0] + 0.04, y, z]), 'diagram__bar'));
	}
	for (const [a, b] of BONES) root.append(line(flat(bodyPos(a)), flat(bodyPos(b)), 'diagram__bone'));
	const head = flat(bodyPos('head'));
	root.append(svg('circle', { cx: head[0], cy: head[1], r: 8.5, class: 'diagram__head' }));
	for (const s of strings) {
		if (kindOf(s) === 'off') continue;
		root.append(line(flat(restHandle(handleOf(s.handle))), flat(restAttach(s)), kindOf(s) === 'rod' ? 'diagram__rod' : 'diagram__string'));
	}
	return root;
}

/** A model's portrait: its colours as a little figure. */
function portrait(id) {
	const C = {
		gentleman: { skin: '#f0c592', body: '#1f6f6b', legs: '#d9a368', shoe: '#b3261e', top: '#1d2a38' },
		ballerina: { skin: '#f0c592', body: '#d07a92', legs: '#d8cbbb', shoe: '#e0a3b0', top: '#5a3520' },
		knight: { skin: '#aeb6c2', body: '#aeb6c2', legs: '#8f98a6', shoe: '#6f7885', top: '#b3261e' },
	}[id];
	const root = svg('svg', { viewBox: '0 0 60 96', class: 'portrait', 'aria-hidden': 'true' });
	const add = (tag, attrs) => root.append(svg(tag, attrs));
	add('path', { d: 'M22 60 L20 88 M38 60 L40 88', stroke: C.legs, 'stroke-width': id === 'ballerina' ? 5 : 7, 'stroke-linecap': 'round', fill: 'none' });
	add('path', { d: 'M17 90h9 M34 90h9', stroke: C.shoe, 'stroke-width': 5, 'stroke-linecap': 'round' });
	add('path', { d: 'M17 34 L10 58 M43 34 L50 58', stroke: id === 'knight' ? C.body : C.skin, 'stroke-width': id === 'ballerina' ? 4 : 5.5, 'stroke-linecap': 'round', fill: 'none' });
	add('rect', { x: 18, y: 30, width: 24, height: 32, rx: id === 'ballerina' ? 9 : 7, fill: C.body });
	if (id === 'ballerina') add('ellipse', { cx: 30, cy: 60, rx: 22, ry: 5, fill: '#fbeef0' });
	if (id === 'knight') { add('path', { d: 'M14 58h32l3 10H11z', fill: C.legs }); add('path', { d: 'M30 36v18M24 42h12', stroke: '#f3ead8', 'stroke-width': 3 }); }
	if (id === 'gentleman') add('path', { d: 'M25 33l5 3 5-3v6l-5-3-5 3z', fill: '#b3261e' });
	add('circle', { cx: 30, cy: 18, r: 11, fill: C.skin });
	if (id === 'gentleman') add('path', { d: 'M17 11h26M22 11V3h15v8', stroke: C.top, 'stroke-width': 4, 'stroke-linejoin': 'round', fill: C.top });
	if (id === 'ballerina') { add('path', { d: 'M19 17a11 11 0 0 1 22 0c-4-6-18-6-22 0z', fill: C.top }); add('circle', { cx: 30, cy: 5, r: 5, fill: C.top }); }
	if (id === 'knight') { add('path', { d: 'M21 17h18', stroke: '#14100e', 'stroke-width': 2.5 }); add('path', { d: 'M30 7c6-8 14-4 14 4', stroke: C.top, 'stroke-width': 4, 'stroke-linecap': 'round', fill: 'none' }); }
	return root;
}

// ----------------------------------------------------------------------- boot

async function boot() {
	const saved = loadMarionette();
	const doc = { name: saved ? saved.name : DEFAULT_NAME, model: saved ? saved.model : DEFAULT_MODEL, strings: saved ? saved.strings : cloneStrings() };
	const view = $('view'), canvas = $('stage');
	const world = await createWorld(canvas, {
		rig: { ...rigForModel(doc.model), strings: doc.strings },
		size: () => [view.clientWidth, view.clientHeight],
		strings: { width: 2, tensionColors: true },
		onProgress: veil.say,
	});
	const { sim, controller, stage } = world;
	new ResizeObserver(world.resize).observe(view);

	// --------------------------------------------------------------- state
	let selected = 0;
	let bench = BENCH[0], benchT = 0, benchLast = controller.t, benchSpeed = 1, benchSize = 1;
	let query = '';
	world.selected = new Set([selected]);
	controller.director = (add) => {
		benchT += (controller.t - benchLast) * benchSpeed;
		benchLast = controller.t;
		bench.run((key, value) => add(key, value * benchSize), benchT);
	};

	const camera = new OrbitCam(canvas, { position: [0.9, 1.75, 5.2], target: [0, 1.5, 0] });
	world.onFrame = () => { camera.apply(stage.camera); placeTag(); };

	// ------------------------------------------------- saving, undo and redo
	const snapshot = () => JSON.stringify({ name: doc.name, strings: doc.strings });
	const undo = [], redo = [];
	let applyTimer = 0, savedOk = true, last = snapshot();

	/** Restrings the puppet and saves. */
	function apply() {
		clearTimeout(applyTimer); applyTimer = 0;
		doc.strings = sanitizeStrings(doc.strings, RIG);
		world.setStrings(doc.strings);
		const isDefault = doc.model === DEFAULT_MODEL && doc.name === DEFAULT_NAME && JSON.stringify(doc.strings) === JSON.stringify(sanitizeStrings(cloneStrings(), RIG));
		savedOk = saveMarionette(isDefault ? null : marionetteDocument(doc.name, doc.strings, doc.model));
		const now = snapshot();
		if (now !== last) { undo.push(last); if (undo.length > 200) undo.shift(); redo.length = 0; last = now; }
		renderStatus(isDefault);
	}
	/** The table changed: restring (in a moment, so a dragged slider does not restring sixty times a second) and save. */
	function changed(now = false) {
		clearTimeout(applyTimer);
		if (now) apply(); else applyTimer = setTimeout(apply, 140);
	}
	function travel(from, to, what) {
		if (applyTimer) apply();
		if (!from.length) { toast(`Nothing to ${what}`); return; }
		to.push(last);
		last = from.pop();
		const state = JSON.parse(last);
		doc.name = state.name; doc.strings = state.strings; nameInput.value = doc.name;
		const keep = [...undo], keepRedo = [...redo];
		apply();
		undo.length = 0; undo.push(...keep); redo.length = 0; redo.push(...keepRedo);
		renderStatus();
		renderPresets();
		select(selected);
	}

	function select(index, reveal = false) {
		selected = Math.max(0, Math.min(doc.strings.length - 1, index));
		world.selected = new Set(doc.strings.length ? [selected] : []);
		renderList();
		renderDetail();
		if (reveal) { const row = listEl.querySelector('.is-selected'); if (row) row.scrollIntoView({ block: 'nearest' }); }
	}

	function setKind(index, kind) {
		const s = doc.strings[index];
		if (!s) return;
		s.enabled = kind !== 'off';
		if (kind === 'rod') { s.kind = 'rod'; s.breakable = false; } else if (kind === 'string') delete s.kind;
		changed(true);
		renderPresets();
		select(index);
	}

	function setModel(id) {
		if (id === doc.model) return;
		if (applyTimer) apply();
		doc.model = id;
		apply();
		if (!savedOk) { toast('This browser would not save it, so the puppet cannot be changed here.'); return; }
		// Another puppet is other wood: other colliders, other masses. The page is built again round it.
		veil.say(`Carving ${MODELS.find((m) => m.id === id).label.toLowerCase()}…`);
		document.getElementById('curtain').classList.remove('is-open');
		setTimeout(() => location.reload(), 380);
	}

	function usePreset(p) {
		doc.strings = p.strings();
		changed(true);
		renderPresets();
		select(0);
		world.reset();
		toast(`${p.label} · ${p.tradition}`);
	}

	// ---------------------------------------------------------------- panel
	const side = $('side');
	const listEl = el('ul.links');
	const detailEl = el('div.detail');
	const presetGrid = el('div.cards.cards--presets');
	const presetAbout = el('div.about');
	const countEl = el('span.count');
	const filterBox = el('input.search', { type: 'search', placeholder: 'Find a link…  ( / )', 'aria-label': 'Find a link by name, handle or part', oninput: (e) => { query = e.target.value.trim().toLowerCase(); renderList(); } });
	const filterSeg = el('div.seg.seg--small', { role: 'group', 'aria-label': 'Which links to list' }, [['all', 'All'], ['string', 'Strings'], ['rod', 'Rods'], ['off', 'Off']].map(([id, label]) => el('button', { type: 'button', text: label, 'data-filter': id, onclick: () => { ui.filter = id; saveUi(); renderList(); } })));

	/** A section of the panel that folds away; which ones are folded is remembered. */
	function section(id, title, extra, ...children) {
		const node = el('details.fold', { open: !ui.closed.includes(id) },
			el('summary', {}, el('h2', { text: title }), extra),
			el('div.fold__body', {}, children));
		node.addEventListener('toggle', () => { ui.closed = ui.closed.filter((x) => x !== id); if (!node.open) ui.closed.push(id); saveUi(); });
		return node;
	}

	const modelCards = MODELS.map((m) => el('button.card.card--model', { type: 'button', 'aria-pressed': String(m.id === doc.model), title: m.about, onclick: () => setModel(m.id) },
		portrait(m.id), el('b', { text: m.label.replace(/^The /, '') })));
	const presetCards = MARIONETTE_PRESETS.map((p) => {
		const table = p.strings();
		const rods = table.filter((s) => kindOf(s) === 'rod').length, strings = table.filter((s) => kindOf(s) === 'string').length;
		return el('button.card.card--preset', { type: 'button', title: p.about, 'data-preset': p.id, onclick: () => usePreset(p) },
			diagram(table),
			el('span', {}, el('b', { text: p.label }), el('small', { text: p.tradition }), el('em', { text: [strings && plural(strings, 'string'), rods && plural(rods, 'rod')].filter(Boolean).join(' · ') })));
	});
	presetGrid.append(...presetCards);

	side.append(
		section('model', 'Puppet', el('span.count', { text: MODELS.find((m) => m.id === doc.model).label }),
			el('div.cards.cards--models', {}, modelCards),
			el('p.note', { text: `${MODELS.find((m) => m.id === doc.model).about} All three share one skeleton, so any stringing fits any of them.` })),
		section('style', 'Stringing', el('span.count', { id: 'style-name' }),
			presetGrid, presetAbout,
			el('dl.legend', {},
				el('div', {}, el('i'), el('span', { text: 'String — only pulls; hangs slack and wraps round a limb.' })),
				el('div', {}, el('i.rod'), el('span', { text: 'Rod — a stiff wire: pushes as well as pulls, never slack.' })))),
		section('links', 'Links', countEl,
			el('div.toolbar', {}, filterBox, filterSeg),
			listEl,
			el('div.row', { style: 'margin-top:10px' },
				el('button.btn', { type: 'button', text: '+ Add a link', onclick: addLink }),
				el('span.topbar__gap'),
				el('button.btn.btn--quiet', { type: 'button', text: 'All strings', title: 'Make every link that is on a string', onclick: () => bulk('string') }),
				el('button.btn.btn--quiet', { type: 'button', text: 'All rods', title: 'Make every link that is on a rod', onclick: () => bulk('rod') }))),
		section('detail', 'Selected link', null, detailEl),
	);

	function bulk(kind) {
		doc.strings.forEach((s) => { if (s.enabled === false) return; if (kind === 'rod') { s.kind = 'rod'; s.breakable = false; } else delete s.kind; });
		changed(true); renderPresets(); select(selected);
	}

	function renderPresets() {
		const active = presetOf(doc.strings);
		presetCards.forEach((card, i) => card.setAttribute('aria-pressed', String(MARIONETTE_PRESETS[i] === active)));
		$('style-name').textContent = active ? active.label : 'Your own';
		presetAbout.replaceChildren(...(active
			? [el('p', {}, el('b', { text: `${active.tradition}. ` }), active.about), el('p.note', { text: active.feel })]
			: [el('p', {}, el('b', { text: 'Your own stringing. ' }), 'Changed by hand from a tradition; pick one above to start again from it.')]));
	}

	function renderStatus(isDefault) {
		const rods = doc.strings.filter((s) => kindOf(s) === 'rod').length, strings = doc.strings.filter((s) => kindOf(s) === 'string').length, off = doc.strings.length - rods - strings;
		countEl.textContent = [plural(strings, 'string'), plural(rods, 'rod'), off && `${off} off`].filter(Boolean).join(' · ');
		if (isDefault !== undefined) {
			const state = $('saved');
			state.textContent = !savedOk ? 'This browser would not save it' : isDefault ? 'The default marionette' : 'Saved · the stage and the Studio use it';
			state.classList.toggle('is-bad', !savedOk);
		}
		$('btn-undo').disabled = !undo.length;
		$('btn-redo').disabled = !redo.length;
	}

	const loadBars = [];
	function renderList() {
		loadBars.length = 0;
		[...filterSeg.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === ui.filter)));
		const rows = [];
		doc.strings.forEach((s, i) => {
			const kind = kindOf(s);
			const bar = el('i');
			loadBars[i] = bar;
			const where = `${handleOf(s.handle).label} handle → ${bodyLabel(s.body)}`;
			if (ui.filter !== 'all' && kind !== ui.filter && i !== selected) return;
			if (query && !`${s.label} ${where} ${s.group}`.toLowerCase().includes(query)) return;
			const seg = el('div.seg.seg--small', { role: 'group', 'aria-label': `${s.label}: what it is` }, ['string', 'rod', 'off'].map((k) => el('button', {
				type: 'button', text: KIND_LABEL[k], 'data-kind': k, 'aria-pressed': String(kind === k),
				onclick: (e) => { e.stopPropagation(); setKind(i, k); },
			})));
			rows.push(el(`li.link${i === selected ? '.is-selected' : ''}${kind === 'off' ? '.is-off' : ''}`, { onclick: () => select(i), 'data-kind': kind },
				el('span.link__n', { text: i + 1 }),
				el('div.link__name', {}, el('b', { text: s.label }), el('small', { text: where }), el('div.link__load', {}, bar)),
				seg));
		});
		listEl.replaceChildren(...(rows.length ? rows : [el('li.empty', { text: doc.strings.length ? 'No link matches.' : 'No links. Add one, or pick a stringing above.' })]));
	}

	let liveEl = null;
	function renderDetail() {
		const s = doc.strings[selected];
		liveEl = null;
		if (!s) { detailEl.replaceChildren(el('p.empty', { text: 'No links. Add one, or pick a stringing above.' })); return; }
		const kind = kindOf(s);
		const original = cloneStrings().find((d) => d.id === s.id);
		const pick = (label, current, set, options) => el('label.field.field--wide', {}, el('span.field__label', { text: label }),
			el('select', { onchange: (e) => { set(e.target.value); changed(true); renderPresets(); select(selected); } }, options));
		const option = ([value, text], current) => el('option', { value, text, selected: value === current });
		const handles = RIG.bars.map((bar) => el('optgroup', { label: bar.label }, RIG.handles.filter((h) => h.bar === bar.id).map((h) => option([h.id, h.label], s.handle))));
		const tie = [['Side', 'x', 'Towards the puppet’s left (+) or right (−)'], ['Height', 'y', 'Up (+) or down (−) the part'], ['Front', 'z', 'Towards the audience (+) or the back (−)']].map(([label, axis, title], n) => slider(label, {
			min: -0.2, max: 0.2, hardMin: -0.4, hardMax: 0.4, step: 0.005, value: s.at[n], unit: 'cm', scale: 100, digits: 1, title, reset: original && original.body === s.body ? original.at[n] : 0,
			oninput: (v) => { s.at[n] = v; changed(); }, onchange: () => { changed(true); renderPresets(); },
		}).row);
		const twinBody = twin(s.body), twinHandle = twin(s.handle);
		liveEl = el('div.live');
		detailEl.replaceChildren(...[
			el('div.detail__head', {},
				el('input.detail__name', { type: 'text', maxLength: 32, value: s.label, 'aria-label': 'Name of this link', oninput: (e) => { s.label = e.target.value; }, onchange: () => { changed(true); renderPresets(); renderList(); } }),
				el('div.seg', { role: 'group', 'aria-label': 'What this link is' }, ['string', 'rod', 'off'].map((k) => el('button', { type: 'button', text: KIND_LABEL[k], 'data-kind': k, 'aria-pressed': String(kind === k), title: `${KIND_LABEL[k]} (${{ string: 'S', rod: 'D', off: 'X' }[k]})`, onclick: () => setKind(selected, k) })))),
			liveEl,
			el('h3', { text: 'Where it runs' }),
			pick('Hangs from', s.handle, (v) => { s.handle = v; }, handles),
			pick('Tied to', s.body, (v) => { s.body = v; s.at = [0, 0, 0]; delete s.out; }, RIG.bodies.map((b) => option([b.id, bodyLabel(b.id)], s.body))),
			el('h3', { text: 'Tie point', title: 'Where on that part, from its middle. A point inside the wood is moved out to the surface.' }),
			tie,
			el('h3', { text: kind === 'rod' ? 'The rod' : 'The string' }),
			kind === 'rod'
				? el('p.note', { text: 'A rod is as long as the distance it spans at rest: it has no slack to set.' })
				: slider('Slack', { min: -0.05, max: 0.3, hardMin: -0.2, hardMax: 0.6, step: 0.002, value: s.slack, unit: 'cm', scale: 100, digits: 1, reset: original ? original.slack : 0.02, title: 'Spare length at rest; below zero the string is tight before anything moves. Double-click to put back.', oninput: (v) => { s.slack = v; changed(); }, onchange: () => { changed(true); renderPresets(); } }).row,
			slider(kind === 'rod' ? 'Strength' : 'Gives at', { min: 20, max: 600, step: 5, value: s.max, unit: 'N', digits: 0, reset: original ? original.max : 160, title: 'The most it can carry before it gives. Double-click to put back.', oninput: (v) => { s.max = v; changed(); }, onchange: () => { changed(true); renderPresets(); } }).row,
			kind === 'string' && el('label.check', {}, el('input', { type: 'checkbox', checked: !!s.breakable, onchange: (e) => { s.breakable = e.target.checked; changed(true); renderPresets(); } }), 'Snaps if held at its limit'),
			el('div.row.detail__actions', {},
				el('button.btn', { type: 'button', text: 'Duplicate', title: 'A second link like this one (⌘D)', onclick: duplicate }),
				(twinBody || twinHandle) && el('button.btn', { type: 'button', text: 'Mirror', title: 'Make the link on the other side match this one (M)', onclick: mirror }),
				original && el('button.btn', { type: 'button', text: 'As it came', title: 'Put this link back as the default marionette has it', onclick: () => { doc.strings[selected] = { ...cloneStrings().find((d) => d.id === s.id) }; changed(true); renderPresets(); select(selected); } }),
				el('span.topbar__gap'),
				el('button.btn.btn--danger', { type: 'button', text: 'Remove', title: 'Remove this link (Del)', onclick: remove })),
		].flat().filter(Boolean));
	}

	function addLink() {
		if (doc.strings.length >= MAX_LINKS) { toast('Twenty-four links is the most a marionette here can carry'); return; }
		const n = doc.strings.length + 1;
		doc.strings.push({ n, id: `link${Date.now() % 100000}`, label: `Link ${n}`, body: 'chest', handle: 'back', at: [0, 0.06, -0.08], slack: 0.02, k: 3000, c: 30, max: 160, group: 'custom', enabled: true, breakable: false });
		changed(true); renderPresets();
		ui.filter = 'all'; query = ''; filterBox.value = '';
		select(doc.strings.length - 1, true);
	}
	function duplicate() {
		const s = doc.strings[selected];
		if (!s) return;
		if (doc.strings.length >= MAX_LINKS) { toast('Twenty-four links is the most a marionette here can carry'); return; }
		doc.strings.splice(selected + 1, 0, { ...s, at: [...s.at], id: `${s.id.slice(0, 16)}_${Date.now() % 1000}`, label: `${s.label} 2`.slice(0, 32) });
		changed(true); renderPresets();
		select(selected + 1, true);
	}
	function mirror() {
		const s = doc.strings[selected];
		if (!s) return;
		const body = twin(s.body) || s.body, handle = twin(s.handle) || s.handle;
		if (body === s.body && handle === s.handle) { toast('This link is on the puppet’s middle: it has no other side'); return; }
		let other = doc.strings.findIndex((o, i) => i !== selected && (o.id === twin(s.id) || (o.body === body && o.handle === handle)));
		const mirrored = { at: [-s.at[0], s.at[1], s.at[2]], slack: s.slack, max: s.max, k: s.k, c: s.c, enabled: s.enabled, breakable: s.breakable, ...(s.out ? { out: [-s.out[0], s.out[1], s.out[2]] } : {}) };
		if (other < 0) {
			if (doc.strings.length >= MAX_LINKS) { toast('Twenty-four links is the most a marionette here can carry'); return; }
			doc.strings.splice(selected + 1, 0, { ...s, ...mirrored, id: twin(s.id) || `${s.id.slice(0, 16)}_m`, label: s.label.replace(/\b(Left|Right)\b/i, (w) => (/left/i.test(w) ? 'Right' : 'Left')), body, handle });
			other = selected + 1;
		} else {
			const o = doc.strings[other];
			Object.assign(o, mirrored, { body, handle });
			if (s.kind === 'rod') o.kind = 'rod'; else delete o.kind;
			if (!s.out) delete o.out;
		}
		changed(true); renderPresets(); select(selected);
		toast(`${doc.strings[other].label} now matches ${s.label}`);
	}
	function remove() {
		if (!doc.strings[selected]) return;
		const { label } = doc.strings[selected];
		doc.strings.splice(selected, 1);
		changed(true); renderPresets(); select(selected);
		toast(`${label} removed · ⌘Z brings it back`);
	}

	// What each link is carrying, a few times a second: a bar under its name (steel while a rod pushes) and the figures for the selected one.
	setInterval(() => {
		sim.strings.forEach((s, i) => {
			const bar = loadBars[i];
			if (!bar) return;
			bar.style.width = `${Math.min(100, (sim.tension[i] / s.def.max) * 100 * 2.5).toFixed(0)}%`;
			bar.classList.toggle('is-push', !!s.push);
		});
		const live = sim.strings[selected], s = doc.strings[selected];
		if (!liveEl || !s) return;
		if (!live || live.def.id !== s.id || kindOf(s) === 'off') { liveEl.replaceChildren(el('span', { text: kindOf(s) === 'off' ? 'Taken off: it carries nothing.' : '…' })); return; }
		const load = sim.tension[selected];
		const state = live.broken ? 'snapped' : live.push ? 'pushing' : load > 0.05 ? (live.rod ? 'pulling' : 'taut') : (live.rod ? 'at rest' : 'slack');
		liveEl.replaceChildren(
			el('span', {}, el('b', { text: `${load.toFixed(1)} N` }), ` of ${live.def.max.toFixed(0)} N`),
			el('span', { class: `live__state is-${state.replace(' ', '-')}`, text: state }),
			el('span', {}, el('b', { text: `${(live.rest * 100).toFixed(1)} cm` }), ' long'));
	}, 160);

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
		if (hit >= 0) select(hit, true);
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

	// The test bench, along the bottom of the viewport.
	const benchAbout = el('span.bench__about');
	const benchButtons = BENCH.map((b) => el('button', { type: 'button', text: b.label, title: b.about, 'aria-pressed': 'false', onclick: () => setBench(b) }));
	function setBench(b) {
		bench = b; benchT = 0;
		benchButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(BENCH[i] === b)));
		benchAbout.textContent = b.about;
	}
	$('bench').append(
		el('div.bench__row', {}, el('span.bench__title', { text: 'Try it' }), el('div.seg', { role: 'group', 'aria-label': 'What the control bars do' }, benchButtons)),
		el('div.bench__row', {},
			slider('Speed', { min: 0.1, max: 3, step: 0.05, value: 1, unit: '×', digits: 2, reset: 1, oninput: (v) => { benchSpeed = v; } }).row,
			slider('Size', { min: 0, max: 2, step: 0.05, value: 1, unit: '×', digits: 2, reset: 1, title: 'How far the bars and handles are moved. Double-click to put back.', oninput: (v) => { benchSize = v; } }).row,
			benchAbout));

	const viewButtons = VIEWS.map((v) => el('button', { type: 'button', text: v.label, title: v.title, onclick: () => camera.set(v.position, v.target) }));
	$('views').append(...viewButtons);

	// -------------------------------------------------------------- buttons
	const nameInput = $('name');
	nameInput.value = doc.name;
	nameInput.addEventListener('change', () => { doc.name = nameInput.value.trim().slice(0, 40) || DEFAULT_NAME; nameInput.value = doc.name; changed(true); });
	const slow = () => { const on = world.tuning.timeScale === 1; world.tuning.timeScale = on ? 0.25 : 1; $('btn-slow').setAttribute('aria-pressed', String(on)); };
	$('btn-reset').addEventListener('click', () => { world.reset(); toast('Puppet reset'); });
	$('btn-slow').addEventListener('click', slow);
	$('btn-undo').addEventListener('click', () => travel(undo, redo, 'undo'));
	$('btn-redo').addEventListener('click', () => travel(redo, undo, 'redo'));
	$('btn-export').addEventListener('click', () => { if (applyTimer) apply(); downloadJson(doc.name, marionetteDocument(doc.name, doc.strings, doc.model)); });
	$('btn-import').addEventListener('click', () => openJson((data) => {
		const next = parseMarionette(data);
		if (!next) { toast('That file holds no strings or rods this puppet can use'); return; }
		doc.name = next.name; doc.strings = next.strings; nameInput.value = doc.name;
		changed(true); renderPresets(); select(0);
		if (next.model !== doc.model) { setModel(next.model); return; }
		toast(`Loaded “${doc.name}”`);
	}));
	$('btn-default').addEventListener('click', () => {
		doc.name = DEFAULT_NAME; doc.strings = cloneStrings(); nameInput.value = doc.name;
		changed(true); renderPresets(); select(0); world.reset();
		if (doc.model !== DEFAULT_MODEL) { setModel(DEFAULT_MODEL); return; }
		toast('Default marionette loaded: the twelve strings · ⌘Z brings yours back');
	});
	$('btn-stage').addEventListener('click', () => {
		changed(true);   // anything still waiting on a dragged slider is saved before leaving
		if (!savedOk) { toast('This browser would not save it, so the stage cannot use it. Export it instead.'); return; }
		location.href = './';
	});

	const help = $('help');
	help.querySelector('dl').append(...SHORTCUTS.map(([keys, what]) => el('div', {}, el('dt', {}, keys.split(' ').map((k) => (/^[–]$/.test(k) ? ' – ' : el('kbd', { text: k })))), el('dd', { text: what }))));
	const toggleHelp = (on = help.hidden) => { help.hidden = !on; $('btn-help').setAttribute('aria-pressed', String(on)); };
	$('btn-help').addEventListener('click', () => toggleHelp());
	$('help-close').addEventListener('click', () => toggleHelp(false));

	window.addEventListener('keydown', (e) => {
		const mod = e.metaKey || e.ctrlKey;
		if (mod && e.key.toLowerCase() === 'z' && !typing(e)) { e.preventDefault(); if (e.shiftKey) travel(redo, undo, 'redo'); else travel(undo, redo, 'undo'); return; }
		if (mod && e.key.toLowerCase() === 'y' && !typing(e)) { e.preventDefault(); travel(redo, undo, 'redo'); return; }
		if (mod && e.key.toLowerCase() === 'd' && !typing(e)) { e.preventDefault(); duplicate(); return; }
		if (e.key === 'Escape') { if (!help.hidden) toggleHelp(false); else if (document.activeElement === filterBox) { filterBox.value = ''; query = ''; renderList(); filterBox.blur(); } return; }
		if (typing(e) || mod || e.altKey) return;
		const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
		if (key === '?') toggleHelp();
		else if (key === '/') { e.preventDefault(); filterBox.closest('details').open = true; filterBox.focus(); }
		else if (key === 'r') $('btn-reset').click();
		else if (key === ' ') { e.preventDefault(); slow(); }
		else if (key >= '1' && key <= String(VIEWS.length)) viewButtons[+key - 1].click();
		else if (key === 'ArrowDown') { e.preventDefault(); select(selected + 1, true); }
		else if (key === 'ArrowUp') { e.preventDefault(); select(selected - 1, true); }
		else if (key === 's') setKind(selected, 'string');
		else if (key === 'd') setKind(selected, 'rod');
		else if (key === 'x') setKind(selected, 'off');
		else if (key === 'm') mirror();
		else if (key === 'Delete' || key === 'Backspace') remove();
	});

	setBench(BENCH[0]);
	apply();
	undo.length = 0;
	renderPresets();
	select(0);
	renderStatus();
	// Handy for the browser console and automated checks.
	window.motionPuppet = { ...world, world, doc, camera, select, setKind, setModel, usePreset: (id) => usePreset(MARIONETTE_PRESETS.find((p) => p.id === id)), setBench: (id) => setBench(BENCH.find((b) => b.id === id) || BENCH[0]) };
	world.start();
	veil.open();
}

boot().catch((err) => { console.error(err); veil.fail(bootError(err)); });
