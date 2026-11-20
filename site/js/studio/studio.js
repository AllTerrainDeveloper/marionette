// The Studio: animate the marionette on a timeline. Keys are set on tracks — the camera, the two
// control bars, the twelve string handles — and played back through the control layer, so the
// puppet is still moved by its strings and the physics; nothing is posed by hand and no phone or
// sensor is involved. The camera, and the bars when they travel, move along Bezier curves through
// their keys; every stretch between two keys is eased by a timing curve you can pick or draw.
//
// Workspace view: look round freely, drag the bars, the handles, the camera and what it looks
// at. Through camera: the viewport is the shot; moving the view moves the camera.

import * as THREE from 'three';
import * as M from '../shared/math.js';
import { marionetteRig } from '../shared/marionette.js';
import {
	TRACKS, EASES, trackById, easeAt, easeName, sampleTrack, sampleCamera, pathControls, driveTargets, keyBefore,
	newAnimation, setKey, removeKey, moveKey, setDuration, sanitizeAnimation, keyCount, demoAnimation, snapTime,
} from '../shared/timeline.js';
import { createWorld, bootError } from '../stage/world.js';
import { OrbitCam, toScreen, pointerAt, dragPoint } from './orbit.js';
import { el, toast, downloadJson, openJson, slider, typing, curtain } from './ui.js';

const $ = (id) => document.getElementById(id);
const veil = curtain();
const STORE_KEY = 'motion-puppet-studio';
const PAD = 12;                 // px of timeline lane before 0 s and after the end, so the first and last keys can be grabbed
const PICK_RADIUS = 16;         // px within which a click takes hold of something in the viewport
const UNDO_DEPTH = 80;
const CAMERA = TRACKS[0];

function loadAnimation() {
	try {
		const stored = localStorage.getItem(STORE_KEY);
		if (stored) return sanitizeAnimation(JSON.parse(stored));
	} catch { /* nothing stored, or not JSON */ }
	return demoAnimation();
}

