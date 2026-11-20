// Puppeteer (phone): captures motion + touch, sends them to the stage over
// WebRTC, and draws the interactive top-down board from the state it gets back.

import * as THREE from 'three';
import { BODIES, JOINTS, HANDLES, EFFECTORS, STRINGS, BARS, RIG_HOME } from '../shared/rig-config.js';
import { MODES, modeById, defaultCustomRig, sanitizeCustomRig, sanitizeStrings, stringsForMode } from '../shared/modes.js';
import { GESTURES, GESTURE_LIST } from '../shared/gestures.js';
import { RIG } from '../shared/rig-config.js';
import { encodeInput, decodeState, seqNewer, PROTOCOL_VERSION } from '../shared/protocol.js';
import { GuestLink } from '../shared/net.js';
import { qToYPR, qAxisAngle, qRot, qConj, clamp } from '../shared/math.js';
import { Sensors } from './sensors.js';
import { BoardView, DEFAULT_ORBIT } from './view.js';
import { RigEditor } from './custom.js';

const $ = (id) => document.getElementById(id);
const store = {
	get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
	set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

const sensors = new Sensors();
const link = new GuestLink();
let view = null;

const state = {
	slot: 0, phones: 1, slots: [true, false],
	mode: MODES[0],
	custom: sanitizeCustomRig(store.get('mp.custom', null), RIG),
	strings: [],
	locks: new Set(),
	sel: [],                       // [{ type, index }]
	handleOff: new Map(), pulls: new Map(), ik: new Map(), joints: new Map(),
	pins: new Set(),
	groups: store.get('mp.groups', []),   // arrays of handle indices
	stick: [0, 0],
	camera: false, multi: false,
	joined: false, seq: 0, lastSeq: -1, gotState: false,
};

const toastEl = $('toast');
let toastTimer = 0;
function toast(text) {
	toastEl.textContent = text;
	toastEl.classList.add('is-on');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2400);
}
const buzz = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* unsupported */ } };

// ------------------------------------------------------------------ intro

const code = (location.hash.slice(1) || new URLSearchParams(location.search).get('s') || '').trim().toUpperCase();
const btnStart = $('btn-start');
const introStatus = $('intro-status');
const hasCode = /^[A-Z0-9]{6,12}$/.test(code);
if (!hasCode) {
	$('intro-text').textContent = 'Open Motion Puppet on a computer or TV, then scan the QR code shown beside the puppet with this phone.';
	btnStart.disabled = true;
	btnStart.textContent = 'Waiting for a pairing code';
}
let permission = 'unsupported';

// The stage greets us the instant the channel opens, so listen before joining.
const pendingMessages = [];
let onMessage = null;
link.onmessage = (msg) => { if (onMessage) onMessage(msg); else pendingMessages.push(msg); };

btnStart.addEventListener('click', async () => {
	btnStart.disabled = true;
	introStatus.classList.remove('is-error');
	introStatus.textContent = 'Asking for motion sensors…';
	permission = await sensors.requestPermission();
	sensors.start();
	introStatus.textContent = 'Finding the stage…';
	link.onstatus = (s) => { if (s === 'connecting') introStatus.textContent = 'Shaking hands with the stage…'; };
	try {
		await link.join(code);
	} catch (err) {
		introStatus.classList.add('is-error');
		introStatus.textContent = err && err.code ? err.message : 'Could not reach the stage. Put this phone on the same Wi‑Fi as the stage’s screen (mobile data usually will not connect), check the stage is still open, then try again.';
		btnStart.disabled = err && (err.code === 'expired' || err.code === 'taken');
		btnStart.textContent = btnStart.disabled ? 'Scan a fresh code' : 'Try again';
		return;
	}
	state.joined = true;
	link.send({ t: 'hello', v: PROTOCOL_VERSION, name: /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Phone' });
	try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {}); } catch { /* optional */ }
	startBoard();
	$('intro').hidden = true;
	openCalibration(true);
});

link.onclose = () => {
	state.joined = false;
	$('link').className = 'link is-off';
	$('role').textContent = 'Disconnected';
	$('calib').hidden = true;
	$('intro').hidden = false;
	$('intro').classList.add('is-over');
	document.querySelector('#intro h1').textContent = 'The strings went slack.';
	$('intro-text').textContent = 'The connection to the stage was lost. Scan the QR code on the big screen again to pick the strings back up.';
	btnStart.disabled = true;
	btnStart.textContent = 'Scan a fresh code';
	introStatus.textContent = '';
};

// ------------------------------------------------------------ calibration

const calib = $('calib');
let calibHold = 0, calibSince = 0, calibFirst = true;

function openCalibration(first) {
	calibFirst = first;
	calibHold = 0;
	calibSince = performance.now();
	calib.hidden = false;
	calib.classList.toggle('is-over', true);
	$('calib-kicker').textContent = first ? 'One last thing · calibration' : 'Recalibrate';
	$('btn-skip').textContent = first ? 'Use touch only' : 'Cancel';
	$('btn-calibrate').hidden = false;
}

