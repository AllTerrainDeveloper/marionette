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
import { HAT_FRAME, modelById } from './puppet-shapes.js';

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
		// The ballerina's and the knight's.
		paintPink: new THREE.MeshStandardMaterial({ color: 0xb8607a, roughness: 0.5 }),
		satin: new THREE.MeshStandardMaterial({ color: 0xc98a98, roughness: 0.3 }),
		tulle: new THREE.MeshStandardMaterial({ color: 0xb99aa4, roughness: 0.95 }),
		tulleDeep: new THREE.MeshStandardMaterial({ color: 0x9c6f80, roughness: 0.95 }),
		tights: new THREE.MeshStandardMaterial({ color: 0xa8998a, roughness: 0.7 }),
		hair: wood(0x5a3520, 0.7),
		steel: new THREE.MeshStandardMaterial({ color: 0x77808d, roughness: 0.46, metalness: 0.62 }),
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
 * rig body i. `detail`: 'high' for the stage, 'low' for phones. `model`: which
 * puppet (see MODELS in puppet-shapes.js); the gentleman if none is named.
 */
export function buildPuppet(detail = 'high', materials = makeMaterials(detail), model = undefined) {
	const m = materials;
	const hi = detail === 'high';
	const seg = hi ? 28 : 14;
	const which = modelById(model);
	const root = new THREE.Group();
	const parts = BODIES.map((def) => {
		const group = new THREE.Group();
		group.name = def.id;
		for (const piece of which.shapes[def.id] || []) group.add(turnPiece(piece, m, seg));
		root.add(group);
		return group;
	});
	const part = (id) => parts[BODIES.findIndex((b) => b.id === id)];
	const add = (id, ...meshes) => { for (const mesh of meshes) part(id).add(mesh); };

	// Painted and fitted details (no collision volume of their own).
	DETAILS[which.id]({ m, add, seg });

	root.traverse((o) => {
		if (o.isMesh) { o.castShadow = hi; o.receiveShadow = hi; }
	});
	return { root, parts, materials: m, model: which.id };
}

const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
const pin = (r, length, mat) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, length, 8), mat);

/** Brass pins through the elbow and knee hinges. */
function hingePins({ m, add }, elbow = 0.086, knee = 0.106, mat = m.brass) {
	for (const side of ['L', 'R']) {
		add(`upperArm${side}`, at(pin(0.008, elbow, mat), 0, -0.14, 0).rotateZ(Math.PI / 2));
		add(`thigh${side}`, at(pin(0.009, knee, mat), 0, -0.195, 0).rotateZ(Math.PI / 2));
	}
}

