// Custom Rig editor: strings, motion mappings and body tone, all stored as one
// JSON document that can be saved in this browser, exported and imported.

import { RIG, BODIES, HANDLES } from '../shared/rig-config.js';
import { defaultCustomRig, sanitizeCustomRig } from '../shared/modes.js';
import { SOURCES, CURVES, listTargets } from '../shared/mapping.js';

const SAVED_KEY = 'mp.rigs';
const MAX_STRINGS = 24;

function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === 'class') el.className = value;
		else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
		else if (value === true) el.setAttribute(key, '');
		else if (value !== false && value !== null && value !== undefined) el.setAttribute(key, value);
	}
	for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child);
	return el;
}

export class RigEditor {
	/** opts: { panel, body, tabs, get(): rig, set(rig), toast(text) } */
	constructor(opts) {
		this.o = opts;
		this.tab = 'strings';
		this.open_ = new Set();
		this.targets = listTargets(RIG);
		this.timer = 0;
		for (const b of opts.tabs.querySelectorAll('button')) {
			b.addEventListener('click', () => {
				this.tab = b.dataset.tab;
				for (const x of opts.tabs.querySelectorAll('button')) x.setAttribute('aria-pressed', x === b);
				this.render();
			});
		}
	}

	open() { this.o.panel.hidden = false; this.render(); }
	close() { this.o.panel.hidden = true; }