function finishCalibration(done) {
	if (done) {
		sensors.calibrate();
		link.send({ t: 'cal' });
		buzz(30);
		toast('Calibrated — this pose is "bar level"');
	} else if (calibFirst && !sensors.calibrated) {
		toast('Touch only. Tap Level any time to add motion.');
	}
	calib.hidden = true;
}
$('btn-calibrate').addEventListener('click', () => finishCalibration(sensors.available));
$('btn-skip').addEventListener('click', () => finishCalibration(false));

function tickCalibration(dt, now) {
	if (calib.hidden) return;
	const status = $('calib-status');
	const level = $('level');
	if (!sensors.available) {
		const waited = now - calibSince;
		$('btn-calibrate').hidden = waited > 1500;
		if (waited > 1500) {
			status.textContent = permission === 'denied'
				? 'Motion access was declined. You can still play by touch — or allow "Motion & Orientation Access" for this site and reload.'
				: 'No motion sensors found on this device. You can still pull every string by touch.';
			$('btn-skip').textContent = 'Continue with touch';
		}
		return;
	}
	$('btn-calibrate').hidden = false;
	const [beta, gamma] = sensors.tilt;
	const bx = clamp(gamma / 30, -1, 1) * 62, by = clamp(beta / 30, -1, 1) * 62;
	$('level-bubble').setAttribute('cx', 100 + bx);
	$('level-bubble').setAttribute('cy', 100 + by);
	const flat = Math.abs(beta) < 11 && Math.abs(gamma) < 11;
	const still = sensors.spin < 0.16;
	level.classList.toggle('is-level', flat);
	calibHold = flat && still ? calibHold + dt : Math.max(0, calibHold - dt * 2);
	$('level-progress').style.strokeDasharray = `${Math.min(100, (calibHold / 1.3) * 100)} 100`;
	$('level-progress').style.opacity = calibHold > 0.02 ? 1 : 0;
	status.textContent = !flat ? 'Tilt until the bubble sits in the middle…' : !still ? 'Good — now hold still…' : 'Hold it…';
	if (calibHold >= 1.3) finishCalibration(true);
}

// ------------------------------------------------------------------ board

const hits = [];
const overlay = $('overlay');
const og = overlay.getContext('2d');
const P = { x: 0, y: 0, visible: true };
const V = new THREE.Vector3();
const V2 = new THREE.Vector3();
let dpr = 1;

function startBoard() {
	$('board').hidden = false;
	const lowPower = (navigator.hardwareConcurrency || 4) <= 4 && (window.devicePixelRatio || 1) < 2.5 && /Android/.test(navigator.userAgent);
	view = new BoardView($('view'), lowPower);
	resize();
	window.addEventListener('resize', resize);
	buildModes();
	buildMoves();
	setMode(state.mode.id, false);
	bindTouch();
	bindUi();
	link.onpacket = (buffer) => {
		const snap = decodeState(buffer);
		if (!snap || !view) return;
		if (state.gotState && !seqNewer(snap.seq, state.lastSeq)) return;
		state.lastSeq = snap.seq; state.gotState = true;
		view.pushSnapshot(snap, performance.now());
		const mode = MODES[snap.mode];
		if (mode && mode.id !== state.mode.id) setMode(mode.id, false);
		if (snap.phones !== state.phones || !!(snap.flags & 1) !== state.slots[0] || !!(snap.flags & 2) !== state.slots[1]) {
			state.phones = snap.phones; state.slots = [!!(snap.flags & 1), !!(snap.flags & 2)];
			updateRole();
		}
		state.locks = new Set(JOINTS.map((_, i) => i).filter((i) => snap.locks & (1 << i)));
	};
	onMessage = (msg) => {
		switch (msg.t) {
			case 'welcome':
				state.slot = msg.slot === 1 ? 1 : 0;
				// How the stage's puppet is strung (the Marionette editor may have swapped strings for rods).
				if (Array.isArray(msg.strings)) { const strung = sanitizeStrings(msg.strings, RIG); if (strung.length) state.rigStrings = strung; }
				// ... and which puppet it is (the gentleman, the ballerina, the knight).
				if (typeof msg.model === 'string') view.setModel(msg.model);
				if (msg.custom && !store.get('mp.custom', null)) state.custom = sanitizeCustomRig(msg.custom, RIG);
				else link.send({ t: 'custom', rig: state.custom });
				if (typeof msg.mode === 'string') setMode(msg.mode, false);
				if (Array.isArray(msg.slots)) { state.slots = [!!msg.slots[0], !!msg.slots[1]]; state.phones = msg.phones || 1; }
				updateRole();
				break;
			case 'mode': if (typeof msg.id === 'string') setMode(msg.id, false); break;
			case 'custom': state.custom = sanitizeCustomRig(msg.rig, RIG); store.set('mp.custom', state.custom); if (state.mode.custom) applyStrings(); break;
			case 'peers': state.phones = msg.phones || 1; if (Array.isArray(msg.slots)) state.slots = [!!msg.slots[0], !!msg.slots[1]]; updateRole(); if (state.phones === 2) toast('Pro: a second puppeteer joined'); break;
			case 'reset': letGo(); toast('Puppet reset'); break;   // the stage or the other phone pressed Reset
			default: break;
		}
	};
	// Messages that arrived while the board was still being built (the stage's welcome, usually).
	for (const msg of pendingMessages.splice(0)) onMessage(msg);
	$('link').className = 'link is-on';
	updateRole();
	requestAnimationFrame((now) => { lastFrame = now; frame(now); });
}

