// Small things the two workbench pages share: building DOM, the toast, files, the opening curtain.

/** el('button.btn', { type: 'button', onclick }, 'Text', child, ...) */
export function el(spec, props = {}, ...children) {
	const [tag, ...classes] = spec.split('.');
	const node = document.createElement(tag || 'div');
	if (classes.length) node.className = classes.join(' ');
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;
		if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
		else if (key === 'text') node.textContent = value;
		else if (key in node && key !== 'list') node[key] = value;
		else node.setAttribute(key, value === true ? '' : value);
	}
	for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
	return node;
}

let toastTimer = 0;
export function toast(text) {
	const node = document.getElementById('toast');
	node.textContent = text;
	node.classList.add('is-on');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => node.classList.remove('is-on'), 2600);
}

/** Offers `data` as a JSON file to save. */
export function downloadJson(name, data) {
	const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, '\t')], { type: 'application/json' }));
	const a = el('a', { href: url, download: `${String(name).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'untitled'}.json` });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Asks for a JSON file and hands what it holds to `use`. */
export function openJson(use) {
	const input = el('input', { type: 'file', accept: '.json,application/json' });
	input.addEventListener('change', async () => {
		const file = input.files && input.files[0];
		if (!file) return;
		try { use(JSON.parse(await file.text()), file.name); } catch { toast('That file is not JSON this page can read'); }
	});
	input.click();
}

/** A number as it is shown in a number box: `digits` decimals, and up to two more if the value really has them. */
export function showNumber(v, digits = 2) {
	const fixed = v.toFixed(digits);
	if (Math.abs(+fixed - v) < 1e-9) return fixed;
	return String(+v.toFixed(digits + 2));
}

/** Reads what was typed into a number box ("1,5", " 12 cm", "-.4"); NaN if it is no number. */
export function readNumber(text) {
	const match = String(text).replace(',', '.').match(/-?(\d+\.?\d*|\.\d+)(e-?\d+)?/i);
	return match ? parseFloat(match[0]) : NaN;
}

/**
 * A labelled slider with a number box beside it, so a value can be dragged roughly or typed
 * exactly. The slider moves in `step`s between `min` and `max`; the box takes any value between
 * `hardMin` and `hardMax` (the slider's ends unless given), is not rounded to the step, and
 * steps with ↑ ↓ (Shift: ten steps, Alt: a tenth of one). Shown as value × `scale` with
 * `digits` decimals and a `unit`. Double-clicking the label goes back to `reset`.
 * Returns { row, input, box, set(value), value }.
 */
export function slider(label, { min, max, step = 0.01, value = 0, unit = '', scale = 1, digits = 2, hardMin = min, hardMax = max, reset, title, oninput, onchange }) {
	let current = +value, dirty = false;
	const input = el('input', { type: 'range', min, max, step, 'aria-label': label, tabIndex: -1 });
	const box = el('input', { type: 'text', inputMode: 'decimal', autocomplete: 'off', spellcheck: false, 'aria-label': unit ? `${label} (${unit})` : label, title: `Type an exact value · ↑ ↓ to step · Shift ×10 · Alt ÷10` });
	const clamp = (v) => Math.max(hardMin, Math.min(hardMax, v));
	const show = () => { input.value = current; box.value = showNumber(current * scale, digits); };
	const put = (v, final) => {
		const next = clamp(v);
		const moved = next !== current;
		current = next;
		if (moved && oninput) oninput(current);
		if (moved) dirty = true;
		if (final && dirty) { dirty = false; if (onchange) onchange(current); }
	};
	show();
	input.addEventListener('input', () => { put(+input.value, false); box.value = showNumber(current * scale, digits); });
	input.addEventListener('change', () => put(+input.value, true));
	const commit = () => {
		const typed = readNumber(box.value);
		if (Number.isFinite(typed)) put(typed / scale, true);
		show();
	};
	box.addEventListener('focus', () => box.select());
	box.addEventListener('blur', commit);
	box.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { commit(); box.select(); e.preventDefault(); }
		else if (e.key === 'Escape') { show(); box.blur(); }
		else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			const typed = readNumber(box.value);
			const from = Number.isFinite(typed) ? typed / scale : current;
			const by = step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
			put(+(from + by).toFixed(10), false);
			show();
			box.select();
		}
	});
	const name = el('span.field__label', { text: label, title: title || (reset !== undefined ? 'Double-click to put back' : undefined) });
	if (reset !== undefined) name.addEventListener('dblclick', () => { put(reset, true); show(); });
	const row = el('div.field.field--num', {}, name, input, el('span.numbox', {}, box, unit && el('i', { text: unit })));
	return {
		row, input, box,
		get value() { return current; },
		set(v) { current = +v; if (document.activeElement !== box) show(); else input.value = current; },
	};
}

/** True while typing somewhere a keyboard shortcut should leave alone. */
export const typing = (e) => e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox' || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;

/** Lifts the opening curtain, or says on it why the page could not start. */
export function curtain() {
	const node = document.getElementById('curtain');
	const text = document.getElementById('curtain-text');
	return {
		say(message) { text.textContent = message; },
		open() { node.classList.add('is-open'); },
		fail(message) { node.classList.add('is-error'); text.textContent = message; },
	};
}
