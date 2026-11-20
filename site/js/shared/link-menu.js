// The little menu that opens where a string or rod is clicked: what the link is, what it is
// carrying, and the things that can be done to it there and then. The Marionette editor and
// the stage (while no phone holds the strings) both open it; each says what goes in it.

import { toScreen, pointerAt, segmentDistance } from '../studio/orbit.js';

const _a = [0, 0, false], _b = [0, 0, false];

/** The link under the pointer: the index of the nearest drawn string or rod within `reach` pixels, or -1. */
export function linkAt(e, strings, camera, canvas, reach = 9) {
	const p = pointerAt(e, canvas);
	let best = -1, least = reach;
	strings.items.forEach((item, i) => {
		if (!item.points || !item.line.visible) return;
		for (let k = 0; k < item.points.length - 1; k++) {
			toScreen(item.points[k], camera, canvas, _a); toScreen(item.points[k + 1], camera, canvas, _b);
			if (!_a[2] || !_b[2]) continue;
			const d = segmentDistance(p, _a, _b);
			if (d < least) { least = d; best = i; }
		}
	});
	return best;
}

export const kindOf = (s) => (s.enabled === false ? 'off' : s.kind === 'rod' ? 'rod' : 'string');
const KINDS = [['string', 'String'], ['rod', 'Rod'], ['off', 'Off']];

function make(tag, props = {}, ...children) {
	const [name, ...classes] = tag.split('.');
	const node = document.createElement(name || 'div');
	if (classes.length) node.className = classes.join(' ');
	for (const [key, value] of Object.entries(props)) {
		if (key === 'text') node.textContent = value;
		else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
		else if (value !== false && value != null) node.setAttribute(key, value);
	}
	node.append(...children.flat().filter(Boolean));
	return node;
}

/** A number that can be typed exactly, with a step either side of it. */
function stepper({ label, unit = '', value, scale = 1, digits = 1, step, min, max, title, set }) {
	let current = value;
	const show = () => { box.value = (current * scale).toFixed(digits).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m)).replace(/^-0$/, '0'); };
	const put = (v) => {
		if (!Number.isFinite(v)) { show(); return; }
		current = Math.max(min, Math.min(max, v));
		show();
		set(current);
	};
	const box = make('input', { type: 'text', inputmode: 'decimal', 'aria-label': `${label}${unit ? `, in ${unit}` : ''}`, autocomplete: 'off', spellcheck: 'false' });
	box.addEventListener('change', () => put(parseFloat(box.value.replace(',', '.')) / scale));
	box.addEventListener('focus', () => box.select());
	box.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { box.blur(); return; }
		if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
		e.preventDefault();
		put(current + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1));
	});
	show();
	return make('div.linkmenu__num', { title },
		make('span', { text: label }),
		make('button', { type: 'button', text: '−', 'aria-label': `Less ${label.toLowerCase()}`, onclick: () => put(current - step) }),
		box,
		make('button', { type: 'button', text: '+', 'aria-label': `More ${label.toLowerCase()}`, onclick: () => put(current + step) }),
		make('em', { text: unit }));
}

/** A slider for something that is moved rather than set: how far a handle is held from where it hangs. */
function range({ label, unit = '', value, scale = 1, digits = 0, step, min, max, title, set }) {
	const input = make('input', { type: 'range', min, max, step, 'aria-label': `${label}${unit ? `, in ${unit}` : ''}` });
	const out = make('em');
	const show = () => { out.textContent = `${(+input.value * scale).toFixed(digits).replace(/^-0$/, '0')} ${unit}`; };
	input.value = value;
	input.addEventListener('input', () => { show(); set(+input.value); });
	input.addEventListener('dblclick', () => { input.value = 0; show(); set(0); });
	show();
	return make('label.linkmenu__range', { title }, make('span', { text: label }), input, out);
}