function resize() {
	const w = window.innerWidth, h = window.innerHeight;
	view.resize(w, h);
	dpr = Math.min(window.devicePixelRatio || 1, 2);
	overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
}

function updateRole() {
	const pro = state.phones >= 2;
	const logical = state.slot === 1 && state.slots[0] ? 1 : 0;
	const names = state.mode.id === 'arms' ? ['Left hand', 'Right hand'] : state.mode.id === 'walk' ? ['Steering', 'Posture'] : ['Main bar', 'Limb bar'];
	$('role').textContent = pro ? `${names[logical]} · puppeteer ${logical + 1} of 2` : 'Connected · solo, both bars';
	$('btn-pro').hidden = !pro;
}

function applyStrings() {
	state.strings = stringsForMode(state.mode, state.custom, state.rigStrings || STRINGS);
	view.setStrings(state.strings);
	state.pulls.clear();
	state.sel = state.sel.filter((s) => s.type !== 'string');
	renderSelection();
}

function buildModes() {
	const nav = $('modes');
	nav.textContent = '';
	for (const mode of MODES) {
		const b = document.createElement('button');
		b.type = 'button'; b.textContent = mode.label; b.dataset.mode = mode.id;
		b.addEventListener('click', () => { if (mode.id !== state.mode.id) { setMode(mode.id, true); buzz(); } });
		nav.appendChild(b);
	}
}

/** The one-tap moves: every scripted flourish the stage knows, in one row to flick through. */
function buildMoves() {
	const nav = $('moves');
	nav.textContent = '';
	for (const move of GESTURE_LIST) {
		const b = document.createElement('button');
		b.type = 'button'; b.textContent = move.label;
		b.addEventListener('click', () => {
			link.send({ t: 'act', id: move.id });
			buzz(12);
			// Light the button for as long as the stage will be playing the move.
			b.classList.add('is-playing');
			clearTimeout(b.timer);
			b.timer = setTimeout(() => b.classList.remove('is-playing'), GESTURES[move.id].dur * 1000);
		});
		nav.appendChild(b);
	}
}

let blurbTimer = 0;
function setMode(id, announce) {
	const mode = modeById(id);
	state.mode = mode;
	for (const b of $('modes').children) {
		const on = b.dataset.mode === mode.id;
		b.setAttribute('aria-pressed', on);
		if (on && b.scrollIntoView) b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
	}
	const blurb = $('blurb');
	blurb.textContent = mode.blurb;
	blurb.classList.remove('is-faded');
	clearTimeout(blurbTimer);
	blurbTimer = setTimeout(() => blurb.classList.add('is-faded'), 9000);
	$('stick').hidden = !mode.stick;
	$('stick-label').textContent = mode.stick || '';
	state.stick = [0, 0];
	const actions = $('actions');
	actions.textContent = '';
	for (const a of mode.actions || []) {
		if (Object.hasOwn(GESTURES, a.id)) continue;   // moves live in their own row; these are the mode's own tricks
		const b = document.createElement('button');
		b.type = 'button'; b.textContent = a.label;
		b.addEventListener('click', () => { link.send({ t: 'act', id: a.id }); buzz(12); });
		actions.appendChild(b);
	}
	$('tool-rig').hidden = !mode.custom;
	// A new configuration starts from clean hands.
	state.handleOff.clear(); state.ik.clear(); state.joints.clear(); state.sel = [];
	if (view) applyStrings();
	updateRole();
	if (announce) {
		link.send({ t: 'mode', id: mode.id });
		if (mode.custom) link.send({ t: 'custom', rig: state.custom });
	}
}

// -------------------------------------------------------------- selection

const sameItem = (a, b) => a && b && a.type === b.type && a.index === b.index;
const isSelected = (item) => state.sel.some((s) => sameItem(s, item));
const groupOf = (handle) => state.groups.find((g) => g.includes(handle));

function select(item) {
	if (state.multi) {
		state.sel = isSelected(item) ? state.sel.filter((s) => !sameItem(s, item)) : [...state.sel.filter((s) => s.type === item.type), item];
	} else {
		state.sel = isSelected(item) && state.sel.length === 1 ? [] : [item];
	}
	buzz();
	renderSelection();
}

/** Handles moved together with `index`: its group, plus the rest of a multi-selection. */
function handleMembers(index) {
	const members = new Set([index]);
	for (const m of groupOf(index) || []) members.add(m);
	if (isSelected({ type: 'handle', index })) for (const s of state.sel) if (s.type === 'handle') { members.add(s.index); for (const m of groupOf(s.index) || []) members.add(m); }
	return [...members];
}

