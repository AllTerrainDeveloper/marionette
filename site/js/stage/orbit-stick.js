// A thumbstick for the stage's camera, like the one in a phone game: push it and the camera
// goes round the puppet (left / right) and over it (up / down) for as long as it is held; let
// go and the camera stays where it got to. Two small buttons move in and out, a third puts
// the view back. It sits faint in a corner and takes nothing from the picture.

const YAW = 0.85;             // how far round to either side, radians: as far as the side curtains let the puppet be seen
const PITCH = [-0.1, 0.45];  // from just under eye level to as high as the pelmet allows
const ZOOM = [0.55, 1.5];    // of the distance the theatre frames the puppet from
const RATE = [1.5, 1.0];     // radians a second at full push: round, over

function make(tag, props = {}, ...children) {
	const [name, ...classes] = tag.split('.');
	const node = document.createElement(name || 'div');
	if (classes.length) node.className = classes.join(' ');
	for (const [key, value] of Object.entries(props)) {
		if (key === 'text') node.textContent = value;
		else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, value);
	}
	node.append(...children);
	return node;
}

/**
 * Adds the stick to the page. Call `apply(dt)` each frame after the theatre has placed its
 * camera (it turns that placement about the point the camera looks at); `reset()` puts it back.
 */
export function createOrbitStick(stage, THREE) {
	const stick = [0, 0];
	const view = { yaw: 0, pitch: 0, zoom: 1 };
	const want = { yaw: 0, pitch: 0, zoom: 1 };
	const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

	const knob = make('i');
	const pad = make('div.orbit__pad', { role: 'slider', tabindex: '0', 'aria-label': 'Camera: push to go round the puppet, arrow keys work too', 'aria-valuetext': 'centred', title: 'Hold and push to move the camera round the puppet · double-click to put the view back' }, knob);
	const home = make('button.orbit__home', { type: 'button', text: '⟲', title: 'Put the view back (0)', 'aria-label': 'Put the view back', hidden: '' });
	const node = make('div.orbit', { 'aria-label': 'Camera', 'data-keeps-linkmenu': '' },
		pad,
		make('div.orbit__zoom', {},
			make('button', { type: 'button', text: '+', title: 'Closer', 'aria-label': 'Camera closer', onclick: () => { want.zoom = clamp(want.zoom / 1.18, ...ZOOM); } }),
			make('button', { type: 'button', text: '−', title: 'Further', 'aria-label': 'Camera further', onclick: () => { want.zoom = clamp(want.zoom * 1.18, ...ZOOM); } }),
			home));
	document.body.append(node);

	const moved = () => Math.abs(want.yaw) > 0.01 || Math.abs(want.pitch) > 0.01 || Math.abs(want.zoom - 1) > 0.01;
	function reset() { want.yaw = 0; want.pitch = 0; want.zoom = 1; }
	home.addEventListener('click', reset);
	pad.addEventListener('dblclick', reset);

	// The stick itself.
	let held = -1;
	function push(e) {
		const r = pad.getBoundingClientRect();
		const reach = r.width / 2 - knob.offsetWidth / 2 + 4;
		let x = (e.clientX - (r.left + r.width / 2)) / reach, y = (e.clientY - (r.top + r.height / 2)) / reach;
		const l = Math.hypot(x, y);
		if (l > 1) { x /= l; y /= l; }
		stick[0] = x; stick[1] = y;
		knob.style.transform = `translate(${(x * reach).toFixed(1)}px, ${(y * reach).toFixed(1)}px)`;
	}
	function release() {
		held = -1;
		stick[0] = stick[1] = 0;
		knob.style.transform = '';
		node.classList.remove('is-held');
	}
	pad.addEventListener('pointerdown', (e) => {
		held = e.pointerId;
		try { pad.setPointerCapture(held); } catch { /* a pointer that is already gone */ }
		node.classList.add('is-held');
		push(e);
		e.preventDefault();
	});
	pad.addEventListener('pointermove', (e) => { if (e.pointerId === held) push(e); });
	pad.addEventListener('pointerup', release);
	pad.addEventListener('pointercancel', release);
	pad.addEventListener('lostpointercapture', release);
	// With the stick focused, the arrow keys nudge the camera.
	pad.addEventListener('keydown', (e) => {
		const step = { ArrowLeft: [-0.12, 0], ArrowRight: [0.12, 0], ArrowUp: [0, 0.08], ArrowDown: [0, -0.08] }[e.key];
		if (e.key === '0' || e.key === 'Home') { reset(); e.preventDefault(); return; }
		if (!step) return;
		e.preventDefault(); e.stopPropagation();
		want.yaw = clamp(want.yaw + step[0], -YAW, YAW);
		want.pitch = clamp(want.pitch + step[1], ...PITCH);
	});

	const target = new THREE.Vector3(), arm = new THREE.Vector3();
	function apply(dt) {
		// Pushing right carries the camera round to the right; pushing up carries it up and over.
		want.yaw = clamp(want.yaw + stick[0] * RATE[0] * dt, -YAW, YAW);
		want.pitch = clamp(want.pitch - stick[1] * RATE[1] * dt, ...PITCH);
		const ease = Math.min(1, dt * 9);
		view.yaw += (want.yaw - view.yaw) * ease;
		view.pitch += (want.pitch - view.pitch) * ease;
		view.zoom += (want.zoom - view.zoom) * ease;
		home.hidden = !moved();
		if (Math.abs(view.yaw) < 1e-4 && Math.abs(view.pitch) < 1e-4 && Math.abs(view.zoom - 1) < 1e-4) return;

		const cam = stage.camera;
		target.set(stage.focus.x, stage.focus.y, 0);
		arm.copy(cam.position).sub(target);
		const length = arm.length();
		const yaw = Math.atan2(arm.x, arm.z) + view.yaw;
		const pitch = clamp(Math.asin(arm.y / length) + view.pitch, -0.2, 1.35);
		const r = length * view.zoom;
		cam.position.set(target.x + r * Math.sin(yaw) * Math.cos(pitch), Math.max(0.25, target.y + r * Math.sin(pitch)), target.z + r * Math.cos(yaw) * Math.cos(pitch));
		cam.lookAt(target);
	}

	return { node, apply, reset, view: want };
}
