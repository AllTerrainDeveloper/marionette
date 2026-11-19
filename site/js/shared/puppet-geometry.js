// The wooden puppet's look, shared by the stage and the phone's top-down view.
// One mesh group per rigid body, in rig-config order; each group's origin is the
// body's origin, so the renderer only has to copy the simulated transforms in.
//
// The solid pieces are lathed straight from puppet-shapes.js — the same table
// the physics colliders and the string collisions are built from — so the
// puppet you see is the puppet that collides. Only painted details with no
// real volume (eyes, buttons, bow tie, brass pins) are added here.

import * as THREE from 'three';
import { BODIES, JOINTS } from './rig-config.js';
import { SHAPES, HAT_FRAME } from './puppet-shapes.js';

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

const sphere = (r, mat, seg = 16) => new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, Math.round(seg * 0.7))), mat);
const at = (mesh, x, y, z) => { mesh.position.set(x, y, z); return mesh; };

/** Lathes one solid piece from the shared shape table. */
function turnPiece(piece, materials, segments) {
	const profile = piece.profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0005, r), y));
	const mesh = new THREE.Mesh(new THREE.LatheGeometry(profile, piece.smooth ? Math.round(segments * 1.3) : segments), materials[piece.mat]);
	mesh.position.set(piece.at[0], piece.at[1], piece.at[2]);
	mesh.quaternion.set(piece.rot[0], piece.rot[1], piece.rot[2], piece.rot[3]);
	mesh.scale.set(piece.scale[0], piece.scale[1], piece.scale[2]);
	mesh.userData.solid = true;   // a real, colliding piece (not a painted detail)
	return mesh;
}

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
		for (const piece of SHAPES[def.id] || []) group.add(turnPiece(piece, m, seg));
		root.add(group);
		return group;
	});
	const part = (id) => parts[BODIES.findIndex((b) => b.id === id)];
	const add = (id, ...meshes) => { for (const mesh of meshes) part(id).add(mesh); };

	// --- painted and fitted details (no collision volume of their own) --------
	// Waistcoat buttons and a bow tie.
	for (let i = 0; i < 3; i++) add('chest', at(sphere(0.011, m.brass, 10), 0, 0.04 - i * 0.045, 0.094 - Math.abs(i - 1) * 0.004 + (i === 2 ? -0.006 : 0)));
	const bowL = at(sphere(0.03, m.paintRed, 12), 0.03, 0.098, 0.074); bowL.scale.set(1, 0.7, 0.45);
	const bowR = at(sphere(0.03, m.paintRed, 12), -0.03, 0.098, 0.074); bowR.scale.set(1, 0.7, 0.45);
	add('chest', bowL, bowR, at(sphere(0.012, m.paintRed, 10), 0, 0.098, 0.08));

	// The face.
	for (const sx of [1, -1]) {
		const white = at(sphere(0.026, m.paintCream, 14), sx * 0.042, 0.018, 0.098); white.scale.set(1, 1.15, 0.45);
		const pupil = at(sphere(0.012, m.paintBlack, 12), sx * 0.04, 0.014, 0.111); pupil.scale.set(1, 1.1, 0.45);
		const glint = at(sphere(0.004, m.paintCream, 8), sx * 0.04 + 0.004, 0.02, 0.117);
		const brow = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.008, 0.01), m.dark);
		brow.position.set(sx * 0.044, 0.058, 0.098); brow.rotation.set(-0.3, sx * -0.35, sx * 0.22);
		const cheek = at(sphere(0.02, m.blush, 10), sx * 0.066, -0.034, 0.083); cheek.scale.set(1, 0.8, 0.35);
		add('head', white, pupil, glint, brow, cheek);
	}
	const smile = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.0042, 8, 20, Math.PI * 0.72), m.paintRed);
	smile.position.set(0, -0.04, 0.099); smile.rotation.set(-0.18, 0, Math.PI + (Math.PI - Math.PI * 0.72) / 2);
	add('head', smile);
	// The hat band.
	const band = new THREE.Mesh(new THREE.CylinderGeometry(0.063, 0.0665, 0.016, seg), m.paintRed);
	band.quaternion.set(HAT_FRAME.rot[0], HAT_FRAME.rot[1], HAT_FRAME.rot[2], HAT_FRAME.rot[3]);
	band.position.copy(new THREE.Vector3(0, 0.012, 0).applyQuaternion(band.quaternion)).add(new THREE.Vector3(HAT_FRAME.at[0], HAT_FRAME.at[1], HAT_FRAME.at[2]));
	add('head', band);

	// Brass hinge pins and shoe buckles.
	for (const side of ['L', 'R']) {
		add(`upperArm${side}`, at(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.086, 8), m.brass), 0, -0.14, 0).rotateZ(Math.PI / 2));
		add(`thigh${side}`, at(new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.106, 8), m.brass), 0, -0.195, 0).rotateZ(Math.PI / 2));
		add(`foot${side}`, at(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.008, 0.026), m.brass), 0, 0.024, 0.03));
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