const LIFT = {
	handle: { label: 'Lift', min: 0, max: 0.7 },
	string: { label: 'Pull', min: 0, max: 0.75 },
	ik: { label: 'Height', min: -0.35, max: 1.0 },
	joint: { label: 'Twist', min: -1.2, max: 1.2 },
};

function liftValue(item) {
	if (item.type === 'handle') return (state.handleOff.get(item.index) || [0, 0, 0])[1];
	if (item.type === 'string') return state.pulls.get(item.index) || 0;
	if (item.type === 'ik') return (state.ik.get(item.index) || [0, 0, 0])[1];
	return (state.joints.get(item.index) || [0, 0, 0])[1];
}

function setLift(item, value) {
	if (item.type === 'handle') {
		for (const m of handleMembers(item.index)) {
			const off = state.handleOff.get(m) || [0, 0, 0];
			off[1] = value;
			if (off[0] || off[1] || off[2]) state.handleOff.set(m, off); else state.handleOff.delete(m);
		}
	} else if (item.type === 'string') {
		for (const s of state.sel) if (s.type === 'string') { if (value > 0.004) state.pulls.set(s.index, value); else state.pulls.delete(s.index); }
	} else if (item.type === 'ik') {
		const off = state.ik.get(item.index) || ikStartOffset(item.index);
		off[1] = value;
		state.ik.set(item.index, off);
	} else if (JOINTS[item.index].type !== 'hinge') {
		const t = state.joints.get(item.index) || [0, 0, 0];
		t[1] = clamp(value, JOINTS[item.index].min[1], JOINTS[item.index].max[1]);
		state.joints.set(item.index, t);
	}
}

function resetItem(item) {
	if (item.type === 'handle') for (const m of handleMembers(item.index)) { state.handleOff.delete(m); state.pins.delete(m); }
	if (item.type === 'string') state.pulls.delete(item.index);
	if (item.type === 'ik') state.ik.delete(item.index);
	if (item.type === 'joint') state.joints.delete(item.index);
	buzz(14);
	renderSelection();
}

function sendLocks() { link.send({ t: 'locks', joints: [...state.locks] }); }

/** Drops everything this phone is holding, so a reset really leaves the puppet at rest. */
function letGo() {
	state.handleOff.clear(); state.pulls.clear(); state.ik.clear(); state.joints.clear(); state.pins.clear(); state.sel = [];
	state.locks.clear();
	renderSelection();
}

function renderSelection() {
	const sheet = $('sheet');
	const lift = $('lift');
	const item = state.sel[state.sel.length - 1];
	if (!item) { sheet.hidden = true; lift.hidden = true; return; }
	sheet.hidden = false;
	const actions = $('sheet-actions');
	actions.textContent = '';
	const button = (label, fn, pressed) => {
		const b = document.createElement('button');
		b.type = 'button'; b.textContent = label;
		if (pressed !== undefined) b.setAttribute('aria-pressed', pressed);
		b.addEventListener('click', () => { fn(); renderSelection(); });
		actions.appendChild(b);
	};
	const many = state.sel.length > 1 ? ` (+${state.sel.length - 1})` : '';
	let title = '', sub = '';
	if (item.type === 'handle') {
		const h = HANDLES[item.index];
		const strings = state.strings.filter((s) => s.handle === h.id && s.enabled !== false).map((s) => s.label);
		title = `${h.label} handle${many}`;
		sub = `${BARS.find((b) => b.id === h.bar).label} · ${strings.length ? strings.join(', ') : 'no string attached'}`;
		const members = handleMembers(item.index);
		const pinned = members.every((m) => state.pins.has(m));
		button(pinned ? 'Pinned' : 'Pin in place', () => { for (const m of members) pinned ? state.pins.delete(m) : state.pins.add(m); }, pinned);
		button('Let go', () => resetItem(item));
		const picked = state.sel.filter((s) => s.type === 'handle').map((s) => s.index);
		if (picked.length > 1) button('Group these', () => { state.groups = state.groups.filter((g) => !g.some((m) => picked.includes(m))); state.groups.push(picked); store.set('mp.groups', state.groups); toast(`Grouped ${picked.length} handles — they now move together`); });
		if (groupOf(item.index)) button('Ungroup', () => { state.groups = state.groups.filter((g) => !g.includes(item.index)); store.set('mp.groups', state.groups); });
	} else if (item.type === 'string') {
		const s = state.strings[item.index];
		title = `String ${s.n} · ${s.label}${many}`;
		sub = `${s.body} → ${HANDLES.find((h) => h.id === s.handle).label} handle`;
		button('Slacken', () => { for (const x of state.sel) if (x.type === 'string') state.pulls.delete(x.index); });
		if (state.mode.custom) button(s.enabled === false ? 'Enable' : 'Disable', () => { state.custom.strings[item.index].enabled = s.enabled === false; pushCustom(); });
		button('Re-tie broken', () => link.send({ t: 'act', id: 'restring' }));
	} else if (item.type === 'ik') {
		title = `${EFFECTORS[item.index].label} target`;
		sub = state.ik.has(item.index) ? 'Drag to place · slider sets height' : 'Drag to take hold of it';
		button('Release', () => resetItem(item));
	} else {
		const j = JOINTS[item.index];
		const locked = state.locks.has(item.index);
		title = `${j.id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())} joint${many}`;
		sub = j.type === 'hinge' ? 'Hinge · drag up / down to bend' : 'Ball joint · drag to pose, slider twists';
		button(locked ? 'Locked' : 'Lock', () => { for (const x of state.sel) if (x.type === 'joint') locked ? state.locks.delete(x.index) : state.locks.add(x.index); sendLocks(); }, locked);
		button('Release', () => { for (const x of state.sel) if (x.type === 'joint') state.joints.delete(x.index); });
	}
	$('sheet-title').textContent = title;
	$('sheet-sub').textContent = sub;
	const cfg = LIFT[item.type];
	lift.hidden = item.type === 'joint' && JOINTS[item.index].type === 'hinge';
	$('lift-label').textContent = cfg.label;
	$('lift-range').value = Math.round(((liftValue(item) - cfg.min) / (cfg.max - cfg.min)) * 100);
}