async function boot() {
	let anim = loadAnimation();
	const view = $('view'), canvas = $('stage');
	const world = await createWorld(canvas, { rig: marionetteRig(), size: () => [view.clientWidth, view.clientHeight], onProgress: veil.say });
	const { sim, controller, stage } = world;
	new ResizeObserver(world.resize).observe(view);

	// --------------------------------------------------------------- state
	let time = 0;
	let playing = false, loop = true, autoKey = true;
	let shotView = false;
	let selTrack = 'main';
	let selKey = null;                 // the selected key (an object in anim.tracks[selTrack]) or null
	const held = new Map();            // trackId -> values held in place without a key (auto-key off)
	const undo = [], redo = [];
	let committed = JSON.stringify(anim);
	let timelineStale = true, inspectorStale = true, pathStale = true;

	controller.director = (add) => driveTargets(anim, time, add, held);

	const keysOf = (id) => anim.tracks[id] || [];
	/** A track's values now: held, else keyed, else at rest. */
	const valuesOf = (id) => {
		const track = trackById(id);
		return (held.get(id) || sampleTrack(track, anim.tracks[id], time, []) || track.rest).slice();
	};
	const stale = () => { timelineStale = inspectorStale = pathStale = true; };

	/** Something was changed and the change is complete: one step for Undo, and saved. */
	function commit() {
		const now = JSON.stringify(anim);
		if (now === committed) return;
		undo.push(committed);
		if (undo.length > UNDO_DEPTH) undo.shift();
		redo.length = 0;
		committed = now;
		save();
	}
	function save() {
		let ok = true;
		try { localStorage.setItem(STORE_KEY, committed); } catch { ok = false; }
		const n = keyCount(anim);
		$('saved').textContent = ok ? `Saved here · ${n} key${n === 1 ? '' : 's'}` : 'This browser would not save it';
		$('btn-undo').disabled = !undo.length;
		$('btn-redo').disabled = !redo.length;
	}
	function restore(json, from) {
		from.push(committed);
		committed = json;
		anim = sanitizeAnimation(JSON.parse(json));
		selKey = null; held.clear();
		time = Math.min(time, anim.duration);
		syncHeader(); stale(); save();
	}
	function replaceAnimation(next, message) {
		anim = next;
		selKey = null; held.clear(); time = 0;
		commit(); syncHeader(); stale();
		world.reset();
		if (message) toast(message);
	}

	function setTime(t, keepHeld = false) {
		t = Math.max(0, Math.min(anim.duration, t));
		if (t === time) return;
		time = t;
		if (!keepHeld && held.size) held.clear();   // what was not keyed is let go when the playhead moves, as in any animation tool
		inspectorStale = true;
	}

	/**
	 * Gives a track new values at the playhead: a key with Auto-key on, otherwise held in place
	 * until keyed. `done` false while a drag is still going (one Undo step for the whole drag).
	 */
	function edit(id, values, done = true) {
		const track = trackById(id);
		if (playing) setPlaying(false);   // a change belongs to one moment: playback stops where it was made
		values = values.map((v, n) => Math.max(track.channels[n].min, Math.min(track.channels[n].max, v)));
		if (autoKey) { selKey = setKey(anim, id, time, values); held.delete(id); } else held.set(id, values);
		if (selTrack !== id) selTrack = id;
		stale();
		if (done) commit();
	}
	function keyHere(id = selTrack) {
		selKey = setKey(anim, id, time, valuesOf(id));
		held.delete(id);
		selTrack = id;
		stale(); commit();
	}
	function selectTrack(id, key = null) {
		selTrack = id; selKey = key;
		timelineStale = inspectorStale = true;
	}
	function removeSelectedKey() {
		if (!selKey) return;
		removeKey(anim, selTrack, selKey);
		selKey = null;
		stale(); commit();
	}

	function setPlaying(on) {
		playing = on;
		if (on) { held.clear(); if (time >= anim.duration - 1e-6) time = 0; }
		$('play-icon').setAttribute('d', on ? 'M3 2h4v12H3zM9 2h4v12H9z' : 'M4 2l10 6-10 6z');
		$('btn-play').setAttribute('aria-label', on ? 'Pause' : 'Play');
		inspectorStale = true;
	}
	function toStart() {
		setPlaying(false);
		setTime(0);
		world.reset();
	}

	// ------------------------------------------------------------- cameras
	// One hand-held camera for the viewport. In the workspace it is your own eye; through the
	// camera it is the shot, and moving it edits the camera track.
	const orbit = new OrbitCam(canvas, { position: [4.4, 3.3, 9.2], target: [0, 1.2, 1.3], fov: 31 });
	let workspace = { position: orbit.position.toArray(), target: orbit.target.toArray() };
	const shot = sampleCamera(anim, 0);
	let orbiting = false;
	orbit.onChange = () => {
		if (!shotView) return;
		orbiting = true;
		edit('camera', [orbit.position.x, orbit.position.y, orbit.position.z, orbit.target.x, orbit.target.y, orbit.target.z, shot[6]], false);
	};
	orbit.onEnd = () => { orbiting = false; if (shotView) commit(); };

	function setShotView(on) {
		if (on === shotView) return;
		if (on) workspace = { position: orbit.position.toArray(), target: orbit.target.toArray() };
		else orbit.set(workspace.position, workspace.target, 31);
		shotView = on;
		$('view-free').setAttribute('aria-pressed', !on);
		$('view-shot').setAttribute('aria-pressed', on);
		$('frame').hidden = !on;
		$('hint').textContent = on
			? 'Through the camera: drag to swing it round what it looks at · right-drag to slide · wheel to move in. Every move is keyed at the playhead.'
			: 'Workspace: drag a bar, a string handle, the camera or its aim to move it · drag empty space to look round · right-drag to slide · wheel to zoom';
		if (on) selectTrack('camera');
	}

	// What is drawn in the workspace for the camera: its body, where it looks, and its path.
	const gizmos = new THREE.Group();
	stage.scene.add(gizmos);
	const shotCamera = new THREE.PerspectiveCamera(31, 16 / 9, 0.12, 0.7);
	const shotHelper = new THREE.CameraHelper(shotCamera);
	shotHelper.material.fog = false;
	const aim = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff8a70, fog: false, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 }));
	const sight = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), new THREE.LineBasicMaterial({ color: 0xff8a70, transparent: true, opacity: 0.35, fog: false }));
	const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff8a70, fog: false }));
	const aimLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff8a70, transparent: true, opacity: 0.45, fog: false }));
	const pathDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffd0c4, size: 7, sizeAttenuation: false, fog: false, depthTest: false }));
	const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.038, 28), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
	for (const o of [sight, pathLine, aimLine, pathDots, shotHelper, aim, ring]) { o.frustumCulled = false; gizmos.add(o); }

	/** Redraws the camera's Bezier path (and the path of what it looks at) from its keys. */
	function rebuildPath() {
		pathStale = false;
		const keys = keysOf('camera');
		const STEPS = 28;
		const build = (line, triple) => {
			const pts = [];
			for (let i = 0; i < keys.length - 1; i++) {
				const c = pathControls(keys, i, triple);
				for (let k = i ? 1 : 0; k <= STEPS; k++) {
					const t = k / STEPS, f = 1 - t;
					for (let n = 0; n < 3; n++) pts.push(f * f * f * c[0][n] + 3 * f * f * t * c[1][n] + 3 * f * t * t * c[2][n] + t * t * t * c[3][n]);
				}
			}
			line.geometry.dispose();
			line.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
		};
		build(pathLine, CAMERA.paths[0]);
		build(aimLine, CAMERA.paths[1]);
		pathDots.geometry.dispose();
		pathDots.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(keys.flatMap((k) => [k.v[0], k.v[1], k.v[2]])), 3));
	}

	// ----------------------------------------------- picking in the viewport
	const _s = [0, 0, false];
	const _p = new THREE.Vector3(), _from = new THREE.Vector3();
	const barOf = (track) => sim.bars[track.bar];
	/** Where a track's thing is in the world: a handle's knob, a bar's middle, the camera or its aim. */
	function anchorOf(track, part = 0) {
		if (track.kind === 'handle') return sim.handleAt(track.handle);
		if (track.kind === 'bar') return barOf(track).pos;
		return part ? [shot[3], shot[4], shot[5]] : [shot[0], shot[1], shot[2]];
	}
	/** What is under the pointer: { track, part } or null. Handles win over the bars they sit on. */
	function pick(e) {
		const p = pointerAt(e, canvas);
		let best = null, least = PICK_RADIUS;
		const tryFor = (track, part, bias) => {
			toScreen(anchorOf(track, part), stage.camera, canvas, _s);
			if (!_s[2]) return;
			const d = Math.hypot(_s[0] - p[0], _s[1] - p[1]) + bias;
			if (d < least) { least = d; best = { track, part }; }
		};
		for (const track of TRACKS) {
			if (track.kind === 'handle') tryFor(track, 0, 0);
			else if (track.kind === 'bar') tryFor(track, 0, 5);
			else if (!shotView) { tryFor(track, 0, 0); tryFor(track, 1, 0); }
		}
		return best;
	}

	let drag = null, hover = null;
	orbit.intercept = (e) => {
		if (playing || e.button !== 0 || e.shiftKey) return false;
		const hit = pick(e);
		if (!hit) return false;
		const origin = new THREE.Vector3(...anchorOf(hit.track, hit.part));
		if (!dragPoint(e, stage.camera, canvas, origin, _from)) return false;
		selectTrack(hit.track.id, null);
		drag = { ...hit, id: e.pointerId, origin, from: _from.clone(), start: valuesOf(hit.track.id), moved: false };
		canvas.setPointerCapture(e.pointerId);
		canvas.classList.add('is-dragging');
		return true;
	};
	canvas.addEventListener('pointermove', (e) => {
		if (!drag) {
			if (!e.buttons) { hover = playing ? null : pick(e); canvas.classList.toggle('is-over', !!hover); }
			return;
		}
		if (drag.id !== e.pointerId || !dragPoint(e, stage.camera, canvas, drag.origin, _p)) return;
		let d = [_p.x - drag.from.x, _p.y - drag.from.y, _p.z - drag.from.z];
		const { track, start } = drag;
		// A handle's offset is counted in its bar's own frame, so that it tilts with the bar.
		if (track.kind === 'handle') d = M.qRot(M.qConj(barOf(track).quat), d);
		const values = start.slice();
		const at = track.kind === 'camera' && drag.part ? 3 : 0;
		values[at] += d[0]; values[at + 1] += d[1]; values[at + 2] += d[2];
		drag.moved = true;
		edit(track.id, values, false);
	});
	const endDrag = (e) => {
		if (!drag || drag.id !== e.pointerId) return;
		canvas.classList.remove('is-dragging');
		if (drag.moved) commit();
		drag = null;
	};
	canvas.addEventListener('pointerup', endDrag);
	canvas.addEventListener('pointercancel', endDrag);

	// ------------------------------------------------------------ each frame
	const tag = $('tag');
	let tick = 0;
	world.onFrame = (dt) => {
		if (playing) {
			time += dt * world.tuning.timeScale;
			if (time >= anim.duration) {
				if (loop) time %= anim.duration; else { time = anim.duration; setPlaying(false); }
			}
		}
		const cam = held.get('camera') || sampleCamera(anim, time, shot);
		for (let n = 0; n < 7; n++) shot[n] = cam[n];
		if (shotView && !orbiting) orbit.set(shot, [shot[3], shot[4], shot[5]], shot[6]);
		if (shotView) orbit.fov = shot[6];
		orbit.enabled = !(playing && shotView);
		orbit.apply(stage.camera);

		// In the workspace the camera is a thing in the scene: its body, its aim, its path.
		if (!shotView) {
			if (pathStale) rebuildPath();
			shotCamera.position.set(shot[0], shot[1], shot[2]);
			shotCamera.fov = shot[6]; shotCamera.aspect = stage.camera.aspect;
			shotCamera.lookAt(shot[3], shot[4], shot[5]);
			shotCamera.updateProjectionMatrix(); shotCamera.updateMatrixWorld();
			shotHelper.update();
			aim.position.set(shot[3], shot[4], shot[5]);
			const line = sight.geometry.attributes.position;
			line.setXYZ(0, shot[0], shot[1], shot[2]); line.setXYZ(1, shot[3], shot[4], shot[5]); line.needsUpdate = true;
		}
		const drawn = (line) => !shotView && !!line.geometry.attributes.position && line.geometry.attributes.position.count > 0;
		shotHelper.visible = aim.visible = sight.visible = !shotView;
		pathLine.visible = drawn(pathLine); aimLine.visible = drawn(aimLine); pathDots.visible = drawn(pathDots);
		// A ring round whatever the selected track moves, and a name beside what the pointer is on.
		const track = trackById(selTrack);
		ring.visible = !shotView || track.kind !== 'camera';
		if (ring.visible) {
			const where = anchorOf(track, drag && drag.track === track ? drag.part : 0);
			ring.position.set(where[0], where[1], where[2]);
			ring.quaternion.copy(stage.camera.quaternion);
			ring.scale.setScalar(Math.max(0.6, stage.camera.position.distanceTo(ring.position) / 5.5));
		}
		const named = drag || hover;
		tag.hidden = !named;
		if (named) {
			toScreen(anchorOf(named.track, named.part), stage.camera, canvas, _s);
			tag.style.left = `${_s[0]}px`; tag.style.top = `${_s[1]}px`;
			tag.textContent = named.track.kind === 'camera' ? (named.part ? 'Camera aim' : 'Camera') : named.track.label;
		}

		if (timelineStale) renderTimeline();
		if (inspectorStale || (playing && ++tick % 6 === 0)) renderValues();
		placePlayhead();
	};

	// -------------------------------------------------------------- timeline
	const tracksEl = $('tracks');
	const inner = el('div.tracks__inner');
	const playhead = el('div.playhead');
	const lanes = el('div', { style: `position:absolute;top:0;bottom:0;left:var(--label);right:0;pointer-events:none;z-index:4` }, playhead);
	tracksEl.append(inner);
	const at = (t) => `calc(${PAD}px + ${(t / anim.duration).toFixed(6)} * (100% - ${PAD * 2}px))`;
	/** The time under the pointer, on the timeline. */
	function timeAt(e) {
		// Every lane spans the same stretch as the ruler's, and the ruler is found afresh each
		// time: the rows are rebuilt while a key is being dragged along one.
		const r = inner.querySelector('.ruler__lane').getBoundingClientRect();
		return ((e.clientX - r.left - PAD) / Math.max(1, r.width - PAD * 2)) * anim.duration;
	}

	function renderTimeline() {
		timelineStale = false;
		const d = anim.duration;
		const major = d <= 12 ? 1 : d <= 30 ? 2 : d <= 80 ? 5 : d <= 200 ? 10 : 30;
		const ticks = [];
		for (let t = 0; t <= d + 1e-6; t += major / 2) {
			const whole = Math.abs(t / major - Math.round(t / major)) < 1e-6;
			ticks.push(el(`div.ruler__tick${whole ? '' : '.is-minor'}`, { style: `left:${at(t)}`, text: whole ? `${+t.toFixed(1)}s` : '' }));
		}
		const rows = TRACKS.map((track) => {
			const keys = keysOf(track.id);
			const lane = el('div.track__lane', { 'data-track': track.id });
			if (keys.length > 1) lane.append(el('div.track__span', { style: `left:${at(keys[0].t)};right:calc(100% - (${at(keys[keys.length - 1].t)}))` }));
			keys.forEach((key, i) => lane.append(el(`button.key${key === selKey ? '.is-selected' : ''}`, {
				type: 'button', style: `left:${at(key.t)}`, 'data-track': track.id, 'data-key': i,
				title: `${track.label} · ${key.t.toFixed(2)} s`, 'aria-label': `${track.label} key at ${key.t.toFixed(2)} seconds`,
			})));
			return el(`div.track${track.id === selTrack ? '.is-selected' : ''}${keys.length ? '' : '.is-empty'}`, { 'data-kind': track.kind },
				el('div.track__label', { 'data-label': track.id, title: track.kind === 'handle' ? `${track.label}: string handle` : track.label }, el('i'), track.label),
				lane);
		});
		inner.replaceChildren(
			el('div.ruler', {}, el('div.ruler__label', { text: 'Tracks' }), el('div.ruler__lane', { 'data-ruler': '1' }, ticks)),
			...rows, lanes);
	}
	function placePlayhead() {
		playhead.style.left = at(time);
		const frame = Math.round(time * anim.fps);
		$('clock').innerHTML = `${time.toFixed(2)} <small>/ ${anim.duration.toFixed(2)} s · f${frame}</small>`;
	}

	// Scrubbing, and dragging keys along their track.
	let scrub = null;
	tracksEl.addEventListener('pointerdown', (e) => {
		if (e.button !== 0) return;
		const keyEl = e.target.closest('.key');
		const lane = e.target.closest('.track__lane, .ruler__lane');
		const label = e.target.closest('[data-label]');
		if (label) { selectTrack(label.dataset.label); return; }
		if (!lane) return;
		setPlaying(false);
		tracksEl.setPointerCapture(e.pointerId);
		if (keyEl) {
			const id = keyEl.dataset.track, key = keysOf(id)[+keyEl.dataset.key];
			selectTrack(id, key);
			setTime(key.t);
			scrub = { id: e.pointerId, key, track: id, x: e.clientX, moved: false };
		} else {
			if (lane.dataset.track) selectTrack(lane.dataset.track, null);
			setTime(snapTime(anim, timeAt(e)));
			scrub = { id: e.pointerId };
		}
		e.preventDefault();
	});
	tracksEl.addEventListener('pointermove', (e) => {
		if (!scrub || scrub.id !== e.pointerId) return;
		const t = snapTime(anim, timeAt(e));
		if (scrub.key) {
			if (!scrub.moved && Math.abs(e.clientX - scrub.x) < 3) return;
			scrub.moved = true;
			moveKey(anim, scrub.track, scrub.key, t);
			setTime(scrub.key.t);
			stale();
		} else setTime(t);
	});
	const endScrub = (e) => {
		if (!scrub || scrub.id !== e.pointerId) return;
		if (scrub.moved) commit();
		scrub = null;
	};
	tracksEl.addEventListener('pointerup', endScrub);
	tracksEl.addEventListener('pointercancel', endScrub);
	tracksEl.addEventListener('dblclick', (e) => {
		// (The press before this one captured the pointer, so the event arrives at the timeline
		// itself; what was double-clicked is whatever lies under the pointer.)
		const under = document.elementFromPoint(e.clientX, e.clientY);
		const lane = under && under.closest('.track__lane');
		if (!lane || under.closest('.key')) return;
		setTime(snapTime(anim, timeAt(e)));
		keyHere(lane.dataset.track);
	});

	// ------------------------------------------------------------- inspector
	const side = $('side');
	const trackSection = el('section'), keySection = el('section');
	side.append(trackSection, keySection, el('section', {},
		el('h2', { text: 'How it works' }),
		el('p', { text: 'Move the playhead, then move something: a control bar, a string handle or the camera. With Auto-key on, every move sets a key there. The puppet is still worked by its strings — keys move the control, physics moves the puppet.' }),
		el('p.note', { text: 'The camera and the bars travel on Bezier curves through their keys. Every stretch between two keys follows the timing curve of the key it leaves.' })));
	let sliders = [];
	let shownTrack = null, shownKey;

	function renderValues() {
		inspectorStale = false;
		if (shownTrack !== selTrack || shownKey !== selKey) renderInspector();
		const values = valuesOf(selTrack);
		sliders.forEach((s, n) => s.set(values[n]));
	}

	function renderInspector() {
		shownTrack = selTrack; shownKey = selKey;
		const track = trackById(selTrack);
		const values = valuesOf(selTrack);
		const keys = keysOf(selTrack);
		const turn = (id) => id === 'yaw' || id === 'pitch' || id === 'roll';
		sliders = track.channels.map((c, n) => slider(c.label, {
			min: c.min, max: c.max, step: c.step, value: values[n],
			format: (v) => (c.id === 'fov' ? `${v.toFixed(1)}°` : turn(c.id) ? `${(v * 57.2958).toFixed(0)}°` : `${v.toFixed(2)} m`),
			oninput: (v) => { const now = valuesOf(selTrack); now[n] = v; edit(selTrack, now, false); },
			onchange: () => commit(),
		}));
		trackSection.replaceChildren(
			el('h2', { text: track.kind === 'handle' ? `${track.label} · string handle` : track.label }),
			...sliders.map((s) => s.row),
			el('div.row', { style: 'margin-top:10px' },
				el('button.btn', { type: 'button', text: '◆ Key here', title: 'Set a key at the playhead (K)', onclick: () => keyHere() }),
				track.kind !== 'camera' && el('button.btn', { type: 'button', text: 'Back to rest', title: 'Set every value of this track to rest at the playhead', onclick: () => edit(selTrack, track.rest.slice()) }),
				track.kind === 'camera' && !shotView && el('button.btn', { type: 'button', text: 'Use workspace view', title: 'Put the camera where you are looking from now', onclick: () => edit('camera', [...orbit.position.toArray(), ...orbit.target.toArray(), shot[6]]) }),
				keys.length > 0 && el('button.btn.btn--danger', { type: 'button', text: 'Clear track', onclick: () => { delete anim.tracks[selTrack]; selKey = null; stale(); commit(); } })),
			el('p.note', { text: `${keys.length} key${keys.length === 1 ? '' : 's'} on this track.${track.paths.length ? ' It travels on a Bezier curve through them.' : ' It moves straight from key to key, eased.'}${!autoKey && held.has(selTrack) ? ' Not keyed yet — press K to keep this.' : ''}` }));

		if (!selKey) {
			keySection.replaceChildren(el('h2', { text: 'Key' }), el('p.empty', { text: 'No key selected. Click a diamond on the timeline, or double-click a track to set one.' }));
			return;
		}
		const key = selKey;
		const last = keys.indexOf(key) === keys.length - 1;
		const presets = el('div.ease__presets');
		const valueEl = el('div.ease__value');
		const graph = el('canvas', { width: 264, height: 264, 'aria-label': 'Timing curve: drag the two round handles' });
		const drawEase = () => {
			paintEase(graph, key.ease);
			const name = easeName(key.ease);
			valueEl.textContent = `cubic-bezier(${key.ease.map((v) => +v.toFixed(2)).join(', ')})`;
			[...presets.children].forEach((b) => b.setAttribute('aria-pressed', b.dataset.ease === name));
		};
		for (const [id, preset] of Object.entries(EASES)) presets.append(el('button.btn', { type: 'button', text: preset.label, 'data-ease': id, onclick: () => { key.ease = [...preset.curve]; drawEase(); commit(); } }));
		dragEase(graph, key, drawEase, commit);
		keySection.replaceChildren(
			el('h2', { text: 'Key' }),
			el('label.field.field--wide', {}, el('span', { text: 'Time (s)' }), el('input', {
				type: 'number', min: 0, max: anim.duration, step: +(1 / anim.fps).toFixed(4), value: +key.t.toFixed(3),
				onchange: (e) => { moveKey(anim, selTrack, key, +e.target.value || 0); setTime(key.t, true); stale(); commit(); },
			})),
			last
				? el('p.note', { text: 'This is the track’s last key: its timing curve is used once another key follows it.' })
				: el('p', { style: 'margin:10px 0 6px', text: 'Easing from this key to the next' }),
			el('div.ease', {}, graph, el('div', {}, presets, valueEl)),
			track.paths.length > 0 && slider('Path roundness', {
				min: 0, max: 2, step: 0.05, value: key.curve ?? 1, format: (v) => (v === 0 ? 'corner' : v.toFixed(2)),
				oninput: (v) => { key.curve = v; pathStale = true; }, onchange: () => commit(),
			}).row,
			el('div.row', { style: 'margin-top:10px' }, el('button.btn.btn--danger', { type: 'button', text: 'Remove key', title: 'Delete', onclick: removeSelectedKey })));
		drawEase();
	}

	// --------------------------------------------------------- top bar, keys
	const nameInput = $('name'), durationInput = $('duration');
	function syncHeader() { nameInput.value = anim.name; durationInput.value = anim.duration; }
	nameInput.addEventListener('change', () => { anim.name = nameInput.value.trim().slice(0, 60) || 'Untitled'; nameInput.value = anim.name; commit(); });
	durationInput.addEventListener('change', () => { setDuration(anim, +durationInput.value); time = Math.min(time, anim.duration); selKey = null; syncHeader(); stale(); commit(); });
	$('btn-play').addEventListener('click', () => setPlaying(!playing));
	$('btn-start').addEventListener('click', toStart);
	$('btn-loop').addEventListener('click', (e) => { loop = !loop; e.currentTarget.setAttribute('aria-pressed', loop); });
	$('btn-auto').addEventListener('click', (e) => { autoKey = !autoKey; e.currentTarget.setAttribute('aria-pressed', autoKey); toast(autoKey ? 'Auto-key on: every change sets a key at the playhead' : 'Auto-key off: changes are held until you press K, and let go when the playhead moves'); });
	$('btn-key').addEventListener('click', () => keyHere());
	$('btn-reset').addEventListener('click', () => { world.reset(); toast('Puppet reset'); });
	$('view-free').addEventListener('click', () => setShotView(false));
	$('view-shot').addEventListener('click', () => setShotView(true));
	$('btn-undo').addEventListener('click', () => { if (undo.length) restore(undo.pop(), redo); });
	$('btn-redo').addEventListener('click', () => { if (redo.length) restore(redo.pop(), undo); });
	$('btn-new').addEventListener('click', () => replaceAnimation(newAnimation(), 'A new, empty animation. Undo brings the last one back.'));
	$('btn-demo').addEventListener('click', () => replaceAnimation(demoAnimation(), 'The example: a bow, a wave, a kick, and a camera that comes round to watch'));
	$('btn-export').addEventListener('click', () => downloadJson(anim.name, anim));
	$('btn-import').addEventListener('click', () => openJson((data) => {
		const next = sanitizeAnimation(data);
		if (!keyCount(next)) { toast('That file holds no keys this Studio can use'); return; }
		replaceAnimation(next, `Loaded “${next.name}”`);
	}));

	window.addEventListener('keydown', (e) => {
		if (typing(e)) return;
		const mod = e.metaKey || e.ctrlKey;
		if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? $('btn-redo') : $('btn-undo')).click(); return; }
		if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); $('btn-redo').click(); return; }
		if (mod || e.altKey) return;
		const frame = 1 / anim.fps;
		const order = TRACKS.map((t) => t.id);
		switch (e.key) {
			case ' ': e.preventDefault(); setPlaying(!playing); break;
			case 'k': case 'K': keyHere(); break;
			case 'Delete': case 'Backspace': removeSelectedKey(); break;
			case ',': setPlaying(false); setTime(snapTime(anim, time - frame)); break;
			case '.': setPlaying(false); setTime(snapTime(anim, time + frame)); break;
			case 'Home': e.preventDefault(); toStart(); break;
			case 'End': e.preventDefault(); setPlaying(false); setTime(anim.duration); break;
			case '1': setShotView(false); break;
			case '2': setShotView(true); break;
			case 'r': world.reset(); break;
			case 'ArrowUp': e.preventDefault(); selectTrack(order[Math.max(0, order.indexOf(selTrack) - 1)]); break;
			case 'ArrowDown': e.preventDefault(); selectTrack(order[Math.min(order.length - 1, order.indexOf(selTrack) + 1)]); break;
			case 'ArrowLeft': case 'ArrowRight': {
				// To the key before or after the playhead on the selected track.
				e.preventDefault();
				const keys = keysOf(selTrack);
				const i = keyBefore(keys, time + (e.key === 'ArrowRight' ? 1e-6 : -1e-6));
				const key = e.key === 'ArrowRight' ? keys[i + 1] : keys[i];
				if (key) { setPlaying(false); selectTrack(selTrack, key); setTime(key.t); }
				break;
			}
			default: break;
		}
	});

	syncHeader();
	save();
	shotView = true; setShotView(false);   // writes the hint and the buttons for the workspace view
	// Handy for the browser console and automated checks.
	window.motionPuppet = {
		...world, world, orbit,
		studio: {
			get anim() { return anim; }, get time() { return time; }, get playing() { return playing; }, get selected() { return { track: selTrack, key: selKey }; }, get shot() { return shot.slice(); },
			setTime, setPlaying, edit, keyHere, selectTrack, setShotView, valuesOf, toStart, set autoKey(v) { autoKey = !!v; $('btn-auto').setAttribute('aria-pressed', autoKey); },
		},
	};
	world.start();
	veil.open();
}

