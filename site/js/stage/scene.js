// The theatre: stage boards, velvet curtains, painted backdrop, footlights,
// a follow spot with dust in its beam, and the post-processing chain
// (ambient occlusion, bloom, tone mapping) with adaptive quality.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

function canvasTexture(w, h, draw, repeat) {
	const canvas = document.createElement('canvas');
	canvas.width = w; canvas.height = h;
	draw(canvas.getContext('2d'), w, h);
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.anisotropy = 8;
	if (repeat) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(repeat[0], repeat[1]); }
	return tex;
}

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function boardsTexture() {
	return canvasTexture(1024, 1024, (g, w, h) => {
		const planks = 8;
		const pw = w / planks;
		for (let i = 0; i < planks; i++) {
			const tone = 28 + rnd() * 16;
			g.fillStyle = `rgb(${tone + 58},${tone + 28},${tone + 4})`;
			g.fillRect(i * pw, 0, pw, h);
			for (let k = 0; k < 150; k++) {
				g.strokeStyle = rnd() > 0.5 ? `rgba(255,214,160,${rnd() * 0.07})` : `rgba(20,8,0,${rnd() * 0.14})`;
				g.lineWidth = 0.6 + rnd() * 1.8;
				const x = i * pw + rnd() * pw;
				g.beginPath(); g.moveTo(x, 0);
				g.bezierCurveTo(x + (rnd() - 0.5) * 12, h * 0.33, x + (rnd() - 0.5) * 12, h * 0.66, x + (rnd() - 0.5) * 8, h);
				g.stroke();
			}
			// Board ends and nail heads.
			const cut = rnd() * h;
			g.fillStyle = 'rgba(8,3,0,0.75)';
			g.fillRect(i * pw, cut, pw, 3);
			for (const dy of [-14, 16]) for (const dx of [0.2, 0.8]) {
				g.beginPath(); g.arc(i * pw + pw * dx, (cut + dy + h) % h, 2.6, 0, Math.PI * 2); g.fill();
			}
			g.fillStyle = 'rgba(6,2,0,0.85)';
			g.fillRect(i * pw - 1.5, 0, 3, h);
		}
	}, [2.2, 1.6]);
}

function backdropTexture() {
	return canvasTexture(1024, 512, (g, w, h) => {
		const sky = g.createLinearGradient(0, 0, 0, h);
		sky.addColorStop(0, '#0b1230'); sky.addColorStop(0.55, '#27305e'); sky.addColorStop(0.8, '#7a4a5c'); sky.addColorStop(1, '#c9805a');
		g.fillStyle = sky; g.fillRect(0, 0, w, h);
		for (let i = 0; i < 170; i++) {
			g.fillStyle = `rgba(255,244,214,${0.25 + rnd() * 0.7})`;
			const r = rnd() * 1.4 + 0.3;
			g.beginPath(); g.arc(rnd() * w, rnd() * h * 0.62, r, 0, Math.PI * 2); g.fill();
		}
		// Moon with a soft halo.
		const mx = w * 0.74, my = h * 0.24;
		const halo = g.createRadialGradient(mx, my, 10, mx, my, 130);
		halo.addColorStop(0, 'rgba(255,240,200,0.5)'); halo.addColorStop(1, 'rgba(255,240,200,0)');
		g.fillStyle = halo; g.fillRect(mx - 140, my - 140, 280, 280);
		g.fillStyle = '#fff3cf'; g.beginPath(); g.arc(mx, my, 34, 0, Math.PI * 2); g.fill();
		g.fillStyle = 'rgba(190,170,130,0.35)';
		for (const [dx, dy, r] of [[-10, -6, 7], [9, 8, 5], [4, -14, 4]]) { g.beginPath(); g.arc(mx + dx, my + dy, r, 0, Math.PI * 2); g.fill(); }
		// Painted hills and a little town, flat like a theatre cloth.
		const hill = (base, amp, color, f) => {
			g.fillStyle = color; g.beginPath(); g.moveTo(0, h);
			for (let x = 0; x <= w; x += 8) g.lineTo(x, base - Math.sin(x * f + base) * amp - Math.sin(x * f * 2.7) * amp * 0.3);
			g.lineTo(w, h); g.fill();
		};
		hill(h * 0.78, 34, '#2a2448', 0.006); hill(h * 0.86, 26, '#1c1832', 0.011);
		for (let i = 0; i < 16; i++) {
			const x = 60 + i * 58 + rnd() * 20, bw = 22 + rnd() * 20, bh = 30 + rnd() * 50, y = h * 0.9;
			g.fillStyle = '#120f22'; g.fillRect(x, y - bh, bw, bh + 60);
			g.beginPath(); g.moveTo(x - 3, y - bh); g.lineTo(x + bw / 2, y - bh - 16 - rnd() * 14); g.lineTo(x + bw + 3, y - bh); g.fill();
			g.fillStyle = 'rgba(255,196,96,0.9)';
			for (let k = 0; k < 2; k++) if (rnd() > 0.35) g.fillRect(x + 5 + k * 10, y - bh + 10 + rnd() * 14, 4, 6);
		}
	});
}

