// Stage (desktop): owns the simulation, renders the theatre, pairs up to two
// phones (one QR code each) and streams puppet state to them.

import * as THREE from 'three';
import qrcode from '../../vendor/qrcode.mjs';
import { RIG } from '../shared/rig-config.js';
import { MODES } from '../shared/modes.js';
import { encodeState, decodeInput, seqNewer, PROTOCOL_VERSION } from '../shared/protocol.js';
import { HostLink } from '../shared/net.js';
import { cloneStrings } from '../shared/rig-config.js';
import { sanitizeStrings } from '../shared/modes.js';
import { marionetteRig, loadMarionette, saveMarionette, marionetteDocument, isDefaultMarionette, DEFAULT_NAME } from '../shared/marionette.js';
import { createLinkMenu, linkAt, linkState, kindOf } from '../shared/link-menu.js';
import { createWorld, bootError } from './world.js';

const $ = (sel) => document.querySelector(sel);
const SNAPSHOT_HZ = 40;
const ROLE_NAMES = ['Puppeteer one', 'Puppeteer two'];
const TICKET_LINGER = 30000;   // ms the spare ticket stays large after a phone joins, before it folds to a chip

const curtain = $('#curtain');
const curtainText = $('#curtain-text');
const toastEl = $('#toast');
let toastTimer = 0;
function toast(text) {
	toastEl.textContent = text;
	toastEl.classList.add('is-on');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2600);
}

function qrSvg(text) {
	const qr = qrcode(0, 'M');
	qr.addData(text);
	qr.make();
	const n = qr.getModuleCount();
	let d = '';
	for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${n + 2} ${n + 2}" shape-rendering="crispEdges"><path fill="#1a0f0a" d="${d}"/></svg>`;
}