const DETAILS = {
	gentleman(ctx) {
		const { m, add, seg } = ctx;
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
			const brow = box(0.04, 0.008, 0.01, m.dark);
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
		hingePins(ctx);
		for (const side of ['L', 'R']) add(`foot${side}`, at(box(0.04, 0.008, 0.026, m.brass), 0, 0.024, 0.03));
	},

	ballerina(ctx) {
		const { m, add, seg } = ctx;
		// The face: large dark eyes, lashes, a small mouth.
		for (const sx of [1, -1]) {
			const white = at(sphere(0.022, m.paintCream, 14), sx * 0.038, 0.012, 0.09); white.scale.set(1, 1.2, 0.45);
			const pupil = at(sphere(0.012, m.paintBlack, 12), sx * 0.037, 0.01, 0.1); pupil.scale.set(1, 1.2, 0.45);
			const glint = at(sphere(0.0036, m.paintCream, 8), sx * 0.037 + 0.004, 0.017, 0.105);
			const lash = box(0.034, 0.005, 0.008, m.paintBlack);
			lash.position.set(sx * 0.04, 0.04, 0.092); lash.rotation.set(-0.3, sx * -0.3, sx * -0.2);
			const cheek = at(sphere(0.018, m.blush, 10), sx * 0.058, -0.03, 0.078); cheek.scale.set(1, 0.8, 0.35);
			add('head', white, pupil, glint, lash, cheek);
		}
		const mouth = at(sphere(0.012, m.paintRed, 10), 0, -0.046, 0.089); mouth.scale.set(1.3, 0.6, 0.4);
		// A ribbon round the bun, and a tiara's worth of brass at the hairline.
		const ribbon = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.006, 8, 20), m.paintPink);
		ribbon.position.set(0, 0.078, -0.052); ribbon.rotation.set(-0.95, 0, 0);
		add('head', mouth, ribbon);
		for (let i = -1; i <= 1; i++) add('head', at(sphere(i ? 0.006 : 0.009, m.brass, 8), i * 0.022, 0.104 - Math.abs(i) * 0.004, 0.036));

		// The bodice: a neckline and a ribbon at the waist.
		const neckline = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.005, 8, 24, Math.PI), m.paintCream);
		neckline.position.set(0, 0.104, 0.03); neckline.rotation.set(-1.0, 0, Math.PI); neckline.scale.set(1.2, 1, 1);
		add('chest', neckline);
		const sash = new THREE.Mesh(new THREE.CylinderGeometry(0.098, 0.1, 0.02, seg), m.satin);
		sash.scale.set(1.12, 1, 0.74);
		add('abdomen', at(sash, 0, -0.02, 0));

		// Ankle ribbons, crossed twice round each shin.
		for (const side of ['L', 'R']) {
			for (const y of [-0.115, -0.15]) {
				const tie = new THREE.Mesh(new THREE.TorusGeometry(0.029 - (y + 0.115) * -0.06, 0.004, 6, 18), m.satin);
				tie.position.set(0, y, 0); tie.rotation.set(Math.PI / 2 + (y < -0.13 ? 0.3 : -0.3), 0, 0);
				add(`shin${side}`, tie);
			}
		}
		hingePins(ctx, 0.066, 0.086);
	},

	knight(ctx) {
		const { m, add, seg } = ctx;
		// The visor: a dark sight and a row of breaths.
		const sight = box(0.1, 0.012, 0.02, m.paintBlack);
		sight.position.set(0, 0.03, 0.112);
		add('head', sight);
		for (let i = -2; i <= 2; i++) add('head', at(sphere(0.005, m.paintBlack, 8), i * 0.016, -0.05 - Math.abs(i) * 0.002, 0.098 - Math.abs(i) * 0.004));
		const rim = new THREE.Mesh(new THREE.TorusGeometry(0.111, 0.006, 8, seg), m.brass);
		rim.position.set(0, 0.055, 0); rim.rotation.set(Math.PI / 2, 0, 0); rim.scale.set(0.97, 1.01, 1);
		add('head', rim);

		// The breastplate: a cross on a red field, rivets at the shoulders.
		const field = at(sphere(0.07, m.paintRed, 16), 0, 0.012, 0.074); field.scale.set(0.95, 1.15, 0.62);
		add('chest', field, at(box(0.02, 0.1, 0.012, m.brass), 0, 0.014, 0.114), at(box(0.07, 0.02, 0.012, m.brass), 0, 0.03, 0.114));
		for (const sx of [1, -1]) add('chest', at(sphere(0.008, m.brass, 8), sx * 0.118, 0.07, 0.07));
		// A buckle on the sword belt, and brass edges to the skirt of plates.
		add('pelvis', at(box(0.04, 0.028, 0.012, m.brass), 0, 0.03, 0.104));
		const hem = new THREE.Mesh(new THREE.TorusGeometry(0.142, 0.006, 8, seg), m.brass);
		hem.position.set(0, -0.072, 0); hem.rotation.set(Math.PI / 2, 0, 0); hem.scale.set(1.18, 0.84, 1);
		add('pelvis', hem);

		// Rivets on the pauldrons, spurs at the heels.
		for (const [side, sx] of [['L', 1], ['R', -1]]) {
			add(`clavicle${side}`, at(sphere(0.007, m.brass, 8), sx * 0.095, 0.02, 0.054));
			const spur = pin(0.004, 0.05, m.brass);
			spur.position.set(0, -0.004, -0.075); spur.rotation.set(Math.PI / 2 - 0.25, 0, 0);
			add(`foot${side}`, spur, at(sphere(0.009, m.brass, 8), 0, 0.002, -0.1));
		}
		hingePins(ctx, 0.09, 0.11, m.iron);
	},
};

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
