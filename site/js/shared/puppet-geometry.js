// The wooden puppet's look, shared by the stage and the phone's top-down view.
// One mesh group per rigid body, in rig-config order; each group's origin is the
// body's centre, so the renderer only has to copy the simulated transforms in.

import * as THREE from 'three';
import { BODIES, JOINTS } from './rig-config.js';

function grainTexture(size, seed = 1) {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const g = canvas.getContext('2d');
	let s = seed * 9301 + 49297;
	const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
	g.fillStyle = '#b9895a';
	g.fillRect(0, 0, size, size);
	// Long grain streaks running along V.
	for (let i = 0; i < size * 1.6; i++) {
		const x = rnd() * size;
		const w = 0.5 + rnd() * 2.2;
		const light = rnd() > 0.5;
		g.strokeStyle = light ? `rgba(240,205,150,${0.05 + rnd() * 0.12})` : `rgba(70,38,14,${0.05 + rnd() * 0.16})`;
		g.lineWidth = w;
		g.beginPath();
		let px = x;
		g.moveTo(px, 0);
		for (let y = 0; y <= size; y += size / 8) {
			px += (rnd() - 0.5) * 5;
			g.lineTo(px, y);
		}
		g.stroke();
	}
	// A few knots.
	for (let i = 0; i < 3; i++) {
		const x = rnd() * size, y = rnd() * size, r = 4 + rnd() * 9;
		for (let k = 5; k > 0; k--) {
			g.strokeStyle = `rgba(60,30,10,${0.06 * k})`;
			g.lineWidth = 1;
			g.beginPath();
			g.ellipse(x, y, r * k * 0.35, r * k * 0.6, 0, 0, Math.PI * 2);
			g.stroke();
		}
	}
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.anisotropy = 4;
	return tex;
}

export function makeMaterials(detail = 'high') {
	const hi = detail === 'high';
	const grain = grainTexture(hi ? 512 : 128);
	const wood = (color, roughness = 0.52) => {
		const mat = new THREE.MeshStandardMaterial({ color, map: grain, roughness, metalness: 0 });
		if (hi) { mat.bumpMap = grain; mat.bumpScale = 0.6; }
		return mat;
	};
	return {
		grain,
		beech: wood(0xf0c592),
		oak: wood(0xd9a368),
		walnut: wood(0x8a5632, 0.6),
		dark: wood(0x4a2c18, 0.62),
		brass: new THREE.MeshStandardMaterial({ color: 0xc9a14a, roughness: 0.32, metalness: 0.95 }),
		iron: new THREE.MeshStandardMaterial({ color: 0x3a3632, roughness: 0.5, metalness: 0.8 }),
		paintRed: new THREE.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.38 }),
		paintTeal: new THREE.MeshStandardMaterial({ color: 0x1f6f6b, roughness: 0.45 }),
		paintCream: new THREE.MeshStandardMaterial({ color: 0xf3ead8, roughness: 0.4 }),
		paintBlack: new THREE.MeshStandardMaterial({ color: 0x14100e, roughness: 0.3 }),
		blush: new THREE.MeshStandardMaterial({ color: 0xe58f7c, roughness: 0.6 }),
		felt: new THREE.MeshStandardMaterial({ color: 0x1d2a38, roughness: 0.95 }),
	};
}

/** A lathe-turned piece: profile is [[radius, y], ...] from bottom to top. */
function turned(profile, segments, mat, sx = 1, sz = 1) {
	const geo = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0005, r), y)), segments);
	const mesh = new THREE.Mesh(geo, mat);
	mesh.scale.set(sx, 1, sz);
	return mesh;
}

/** A turned limb segment with rounded ends, a belly and a decorative groove. */
function limbProfile(half, rTop, rBottom, belly, groove = true) {
	const pts = [[0, -half]];
	const steps = 14;
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;                       // 0 bottom … 1 top
		const y = -half + t * 2 * half;
		let r = rBottom + (rTop - rBottom) * t + belly * Math.sin(Math.PI * t) ** 0.9;
		const cap = Math.min(t, 1 - t) * 9;        // round the ends
		if (cap < 1) r *= Math.sqrt(1 - (1 - cap) ** 2) * 0.6 + 0.4;
		if (groove && Math.abs(t - 0.14) < 0.03) r *= 0.9;
		pts.push([r, y]);
	}
	pts.push([0, half]);
	return pts;
}

const sphere = (r, mat, seg = 16) => new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, Math.round(seg * 0.7))), mat);
const at = (mesh, x, y, z) => { mesh.position.set(x, y, z); return mesh; };

