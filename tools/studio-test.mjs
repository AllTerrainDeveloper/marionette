// The Studio's keyframe engine, and an animation played on the real puppet: node tools/studio-test.mjs
import RAPIER from '../site/vendor/rapier.mjs';
import { PuppetSim } from '../site/js/stage/sim.js';
import { Controller } from '../site/js/stage/control.js';
import { RIG } from '../site/js/shared/rig-config.js';
import * as M from '../site/js/shared/math.js';
import {
	TRACKS, EASES, CAMERA_REST, trackById, easeAt, easeName, cleanEase, sampleTrack, sampleCamera, pathControls, driveTargets,
	newAnimation, setKey, removeKey, moveKey, setDuration, sanitizeAnimation, keyCount, demoAnimation, snapTime,
} from '../site/js/shared/timeline.js';

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// 1. Timing curves.
{
	check('every ease starts at 0 and ends at 1', Object.values(EASES).every((e) => easeAt(e.curve, 0) === 0 && easeAt(e.curve, 1) === 1));
	check('linear is linear', [0.1, 0.37, 0.9].every((u) => near(easeAt(EASES.linear.curve, u), u)));
	check('ease in-out is slow, fast, slow and symmetric', easeAt(EASES.inOut.curve, 0.1) < 0.05 && near(easeAt(EASES.inOut.curve, 0.5), 0.5, 1e-4) && near(easeAt(EASES.inOut.curve, 0.25) + easeAt(EASES.inOut.curve, 0.75), 1, 1e-4));
	check('ease in lags, ease out leads', easeAt(EASES.in.curve, 0.5) < 0.4 && easeAt(EASES.out.curve, 0.5) > 0.6);
	// The CSS reference value: cubic-bezier(0.25, 0.1, 0.25, 1) at 0.5 is 0.8024.
	check('matches the CSS cubic-bezier', near(easeAt([0.25, 0.1, 0.25, 1], 0.5), 0.8024, 2e-4), easeAt([0.25, 0.1, 0.25, 1], 0.5).toFixed(4));
	let monotone = true, peak = 0;
	for (let i = 1; i <= 200; i++) { if (easeAt(EASES.inOut.curve, i / 200) < easeAt(EASES.inOut.curve, (i - 1) / 200)) monotone = false; peak = Math.max(peak, easeAt(EASES.back.curve, i / 200)); }
	check('never runs backwards', monotone);
	check('overshoot goes past the target and comes back', peak > 1.05 && peak < 1.2, `peak ${peak.toFixed(3)}`);
	check('a steep curve still solves', [0.01, 0.5, 0.99].every((u) => Number.isFinite(easeAt([1, 0, 0, 1], u)) && easeAt([1, 0, 0, 1], u) >= -1e-6 && easeAt([1, 0, 0, 1], u) <= 1 + 1e-6));
	check('ease names', easeName(EASES.back.curve) === 'back' && easeName([0.1, 0.2, 0.3, 0.4]) === null);
	check('a broken ease becomes the default', cleanEase('fast').join() === EASES.inOut.curve.join() && cleanEase([5, 9, -3, 0])[0] === 1 && cleanEase([5, 9, -3, 0])[2] === 0);
}

// 2. Keys and sampling.
{
	const anim = newAnimation('Test');
	const hand = trackById('handle.wristL');
	check('an empty track samples to nothing', sampleTrack(hand, anim.tracks[hand.id], 1) === null);
	setKey(anim, hand.id, 2, [0, 0, 0], EASES.linear.curve);
	setKey(anim, hand.id, 4, [0.2, 0.4, -0.2], EASES.linear.curve);
	setKey(anim, hand.id, 1, [0.1, 0, 0], EASES.linear.curve);
	const keys = anim.tracks[hand.id];
	check('keys stay in time order', keys.map((k) => k.t).join() === '1,2,4');
	check('holds the first key before it and the last after it', sampleTrack(hand, keys, 0)[0] === 0.1 && sampleTrack(hand, keys, 99)[1] === 0.4);
	check('a handle moves in a straight line between keys', near(sampleTrack(hand, keys, 3)[0], 0.1) && near(sampleTrack(hand, keys, 3)[1], 0.2) && near(sampleTrack(hand, keys, 3)[2], -0.1));
	keys[1].ease = EASES.in.curve;
	check('... at the pace its ease sets', sampleTrack(hand, keys, 3)[1] < 0.14, sampleTrack(hand, keys, 3)[1].toFixed(3));
	setKey(anim, hand.id, 2.01, [0.3, 0.3, 0.3]);
	check('a key on the same frame replaces, and keeps its ease', keys.length === 3 && keys[1].v[0] === 0.3 && keys[1].ease.join() === EASES.in.curve.join());
	check('values are kept inside what the rig allows', setKey(anim, hand.id, 6, [9, -9, 0]).v.join() === '0.7,-0.5,0');
	check('times land on frames', near(snapTime(anim, 1.234), 37 / 30) && snapTime(anim, 99) === anim.duration && snapTime(anim, -1) === 0);
	moveKey(anim, hand.id, keys[0], 5);
	check('a moved key is re-sorted', keys.map((k) => +k.t.toFixed(2)).join() === '2,4,5,6');
	moveKey(anim, hand.id, keys[2], 6);
	check('... and cannot land on another key', keys.length === 4 && new Set(keys.map((k) => k.t.toFixed(3))).size === 4 && near(keys[2].t, 6 - 1 / 30, 1e-9));
	removeKey(anim, hand.id, keys[0]);
	check('keys can be removed', anim.tracks[hand.id].length === 3 && keyCount(anim) === 3);
	setDuration(anim, 4.5);
	check('shortening the animation brings late keys back to its end', anim.tracks[hand.id].every((k) => k.t <= 4.5) && anim.tracks[hand.id].length === 2, anim.tracks[hand.id].map((k) => k.t).join());
	for (const k of [...anim.tracks[hand.id]]) removeKey(anim, hand.id, k);
	check('a track with no keys is gone', !(hand.id in anim.tracks));
}