async function boot() {
	// The puppet as the Marionette editor last strung it (strings, rods), or the default twelve strings.
	const world = await createWorld($('#stage'), { rig: marionetteRig(), onProgress: (text) => { curtainText.textContent = text; } });
	const { sim, controller, stage, puppet, strings, tuning, resize } = world;
	window.addEventListener('resize', resize);

	// ------------------------------------------------------------ pairing
	const pairing = $('#pairing');
	const modeLabel = $('#mode-label');
	const phonesLabel = $('#phones-label');
	const slots = [0, 1].map((slot) => {
		const el = pairing.querySelector(`[data-slot="${slot}"]`);
		return { slot, el, qr: el.querySelector('.ticket__qr'), state: el.querySelector('.ticket__state'), toggle: el.querySelector('.ticket__toggle'), link: new HostLink(), seq: -1, got: false, name: '' };
	});

	// One ticket at a time is shown large; the other waits as a chip. -1: every free ticket is folded.
	let featured = 0;
	let foldTimer = 0;
	function feature(slot, linger = 0) {
		featured = slot;
		clearTimeout(foldTimer);
		if (linger) foldTimer = setTimeout(() => feature(-1), linger);
		refreshHud();
	}
	/** After a phone joins or leaves: put the free ticket on show (for a while, once the show is on). */
	function offerTicket() {
		const free = slots.filter((s) => !s.link.open);
		feature(free.length ? free[0].slot : -1, free.length === 1 ? TICKET_LINGER : 0);
	}
	for (const s of slots) {
		// Pressing a ticket trades places with the other one (or folds it away when that one is taken).
		s.toggle.addEventListener('click', () => {
			const other = slots[1 - s.slot];
			feature(featured !== s.slot ? s.slot : other.link.open ? -1 : other.slot);
		});
	}

	function refreshHud() {
		const n = controller.phones;
		for (const s of slots) {
			const big = s.slot === featured && !s.link.open;
			s.el.classList.toggle('is-featured', big);
			s.el.classList.toggle('is-folded', !big && !s.link.open);
			s.toggle.hidden = s.link.open;
			s.toggle.setAttribute('aria-expanded', big);
			s.toggle.title = big ? 'Put this ticket away' : 'Show this code large';
		}
		pairing.classList.toggle('is-live', n > 0 && !slots.some((s) => s.el.classList.contains('is-featured')));
		modeLabel.textContent = n ? controller.mode.title : 'Waiting in the wings';
		phonesLabel.textContent = n === 0
			? 'No puppeteer yet — the puppet is rehearsing on its own · click a string to work on it'
			: n === 1 ? 'One puppeteer on the strings' : 'Pro: two puppeteers, one on each bar';
	}

	function broadcast(message, except = -1) {
		for (const s of slots) if (s.slot !== except && s.link.open) s.link.send(message);
	}
	const peers = () => ({ t: 'peers', phones: controller.phones, slots: slots.map((s) => s.link.open) });

	/** Rest pose, strings re-tied, joints unlocked — and every phone but the one that asked lets go of what it holds. */
	function resetPuppet(from = -1) {
		controller.setLocks([]);
		world.reset();
		broadcast({ t: 'reset' }, from);
		toast('Puppet reset');
	}
	$('#btn-reset').addEventListener('click', () => resetPuppet());

	// Tangling: strings catching on each other. Off unless someone asks for it (the button, K,
	// or ?knots in the address); remembered on this device.
	const knotsButton = $('#btn-knots');
	const KNOTS_KEY = 'motion-puppet-knots';
	function setKnots(on, quiet = false, remember = true) {
		strings.tangles.enabled = on;
		if (!on) sim.setKnots(null);
		knotsButton.setAttribute('aria-pressed', on);
		$('#btn-knots-label').textContent = on ? 'Tangles on' : 'Tangles off';
		if (remember) try { localStorage.setItem(KNOTS_KEY, on ? '1' : '0'); } catch { /* private mode: not remembered */ }
		if (!quiet) toast(on ? 'Strings now catch on each other — Reset untangles them' : 'Strings pass through each other again');
	}
	knotsButton.addEventListener('click', () => setKnots(!strings.tangles.enabled));
	{
		let stored = null;
		try { stored = localStorage.getItem(KNOTS_KEY); } catch { /* ignore */ }
		const asked = new URLSearchParams(location.search);
		// (?knots tries it for this visit only; the button is what is remembered.)
		if (asked.has('knots') ? asked.get('knots') !== '0' : stored === '1') setKnots(true, true, false);
	}

	// Bare stage: tickets, titles and the playbill step out; a faint eye in the corner brings them back.
	const uiButton = $('#btn-ui');
	function setBare(bare) {
		document.body.classList.toggle('is-bare', bare);
		uiButton.setAttribute('aria-pressed', bare);
		uiButton.title = bare ? 'Show the tickets and titles (H)' : 'Hide the tickets and titles (H)';
		$('#btn-ui-label').textContent = bare ? 'Show' : 'Hide';
		toast(bare ? 'Stage cleared — press H to bring everything back' : 'Tickets and titles are back');
	}
	uiButton.addEventListener('click', () => setBare(!document.body.classList.contains('is-bare')));

	for (const s of slots) {
		const link = s.link;
		s.qr.classList.add('is-empty');
		link.oncode = (code) => {
			const url = new URL('controller.html', location.href);
			url.search = '';
			url.hash = code;
			s.qr.classList.remove('is-empty');
			s.qr.innerHTML = qrSvg(url.href);
			s.qr.dataset.url = url.href;
			s.state.textContent = `Ready — code ${code.slice(0, 4)} ${code.slice(4)}`;
		};
		link.onstatus = (status) => {
			if (status === 'connecting') s.state.textContent = 'A phone is joining…';
			if (status === 'error') s.state.textContent = 'Pairing service unreachable — retrying…';
		};
		link.onopen = () => {
			controller.connect(s.slot);
			releaseLink();   // the strings are the puppeteer's now
			s.seq = -1; s.got = false;
			s.el.classList.add('is-paired');
			s.state.textContent = 'Connected';
			link.send({ ...peers(), t: 'welcome', v: PROTOCOL_VERSION, slot: s.slot, mode: controller.mode.id, custom: controller.custom, locks: [...controller.locks], strings: world.rig.strings, model: world.puppet.model });
			broadcast(peers(), s.slot);
			if (controller.phones === 1) controller.play('greet');
			toast(`${ROLE_NAMES[s.slot]} has taken the strings`);
			offerTicket();
		};
		link.onclose = (wasOpen) => {
			if (wasOpen) {
				controller.disconnect(s.slot);
				toast(`${ROLE_NAMES[s.slot]} let go`);
				broadcast(peers());
				if (controller.phones === 0) { controller.setLocks([]); controller.setMode('classic'); }
			}
			s.el.classList.remove('is-paired');
			s.qr.classList.add('is-empty');
			s.qr.innerHTML = '';
			s.state.textContent = 'Preparing a fresh code…';
			if (wasOpen) offerTicket(); else refreshHud();
			link.listen();
		};
		link.onpacket = (buffer) => {
			const input = decodeInput(buffer);
			if (!input) return;
			if (s.got && !seqNewer(input.seq, s.seq)) return;   // stale or duplicate
			s.seq = input.seq; s.got = true;
			controller.setInput(s.slot, input);
		};
		link.onmessage = (msg) => {
			switch (msg.t) {
				case 'hello': s.name = String(msg.name || '').slice(0, 24); break;
				case 'mode':
					if (MODES.some((m) => m.id === msg.id)) {
						controller.setMode(msg.id);
						broadcast({ t: 'mode', id: controller.mode.id });
						refreshHud();
					}
					break;
				case 'custom': controller.setCustom(msg.rig); broadcast({ t: 'custom', rig: controller.custom }, s.slot); break;
				case 'locks':
					if (Array.isArray(msg.joints)) {
						controller.setLocks(msg.joints.filter((i) => Number.isInteger(i) && i >= 0 && i < RIG.joints.length));
						broadcast({ t: 'locks', joints: [...controller.locks] }, s.slot);
					}
					break;
				case 'act': if (typeof msg.id === 'string') controller.action(msg.id.slice(0, 16)); break;
				case 'reset': resetPuppet(s.slot); break;
				case 'cal': toast(`${ROLE_NAMES[s.slot]} calibrated`); break;
				default: break;
			}
		};
		link.listen();
	}
	refreshHud();

	// ------------------------------------------------- a menu on each link
	// While no phone holds the strings, a click on a string or rod opens a menu on it: what it
	// is carrying, string / rod / off, its slack and strength, cut it. What is changed is saved
	// to the marionette, as the editor would save it.
	const canvas = $('#stage');
	const menu = createLinkMenu();
	const bodyLabel = (id) => id.replace(/([a-z])([LR])$/, (_, a, side) => `${a}, ${side === 'L' ? 'left' : 'right'}`).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
	const free = () => controller.phones === 0;
	function releaseLink() {
		menu.close();
		canvas.classList.remove('is-over');
	}
	/** Restrings the puppet with the table as changed, and saves it. */
	function restring(change, said) {
		const saved = loadMarionette();
		const strings = sanitizeStrings(world.rig.strings, RIG);
		change(strings);
		world.setStrings(sanitizeStrings(strings, RIG));
		const doc = { name: saved ? saved.name : DEFAULT_NAME, model: puppet.model, strings: world.rig.strings };
		const kept = saveMarionette(isDefaultMarionette(doc) ? null : marionetteDocument(doc.name, doc.strings, doc.model));
		if (said) toast(kept ? `${said} · saved to your marionette` : `${said} · this browser would not save it`);
	}
	function showLinkMenu(index, at) {
		const s = world.rig.strings[index];
		if (!s || !free()) { menu.close(); return; }
		world.selected = new Set([index]);
		const kind = kindOf(s);
		const original = cloneStrings().find((d) => d.id === s.id);
		const handle = RIG.handles.find((h) => h.id === s.handle);
		const number = (set) => (v) => restring((table) => { if (table[index]) set(table[index], v); });
		menu.open({
			title: s.label,
			sub: `${handle ? handle.label : s.handle} handle → ${bodyLabel(s.body)}`,
			kind,
			onKind: (k) => {
				restring((table) => {
					const link = table[index];
					link.enabled = k !== 'off';
					if (k === 'rod') { link.kind = 'rod'; link.breakable = false; } else if (k === 'string') delete link.kind;
				}, `${s.label}: ${{ string: 'a string', rod: 'a rod', off: 'taken off' }[k]}`);
				showLinkMenu(index);
			},
			live: () => {
				const live = sim.strings[index];
				if (kind === 'off') return { text: 'Taken off: it carries nothing.', state: 'off' };
				return live && live.def.id === s.id ? linkState(live, sim.tension[index]) : { text: '…' };
			},
			numbers: [
				kind === 'string' && { label: 'Slack', unit: 'cm', value: s.slack, scale: 100, digits: 2, step: 0.005, min: -0.2, max: 0.6, title: 'Spare length at rest; below zero it is tight before anything moves', set: number((link, v) => { link.slack = v; }) },
				kind !== 'off' && { label: kind === 'rod' ? 'Strength' : 'Gives at', unit: 'N', value: s.max, digits: 0, step: 10, min: 20, max: 600, title: 'The most it can carry before it gives', set: number((link, v) => { link.max = v; }) },
			].filter(Boolean),
			actions: [
				kind === 'string' && { label: 'Cut it', title: 'Cut this string now. Reset ties it again.', run: () => { const live = sim.strings[index]; if (live) live.broken = true; toast(`${s.label} cut · Reset ties it again`); } },
				original && { label: 'As it came', title: 'Put this link back as the default marionette has it', run: () => { restring((table) => { table[index] = original; }, `${s.label} is as it came`); showLinkMenu(index); return true; } },
				{ label: 'Open in the editor', title: 'Every setting of this link, in the Marionette editor', run: () => { location.href = `editor.html#link=${encodeURIComponent(s.id)}`; } },
			].filter(Boolean),
			note: 'Here while no phone holds the strings.',
			onClose: () => { world.selected = null; },
		}, at);
	}
	{
		const over = (e) => (free() ? linkAt(e, strings, stage.camera, canvas) : -1);
		let pressed = null;
		canvas.addEventListener('pointerdown', (e) => { pressed = [e.clientX, e.clientY]; });
		canvas.addEventListener('pointerup', (e) => {
			if (!pressed || Math.hypot(e.clientX - pressed[0], e.clientY - pressed[1]) > 4) return;
			const hit = over(e);
			if (hit >= 0) showLinkMenu(hit, [e.clientX, e.clientY]);
		});
		canvas.addEventListener('pointermove', (e) => { if (!e.buttons) canvas.classList.toggle('is-over', over(e) >= 0); });
		canvas.addEventListener('contextmenu', (e) => { if (over(e) >= 0) e.preventDefault(); });
	}

	// ----------------------------------------------------------- snapshots
	let seq = 0;
	function sendSnapshots() {
		if (!slots.some((s) => s.link.open)) return;
		const buffer = encodeState({
			seq: seq++, time: sim.time * 1000, mode: controller.modeIndex, phones: controller.phones,
			flags: (slots[0].link.open ? 1 : 0) | (slots[1].link.open ? 2 : 0),
			bodyPos: sim.pos, bodyQuat: sim.quat, bars: sim.bars, handlePos: sim.handlePos,
			tension: sim.tension, tensionMax: sim.strings.map((x) => x.def.max * sim.ctl.stringGain || 1),
			broken: sim.strings.map((x) => x.broken), ik: sim.ctl.ik, locks: sim.ctl.locks,
		});
		for (const s of slots) if (s.link.open) s.link.sendPacket(buffer);
	}

	// ---------------------------------------------------------- main loop
	const fpsEl = $('#fps');
	world.onStep = (n) => { if (n % Math.max(1, Math.round(sim.opts.hz / SNAPSHOT_HZ)) === 0) sendSnapshots(); };
	world.onSecond = (fps, physicsMs) => {
		if (!fpsEl.hidden) fpsEl.textContent = `${fps} fps · physics ${physicsMs.toFixed(2)} ms at ${sim.opts.hz} Hz × ${sim.opts.iterations} · quality ${stage.quality}`;
	};

	window.addEventListener('keydown', (e) => {
		if (e.target instanceof HTMLInputElement) return;
		if (e.key === 'r') resetPuppet();
		if (e.key === 'k' && !e.repeat) knotsButton.click();
		if (e.key === 'h' && !e.repeat) uiButton.click();
		if (e.key === 'q') { stage.setQuality((stage.quality + 2) % 3); resize(); toast(`Quality: ${['low', 'medium', 'high'][stage.quality]}`); }
		if (e.key === 'd') fpsEl.hidden = !fpsEl.hidden;
		if (e.key === 'f' && document.documentElement.requestFullscreen) {
			if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
		}
	});

	// Handy for the browser console and automated checks.
	window.motionPuppet = { world, sim, controller, stage, slots, puppet, strings, tuning, THREE, menu, showLinkMenu };

	// Debug mode: add ?debug (or ?debug=<routine>) to the stage URL for predefined movement
	// routines that play the puppet without a phone. Loaded only when asked for.
	const params = new URLSearchParams(location.search);
	if (params.has('debug')) {
		import('./debug.js')
			.then((m) => m.startDebug({ ...window.motionPuppet, toast, refreshHud }, params.get('debug')))
			.catch((err) => console.error('Debug mode failed to load', err));
	}

	world.start();
	curtain.classList.add('is-open');
}

boot().catch((err) => {
	console.error(err);
	curtain.classList.add('is-error');
	curtainText.textContent = bootError(err);
});