/**
 * Builds the puppet. Returns { root, parts } where parts[i] is the group for
 * rig body i. `detail`: 'high' for the stage, 'low' for phones.
 */
export function buildPuppet(detail = 'high', materials = makeMaterials(detail)) {
	const m = materials;
	const hi = detail === 'high';
	const seg = hi ? 28 : 14;
	const root = new THREE.Group();
	const parts = BODIES.map((def) => {
		const group = new THREE.Group();
		group.name = def.id;
		root.add(group);
		return group;
	});
	const part = (id) => parts[BODIES.findIndex((b) => b.id === id)];
	const add = (id, ...meshes) => { for (const mesh of meshes) part(id).add(mesh); };

	// --- torso -------------------------------------------------------------
	add('pelvis',
		turned([[0, -0.075], [0.07, -0.07], [0.118, -0.03], [0.125, 0.02], [0.105, 0.06], [0.06, 0.075], [0, 0.078]], seg, m.oak, 1.22, 0.74),
		at(sphere(0.052, m.walnut, seg), 0, 0.07, 0));
	add('abdomen',
		turned([[0, -0.07], [0.06, -0.066], [0.098, -0.03], [0.108, 0.01], [0.1, 0.05], [0.06, 0.07], [0, 0.072]], seg, m.beech, 1.16, 0.76));
	const chest = turned([[0, -0.118], [0.07, -0.112], [0.11, -0.08], [0.134, -0.02], [0.142, 0.04], [0.128, 0.09], [0.08, 0.114], [0, 0.118]], seg, m.paintTeal, 1.2, 0.68);
	add('chest', chest,
		at(sphere(0.05, m.walnut, seg), 0, -0.118, 0),
		at(sphere(0.04, m.walnut, seg), 0, 0.118, 0));
	// Waistcoat buttons and a bow tie.
	for (let i = 0; i < 3; i++) add('chest', at(sphere(0.011, m.brass, 10), 0, 0.04 - i * 0.045, 0.094 - Math.abs(i - 1) * 0.004 + (i === 2 ? -0.006 : 0)));
	const bowL = at(sphere(0.03, m.paintRed, 12), 0.03, 0.098, 0.074); bowL.scale.set(1, 0.7, 0.45);
	const bowR = at(sphere(0.03, m.paintRed, 12), -0.03, 0.098, 0.074); bowR.scale.set(1, 0.7, 0.45);
	add('chest', bowL, bowR, at(sphere(0.012, m.paintRed, 10), 0, 0.098, 0.08));

	add('neck', turned([[0, -0.05], [0.03, -0.048], [0.036, -0.02], [0.03, 0.02], [0.034, 0.045], [0, 0.05]], seg, m.walnut));

	// --- head --------------------------------------------------------------
	const skull = sphere(0.115, m.beech, hi ? 36 : 18);
	skull.scale.set(0.96, 1.06, 0.98);
	const jaw = at(sphere(0.085, m.beech, seg), 0, -0.055, 0.012); jaw.scale.set(0.95, 0.8, 0.95);
	add('head', skull, jaw);
	for (const sx of [1, -1]) {
		const white = at(sphere(0.026, m.paintCream, 14), sx * 0.042, 0.018, 0.098); white.scale.set(1, 1.15, 0.45);
		const pupil = at(sphere(0.012, m.paintBlack, 12), sx * 0.04, 0.014, 0.111); pupil.scale.set(1, 1.1, 0.45);
		const glint = at(sphere(0.004, m.paintCream, 8), sx * 0.04 + 0.004, 0.02, 0.117);
		const brow = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.008, 0.01), m.dark);
		brow.position.set(sx * 0.044, 0.058, 0.098); brow.rotation.set(-0.3, sx * -0.35, sx * 0.22);
		const cheek = at(sphere(0.02, m.blush, 10), sx * 0.066, -0.034, 0.083); cheek.scale.set(1, 0.8, 0.35);
		const ear = at(sphere(0.022, m.oak, 10), sx * 0.108, 0.0, 0.0); ear.scale.set(0.45, 1, 0.8);
		add('head', white, pupil, glint, brow, cheek, ear);
	}
	add('head', at(sphere(0.021, m.paintRed, 14), 0, -0.014, 0.118));
	const smile = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.0042, 8, 20, Math.PI * 0.72), m.paintRed);
	smile.position.set(0, -0.04, 0.099); smile.rotation.set(-0.18, 0, Math.PI + (Math.PI - Math.PI * 0.72) / 2);
	add('head', smile);
	// A small felt hat, worn at a jaunty angle.
	const hat = new THREE.Group();
	hat.add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.008, seg), m.felt));
	hat.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.066, 0.075, seg), m.felt), 0, 0.04, 0));
	hat.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.068, 0.016, seg), m.paintRed), 0, 0.012, 0));
	hat.position.set(0.012, 0.108, 0.006); hat.rotation.set(-0.12, 0, -0.2);
	add('head', hat);

	// --- arms --------------------------------------------------------------
	for (const [side, sx] of [['L', 1], ['R', -1]]) {
		const clav = new THREE.Mesh(new THREE.CapsuleGeometry(0.026, 0.12, 4, 12), m.walnut);
		clav.rotation.z = Math.PI / 2;
		add(`clavicle${side}`, clav, at(sphere(0.046, m.walnut, seg), sx * 0.095, 0, 0));
		add(`upperArm${side}`,
			turned(limbProfile(0.135, 0.036, 0.03, 0.01), seg, m.beech),
			at(new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.08, 16), m.walnut), 0, -0.14, 0).rotateZ(Math.PI / 2),
			at(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.094, 8), m.brass), 0, -0.14, 0).rotateZ(Math.PI / 2));
		add(`forearm${side}`,
			turned(limbProfile(0.115, 0.03, 0.024, 0.008), seg, m.oak),
			at(sphere(0.026, m.walnut, 14), 0, -0.12, 0));
		const palm = sphere(0.04, m.beech, 14); palm.scale.set(0.5, 1.25, 0.95); palm.position.y = -0.005;
		const thumb = at(sphere(0.016, m.beech, 10), sx * -0.004, 0.004, 0.036); thumb.scale.set(0.6, 1.4, 0.8);
		const cuff = at(new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.03, 0.022, 14), m.paintCream), 0, 0.05, 0);
		add(`hand${side}`, palm, thumb, cuff);
	}

	// --- legs --------------------------------------------------------------
	for (const [side] of [['L'], ['R']]) {
		add(`thigh${side}`,
			at(sphere(0.062, m.walnut, seg), 0, 0.192, 0),
			turned(limbProfile(0.185, 0.058, 0.044, 0.012), seg, m.oak),
			at(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.1, 16), m.walnut), 0, -0.195, 0).rotateZ(Math.PI / 2),
			at(new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.116, 8), m.brass), 0, -0.195, 0).rotateZ(Math.PI / 2));
		add(`shin${side}`,
			turned(limbProfile(0.175, 0.042, 0.03, 0.012), seg, m.beech),
			at(sphere(0.034, m.walnut, 14), 0, -0.185, 0));
		const shoe = new THREE.Group();
		const sole = at(new THREE.Mesh(new THREE.BoxGeometry(0.098, 0.016, 0.232), m.dark), 0, -0.027, 0);
		const upper = at(sphere(0.05, m.paintRed, 16), 0, -0.004, 0.02); upper.scale.set(0.98, 0.62, 2.05);
		const toe = at(sphere(0.047, m.paintRed, 14), 0, 0.0, 0.082); toe.scale.set(1, 0.8, 1);
		const buckle = at(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.012, 0.028), m.brass), 0, 0.028, 0.03);
		shoe.add(sole, upper, toe, buckle);
		add(`foot${side}`, shoe);
	}

	root.traverse((o) => {
		if (o.isMesh) { o.castShadow = hi; o.receiveShadow = hi; }
	});
	return { root, parts, materials: m };
}

/** Copies simulated transforms (flat position / quaternion arrays) onto the part groups. */
export function posePuppet(parts, pos, quat) {
	for (let i = 0; i < parts.length; i++) {
		parts[i].position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
		parts[i].quaternion.set(quat[i * 4], quat[i * 4 + 1], quat[i * 4 + 2], quat[i * 4 + 3]);
	}
}

/** World position of a joint, derived from its parent body's transform. */
export function jointWorld(jointIndex, pos, quat, out = new THREE.Vector3()) {
	const j = JOINTS[jointIndex];
	const a = BODIES.findIndex((b) => b.id === j.a);
	const def = BODIES[a];
	_q.set(quat[a * 4], quat[a * 4 + 1], quat[a * 4 + 2], quat[a * 4 + 3]);
	out.set(j.anchor[0] - def.pos[0], j.anchor[1] - def.pos[1], j.anchor[2] - def.pos[2]).applyQuaternion(_q);
	return out.set(out.x + pos[a * 3], out.y + pos[a * 3 + 1], out.z + pos[a * 3 + 2]);
}
const _q = new THREE.Quaternion();
