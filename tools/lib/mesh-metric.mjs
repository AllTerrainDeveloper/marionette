// Measures strings against the puppet's real rendered geometry (the lathed meshes,
// triangle by triangle) rather than against any simplified stand-in. Runs headless.
import * as THREE from '../../site/vendor/three.module.js';
import { BODIES } from '../../site/js/shared/rig-config.js';
import { SHAPES } from '../../site/js/shared/puppet-shapes.js';
import { wrapFrame, stringPath } from '../../site/js/shared/string-path.js';

export function buildMeshes(segments = 20) {
	const root = new THREE.Group();
	const material = new THREE.MeshBasicMaterial();
	const meshes = [];
	const parts = BODIES.map((def) => {
		const group = new THREE.Group();
		group.name = def.id;
		for (const piece of SHAPES[def.id] || []) {
			const mesh = new THREE.Mesh(new THREE.LatheGeometry(piece.profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0005, r), y)), segments), material);
			mesh.position.set(...piece.at); mesh.quaternion.set(...piece.rot); mesh.scale.set(...piece.scale);
			mesh.userData.body = def.id;
			group.add(mesh); meshes.push(mesh);
		}
		root.add(group);
		return group;
	});
	return { root, parts, meshes };
}

const ray = new THREE.Raycaster();
const frame = [];

/**
 * The longest stretch of any string that lies inside the wood, in metres, for the
 * simulation's current state. `routed: false` measures the straight handle-to-attachment
 * line instead (what you would see with string collisions off).
 */
export function stringsInsideWood(sim, model, { routed = true } = {}) {
	model.parts.forEach((group, i) => {
		group.position.set(sim.pos[i * 3], sim.pos[i * 3 + 1], sim.pos[i * 3 + 2]);
		group.quaternion.set(sim.quat[i * 4], sim.quat[i * 4 + 1], sim.quat[i * 4 + 2], sim.quat[i * 4 + 3]);
	});
	model.root.updateMatrixWorld(true);
	wrapFrame(sim.wrapProxies, sim.pos, sim.quat, frame);
	let worst = 0, where = '';
	for (const s of sim.strings) {
		if (!s.def.enabled || s.broken) continue;
		const handle = sim.handleAt(s.handle);
		const attach = sim.pointAt(s.body, s.at);
		// Routed on the transforms being measured, exactly as the renderers route what they draw.
		const points = routed ? stringPath(handle, attach, frame, s.excluded).points : [handle, attach];
		for (let k = 0; k < points.length - 1; k++) {
			const p = new THREE.Vector3(...points[k]), q = new THREE.Vector3(...points[k + 1]);
			const L = p.distanceTo(q);
			if (L < 0.02) continue;
			const dir = q.clone().sub(p).divideScalar(L);
			ray.set(p, dir); ray.far = L;
			const entries = ray.intersectObjects(model.meshes, false);
			if (!entries.length) continue;
			ray.set(q, dir.clone().negate()); ray.far = L;
			const exits = ray.intersectObjects(model.meshes, false);
			for (const hit of entries) {
				const exit = exits.find((e) => e.object === hit.object);
				if (!exit) continue;
				const inside = L - exit.distance - hit.distance;
				if (inside > worst) { worst = inside; where = `${s.def.id} through ${hit.object.userData.body}`; }
			}
		}
	}
	return { worst, where };
}
