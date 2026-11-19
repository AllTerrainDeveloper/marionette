# Motion Puppet

A physics-driven wooden marionette on a theatre stage, played with your phone.

- **Desktop (`site/index.html`)** — the stage. Runs the only physics simulation (our own Augmented Vertex Block Descent solver, fixed 240 Hz step), renders the theatre with Three.js, and shows **two QR codes**: one per puppeteer.
- **Phone (`site/controller.html`)** — the puppeteer's board. Captures motion sensors and touch, and draws an interactive top-down 3D view of the puppet, its strings and the control rig from the state streamed back by the stage. No physics runs on the phone.
- **Pro (two phones)** — scan the second QR code with a second phone. Phone one holds the main bar (head, back, shoulders, hips); phone two holds the limb bar (wrists, knees, ankles). In *Arms & Hands* each phone is one hand.

Live: https://marionette.space.fast/

## Run locally

```bash
php -S 127.0.0.1:8765 -t site
```

Open http://127.0.0.1:8765/ on a computer. Phones need HTTPS for motion sensors, so for real devices use the published Space (or any HTTPS host).

Stage keys: `d` stats · `q` quality · `r` reset · `h` hide / show the tickets and titles · `f` fullscreen. Reset and Hide are also buttons in the top-right corner; every phone has its own **Reset puppet** button.

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
| `site/js/shared/string-shape.js` | The shape a string is drawn with: on its route when tight, hanging free from its two ends when it has spare length, and the gradual change between the two. Shared by both renderers. |
| `site/js/shared/protocol.js` | Binary packets for the unreliable channel, JSON for the reliable one. |
| `site/js/shared/net.js` | Signaling client and WebRTC link (two data channels). |
| `site/js/stage/avbd.js` | The physics solver: Augmented Vertex Block Descent for rigid bodies — joints with limits and motors, frictional contacts, inextensible strings. No dependencies. |
| `site/js/stage/sim.js` | The puppet on that solver: control rig, string routing, contact detection, IK, balance, safety guards. |
| `site/js/shared/gestures.js` | The one-tap moves (bow, wave, cheer, salute, kicks…), shared by the stage that plays them and the phone that lists them. |
| `site/js/stage/control.js` | Phone input → bar / handle / IK / motor targets; gait; idle animation. |
| `site/js/stage/debug.js` | Debug mode: movement routines and live measurements, loaded only with `?debug`. |
| `site/js/stage/scene.js` | Theatre set, lighting, post-processing, adaptive quality. |
| `site/js/controller/*` | Sensors + calibration, top-down board, touch, Custom Rig editor. |
| `site/signal.php` | Minimal PHP signaling (temporary session files). |
| `site/functions/api/signal.js` | The same contract as a Spacefast Function, for hosts that do not execute PHP. |

The client probes `signal.php` first and falls back to `/api/signal`. Spacefast does not execute uploaded PHP, so the published Space uses the Function; any PHP host uses `signal.php`.

Connectivity: STUN only. Devices on the same Wi-Fi connect directly; some carrier / corporate networks will not without a TURN relay.

## Physics notes

