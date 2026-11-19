// Stage (desktop): owns the simulation, renders the theatre, pairs up to two
// phones (one QR code each) and streams puppet state to them.

import * as THREE from 'three';
import RAPIER from '../../vendor/rapier.mjs';
import qrcode from '../../vendor/qrcode.mjs';
import { RIG } from '../shared/rig-config.js';
import { MODES } from '../shared/modes.js';
import { buildPuppet, posePuppet } from '../shared/puppet-geometry.js';
import { RigView, StringsView } from '../shared/rig-view.js';
import { encodeState, decodeInput, seqNewer, PROTOCOL_VERSION } from '../shared/protocol.js';
import { HostLink } from '../shared/net.js';
import { PuppetSim } from './sim.js';
import { Controller } from './control.js';
import { Stage } from './scene.js';

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
	await RAPIER.init();
	curtainText.textContent = 'Stringing the puppet…';
	const sim = new PuppetSim(RAPIER);
	const controller = new Controller(sim);
	// Let the puppet settle onto its strings before the curtain rises.
	for (let i = 0; i < sim.opts.hz * 4; i++) { controller.update(); sim.step(); }   // let the puppet come to rest before the curtain opens

	const canvas = $('#stage');
	const stage = new Stage(canvas);
	const puppet = buildPuppet('high');
	stage.scene.add(puppet.root);
	const rigView = new RigView({ materials: puppet.materials });
	stage.scene.add(rigView.group);
	const strings = new StringsView({ width: 1.5, color: 0xeadfc6, eyeMaterial: puppet.materials.brass, parts: puppet.parts });
	stage.scene.add(strings.group);
	let shownStrings = null;

	const resize = () => {
		const w = window.innerWidth, h = window.innerHeight;
		stage.resize(w, h);
		strings.setResolution(w * stage.size[2], h * stage.size[2]);
	};
	window.addEventListener('resize', resize);
	resize();

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
			? 'No puppeteer yet — the puppet is rehearsing on its own'
			: n === 1 ? 'One puppeteer on the strings' : 'Pro: two puppeteers, one on each bar';
	}

	function broadcast(message, except = -1) {
		for (const s of slots) if (s.slot !== except && s.link.open) s.link.send(message);
	}
	const peers = () => ({ t: 'peers', phones: controller.phones, slots: slots.map((s) => s.link.open) });

	/** Rest pose, strings re-tied, joints unlocked — and every phone but the one that asked lets go of what it holds. */
	function resetPuppet(from = -1) {
		controller.setLocks([]);
		controller.reset();
		broadcast({ t: 'reset' }, from);
		toast('Puppet reset');
	}
	$('#btn-reset').addEventListener('click', () => resetPuppet());

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
			s.seq = -1; s.got = false;
			s.el.classList.add('is-paired');
			s.state.textContent = 'Connected';
			link.send({ ...peers(), t: 'welcome', v: PROTOCOL_VERSION, slot: s.slot, mode: controller.mode.id, custom: controller.custom, locks: [...controller.locks] });
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
	const nb = RIG.bodies.length;
	const ipos = new Float32Array(nb * 3);
	const iquat = new Float32Array(nb * 4);
	const barPos = new Float32Array(RIG.bars.length * 3);
	const barQuat = new Float32Array(RIG.bars.length * 4);
	const tensionNorm = new Float32Array(64);
	// Physics takes what a 60 fps frame has to spare. Each level is [steps per second, solver
	// sweeps, cost relative to the default]; accuracy rises with the step rate (see
	// tools/solver-bench.mjs), so spare time buys smaller steps, and a busy frame gives them back.
	const LEVELS = [[120, 5, 0.8], [180, 5, 0.9], [240, 5, 1], [360, 4, 1.25], [480, 4, 1.5], [720, 4, 2.15], [960, 4, 2.7]];
	const FRAME_MS = 1000 / 60;
	const RESERVE_MS = 4.5;        // of each frame, left for the GPU and the browser
	const PHYSICS_MAX_MS = 9;      // never spend more than this on physics, however idle the rest is
	let level = LEVELS.findIndex((l) => l[0] === sim.opts.hz);
	if (level < 0) level = 2;
	let snapEvery = 1, maxSteps = 1;
	function setLevel(next) {
		level = next;
		sim.setRate(LEVELS[level][0], LEVELS[level][1]);
		snapEvery = Math.max(1, Math.round(sim.opts.hz / SNAPSHOT_HZ));
		maxSteps = Math.ceil(sim.opts.hz / 10);
	}
	setLevel(level);
	let physEma = 0, otherEma = 3, overFor = 0, roomFor = 0, cooling = 2;
	/** Once a frame: move to a cheaper level if physics overran its share, to a finer one if there is room. */
	function govern(dt, physicsMs, workMs) {
		if (dt > 0.05) return;      // a hitch or a hidden tab says nothing about the budget
		physEma += (physicsMs - physEma) * 0.08;
		otherEma += (workMs - physicsMs - otherEma) * 0.08;
		if (!tuning.adaptive) return;
		const budget = Math.min(PHYSICS_MAX_MS, Math.max(0.8, FRAME_MS - RESERVE_MS - otherEma));
		tuning.budget = budget;
		cooling -= dt;
		overFor = physEma > budget ? overFor + dt : 0;
		const next = level + 1 < LEVELS.length ? physEma * (LEVELS[level + 1][2] / LEVELS[level][2]) : Infinity;
		roomFor = next < budget * 0.7 && cooling <= 0 ? roomFor + dt : 0;
		if (overFor > 0.3 && level > 0) {
			physEma *= LEVELS[level - 1][2] / LEVELS[level][2];
			setLevel(level - 1);
			overFor = 0; roomFor = 0; cooling = 3;
		} else if (roomFor > 1.2) {
			physEma = next;
			setLevel(level + 1);
			roomFor = 0; cooling = 1.5;
		}
	}
	const chest = sim.bodyIx.chest;
	const fpsEl = $('#fps');
	let last = performance.now();
	let acc = 0, steps = 0, clock = 0, frames = 0, fpsAt = last, physMs = 0;
	// timeScale: debug mode slows time through this. adaptive: let the governor above choose the step rate.
	const tuning = { timeScale: 1, adaptive: !new URLSearchParams(location.search).has('fixed'), budget: 0, get level() { return level; }, levels: LEVELS, setLevel: (i) => setLevel(Math.max(0, Math.min(LEVELS.length - 1, i))), govern };

	function frame(now) {
		requestAnimationFrame(frame);
		const dt = Math.min(0.1, (now - last) / 1000);
		last = now;
		clock += dt;
		acc += dt * tuning.timeScale;
		const t0 = performance.now();
		let n = 0;
		while (acc >= sim.dt && n < maxSteps) {
			controller.update();
			sim.step();
			acc -= sim.dt;
			n++;
			if (++steps % snapEvery === 0) sendSnapshots();
		}
		if (n === maxSteps) acc = 0;
		const physicsMs = performance.now() - t0;
		physMs += physicsMs;

		// Render between the last two physics states.
		const a = acc / sim.dt;
		for (let i = 0; i < nb * 3; i++) ipos[i] = sim.prevPos[i] + (sim.pos[i] - sim.prevPos[i]) * a;
		for (let i = 0; i < nb; i++) {
			const o = i * 4;
			const p = sim.prevQuat, q = sim.quat;
			const sign = p[o] * q[o] + p[o + 1] * q[o + 1] + p[o + 2] * q[o + 2] + p[o + 3] * q[o + 3] < 0 ? -1 : 1;
			let x = p[o] + (q[o] * sign - p[o]) * a, y = p[o + 1] + (q[o + 1] * sign - p[o + 1]) * a;
			let z = p[o + 2] + (q[o + 2] * sign - p[o + 2]) * a, w = p[o + 3] + (q[o + 3] * sign - p[o + 3]) * a;
			const l = Math.hypot(x, y, z, w) || 1;
			iquat[o] = x / l; iquat[o + 1] = y / l; iquat[o + 2] = z / l; iquat[o + 3] = w / l;
		}
		posePuppet(puppet.parts, ipos, iquat);
		sim.bars.forEach((bar, i) => { barPos.set(bar.pos, i * 3); barQuat.set(bar.quat, i * 4); });
		rigView.update(barPos, barQuat, sim.handlePos);

		if (shownStrings !== sim.strings) {
			shownStrings = sim.strings;
			strings.setStrings(sim.strings.map((s) => s.def));
			strings.setResolution(stage.size[0] * stage.size[2], stage.size[1] * stage.size[2]);
		}
		let brokenMask = 0;
		sim.strings.forEach((s, i) => { tensionNorm[i] = sim.tension[i] / s.def.max; if (s.broken) brokenMask |= 1 << i; });
		strings.update(ipos, iquat, sim.handlePos, tensionNorm, brokenMask, clock, sim.ctl.pull);

		stage.update(dt, clock, { x: ipos[chest * 3], y: ipos[chest * 3 + 1], z: ipos[chest * 3 + 2] });
		stage.render(dt);
		if (stage.adapt(dt * 1000)) resize();
		govern(dt, physicsMs, performance.now() - t0);

		frames++;
		if (now - fpsAt > 1000) {
			if (!fpsEl.hidden) fpsEl.textContent = `${Math.round((frames * 1000) / (now - fpsAt))} fps · physics ${(physMs / frames).toFixed(2)} ms at ${sim.opts.hz} Hz × ${sim.opts.iterations} · quality ${stage.quality}`;
			frames = 0; fpsAt = now; physMs = 0;
		}
	}

	window.addEventListener('keydown', (e) => {
		if (e.target instanceof HTMLInputElement) return;
		if (e.key === 'r') resetPuppet();
		if (e.key === 'h' && !e.repeat) uiButton.click();
		if (e.key === 'q') { stage.setQuality((stage.quality + 2) % 3); resize(); toast(`Quality: ${['low', 'medium', 'high'][stage.quality]}`); }
		if (e.key === 'd') fpsEl.hidden = !fpsEl.hidden;
		if (e.key === 'f' && document.documentElement.requestFullscreen) {
			if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
		}
	});

	// Handy for the browser console and automated checks.
	window.motionPuppet = { sim, controller, stage, slots, puppet, strings, tuning, THREE };

	// Debug mode: add ?debug (or ?debug=<routine>) to the stage URL for predefined movement
	// routines that play the puppet without a phone. Loaded only when asked for.
	const params = new URLSearchParams(location.search);
	if (params.has('debug')) {
		import('./debug.js')
			.then((m) => m.startDebug({ ...window.motionPuppet, toast, refreshHud }, params.get('debug')))
			.catch((err) => console.error('Debug mode failed to load', err));
	}

	stage.update(0.016, 0, { x: 0, y: 1.25, z: 0 });
	stage.render(0.016);
	requestAnimationFrame((now) => { last = now; frame(now); });
	curtain.classList.add('is-open');
}

boot().catch((err) => {
	console.error(err);
	curtain.classList.add('is-error');
	curtainText.textContent = /webgl|context/i.test(String(err && err.message))
		? 'This browser could not start WebGL, which the stage needs. Try a recent Chrome, Edge, Firefox or Safari.'
		: `The stage could not be set up: ${err && err.message ? err.message : err}`;
});