function pushCustom() {
	// The editor mutates this object in place; the stage re-validates whatever it receives.
	store.set('mp.custom', state.custom);
	link.send({ t: 'custom', rig: state.custom });
	if (state.mode.custom) applyStrings();
}

// ------------------------------------------------------------------ touch

const yawOf = (st) => qToYPR([st.barQuat[0], st.barQuat[1], st.barQuat[2], st.barQuat[3]])[0];

/** Offset that puts an IK target exactly where the effector currently is. */
function ikStartOffset(index) {
	const st = view.state;
	const e = EFFECTORS[index];
	const body = BODIES.find((b) => b.id === e.tipBody);
	const rest = [body.pos[0] + e.tip[0] - RIG_HOME[0], body.pos[1] + e.tip[1], body.pos[2] + e.tip[2] - RIG_HOME[2]];
	const base = (state.mode.ikBase && state.mode.ikBase[e.id]) || [0, 0, 0];
	if (!st) return [0, 0, 0];
	const tip = view.effectorPosition(index, st, V2);
	const local = qRot(qAxisAngle([0, 1, 0], -yawOf(st)), [tip.x - st.barPos[0], tip.y, tip.z - st.barPos[2]]);
	return [local[0] - rest[0] - base[0], local[1] - rest[1] - base[1], local[2] - rest[2] - base[2]];
}

function pick(x, y) {
	let best = null, bestD = Infinity;
	for (const type of ['handle', 'ik', 'joint']) {
		for (const h of hits) {
			if (h.type !== type) continue;
			const d = Math.hypot(h.x - x, h.y - y);
			if (d < h.r && d < bestD) { best = h; bestD = d; }
		}
		if (best) return best;
	}
	for (const h of hits) {
		if (h.type !== 'string') continue;
		const vx = h.x2 - h.x, vy = h.y2 - h.y;
		const t = clamp(((x - h.x) * vx + (y - h.y) * vy) / (vx * vx + vy * vy || 1), 0, 1);
		const d = Math.hypot(h.x + vx * t - x, h.y + vy * t - y);
		if (d < 20 && d < bestD) { best = h; bestD = d; }
	}
	return best;
}

