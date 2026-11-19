# Motion Puppet

A physics-driven wooden marionette on a theatre stage, played with your phone.

- **Desktop (`site/index.html`)** — the stage. Runs the only physics simulation (Rapier, fixed 240 Hz step), renders the theatre with Three.js, and shows **two QR codes**: one per puppeteer.
- **Phone (`site/controller.html`)** — the puppeteer's board. Captures motion sensors and touch, and draws an interactive top-down 3D view of the puppet, its strings and the control rig from the state streamed back by the stage. No physics runs on the phone.
- **Pro (two phones)** — scan the second QR code with a second phone. Phone one holds the main bar (head, back, shoulders, hips); phone two holds the limb bar (wrists, knees, ankles). In *Arms & Hands* each phone is one hand.

Live: https://marionette.space.fast/

## Run locally

```bash
php -S 127.0.0.1:8765 -t site
```

Open http://127.0.0.1:8765/ on a computer. Phones need HTTPS for motion sensors, so for real devices use the published Space (or any HTTPS host).

Stage keys: `d` stats · `q` quality · `r` reset · `f` fullscreen.

### Debug mode (no phone needed)

Add `?debug` to the stage URL for a panel of predefined movement routines, or `?debug=<name>` to start one straight away:

```
http://127.0.0.1:8765/?debug
http://127.0.0.1:8765/?debug=arms
```

Routines: `tilt`, `bow`, `pulls`, `handles`, `arms`, `reach`, `joints`, `walk`, `pro` (two phones), `chaos`, and `tour` (all of them in turn). Each one fills in the same input a phone sends, so mapping, gait, strings and collisions run exactly as in a real session. Routines are plain data at the top of `site/js/stage/debug.js`.

The panel also shows live measurements against the rendered meshes (how much string lies inside the wood, how far limbs overlap), and has switches for string collisions on/off, quarter-speed slow motion and a close-up camera. Nothing of it is loaded without the parameter.

## How it fits together

| Path | What it is |
| --- | --- |
| `site/js/shared/rig-config.js` | The puppet as data: 19 bodies, 18 joints (limits, tone, torque), 2 control bars, 12 handles, 12 strings, 4 IK effectors. |
| `site/js/shared/puppet-shapes.js` | The puppet's solid form, once: 49 lathe-turned pieces. The rendered meshes, the physics colliders and the string collision shapes are all built from this table. |
| `site/js/shared/modes.js` | The six control configurations and the Custom Rig JSON schema. |
| `site/js/shared/mapping.js` | Motion mapping engine (sensitivity, dead zone, smoothing, curve, clamp, invert). |
| `site/js/shared/string-path.js` | String-versus-puppet collision: routes a string over the surface of any piece it would cut through, its own limb included. Shared by the simulation and both renderers. |
| `site/js/shared/protocol.js` | Binary packets for the unreliable channel, JSON for the reliable one. |
| `site/js/shared/net.js` | Signaling client and WebRTC link (two data channels). |
| `site/js/stage/sim.js` | Rapier world, tension-only strings, IK, balance, safety guards. |
| `site/js/stage/control.js` | Phone input → bar / handle / IK / motor targets; gait; idle animation. |
| `site/js/stage/debug.js` | Debug mode: movement routines and live measurements, loaded only with `?debug`. |
| `site/js/stage/scene.js` | Theatre set, lighting, post-processing, adaptive quality. |
| `site/js/controller/*` | Sensors + calibration, top-down board, touch, Custom Rig editor. |
| `site/signal.php` | Minimal PHP signaling (temporary session files). |
| `site/functions/api/signal.js` | The same contract as a Spacefast Function, for hosts that do not execute PHP. |

The client probes `signal.php` first and falls back to `/api/signal`. Spacefast does not execute uploaded PHP, so the published Space uses the Function; any PHP host uses `signal.php`.

Connectivity: STUN only. Devices on the same Wi-Fi connect directly; some carrier / corporate networks will not without a TURN relay.

## Physics notes

- Rapier's solver is already a small-steps / TGS-soft solver, so the simulation takes many small steps (240 Hz × 5 iterations) rather than few large ones.
- Strings are unilateral soft distance constraints solved outside Rapier. Each keeps an accumulated impulse that is warm started and refined over four Gauss–Seidel passes, clamped to `[0, max tension]` — the accumulated dual update of *Augmented Vertex Block Descent* (Giles, Diaz, Yuksel, SIGGRAPH 2025) in velocity form with Catto's soft-constraint coefficients.
- What you see is what collides. Every solid piece is a surface of revolution described once in `puppet-shapes.js`; the mesh is lathed from it, the collider is a convex hull of the same surface (no boxes or capsules standing in), and mass is spread evenly through it, so centre of mass and inertia follow the real shape.
- Every part of the puppet collides with every other part; only directly jointed neighbours are exempt.
- Strings collide with the puppet, including the limb they are tied to. Where a string would pass through a piece, via points are placed on its surface at the deepest point of each offending stretch, and the string becomes a polyline through them. The constraint is on the polyline's total length and each via point is a frictionless pulley, so the wood deflects the string and the string presses on the wood. Limits: no friction, strings do not collide with each other or the control bars, and during violent motion a string or limb can still clip briefly (the test below reports how often).
- Joint locks narrow the joint limits to the current pose (a hard stop, not a stiff spring).

## Tests (Node 22+)

```bash
node tools/sim-test.mjs          # hang, lift, shake, IK, collapse, recover, strings vs the real meshes
node tools/control-test.mjs      # protocol round trips, every mode, walking, two phones, locks
node tools/solver-bench.mjs      # A/B of solver settings (jitter, joint gaps, cost)
node tools/solver-precision.mjs  # drift from a 1920 Hz reference
```

## License

MIT — see `LICENSE`. Bundled third-party code in `site/vendor/` keeps its own licence: three.js r187 (MIT), Rapier 0.21 (Apache-2.0), qrcode-generator 2.0.4 (MIT).