// 3. What travels through space travels on a Bezier curve through its keys.
{
	const anim = newAnimation();
	const cam = TRACKS[0];
	check('with nothing keyed the camera is the stage view', sampleCamera(anim, 3).join() === CAMERA_REST.join());
	const P = [[0, 1.5, 6], [-2, 1.2, 4], [0, 2, 2], [2, 1.4, 4]];
	P.forEach((p, i) => setKey(anim, 'camera', i * 2, [...p, 0, 1.3, 0, 31], EASES.linear.curve));
	const keys = anim.tracks.camera;
	const at = (t) => sampleTrack(cam, keys, t, []);
	check('the path passes through every key', P.every((p, i) => M.dist(at(i * 2), p) < 1e-9));
	const mid = at(3), chord = M.lerp3(P[1], P[2], 0.5);
	check('... and bows out between them rather than cutting straight across', M.dist(mid, chord) > 0.05, `${M.dist(mid, chord).toFixed(3)} m off the chord`);
	// No corner at a key: the direction just before it and just after it agree.
	const h = 1e-4;
	const dir = (t0, t1) => M.norm(M.sub(at(t1), at(t0)));
	const turn = (t) => Math.acos(Math.min(1, M.dot(dir(t - h, t), dir(t, t + h))));
	check('no corner where two stretches meet', turn(2) < 0.01 && turn(4) < 0.01, `${(turn(2) * 57.3).toFixed(2)}° and ${(turn(4) * 57.3).toFixed(2)}°`);
	const c = pathControls(keys, 1, [0, 1, 2]);
	check('the control points are those of a cubic Bezier', M.dist(c[0], P[1]) < 1e-9 && M.dist(c[3], P[2]) < 1e-9 && M.dist(M.sub(c[1], c[0]), M.scale(M.sub(P[2], P[0]), 1 / 6)) < 1e-9);
	const b = (t) => { const f = 1 - t; return [0, 1, 2].map((n) => f * f * f * c[0][n] + 3 * f * f * t * c[1][n] + 3 * f * t * t * c[2][n] + t * t * t * c[3][n]); };
	check('... and sampling follows that curve', M.dist(at(2.6), b(0.3)) < 1e-9);
	keys[1].curve = 0; keys[2].curve = 0;
	check('curve 0 makes a corner: a straight stretch', M.dist(at(3), chord) < 1e-9);
	keys[1].curve = 1; keys[2].curve = 1;
	keys[1].ease = EASES.inOut.curve;
	check('easing changes the pace along the path, not the path', M.dist(at(2.4), b(easeAt(EASES.inOut.curve, 0.2))) < 1e-9 && M.dist(at(2.4), b(0.2)) > 0.01);
	check('the lens is eased, not curved', near(at(1)[6], 31) && at(3)[3] === 0);
	check('bars travel on curves too; handles do not', trackById('main').paths.length === 1 && trackById('limb').paths.length === 1 && TRACKS.filter((t) => t.kind === 'handle').every((t) => t.paths.length === 0));
	const wide = newAnimation();
	setKey(wide, 'main', 0, [-1.6, 0, 0, 0, 0, 0]); setKey(wide, 'main', 1, [1.6, 0.9, 0, 0, 0, 0]); setKey(wide, 'main', 2, [1.6, -0.7, 0, 0, 0, 0]);
	let inside = true;
	for (let t = 0; t <= 2; t += 0.01) { const v = sampleTrack(trackById('main'), wide.tracks.main, t, []); if (v[0] > 1.6 + 1e-9 || v[1] > 0.9 + 1e-9 || v[1] < -0.7 - 1e-9) inside = false; }
	check('a path that swings wide is held inside the stage', inside);
}