/** A pleated velvet drape. `gather` pulls the bottom towards one side like a tie-back. */
function drape(width, height, pleats, gather, material) {
	const geo = new THREE.PlaneGeometry(width, height, pleats * 6, 24);
	const p = geo.attributes.position;
	for (let i = 0; i < p.count; i++) {
		const x = p.getX(i), y = p.getY(i);
		const v = 0.5 - y / height;                    // 0 top … 1 bottom
		const u = x / width + 0.5;
		const fold = Math.sin(u * pleats * Math.PI * 2);
		p.setZ(i, fold * (0.07 + 0.05 * v) + Math.sin(u * 37) * 0.012);
		const pinch = Math.sin(Math.min(1, v * 1.35) * Math.PI) * gather;
		p.setX(i, x + pinch * (1 - u) * width * 0.55 + fold * 0.012);
	}
	geo.computeVertexNormals();
	const mesh = new THREE.Mesh(geo, material);
	mesh.castShadow = true; mesh.receiveShadow = true;
	return mesh;
}

/**
 * Ambient occlusion that leaves see-through effect meshes out. GTAOPass draws
 * its own depth and normal buffers with an override material, and that material
 * turns every mesh into a solid surface: the follow spot's beam cone, which is
 * additive and writes no depth in the colour pass, became an opaque wall there.
 * The floor then picked up a hard dark crease along the arc where the cone
 * meets it and along the cone's straight silhouette, and the puppet standing
 * inside the cone got no occlusion at all. Anything that keeps out of the
 * depth buffer in the colour pass is kept out of this one too.
 */
class StageAOPass extends GTAOPass {
	render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
		const hidden = _seeThrough;
		this.scene.traverseVisible((o) => { if (o.isMesh && o.material.depthWrite === false) hidden.push(o); });
		for (const o of hidden) o.visible = false;
		try {
			super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
		} finally {
			for (const o of hidden) o.visible = true;
			hidden.length = 0;
		}
	}
}
const _seeThrough = [];