- **Solver.** The puppet is solved by *Augmented Vertex Block Descent* (Giles, Diaz, Yuksel, SIGGRAPH 2025), implemented in `avbd.js` after the paper and the first author's reference code. Each step is one implicit solve in which every body takes a Newton step on its own 6×6 block and every constraint then updates its multiplier and penalty. Joints, joint limits, the muscle-tone motors, contacts with friction and the strings are all rows of that one solve, so they are resolved against each other rather than one after another. It uses the reference's stabilisation and warm start (α = 0.99, γ = 0.999).
- **Physics takes what the frame has to spare.** The stage aims at 60 fps. Each frame it measures how long physics and everything else took, and moves between 120 and 960 physics steps per second (4–5 solver sweeps each) so that physics fits in what is left: smaller steps when there is room — accuracy rises steadily with the step rate, see `tools/solver-bench.mjs` — and larger ones on a slow machine or a heavy frame. The stats line (`d`) shows the current rate; `?fixed` in the URL pins it at 240 Hz × 5. Strings are re-routed round the limbs about 120 times a second whatever the step rate.
- **Rapier is geometry only.** It builds the convex hulls, gives their mass, centre of mass and inertia, and answers closest-point queries between them. It never steps the puppet.
- **Strings do not stretch and only pull.** A string is one hard, one-sided constraint on the length of its path, with a tension ceiling of a few times the puppet's weight (beyond it the string gives, as a puppeteer's hand would). A string that is suddenly far too short — pulled in hard, or re-tied while the puppet lies on the floor — is taken in at 2 m/s rather than in one step.
- **Strings collide with the puppet,** including the limb they are tied to. Where a string would pass through a piece, via points are placed on its surface and the string becomes a polyline through them; each via point is a frictionless pulley, so the wood deflects the string and the string presses on the wood. The route is carried from one moment to the next — via points move with their limbs and slide to where the string presses, so a string wound round a limb stays on its side — and gives way to the shortest route only when that is clearly shorter or the carried one would cut the wood. The tie point is a screw eye standing 12 mm off the wood, so a string leaves the limb rather than lying on it.
- **Slack strings hang free.** That route is where a string lies when pulled tight. A string with spare length is not on it — nothing presses it against the wood — so it is drawn as a small chain of its full length, pinned only at its two ends, that hangs under gravity and rests on the puppet only where it actually falls against it; a snapped one dangles from its handle. The chain is carried along with its ends, heavily damped, and frozen once it has settled, so a loose string on a still puppet does not move at all. It is kept to exactly the string's length by shortening it along its own way round the limbs, so it arrives taut by itself as the slack runs out, and it tells the router which side of each limb it is on. Neither its points nor the links between them may be in the wood — a loop of slack lies on a shoe, it does not fall through it — and whatever is drawn is checked once more: if easing between two shapes would take the string through a limb, it is drawn in its new place at once.
- **Strings and the floor.** No string goes under the stage floor: a loose one lies on it, and a tight one passing a limb that lies on the floor goes over the limb, not under it. This is how the string is drawn, not a force on the puppet (a slack string exerts none). Both are worked out on the transforms being drawn, so a string never sinks into the surface on screen.
- **Joints have friction.** Every joint resists turning a little, in proportion to the inertia of the limb swinging from it. Without it a limb set swinging takes most of a minute to hang still (and the lightest parts never quite do); with it the puppet stands motionless a few seconds after it is let be.
- **What you see is what collides.** Every solid piece is a surface of revolution described once in `puppet-shapes.js`; the mesh is lathed from it, the collider is a convex hull of the same surface, and mass is spread evenly through it. Every part collides with every other part; only directly jointed neighbours are exempt. Contacts are created shortly before surfaces touch, which is what stops fast limbs passing through each other between steps.
- **Joint angles.** A hinge is measured by its turn about its axis; a ball joint by its rotation vector, which stays smooth for any pose a limb can reach. Joint locks narrow the limits to the current pose (a hard stop, not a stiff spring).
- **Known limits.** Strings do not collide with each other or with the control bars, so they cannot tangle or knot; there is no string friction. In violent motion a string or limb can still clip briefly (the tests report how often). A tight string wound round several limbs can still switch to a shorter route at once (drawn as a quick slide). Two knowing departures from the paper: angle rows keep a fixed penalty, and joint-limit multipliers take only a third of each update — with a full update they flipped on and off from sweep to sweep, and the result depended on whether the number of sweeps was odd or even.

## Tests (Node 22+)

```bash
node tools/sim-test.mjs          # hang, lift, shake, IK, collapse, recover, strings vs the real meshes
node tools/control-test.mjs      # protocol round trips, every mode, walking, two phones, locks
node tools/string-test.mjs       # drawn strings: calm when still, idle, hanging; never in their own limb or under the floor
node tools/solver-bench.mjs      # solver settings compared on a hard scenario (calm, joint gaps, limits, overlap, cost)
```

## License

MIT — see `LICENSE`. Bundled third-party code in `site/vendor/` keeps its own licence: three.js r187 (MIT), Rapier 0.21 (Apache-2.0), qrcode-generator 2.0.4 (MIT). `site/js/stage/avbd.js` follows the AVBD reference solver by Chris Giles (MIT).