function bindTouch() {
	const canvas = $('view');
	const pointers = new Map();
	let touch = null, gesture = null, lastTap = null;

	const endDrag = () => {
		if (touch && touch.drag === 'handle') {
			for (const m of touch.members) {
				if (state.pins.has(m.index)) continue;
				const lift = m.start[1];
				if (lift) state.handleOff.set(m.index, [0, lift, 0]); else state.handleOff.delete(m.index);
			}
		}
		touch = null;
	};

	canvas.addEventListener('pointerdown', (e) => {
		try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 2) {
			endDrag();
			const [a, b] = [...pointers.values()];
			gesture = { dist: Math.hypot(a.x - b.x, a.y - b.y), angle: Math.atan2(b.y - a.y, b.x - a.x), cy: (a.y + b.y) / 2, orbit: { ...view.orbit } };
		} else if (pointers.size === 1) {
			touch = { x0: e.clientX, y0: e.clientY, hit: state.camera ? null : pick(e.clientX, e.clientY), moved: false, drag: null, orbit: { ...view.orbit } };
		}
	});

	canvas.addEventListener('pointermove', (e) => {
		const p = pointers.get(e.pointerId);
		if (!p) return;
		p.x = e.clientX; p.y = e.clientY;
		const st = view.state;
		if (pointers.size === 2 && gesture) {
			// Two fingers always move the camera: pinch = zoom, twist = orbit, slide = tilt.
			const [a, b] = [...pointers.values()];
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			view.orbit.distance = clamp(gesture.orbit.distance * (gesture.dist / Math.max(20, dist)), 2.6, 9);
			view.orbit.azimuth = gesture.orbit.azimuth - (Math.atan2(b.y - a.y, b.x - a.x) - gesture.angle);
			view.orbit.polar = clamp(gesture.orbit.polar + ((a.y + b.y) / 2 - gesture.cy) * 0.005, 0.02, 1.25);
			return;
		}
		if (!touch) return;
		const dx = e.clientX - touch.x0, dy = e.clientY - touch.y0;
		if (!touch.moved && Math.hypot(dx, dy) < 7) return;
		if (!touch.moved) {
			touch.moved = true;
			const hit = touch.hit;
			if (state.camera || !hit || !st) touch.drag = state.camera ? 'orbit' : null;
			else if (hit.type === 'handle') {
				if (!isSelected(hit)) { state.sel = state.multi ? [...state.sel.filter((s) => s.type === 'handle'), { type: 'handle', index: hit.index }] : [{ type: 'handle', index: hit.index }]; renderSelection(); }
				touch.drag = 'handle';
				touch.planeY = st.handlePos[hit.index * 3 + 1];
				touch.p0 = view.planePoint(touch.x0, touch.y0, touch.planeY);
				touch.members = handleMembers(hit.index).map((index) => ({ index, start: [...(state.handleOff.get(index) || [0, 0, 0])], bar: BARS.findIndex((b) => b.id === HANDLES[index].bar) }));
			} else if (hit.type === 'ik') {
				if (!isSelected(hit)) { state.sel = [{ type: 'ik', index: hit.index }]; }
				touch.drag = 'ik';
				touch.start = [...(state.ik.get(hit.index) || ikStartOffset(hit.index))];
				touch.planeY = hit.wy;
				touch.p0 = view.planePoint(touch.x0, touch.y0, touch.planeY);
				state.ik.set(hit.index, [...touch.start]);
				renderSelection();
			} else if (hit.type === 'joint') {
				if (!isSelected(hit)) { state.sel = [{ type: 'joint', index: hit.index }]; renderSelection(); }
				touch.drag = 'joint';
				touch.start = [...(state.joints.get(hit.index) || [0, 0, 0])];
			}
			if (touch.drag && touch.drag !== 'orbit') buzz();
		}
		if (touch.drag === 'orbit') {
			view.orbit.azimuth = touch.orbit.azimuth - dx * 0.006;
			view.orbit.polar = clamp(touch.orbit.polar - dy * 0.005, 0.02, 1.25);
		} else if (touch.drag === 'handle' && touch.p0 && st) {
			const p1 = view.planePoint(e.clientX, e.clientY, touch.planeY, V);
			if (!p1) return;
			const d = [p1.x - touch.p0.x, 0, p1.z - touch.p0.z];
			for (const m of touch.members) {
				const q = [st.barQuat[m.bar * 4], st.barQuat[m.bar * 4 + 1], st.barQuat[m.bar * 4 + 2], st.barQuat[m.bar * 4 + 3]];
				const local = qRot(qConj(q), d);
				state.handleOff.set(m.index, [clamp(m.start[0] + local[0], -0.65, 0.65), clamp(m.start[1] + local[1], -0.4, 0.75), clamp(m.start[2] + local[2], -0.65, 0.65)]);
			}
		} else if (touch.drag === 'ik' && touch.p0 && st) {
			const p1 = view.planePoint(e.clientX, e.clientY, touch.planeY, V);
			if (!p1) return;
			const local = qRot(qAxisAngle([0, 1, 0], -yawOf(st)), [p1.x - touch.p0.x, 0, p1.z - touch.p0.z]);
			state.ik.set(touch.hit.index, [clamp(touch.start[0] + local[0], -0.9, 0.9), touch.start[1], clamp(touch.start[2] + local[2], -0.9, 0.9)]);
		} else if (touch.drag === 'joint') {
			const j = JOINTS[touch.hit.index];
			const lim = (n, v) => (j.type === 'hinge' ? clamp(v, j.min, j.max) : clamp(v, j.min[n], j.max[n]));
			const t = [lim(0, touch.start[0] + dy * 0.012), touch.start[1], j.type === 'hinge' ? 0 : lim(2, touch.start[2] - dx * 0.012)];
			state.joints.set(touch.hit.index, t);
		}
	});

	const up = (e) => {
		if (!pointers.has(e.pointerId)) return;
		pointers.delete(e.pointerId);
		if (pointers.size < 2) gesture = null;
		if (!touch || pointers.size > 0) { if (pointers.size === 0) endDrag(); return; }
		if (!touch.moved) {
			const hit = touch.hit;
			const now = performance.now();
			if (!hit) { if (!state.camera && !state.multi) { state.sel = []; renderSelection(); } }
			else if (lastTap && sameItem(lastTap.item, hit) && now - lastTap.time < 340) { resetItem(hit); lastTap = null; }
			else { select({ type: hit.type, index: hit.index }); lastTap = { item: { type: hit.type, index: hit.index }, time: now }; }
		}
		endDrag();
	};
	canvas.addEventListener('pointerup', up);
	canvas.addEventListener('pointercancel', up);
	canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function bindUi() {
	$('lift-range').addEventListener('input', (e) => {
		const item = state.sel[state.sel.length - 1];
		if (!item) return;
		const cfg = LIFT[item.type];
		setLift(item, cfg.min + (e.target.value / 100) * (cfg.max - cfg.min));
	});
	const toggle = (id, key, on, off) => $(id).addEventListener('click', () => {
		state[key] = !state[key];
		$(id).setAttribute('aria-pressed', state[key]);
		toast(state[key] ? on : off);
		buzz();
	});
	toggle('tool-camera', 'camera', 'Camera: drag to orbit, pinch to zoom', 'Puppet: drag the knobs and targets');
	toggle('tool-multi', 'multi', 'Multi-select: tap several controls', 'Single select');
	$('tool-level').addEventListener('click', () => openCalibration(false));
	$('tool-reset').addEventListener('click', () => {
		letGo();
		sendLocks();
		view.orbit = { ...DEFAULT_ORBIT };
		link.send({ t: 'reset' });   // the stage stands the puppet up, re-ties broken strings and tells the other phone
		toast('Puppet reset');
		buzz(20);
	});
	// The selection sheet and toasts sit just above the dock, whatever its height.
	const dock = $('dock');
	const measureDock = () => document.documentElement.style.setProperty('--dock-h', `${dock.offsetHeight}px`);
	if (window.ResizeObserver) new ResizeObserver(measureDock).observe(dock);
	measureDock();
	$('btn-pro').addEventListener('click', () => toast('Pro: two phones share this puppet — one bar each'));

	// Thumb stick.
	const pad = $('stick-pad'), nub = $('stick-nub');
	let stickId = null;
	const moveStick = (e) => {
		const r = pad.getBoundingClientRect();
		let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
		const m = Math.hypot(x, y);
		if (m > 1) { x /= m; y /= m; }
		state.stick = [x, -y];
		nub.style.transform = `translate(${x * 26}px, ${y * 26}px)`;
	};
	pad.addEventListener('pointerdown', (e) => { stickId = e.pointerId; try { pad.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } moveStick(e); });
	pad.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) moveStick(e); });
	const release = (e) => { if (e.pointerId !== stickId) return; stickId = null; state.stick = [0, 0]; nub.style.transform = ''; };
	pad.addEventListener('pointerup', release);
	pad.addEventListener('pointercancel', release);

	const editor = new RigEditor({
		panel: $('rig-panel'), body: $('rig-body'), tabs: $('rig-tabs'),
		get: () => state.custom,
		set: (rig) => { state.custom = rig; pushCustom(); },
		toast,
	});
	$('tool-rig').addEventListener('click', () => editor.open());
	$('rig-close').addEventListener('click', () => editor.close());
}