// ------------------------------------------------------------ easing graph
// The graph shows progress (up) against time (across), from -0.5 to 1.5 so an overshoot fits.
const LO = -0.5, HI = 1.5;

function paintEase(canvas, ease) {
	const g = canvas.getContext('2d');
	const W = canvas.width, H = canvas.height, m = 22;
	const X = (x) => m + x * (W - m * 2), Y = (y) => H - m - ((y - LO) / (HI - LO)) * (H - m * 2);
	g.clearRect(0, 0, W, H);
	g.lineWidth = 1;
	g.strokeStyle = 'rgba(226,180,87,0.22)';
	g.strokeRect(X(0), Y(1), X(1) - X(0), Y(0) - Y(1));
	g.setLineDash([4, 5]);
	g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(1), Y(1)); g.stroke();
	g.setLineDash([]);
	g.strokeStyle = 'rgba(244,233,210,0.5)';
	g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(ease[0]), Y(ease[1])); g.moveTo(X(1), Y(1)); g.lineTo(X(ease[2]), Y(ease[3])); g.stroke();
	g.strokeStyle = '#e2b457'; g.lineWidth = 3.5;
	g.beginPath();
	for (let i = 0; i <= 60; i++) { const u = i / 60; g[i ? 'lineTo' : 'moveTo'](X(u), Y(easeAt(ease, u))); }
	g.stroke();
	for (const [x, y] of [[ease[0], ease[1]], [ease[2], ease[3]]]) {
		g.fillStyle = '#f4e9d2'; g.strokeStyle = '#2a1708'; g.lineWidth = 2;
		g.beginPath(); g.arc(X(x), Y(y), 8, 0, Math.PI * 2); g.fill(); g.stroke();
	}
}

