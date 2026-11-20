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

/** A labelled slider with its value beside it. Returns { row, set(value) }. */
export function slider(label, { min, max, step = 0.01, value = 0, format = (v) => v.toFixed(2), oninput, onchange }) {
	const out = el('output');
	const input = el('input', { type: 'range', min, max, step, 'aria-label': label });
	const show = (v) => { out.textContent = format(v); };
	input.value = value;
	show(+value);
	input.addEventListener('input', () => { show(+input.value); if (oninput) oninput(+input.value); });
	input.addEventListener('change', () => { if (onchange) onchange(+input.value); });
	return { row: el('label.field', {}, el('span', { text: label }), input, out), input, set(v) { if (document.activeElement !== input) input.value = v; show(+v); } };
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