// ------------------------------------------------------------------ frame

let lastFrame = 0, lastSend = 0, lastMeter = 0;
const selectedStrings = new Set();

function drawOverlay(st) {
	const g = og;
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, view.width, view.height);
	hits.length = 0;
	if (!st) return;
	const mode = state.mode;
	g.lineCap = 'round';

	// Strings: invisible pick segments, plus a tag on the selected ones.
	view.strings.items.forEach((item, i) => {
		if (item.def.enabled === false) return;
		view.project(item.top.x, item.top.y, item.top.z, P);
		const x1 = P.x, y1 = P.y;
		view.project(item.attach.x, item.attach.y, item.attach.z, P);
		hits.push({ type: 'string', index: i, x: x1, y: y1, x2: P.x, y2: P.y });
		// Screw eye where the string meets the puppet.
		const t = st.tension[i] || 0;
		g.beginPath(); g.arc(P.x, P.y, 3.2 + t * 4, 0, Math.PI * 2);
		g.fillStyle = t > 0.004 ? `rgba(255,${Math.round(226 - t * 150)},${Math.round(168 - t * 120)},0.95)` : 'rgba(150,170,200,0.55)';
		g.fill();
	});

	// Joints.
	if (mode.jointControl || state.locks.size) {
		JOINTS.forEach((j, i) => {
			const locked = state.locks.has(i);
			if (!mode.jointControl && !locked) return;
			view.jointPosition(i, st, V);
			view.project(V.x, V.y, V.z, P);
			if (mode.jointControl) hits.push({ type: 'joint', index: i, x: P.x, y: P.y, r: 20 });
			const sel = isSelected({ type: 'joint', index: i });
			const active = state.joints.has(i);
			g.save(); g.translate(P.x, P.y); g.rotate(Math.PI / 4);
			const s = sel ? 8 : 5.5;
			g.fillStyle = locked ? '#ef6a55' : active ? '#e2b457' : 'rgba(20,12,10,0.75)';
			g.strokeStyle = sel ? '#fff' : locked ? '#ffb3a4' : '#e2b457';
			g.lineWidth = sel ? 2.4 : 1.5;
			g.fillRect(-s, -s, s * 2, s * 2); g.strokeRect(-s, -s, s * 2, s * 2);
			g.restore();
		});
	}

	// IK targets.
	if (mode.ik) {
		EFFECTORS.forEach((e, i) => {
			if (!mode.ik.includes(e.id)) return;
			const tip = view.effectorPosition(i, st, V);
			view.project(tip.x, tip.y, tip.z, P);
			const tx = P.x, ty = P.y;
			let wy = tip.y;
			const live = (st.ikMask & (1 << i)) && (state.ik.has(i) || (mode.ikAlways && mode.ikAlways.includes(e.id)));
			if (live) { view.project(st.ikPos[i * 3], st.ikPos[i * 3 + 1], st.ikPos[i * 3 + 2], P); wy = st.ikPos[i * 3 + 1]; }
			hits.push({ type: 'ik', index: i, x: P.x, y: P.y, r: 30, wy });
			const sel = isSelected({ type: 'ik', index: i });
			g.strokeStyle = live ? '#49c5b6' : 'rgba(73,197,182,0.55)';
			g.lineWidth = sel ? 3.2 : 2;
			if (live) { g.setLineDash([4, 5]); g.beginPath(); g.moveTo(tx, ty); g.lineTo(P.x, P.y); g.stroke(); g.setLineDash([]); }
			g.beginPath(); g.arc(P.x, P.y, sel ? 19 : 15, 0, Math.PI * 2); g.stroke();
			g.beginPath(); g.moveTo(P.x - 6, P.y); g.lineTo(P.x + 6, P.y); g.moveTo(P.x, P.y - 6); g.lineTo(P.x, P.y + 6); g.stroke();
			if (sel) { g.fillStyle = 'rgba(73,197,182,0.18)'; g.beginPath(); g.arc(P.x, P.y, 19, 0, Math.PI * 2); g.fill(); }
		});
	}

	// String handles (the knobs on the bars).
	g.font = '600 11px ui-sans-serif, system-ui, sans-serif';
	g.textAlign = 'center';
	HANDLES.forEach((h, i) => {
		view.project(st.handlePos[i * 3], st.handlePos[i * 3 + 1], st.handlePos[i * 3 + 2], P);
		hits.push({ type: 'handle', index: i, x: P.x, y: P.y, r: 30 });
		let load = 0;
		state.strings.forEach((s, k) => { if (s.handle === h.id) load = Math.max(load, st.tension[k] || 0); });
		const sel = isSelected({ type: 'handle', index: i });
		const moved = state.handleOff.has(i);
		const r = sel ? 17 : 13;
		g.beginPath(); g.arc(P.x, P.y, r, 0, Math.PI * 2);
		g.fillStyle = sel ? 'rgba(226,180,87,0.3)' : 'rgba(16,9,9,0.35)';
		g.fill();
		g.lineWidth = sel ? 3 : 1.6 + load * 2.5;
		g.strokeStyle = load > 0.6 ? '#ff7a5c' : moved || sel ? '#ffe2a8' : `rgba(226,180,87,${0.55 + load * 0.45})`;
		g.stroke();
		if (state.pins.has(i)) { g.fillStyle = '#ffe2a8'; g.beginPath(); g.arc(P.x, P.y, 3.5, 0, Math.PI * 2); g.fill(); }
		if (groupOf(i)) { g.setLineDash([3, 4]); g.beginPath(); g.arc(P.x, P.y, r + 5, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,226,168,0.6)'; g.lineWidth = 1.2; g.stroke(); g.setLineDash([]); }
		if (sel) { g.fillStyle = '#fff3d6'; g.fillText(h.label, P.x, P.y - r - 8); }
	});
}