export class Stage {
	constructor(canvas) {
		const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }));
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFShadowMap;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.12;
		renderer.outputColorSpace = THREE.SRGBColorSpace;

		const scene = (this.scene = new THREE.Scene());
		scene.background = new THREE.Color(0x050308);
		scene.fog = new THREE.FogExp2(0x0b0606, 0.045);
		const pmrem = new THREE.PMREMGenerator(renderer);
		scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		scene.environmentIntensity = 0.16;
		pmrem.dispose();

		this.camera = new THREE.PerspectiveCamera(31, 16 / 9, 0.1, 60);
		this.focus = new THREE.Vector3(0, 1.32, 0);
		this.quality = 2;
		this._slow = 0;
		this._buildSet();
		this._buildLights();
		this._buildDust();
		this._buildPost();
	}

	_buildSet() {
		const scene = this.scene;
		const boards = boardsTexture();
		const floor = new THREE.Mesh(
			new THREE.PlaneGeometry(9, 5.4),
			new THREE.MeshStandardMaterial({ map: boards, bumpMap: boards, bumpScale: 0.8, roughness: 0.42, metalness: 0.0, envMapIntensity: 1.6 })
		);
		floor.rotation.x = -Math.PI / 2; floor.position.z = -0.2; floor.receiveShadow = true;
		scene.add(floor);

		const darkWood = new THREE.MeshStandardMaterial({ color: 0x24130b, roughness: 0.55 });
		const gilt = new THREE.MeshStandardMaterial({ color: 0xc79a3c, roughness: 0.3, metalness: 1 });
		// Apron front with gilded trim.
		const apron = new THREE.Mesh(new THREE.BoxGeometry(9, 0.6, 0.12), darkWood);
		apron.position.set(0, -0.3, 2.5); scene.add(apron);
		const trim = new THREE.Mesh(new THREE.BoxGeometry(9, 0.035, 0.14), gilt);
		trim.position.set(0, -0.02, 2.5); scene.add(trim);

		// Painted backdrop.
		const cloth = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 4.2), new THREE.MeshStandardMaterial({ map: backdropTexture(), roughness: 0.95, emissive: 0xffffff, emissiveMap: null, emissiveIntensity: 0 }));
		cloth.position.set(0, 2.05, -2.75); cloth.receiveShadow = true; scene.add(cloth);
		this.backdrop = cloth;

		// Velvet.
		const velvet = new THREE.MeshPhysicalMaterial({ color: 0x6d0d17, roughness: 0.82, sheen: 1, sheenColor: new THREE.Color(0xff6a5a), sheenRoughness: 0.45, side: THREE.DoubleSide });
		const left = drape(2.6, 4.6, 7, 0.55, velvet); left.position.set(-3.25, 2.25, -1.35); left.scale.x = -1; scene.add(left);
		const right = drape(2.6, 4.6, 7, 0.55, velvet); right.position.set(3.25, 2.25, -1.35); scene.add(right);
		const wingL = drape(1.5, 4.8, 4, 0.0, velvet); wingL.position.set(-3.75, 2.3, 0.85); wingL.rotation.y = 0.5; scene.add(wingL);
		const wingR = drape(1.5, 4.8, 4, 0.0, velvet); wingR.position.set(3.75, 2.3, 0.85); wingR.rotation.y = -0.5; scene.add(wingR);
		// Scalloped valance across the top.
		const valGeo = new THREE.PlaneGeometry(8.6, 1.0, 120, 8);
		const vp = valGeo.attributes.position;
		for (let i = 0; i < vp.count; i++) {
			const x = vp.getX(i), y = vp.getY(i);
			const u = x / 8.6 + 0.5;
			const v = 0.5 - y;
			vp.setZ(i, Math.sin(u * 26 * Math.PI) * 0.05);
			vp.setY(i, y - v * (0.22 * Math.abs(Math.sin(u * 5 * Math.PI))));
		}
		valGeo.computeVertexNormals();
		const valance = new THREE.Mesh(valGeo, velvet);
		valance.position.set(0, 3.72, 1.0); valance.castShadow = true; scene.add(valance);
		const fringe = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.05, 0.05), gilt);
		fringe.position.set(0, 4.2, 1.02); scene.add(fringe);

		// Footlights: brass shells with warm bulbs along the stage edge.
		this.bulbs = [];
		const shellGeo = new THREE.SphereGeometry(0.075, 16, 10, 0, Math.PI);
		const bulbGeo = new THREE.SphereGeometry(0.028, 10, 8);
		for (let i = 0; i < 9; i++) {
			const x = (i - 4) * 0.72;
			const shell = new THREE.Mesh(shellGeo, gilt);
			shell.position.set(x, 0.05, 2.32); shell.rotation.y = 0; scene.add(shell);
			const bulb = new THREE.Mesh(bulbGeo, new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
			bulb.position.set(x, 0.055, 2.3); scene.add(bulb);
			this.bulbs.push(bulb);
		}
	}

	_buildLights() {
		const scene = this.scene;
		scene.add(new THREE.HemisphereLight(0x6a78b8, 0x2a130a, 0.42));

		// Follow spot: warm key from the front-left, tracks the puppet.
		const key = (this.key = new THREE.SpotLight(0xffd3a1, 190, 16, 0.2, 0.55, 1.6));
		key.position.set(-2.6, 5.2, 5.2);
		key.castShadow = true;
		key.shadow.mapSize.set(2048, 2048);
		key.shadow.bias = -0.0004; key.shadow.normalBias = 0.012; key.shadow.radius = 5;
		key.shadow.camera.near = 2; key.shadow.camera.far = 14;
		scene.add(key, key.target);

		const fill = new THREE.SpotLight(0xffb37a, 46, 14, 0.42, 0.9, 1.6);
		fill.position.set(3.4, 3.4, 4.6); fill.target.position.set(0, 1.1, 0);
		scene.add(fill, fill.target);

		// Cool rim from behind to peel the puppet off the backdrop.
		const rim = (this.rim = new THREE.SpotLight(0x8fb4ff, 120, 12, 0.5, 0.8, 1.5));
		rim.position.set(1.6, 4.4, -2.3);
		scene.add(rim, rim.target);

		const foot = new THREE.PointLight(0xffb060, 3.2, 6, 1.8);
		foot.position.set(0, 0.25, 2.1); scene.add(foot);
		const wash = new THREE.SpotLight(0x8a9cff, 60, 12, 0.9, 1, 1.4);
		wash.position.set(0, 4.6, 0.6); wash.target.position.set(0, 2, -2.75);
		scene.add(wash, wash.target);

		// The visible beam of the follow spot.
		const beamTex = canvasTexture(64, 256, (g, w, h) => {
			const grad = g.createLinearGradient(0, 0, 0, h);
			grad.addColorStop(0, 'rgba(255,225,180,0.55)'); grad.addColorStop(1, 'rgba(255,225,180,0)');
			g.fillStyle = grad; g.fillRect(0, 0, w, h);
			const side = g.createLinearGradient(0, 0, w, 0);
			side.addColorStop(0, 'rgba(0,0,0,1)'); side.addColorStop(0.5, 'rgba(0,0,0,0)'); side.addColorStop(1, 'rgba(0,0,0,1)');
			g.globalCompositeOperation = 'destination-out'; g.fillStyle = side; g.fillRect(0, 0, w, h);
		});
		const beam = (this.beam = new THREE.Mesh(
			new THREE.CylinderGeometry(0.1, 1.5, 8.6, 32, 1, true),
			new THREE.MeshBasicMaterial({ map: beamTex, transparent: true, opacity: 0.085, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })
		));
		beam.geometry.translate(0, -4.3, 0);
		beam.geometry.rotateX(-Math.PI / 2);   // cone axis along +Z so lookAt() aims it
		scene.add(beam);
	}

	_buildDust() {
		const count = 420;
		const pos = new Float32Array(count * 3);
		this.dustSeed = new Float32Array(count * 3);
		for (let i = 0; i < count; i++) {
			pos[i * 3] = (rnd() - 0.5) * 6; pos[i * 3 + 1] = rnd() * 3.6; pos[i * 3 + 2] = (rnd() - 0.5) * 4.4;
			this.dustSeed[i * 3] = rnd() * 6.28; this.dustSeed[i * 3 + 1] = 0.2 + rnd() * 0.5; this.dustSeed[i * 3 + 2] = rnd() * 6.28;
		}
		const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3));
		const tex = canvasTexture(32, 32, (g) => {
			const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
			grad.addColorStop(0, 'rgba(255,236,200,1)'); grad.addColorStop(1, 'rgba(255,236,200,0)');
			g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
		});
		this.dust = new THREE.Points(geo, new THREE.PointsMaterial({ map: tex, size: 0.022, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
		this.dustBase = pos.slice();
		this.scene.add(this.dust);
	}

	_buildPost() {
		const r = this.renderer;
		const w = Math.max(64, window.innerWidth), h = Math.max(64, window.innerHeight);
		const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
		const composer = (this.composer = new EffectComposer(r, target));
		composer.addPass(new RenderPass(this.scene, this.camera));
		try {
			this.ao = new StageAOPass(this.scene, this.camera, w, h);
			this.ao.updateGtaoMaterial({ radius: 0.32, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: 12 });
			this.ao.blendIntensity = 0.95;
			composer.addPass(this.ao);
		} catch (err) {
			console.warn('Ambient occlusion unavailable', err);
			this.ao = null;
		}
		this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.34, 0.75, 0.88);
		composer.addPass(this.bloom);
		composer.addPass(new OutputPass());
	}

	resize(width, height) {
		const maxRatio = [1, 1.5, 2][this.quality];
		const ratio = Math.min(window.devicePixelRatio || 1, maxRatio);
		this.renderer.setPixelRatio(ratio);
		this.renderer.setSize(width, height, false);
		this.composer.setPixelRatio(ratio);
		this.composer.setSize(width, height);
		const aspect = width / height;
		this.camera.aspect = aspect;
		// Pull back on narrow windows so the whole puppet and its control stay in frame.
		this.distance = aspect >= 1.5 ? 5.8 : 5.8 * (1.5 / aspect) ** 0.85;
		this.camera.updateProjectionMatrix();
		this.size = [width, height, ratio];
	}

	setQuality(level) {
		this.quality = Math.max(0, Math.min(2, level));
		if (this.ao) this.ao.enabled = this.quality === 2;
		this.bloom.enabled = this.quality >= 1;
		this.key.shadow.mapSize.setScalar(this.quality === 0 ? 1024 : 2048);
		if (this.key.shadow.map) { this.key.shadow.map.dispose(); this.key.shadow.map = null; }
		if (this.size) this.resize(this.size[0], this.size[1]);
	}

	/** puppet: world position of the puppet's chest. dt in seconds. */
	update(dt, time, puppet) {
		// Camera: frame the performer, drift a little, never snap.
		this.focus.x += (puppet.x * 0.62 - this.focus.x) * Math.min(1, dt * 1.6);
		this.focus.y += (1.32 + (puppet.y - 1.25) * 0.25 - this.focus.y) * Math.min(1, dt * 1.6);
		const cam = this.camera;
		cam.position.set(this.focus.x * 0.75 + Math.sin(time * 0.11) * 0.22, 1.5 + Math.sin(time * 0.17) * 0.05, this.distance);
		cam.lookAt(this.focus.x, this.focus.y, 0);

		this.key.target.position.lerp(_v.set(puppet.x, puppet.y - 0.15, puppet.z), Math.min(1, dt * 3));
		this.rim.target.position.copy(this.key.target.position);
		this.beam.position.copy(this.key.position);
		this.beam.lookAt(this.key.target.position);

		const flicker = 0.94 + Math.sin(time * 13) * 0.02 + Math.sin(time * 7.3) * 0.02;
		for (const bulb of this.bulbs) bulb.material.color.setRGB(1 * flicker * 2.2, 0.82 * flicker * 2.2, 0.56 * flicker * 2.2);

		const p = this.dust.geometry.attributes.position;
		const base = this.dustBase, s = this.dustSeed;
		for (let i = 0; i < p.count; i++) {
			const f = s[i * 3 + 1];
			p.setXYZ(i,
				base[i * 3] + Math.sin(time * f * 0.5 + s[i * 3]) * 0.25,
				(base[i * 3 + 1] + time * 0.02 * f) % 3.6,
				base[i * 3 + 2] + Math.cos(time * f * 0.4 + s[i * 3 + 2]) * 0.25);
		}
		p.needsUpdate = true;
	}

	render(dt) {
		if (this.quality === 0) this.renderer.render(this.scene, this.camera);
		else this.composer.render(dt);
	}

	/** Steps quality down if frames keep running long. Returns true when it changed. */
	adapt(frameMs) {
		this._slow = frameMs > 24 ? this._slow + 1 : Math.max(0, this._slow - 2);
		if (this._slow > 90 && this.quality > 0) { this._slow = 0; this.setQuality(this.quality - 1); return true; }
		return false;
	}
}
const _v = new THREE.Vector3();