/**
 * One menu for the page. `open(spec, at)` shows it at `at` ([x, y] in the window; where it
 * already is when left out) with:
 *   title, sub          the link's name, and where it runs
 *   kind                'string' | 'rod' | 'off', and onKind(kind) to change it
 *   live()              → { text, state } read a few times a second (what it is carrying), or null
 *   ranges              [{ label, unit, value, scale, digits, step, min, max, title, set(value) }]   sliders, for moving
 *   numbers             [{ label, unit, value, scale, digits, step, min, max, title, set(value) }]
 *   actions             [{ label, title, danger, wide, run() }]   (the menu closes unless run() returns true)
 *   note                a line of small print
 * It closes on Escape, on a press anywhere else, and when `close()` is called.
 */
export function createLinkMenu() {
	const node = make('div.linkmenu', { role: 'dialog', 'aria-label': 'This link', hidden: '' });
	document.body.append(node);
	let place = [0, 0], live = null, liveEl = null, timer = 0, onClose = null;

	function tick() {
		const now = live && live();
		if (!now || !liveEl) return;
		liveEl.textContent = now.text;
		liveEl.dataset.state = now.state || '';
	}
	function close() {
		if (node.hidden) return;
		node.hidden = true;
		clearInterval(timer);
		live = null;
		const done = onClose; onClose = null;
		if (done) done();
	}
	function open(spec, at) {
		if (at) place = at;
		const fresh = node.hidden || !!at;
		clearInterval(timer);
		live = spec.live || null;
		onClose = spec.onClose || null;
		liveEl = live ? make('p.linkmenu__live') : null;
		node.replaceChildren(...[
			make('header', {},
				make('div', {}, make('b', { text: spec.title }), make('small', { text: spec.sub })),
				make('button.linkmenu__x', { type: 'button', text: '×', 'aria-label': 'Close', onclick: close })),
			liveEl,
			spec.onKind && make('div.linkmenu__kinds', { role: 'group', 'aria-label': 'What this link is' }, KINDS.map(([id, label]) => make('button', {
				type: 'button', text: label, 'data-kind': id, 'aria-pressed': String(spec.kind === id), onclick: () => spec.onKind(id),
			}))),
			(spec.ranges || []).map(range),
			(spec.numbers || []).map(stepper),
			spec.actions && make('div.linkmenu__actions', {}, spec.actions.map((a) => make(`button${a.danger ? '.is-danger' : ''}${a.wide ? '.is-wide' : ''}`, {
				type: 'button', text: a.label, title: a.title, onclick: () => { if (a.run() !== true) close(); },
			}))),
			spec.note && make('p.linkmenu__note', { text: spec.note }),
		].flat().filter(Boolean));
		node.hidden = false;
		// Beside the pointer, and wholly on the page.
		const w = node.offsetWidth, h = node.offsetHeight;
		const x = place[0] + 14 + w > innerWidth - 8 ? place[0] - 14 - w : place[0] + 14;
		node.style.left = `${Math.max(8, x)}px`;
		node.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, place[1] - 18))}px`;
		if (fresh) { node.classList.remove('is-in'); requestAnimationFrame(() => node.classList.add('is-in')); }
		tick();
		if (live) timer = setInterval(tick, 160);
	}

	document.addEventListener('pointerdown', (e) => { if (!node.hidden && !node.contains(e.target)) close(); }, true);
	window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !node.hidden) { e.stopPropagation(); close(); } }, true);
	window.addEventListener('resize', close);

	return { node, open, close, get isOpen() { return !node.hidden; } };
}

/** What a simulated link is doing, for the menu's live line. */
export function linkState(live, load) {
	const state = live.broken ? 'snapped' : live.push ? 'pushing' : load > 0.05 ? (live.rod ? 'pulling' : 'taut') : (live.rod ? 'at rest' : 'slack');
	return { text: `${load.toFixed(1)} N of ${live.def.max.toFixed(0)} N · ${state} · ${(live.rest * 100).toFixed(1)} cm long`, state };
}