function frame(now) {
	requestAnimationFrame(frame);
	const dt = Math.min(0.1, (now - lastFrame) / 1000);
	lastFrame = now;
	tickCalibration(dt, now);
	if (!view) return;

	const st = view.sample(now);
	view.updateCamera(dt, st);
	view.pulls.fill(0);
	for (const [i, v] of state.pulls) view.pulls[i] = v;
	selectedStrings.clear();
	for (const s of state.sel) {
		if (s.type === 'string') selectedStrings.add(s.index);
		if (s.type === 'handle') state.strings.forEach((x, k) => { if (x.handle === HANDLES[s.index].id) selectedStrings.add(k); });
	}
	view.render(st, now / 1000, selectedStrings);
	drawOverlay(st);

	if (state.joined && now - lastSend > 14) {
		lastSend = now;
		const live = sensors.available && sensors.calibrated;
		link.sendPacket(encodeInput({
			seq: state.seq++, sensors: live, calibrated: sensors.calibrated,
			quat: live ? sensors.quat : [0, 0, 0, 1], gyro: live ? sensors.gyro : [0, 0, 0], acc: live ? sensors.acc : [0, 0, 0],
			stick: state.stick, handles: state.handleOff, pulls: state.pulls, ik: state.ik, joints: state.joints,
		}));
	}

	if (st && now - lastMeter > 90) {
		lastMeter = now;
		const item = state.sel[state.sel.length - 1];
		let load = 0;
		if (item && item.type === 'string') load = st.tension[item.index] || 0;
		if (item && item.type === 'handle') state.strings.forEach((s, k) => { if (s.handle === HANDLES[item.index].id) load = Math.max(load, st.tension[k] || 0); });
		$('sheet-meter').style.width = `${Math.round(load * 100)}%`;
	}
}

// Calibration can run before the board exists.
requestAnimationFrame(function warm(now) {
	if (view) return;
	tickCalibration(0.016, now);
	requestAnimationFrame(warm);
});

// For the browser console and automated checks.
window.motionPuppetPhone = { state, sensors, link, get view() { return view; }, select, setLift, hits };