	/** Applies an edit; re-renders when the structure (not just a value) changed. */
	commit(rerender = false) {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.o.set(this.o.get()), 140);
		if (rerender) this.render();
	}

	slider(label, value, min, max, step, onInput, format = (v) => v) {
		const out = h('output', {}, String(format(value)));
		const input = h('input', { type: 'range', min, max, step, value, oninput: (e) => { const v = +e.target.value; out.textContent = format(v); onInput(v); this.commit(); } });
		return h('label', { class: 'field' }, h('span', {}, label), input, out);
	}

	select(label, value, options, onChange) {
		const sel = h('select', { onchange: (e) => { onChange(e.target.value); this.commit(true); } },
			options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
		return h('label', { class: 'field' }, h('span', {}, label), sel);
	}

	toggleRow(key, head, more) {
		const open = this.open_.has(key);
		const row = h('div', { class: 'row' }, head);
		if (open) row.append(h('div', { class: 'row__more' }, more()));
		return row;
	}

	expander(key) {
		const open = this.open_.has(key);
		return h('button', { class: 'mini', type: 'button', onclick: () => { open ? this.open_.delete(key) : this.open_.add(key); this.render(); } }, open ? 'Close' : 'Tune');
	}

	render() {
		const body = this.o.body;
		const scroll = body.scrollTop;
		body.textContent = '';
		const rig = this.o.get();
		if (this.tab === 'strings') this.renderStrings(body, rig);
		else if (this.tab === 'mapping') this.renderMapping(body, rig);
		else if (this.tab === 'body') this.renderBody(body, rig);
		else this.renderSaved(body, rig);
		body.scrollTop = scroll;
	}

	renderStrings(body, rig) {
		body.append(h('p', { class: 'note' }, `Up to ${MAX_STRINGS} strings. Each one runs from a handle on a control bar to a point on the puppet, and can only pull.`));
		rig.strings.forEach((s, i) => {
			const key = `s${i}`;
			const head = h('div', { class: 'row__head' },
				h('input', { type: 'checkbox', class: 'switch', checked: s.enabled !== false, 'aria-label': `Enable ${s.label}`, onchange: (e) => { s.enabled = e.target.checked; this.commit(); } }),
				h('strong', {}, `${i + 1}. ${s.label}`), h('small', {}, `${s.body}`), this.expander(key));
			body.append(this.toggleRow(key, head, () => [
				h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', value: s.label, maxlength: 32, onchange: (e) => { s.label = e.target.value || s.label; this.commit(true); } })),
				this.select('Attach to', s.body, BODIES.map((b) => [b.id, b.id]), (v) => { s.body = v; s.at = [0, 0, 0]; }),
				this.select('Handle', s.handle, HANDLES.map((x) => [x.id, `${x.label} (${x.bar} bar)`]), (v) => { s.handle = v; }),
				this.slider('Slack', s.slack, -0.05, 0.4, 0.005, (v) => { s.slack = v; }, (v) => `${Math.round(v * 100)} cm`),
				this.slider('Elasticity', s.k, 300, 12000, 100, (v) => { s.k = v; }, (v) => `${(v / 1000).toFixed(1)}k`),
				this.slider('Damping', s.c, 4, 160, 2, (v) => { s.c = v; }),
				this.slider('Max tension', s.max, 30, 600, 10, (v) => { s.max = v; }, (v) => `${v} N`),
				h('div', { class: 'row__head' },
					h('input', { type: 'checkbox', class: 'switch', checked: !!s.breakable, onchange: (e) => { s.breakable = e.target.checked; this.commit(); } }),
					h('strong', {}, 'Snaps when overloaded'),
					h('button', { class: 'mini mini--danger', type: 'button', onclick: () => { rig.strings.splice(i, 1); this.open_.delete(key); this.commit(true); } }, 'Remove')),
			]));
		});
		body.append(h('button', {
			class: 'mini wide', type: 'button', disabled: rig.strings.length >= MAX_STRINGS,
			onclick: () => {
				const n = rig.strings.length + 1;
				rig.strings.push({ n, id: `custom${Date.now().toString(36)}`, label: `String ${n}`, body: 'head', handle: 'head', at: [0, 0, 0], slack: 0.02, k: 3000, c: 30, max: 200, group: 'custom', enabled: true, breakable: false });
				this.open_.add(`s${n - 1}`);
				this.commit(true);
			},
		}, '+ Add a string'));
	}

	renderMapping(body, rig) {
		body.append(h('p', { class: 'note' }, 'Each row wires one phone input to one part of the puppet. Sensitivity scales it; open a row for dead zone, smoothing, response curve and limits.'));
		rig.mappings.forEach((m, i) => {
			const key = `m${i}`;
			const srcName = (SOURCES.find((x) => x[0] === m.src) || [m.src, m.src])[1];
			const dstName = (this.targets.find((x) => x[0] === m.dst) || [m.dst, m.dst])[1];
			const head = h('div', { class: 'row__head' }, h('strong', {}, `${srcName} → ${dstName}`), h('small', {}, m.dev === 1 ? 'phone 2' : ''), this.expander(key));
			const row = this.toggleRow(key, head, () => [
				this.select('Input', m.src, SOURCES, (v) => { m.src = v; }),
				this.select('Drives', m.dst, this.targets, (v) => { m.dst = v; }),
				this.select('Phone', String(m.dev || 0), [['0', 'First phone'], ['1', 'Second phone (Pro)']], (v) => { if (v === '1') { m.dev = 1; m.when = 'pro'; } else { delete m.dev; delete m.when; } }),
				this.slider('Dead zone', m.dead || 0, 0, 2, 0.01, (v) => { m.dead = v; }, (v) => v.toFixed(2)),
				this.slider('Smoothing', m.smooth || 0, 0, 0.6, 0.01, (v) => { m.smooth = v; }, (v) => `${Math.round(v * 1000)} ms`),
				this.select('Curve', m.curve || 'linear', Object.keys(CURVES).map((c) => [c, c]), (v) => { m.curve = v; }),
				this.slider('Limit ±', m.clamp ? Math.max(Math.abs(m.clamp[0]), Math.abs(m.clamp[1])) : 5, 0.05, 5, 0.05, (v) => { m.clamp = [-v, v]; }, (v) => v.toFixed(2)),
				h('div', { class: 'row__head' },
					h('input', { type: 'checkbox', class: 'switch', checked: !!m.invert, onchange: (e) => { m.invert = e.target.checked; this.commit(); } }),
					h('strong', {}, 'Invert'),
					h('button', { class: 'mini mini--danger', type: 'button', onclick: () => { rig.mappings.splice(i, 1); this.open_.delete(key); this.commit(true); } }, 'Remove')),
			]);
			row.append(h('div', { class: 'row__more' }, this.slider('Sensitivity', m.gain ?? 1, -4, 4, 0.05, (v) => { m.gain = v; }, (v) => `${v.toFixed(2)}×`)));
			body.append(row);
		});
		body.append(h('button', {
			class: 'mini wide', type: 'button', disabled: rig.mappings.length >= 48,
			onclick: () => { rig.mappings.push({ src: 'ori.roll', dst: 'main.roll', gain: 1, dead: 0.02, smooth: 0.05 }); this.open_.add(`m${rig.mappings.length - 1}`); this.commit(true); },
		}, '+ Add a mapping'));
	}

	renderBody(body, rig) {
		body.append(h('p', { class: 'note' }, 'How much the puppet helps you. Tone is the pull of each region back to its rest pose (the active ragdoll); balance keeps the torso upright and calms swinging.'));
		const pct = (v) => `${Math.round(v * 100)}%`;
		body.append(h('div', { class: 'row' }, h('div', { class: 'row__more' },
			this.slider('Spine tone', rig.tone.spine, 0, 5, 0.05, (v) => { rig.tone.spine = v; }, pct),
			this.slider('Head tone', rig.tone.head, 0, 5, 0.05, (v) => { rig.tone.head = v; }, pct),
			this.slider('Arm tone', rig.tone.arms, 0, 5, 0.05, (v) => { rig.tone.arms = v; }, pct),
			this.slider('Leg tone', rig.tone.legs, 0, 5, 0.05, (v) => { rig.tone.legs = v; }, pct),
			this.slider('Balance', rig.balance, 0, 1, 0.01, (v) => { rig.balance = v; }, pct),
			this.slider('String pull', rig.stringGain, 0.2, 1.5, 0.01, (v) => { rig.stringGain = v; }, pct),
			this.slider('Bar response', rig.response, 6, 40, 1, (v) => { rig.response = v; }, (v) => `${v}`))));
	}

	renderSaved(body, rig) {
		let saved = {};
		try { saved = JSON.parse(localStorage.getItem(SAVED_KEY) || '{}') || {}; } catch { saved = {}; }
		const write = () => { try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); } catch { this.o.toast('This browser would not store the rig'); } };
		const name = h('input', { type: 'text', value: rig.name, maxlength: 40, 'aria-label': 'Rig name', onchange: (e) => { rig.name = e.target.value || rig.name; this.commit(); } });
		body.append(h('p', { class: 'note' }, 'Rigs are kept in this browser only. Export the JSON to share one or move it to another phone.'), name,
			h('div', { class: 'btnrow' },
				h('button', { class: 'mini', type: 'button', onclick: () => { rig.name = name.value || rig.name; saved[rig.name] = JSON.parse(JSON.stringify(rig)); write(); this.o.toast(`Saved "${rig.name}"`); this.render(); } }, 'Save'),
				h('button', { class: 'mini', type: 'button', onclick: () => { this.o.set(defaultCustomRig()); this.o.toast('Back to the default rig'); this.render(); } }, 'Start over')));
		for (const key of Object.keys(saved)) {
			body.append(h('div', { class: 'row' }, h('div', { class: 'row__head' },
				h('strong', {}, key),
				h('small', {}, `${(saved[key].strings || []).length} strings`),
				h('button', { class: 'mini', type: 'button', onclick: () => { this.o.set(sanitizeCustomRig(saved[key], RIG)); this.o.toast(`Loaded "${key}"`); this.render(); } }, 'Load'),
				h('button', { class: 'mini mini--danger', type: 'button', onclick: () => { delete saved[key]; write(); this.render(); } }, 'Delete'))));
		}
		const text = h('textarea', { spellcheck: 'false', 'aria-label': 'Rig JSON' }, JSON.stringify(rig, null, 1));
		body.append(h('p', { class: 'note' }, 'JSON'), text,
			h('div', { class: 'btnrow' },
				h('button', { class: 'mini', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(text.value); this.o.toast('Copied'); } catch { text.select(); this.o.toast('Select all and copy'); } } }, 'Copy'),
				h('button', {
					class: 'mini', type: 'button',
					onclick: () => {
						let parsed;
						try { parsed = JSON.parse(text.value); } catch { this.o.toast('That is not valid JSON'); return; }
						this.o.set(sanitizeCustomRig(parsed, RIG));
						this.o.toast('Rig imported');
						this.render();
					},
				}, 'Import from the box')));
	}
}