/** Lets the two control points of a key's timing curve be dragged on its graph. */
function dragEase(canvas, key, redraw, done) {
	const m = 22;
	const read = (e) => {
		const r = canvas.getBoundingClientRect(), k = canvas.width / r.width;
		const x = ((e.clientX - r.left) * k - m) / (canvas.width - m * 2);
		const y = LO + ((canvas.height - m - (e.clientY - r.top) * k) / (canvas.height - m * 2)) * (HI - LO);
		return [Math.max(0, Math.min(1, x)), Math.max(LO, Math.min(HI, y))];
	};
	let which = -1;
	canvas.addEventListener('pointerdown', (e) => {
		const [x, y] = read(e);
		which = Math.hypot(x - key.ease[0], (y - key.ease[1]) / 2) <= Math.hypot(x - key.ease[2], (y - key.ease[3]) / 2) ? 0 : 2;
		canvas.setPointerCapture(e.pointerId);
		key.ease[which] = +x.toFixed(3); key.ease[which + 1] = +y.toFixed(3);
		redraw();
	});
	canvas.addEventListener('pointermove', (e) => {
		if (which < 0) return;
		const [x, y] = read(e);
		key.ease[which] = +x.toFixed(3); key.ease[which + 1] = +y.toFixed(3);
		redraw();
	});
	const end = () => { if (which >= 0) { which = -1; done(); } };
	canvas.addEventListener('pointerup', end);
	canvas.addEventListener('pointercancel', end);
}

boot().catch((err) => { console.error(err); veil.fail(bootError(err)); });
