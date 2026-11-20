// Stage (desktop): owns the simulation, renders the theatre, pairs up to two
// phones (one QR code each) and streams puppet state to them.

import * as THREE from 'three';
import qrcode from '../../vendor/qrcode.mjs';
import { RIG } from '../shared/rig-config.js';
import { MODES } from '../shared/modes.js';
import { encodeState, decodeInput, seqNewer, PROTOCOL_VERSION } from '../shared/protocol.js';
import { HostLink } from '../shared/net.js';
import { marionetteRig } from '../shared/marionette.js';
import { createLinkMenu, pickLink, tiePointOnScreen, linkState } from '../shared/link-menu.js';
import { dragPoint } from '../studio/orbit.js';
import { createOrbitStick } from './orbit-stick.js';
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
			? 'No puppeteer yet — the puppet is rehearsing on its own · drag a string or a limb to move it, or click it'
			: n === 1 ? 'One puppeteer on the strings' : 'Pro: two puppeteers, one on each bar';
	}

	function broadcast(message, except = -1) {
		for (const s of slots) if (s.slot !== except && s.link.open) s.link.send(message);
	}
	const peers = () => ({ t: 'peers', phones: controller.phones, slots: slots.map((s) => s.link.open) });

	/** Rest pose, strings re-tied, joints unlocked — and every phone but the one that asked lets go of what it holds. */
	function resetPuppet(from = -1) {
		controller.setLocks([]);
		letGoAll();
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

	// Wrapping: strings and rods catching on the puppet's limbs. On unless switched off (the
	// button, W); remembered on this device, and the editor and the Studio follow it.
	const wrapButton = $('#btn-wrap');
	function showWrap() {
		wrapButton.setAttribute('aria-pressed', world.wrap);
		$('#btn-wrap-label').textContent = world.wrap ? 'Wrap on' : 'Wrap off';
	}
	wrapButton.addEventListener('click', () => {
		world.setWrap(!world.wrap);
		showWrap();
		broadcast({ t: 'wrap', on: world.wrap });
		toast(world.wrap ? 'Strings and rods catch on the limbs again' : 'Strings and rods pass straight through the limbs');
	});
	showWrap();

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
			link.send({ ...peers(), t: 'welcome', v: PROTOCOL_VERSION, slot: s.slot, mode: controller.mode.id, custom: controller.custom, locks: [...controller.locks], strings: world.rig.strings, model: world.puppet.model, wrap: world.wrap });
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

	// ------------------------------------------------ working a link by hand
	// While no phone holds the strings, the mouse can: drag a string or rod and its handle
	// follows; click one and a menu opens on it to lift it, carry it to the side or forward,
	// pull it short, tug it, cut it or let it go. (What a link *is* — string, rod, its slack —
	// is the Marionette editor's business; the menu has a way there.)
	const canvas = $('#stage');
	const menu = createLinkMenu();
	const bodyLabel = (id) => id.replace(/([a-z])([LR])$/, (_, a, side) => `${a}, ${side === 'L' ? 'left' : 'right'}`).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
	const free = () => controller.phones === 0;
	const REACH = { x: [-0.7, 0.7], y: [-0.5, 0.8], z: [-0.7, 0.7] };
	const held = new Map();    // handle id → [x, y, z] it is held from where it hangs, in metres
	const pulls = new Map();   // link id → metres it is pulled short
	const tugs = new Map();    // handle id → seconds of tug left
	const holding = () => held.size > 0 || pulls.size > 0 || tugs.size > 0;
	/** The mouse's hand on the handles, each physics step. The bar goes on drifting as it does when nobody holds it. */
	function hand(add, dt) {
		controller._idle(add);
		controller.nextIdle = Math.max(controller.nextIdle, controller.t + 6);   // no waving of its own while it is being worked
		for (const [id, at] of held) { add(`handle.${id}.x`, at[0]); add(`handle.${id}.y`, at[1]); add(`handle.${id}.z`, at[2]); }
		for (const [id, by] of pulls) add(`pull.${id}`, by);
		for (const [id, left] of tugs) {
			add(`handle.${id}.y`, 0.2 * Math.sin(Math.PI * (1 - left / 0.45)));
			if (left - dt <= 0) tugs.delete(id); else tugs.set(id, left - dt);
		}
		if (!holding()) controller.director = null;
	}
	function hold(handle, axis, value) {
		const at = held.get(handle) || [0, 0, 0];
		const lim = REACH['xyz'[axis]];
		at[axis] = Math.max(lim[0], Math.min(lim[1], value));
		if (at.some((v) => Math.abs(v) > 1e-4)) held.set(handle, at); else held.delete(handle);
		controller.director = hand;
	}
	function pull(id, by) {
		if (by > 1e-4) pulls.set(id, by); else pulls.delete(id);
		controller.director = hand;
	}
	/** Every handle back where it hangs. */
	function letGoAll() {
		held.clear(); pulls.clear(); tugs.clear();
		controller.director = null;
	}
	function releaseLink() {
		menu.close();
		letGoAll();
		canvas.classList.remove('is-over', 'is-dragging');
	}
	function showLinkMenu(index, at) {
		const s = world.rig.strings[index];
		if (!s || !free()) { menu.close(); return; }
		world.selected = new Set([index]);
		const rod = s.kind === 'rod';
		const handle = RIG.handles.find((h) => h.id === s.handle);
		const now = held.get(s.handle) || [0, 0, 0];
		const move = (label, axis, title) => ({ label, unit: 'cm', value: now[axis], scale: 100, step: 0.005, min: REACH['xyz'[axis]][0], max: REACH['xyz'[axis]][1], title: `${title} Double-click to put back.`, set: (v) => hold(s.handle, axis, v) });
		const others = held.size + pulls.size > (held.has(s.handle) || pulls.has(s.id) ? 1 : 0);
		menu.open({
			title: s.label,
			sub: `${handle ? handle.label : s.handle} handle → ${bodyLabel(s.body)}`,
			anchor: () => (free() ? tiePointOnScreen(strings.items[index], stage.camera, canvas) : null),
			live: () => { const live = sim.strings[index]; return live && live.def.id === s.id ? linkState(live, sim.tension[index]) : { text: '…' }; },
			ranges: [
				move('Lift', 1, 'Raise the handle, or lower it past where it hangs.'),
				move('Side', 0, 'Carry the handle towards the puppet’s left (+) or right (−).'),
				move('Forward', 2, 'Carry the handle towards the audience (+) or the back (−).'),
				!rod && { label: 'Pull', unit: 'cm', value: pulls.get(s.id) || 0, scale: 100, step: 0.005, min: 0, max: 0.75, title: 'Take the string up short through the handle. Double-click to put back.', set: (v) => pull(s.id, v) },
			].filter(Boolean),
			actions: [
				{ label: 'Tug', title: 'A quick pull up and back', run: () => { tugs.set(s.handle, 0.45); controller.director = hand; return true; } },
				{ label: 'Let go', title: 'This handle back where it hangs', run: () => { held.delete(s.handle); pulls.delete(s.id); showLinkMenu(index); return true; } },
				!rod && (sim.strings[index] && sim.strings[index].broken
					? { label: 'Tie it again', title: 'Tie this cut string back on, with the puppet where it is', run: () => { world.retie(index); toast(`${s.label} tied again`); showLinkMenu(index); return true; } }
					: { label: 'Cut it', title: 'Cut this string now. “Tie it again” here, or Reset, puts it back.', run: () => { const live = sim.strings[index]; if (live) live.broken = true; toast(`${s.label} cut`); showLinkMenu(index); return true; } }),
				others && { label: 'Let go of all', title: 'Every handle back where it hangs', run: () => { letGoAll(); showLinkMenu(index); return true; } },
				{ label: 'Change it in the editor', wide: true, title: 'String or rod, its slack, where it is tied: the Marionette editor', run: () => { location.href = `editor.html#link=${encodeURIComponent(s.id)}`; } },
			].filter(Boolean),
			note: 'Or drag the string or its limb. Here while no phone holds the strings.',
			onClose: () => { world.selected = null; },
		}, at);
	}
	{
		const over = (e) => (free() ? pickLink(e, strings, puppet.parts, stage.camera, canvas) : -1);
		const grip = new THREE.Vector3(), from = new THREE.Vector3(), to = new THREE.Vector3();
		let press = null;
		canvas.addEventListener('pointerdown', (e) => {
			const index = e.button === 0 ? over(e) : -1;
			press = { x: e.clientX, y: e.clientY, index, moved: false };
			if (index < 0) return;
			const def = world.rig.strings[index];
			const h = RIG.handles.findIndex((x) => x.id === def.handle);
			grip.set(sim.handlePos[h * 3], sim.handlePos[h * 3 + 1], sim.handlePos[h * 3 + 2]);
			press.handle = def.handle;
			press.start = [...(held.get(def.handle) || [0, 0, 0])];
			press.ok = !!dragPoint(e, stage.camera, canvas, grip, from);
			try { canvas.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone */ }
		});
		canvas.addEventListener('pointermove', (e) => {
			if (!press || !e.buttons) { canvas.classList.toggle('is-over', over(e) >= 0); return; }
			if (press.index < 0 || !press.ok || !free()) return;
			if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 4) return;
			press.moved = true;
			canvas.classList.add('is-dragging');
			world.selected = new Set([press.index]);
			if (!dragPoint(e, stage.camera, canvas, grip, to)) return;
			hold(press.handle, 0, press.start[0] + to.x - from.x);
			hold(press.handle, 1, press.start[1] + to.y - from.y);
			hold(press.handle, 2, press.start[2] + to.z - from.z);
		});
		const lift = (e) => {
			const was = press; press = null;
			canvas.classList.remove('is-dragging');
			if (!was || was.index < 0) return;
			if (was.moved) { world.selected = null; toast('Held there · click the string to move it more, or to let go'); return; }
			if (e.type === 'pointerup') showLinkMenu(was.index, [e.clientX, e.clientY]);
		};
		canvas.addEventListener('pointerup', lift);
		canvas.addEventListener('pointercancel', lift);
		canvas.addEventListener('contextmenu', (e) => { const hit = over(e); if (hit < 0) return; e.preventDefault(); showLinkMenu(hit, [e.clientX, e.clientY]); });
	}

	// A thumbstick in the corner takes the camera round the puppet; the theatre's own framing is what it turns.
	const orbit = createOrbitStick(stage, THREE);
	world.onFrame = (dt) => orbit.apply(dt);

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
		if (e.key === 'w' && !e.repeat) wrapButton.click();
		if (e.key === 'h' && !e.repeat) uiButton.click();
		if (e.key === '0') orbit.reset();
		if (e.key === 'q') { stage.setQuality((stage.quality + 2) % 3); resize(); toast(`Quality: ${['low', 'medium', 'high'][stage.quality]}`); }
		if (e.key === 'd') fpsEl.hidden = !fpsEl.hidden;
		if (e.key === 'f' && document.documentElement.requestFullscreen) {
			if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
		}
	});

	// Handy for the browser console and automated checks.
	window.motionPuppet = { world, sim, controller, stage, slots, puppet, strings, tuning, THREE, menu, orbit, showLinkMenu, held, pulls, hold };

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