// 4. Files.
{
	const demo = demoAnimation();
	const back = sanitizeAnimation(JSON.parse(JSON.stringify(demo)));
	check('an animation round trips through JSON', JSON.stringify(back) === JSON.stringify(demo), `${keyCount(demo)} keys`);
	check('the demo keys camera, bar and handles', ['camera', 'main', 'handle.wristL', 'handle.kneeR'].every((id) => demo.tracks[id].length >= 2));
	const bad = sanitizeAnimation({ name: 7, duration: 'long', fps: 1000, tracks: { camera: [{ t: 1, v: ['x'] }, { t: 'soon', v: [] }, null], nonsense: [{ t: 0, v: [1] }], 'handle.head': [{ t: 3, v: [5, 5, 5], ease: [9, 9, 9, 9], curve: 40 }, { t: 3, v: [0, 0, 0] }] } });
	check('rubbish is cleaned, not trusted', bad.name === '7' && bad.duration === 8 && bad.fps === 60 && !('nonsense' in bad.tracks) && bad.tracks.camera.length === 1 && bad.tracks.camera[0].v.join() === CAMERA_REST.join(), JSON.stringify(bad.tracks['handle.head']));
	check('... two keys on one frame become one', bad.tracks['handle.head'].length === 1);
	check('nothing at all is an empty animation', keyCount(sanitizeAnimation(null)) === 0 && sanitizeAnimation('x').duration === 8);
	check('every puppet channel names a control target', TRACKS.filter((t) => t.kind !== 'camera').every((t) => t.channels.every((c) => /^(main|limb|handle\.\w+)\.(x|y|z|yaw|pitch|roll)$/.test(c.key))));
	check('one track per bar and per handle, plus the camera', TRACKS.length === 1 + RIG.bars.length + RIG.handles.length);
}

// 5. An animation played on the real puppet, through the control layer.
await RAPIER.init();
{
	const sim = new PuppetSim(RAPIER);
	const ctl = new Controller(sim);
	const anim = newAnimation();
	setKey(anim, 'handle.wristL', 1, [0, 0, 0]);
	setKey(anim, 'handle.wristL', 2, [0, 0.5, 0.1]);
	setKey(anim, 'main', 3, [0, 0, 0, 0, 0, 0]);
	setKey(anim, 'main', 4.5, [0.6, 0, 0, 0, 0, 0.3]);
	let time = 0;
	const held = new Map();
	ctl.director = (add) => driveTargets(anim, time, add, held);
	const play = (to) => { while (time < to) { ctl.update(); sim.step(); time += sim.dt; } };
	const hand = () => sim.bodyPos(sim.bodyIx.handL), wrist = () => sim.handleAt(sim.handleIx.wristL);
	play(1);
	const handBefore = hand(), wristBefore = wrist();
	play(3);
	check('a keyed handle goes where its keys say', near(wrist()[1] - wristBefore[1], 0.5, 0.01) && near(wrist()[2] - wristBefore[2], 0.1, 0.01), `rose ${(wrist()[1] - wristBefore[1]).toFixed(3)} m`);
	check('... and the string lifts the hand', hand()[1] - handBefore[1] > 0.2, `hand rose ${(hand()[1] - handBefore[1]).toFixed(3)} m`);
	play(6);
	check('a keyed bar carries the puppet across the stage', near(sim.bars[0].pos[0], 0.6, 0.01) && sim.bodyPos(sim.bodyIx.pelvis)[0] > 0.45, `bar at ${sim.bars[0].pos[0].toFixed(3)}, pelvis at ${sim.bodyPos(sim.bodyIx.pelvis)[0].toFixed(3)}`);
	check('... tilted as keyed', near(M.qToYPR(sim.bars[0].quat)[2], 0.3, 0.02));
	held.set('handle.kneeR', [0, 0.3, 0]);
	const knee = sim.handleAt(sim.handleIx.kneeR)[1];
	play(7);
	check('a held value overrides the keys', near(sim.handleAt(sim.handleIx.kneeR)[1] - knee, 0.3 * Math.cos(0.3), 0.02));
	check('the puppet came through it whole', sim.resets === 1 && sim.jointGap() < 0.01);

	// The demo, start to finish.
	const demo = demoAnimation();
	const sim2 = new PuppetSim(RAPIER), ctl2 = new Controller(sim2);
	let t2 = 0, fastest = 0, highest = 0;
	ctl2.director = (add) => driveTargets(demo, t2, add);
	const rest = sim2.bodyPos(sim2.bodyIx.handL)[1];
	while (t2 < demo.duration) { ctl2.update(); sim2.step(); t2 += sim2.dt; fastest = Math.max(fastest, sim2.maxSpeed()); highest = Math.max(highest, sim2.bodyPos(sim2.bodyIx.handL)[1] - rest); }
	check('the demo plays through', sim2.resets === 1 && fastest < 8 && highest > 0.25, `fastest part ${fastest.toFixed(1)} m/s, the waving hand rose ${highest.toFixed(2)} m`);
	const cam = sampleCamera(demo, 5);
	check('... with the camera on its way round', cam[0] > -1.7 && cam[0] < 1.5 && cam[2] < 5.8 && cam[2] > 3);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll studio checks passed');
process.exit(failures ? 1 : 0);
