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

## How it fits together

| Path | What it is |
| --- | --- |
| `site/js/shared/rig-config.js` | The puppet as data: 19 bodies, 18 joints (limits, tone, torque), 2 control bars, 12 handles, 12 strings, 4 IK effectors. |
| `site/js/shared/modes.js` | The six control configurations and the Custom Rig JSON schema. |
| `site/js/shared/mapping.js` | Motion mapping engine (sensitivity, dead zone, smoothing, curve, clamp, invert). |
| `site/js/shared/protocol.js` | Binary packets for the unreliable channel, JSON for the reliable one. |
| `site/js/shared/net.js` | Signaling client and WebRTC link (two data channels). |
| `site/js/stage/sim.js` | Rapier world, tension-only strings, IK, balance, safety guards. |
| `site/js/stage/control.js` | Phone input → bar / handle / IK / motor targets; gait; idle animation. |
| `site/js/stage/scene.js` | Theatre set, lighting, post-processing, adaptive quality. |
| `site/js/controller/*` | Sensors + calibration, top-down board, touch, Custom Rig editor. |
| `site/signal.php` | Minimal PHP signaling (temporary session files). |
| `site/functions/api/signal.js` | The same contract as a Spacefast Function, for hosts that do not execute PHP. |

The client probes `signal.php` first and falls back to `/api/signal`. Spacefast does not execute uploaded PHP, so the published Space uses the Function; any PHP host uses `signal.php`.

Connectivity: STUN only. Devices on the same Wi-Fi connect directly; some carrier / corporate networks will not without a TURN relay.

## Physics notes

- Rapier's solver is already a small-steps / TGS-soft solver, so the simulation takes many small steps (240 Hz × 5 iterations) rather than few large ones.
- Strings are unilateral soft distance constraints solved outside Rapier. Each keeps an accumulated impulse that is warm started and refined over four Gauss–Seidel passes, clamped to `[0, max tension]` — the accumulated dual update of *Augmented Vertex Block Descent* (Giles, Diaz, Yuksel, SIGGRAPH 2025) in velocity form with Catto's soft-constraint coefficients.
- Joint locks narrow the joint limits to the current pose (a hard stop, not a stiff spring).

## Tests (Node 22+)

```bash
node tools/sim-test.mjs          # hang, lift, shake, IK, collapse, recover
node tools/control-test.mjs      # protocol round trips, every mode, walking, two phones, locks
node tools/solver-bench.mjs      # A/B of solver settings (jitter, joint gaps, cost)
node tools/solver-precision.mjs  # drift from a 1920 Hz reference
```

## License

MIT — see `LICENSE`. Bundled third-party code in `site/vendor/` keeps its own licence: three.js r187 (MIT), Rapier 0.21 (Apache-2.0), qrcode-generator 2.0.4 (MIT).
