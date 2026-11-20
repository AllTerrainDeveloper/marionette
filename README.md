# Motion Puppet

A physics-driven wooden marionette on a theatre stage, played with your phone.

- **Desktop (`site/index.html`)** — the stage. Runs the only physics simulation (our own Augmented Vertex Block Descent solver, fixed 240 Hz step), renders the theatre with Three.js, and shows **two QR codes**: one per puppeteer.
- **Phone (`site/controller.html`)** — the puppeteer's board. Captures motion sensors and touch, and draws an interactive top-down 3D view of the puppet, its strings and the control rig from the state streamed back by the stage. No physics runs on the phone.
- **Pro (two phones)** — scan the second QR code with a second phone. Phone one holds the main bar (head, back, shoulders, hips); phone two holds the limb bar (wrists, knees, ankles). In *Arms & Hands* each phone is one hand.

- **Marionette editor (`site/editor.html`)** — which puppet it is and how it is strung. Three puppets share one skeleton: **the Gentleman**, **the Ballerina** and **the Knight**. Each link is a **string** (only pulls, hangs slack, wraps round a limb), a **rod** (a stiff wire that pushes as well as pulls — the head rod of a Czech or Sicilian marionette) or taken off; eight traditional stringings are a click away, and links can be added, mirrored, moved to another handle or part, and tuned by slider or by typing the exact value. The puppet in the viewport is the real one on the real physics, with a test bench that works the bars. What you make is saved in the browser, and the stage and the Studio build their puppet from it.
- **Studio (`site/studio.html`)** — a keyframe animation editor, worked with the mouse like any animation tool (no phone, no sensors). Keys are set on a timeline for the two control bars, the twelve string handles and the camera; the puppet is still moved by its strings and the physics. The camera and the bars travel on **Bezier curves** through their keys; every stretch between two keys is **eased** by a timing curve you pick or draw.

Live: https://marionette.space.fast/

## Run locally

```bash
php -S 127.0.0.1:8765 -t site
```

Open http://127.0.0.1:8765/ on a computer. Phones need HTTPS for motion sensors, so for real devices use the published Space (or any HTTPS host).

Stage keys: `d` stats · `q` quality · `r` reset · `h` hide / show the tickets and titles · `k` let the strings tangle (off by default) · `f` fullscreen. Reset and Hide are also buttons in the top-right corner; every phone has its own **Reset puppet** button.

### Debug mode (no phone needed)

Add `?debug` to the stage URL for a panel of predefined movement routines, or `?debug=<name>` to start one straight away:

```
http://127.0.0.1:8765/?debug
http://127.0.0.1:8765/?debug=arms
```

Routines: `tilt`, `bow`, `pulls`, `handles`, `arms`, `reach`, `joints`, `walk`, `pro` (two phones), `chaos`, and `tour` (all of them in turn). Each one fills in the same input a phone sends, so mapping, gait, strings and collisions run exactly as in a real session. Routines are plain data at the top of `site/js/stage/debug.js`.

The panel also shows live measurements against the rendered meshes (how much string lies inside the wood, how far limbs overlap), and has switches for string collisions on/off, quarter-speed slow motion and a close-up camera. Nothing of it is loaded without the parameter.

### The Marionette editor

Open `editor.html` (or press **Marionette** on the stage).

- **Puppet.** The Gentleman (turned wood, waistcoat, felt hat), the Ballerina (slight limbs, a tutu that is really there, pointe shoes) or the Knight (a Sicilian paladin in plate). A model is another table of solid pieces on the same nineteen bodies and eighteen joints, so what is drawn, what collides and what a string wraps round all change together, and every stringing, control mode and animation fits every puppet.
- **Stringing.** Eight traditions, each drawn as a small diagram: *All strings* (the classic twelve), *Seven strings* (a first marionette), *Head rod* (Czech), *Head and hand rods* (Sicilian), *One rod, nothing else* (Liège), *Head, waist and hands* (Rajasthani kathputli), *Temples and elbows* (Burmese, sixteen links) and *Shoulder rods* (a body that stays level). Change anything by hand and it becomes your own.
- **Links.** Click a link in the list or in the viewport, then choose **String**, **Rod** or **Off** (keys `s`, `d`, `x`; arrows move through the list; `/` finds one by name). The selected link can be renamed, hung from another handle, tied to another part, its tie point moved, given more or less slack (strings) and a different strength; **Duplicate** (`⌘D`), **Mirror** to the other side (`m`), put back **As it came**, or removed (`Del`). A live readout shows what it is carrying.
- **A menu on each link.** Click a string or rod in the viewport (or right-click it): it is selected and a menu opens beside it with what it is carrying, string / rod / off, its slack and strength as exact numbers, and Cut it, Duplicate, Mirror, As it came, Remove. The stage has the same menu while no phone is paired (kind, slack, strength, Cut it, As it came, Open in the editor); what is changed there is saved to the marionette, and the menu closes and stays shut once a phone takes the strings.
- **Exact values.** Every slider has a number box beside it: drag roughly, or type the value (`1.53`), which is not rounded to the slider's step. In the box `↑` `↓` step, `Shift` ten steps, `Alt` a tenth; double-click a label to put its value back. The Studio's sliders and the phone's Custom Rig sliders have the same box.
- **Try it** works the control bars — rock, bow, lift and lower, hands, march, walk about, shake — at any speed and size, so the difference shows: lower the bar and a string goes slack where a rod pushes. Drag to look round, right-drag to slide, wheel to zoom; `1`–`4` look from the front, the side, above and at the bars.
- **Undo** (`⌘Z`) and redo (`⇧⌘Z`) for everything but the choice of puppet; `?` lists the keys.

The marionette is saved in this browser (`localStorage`, key `motion-puppet-marionette`: name, model, links) and can be exported and imported as JSON. The stage and the Studio use it from then on, and a phone that joins is told which puppet it is and how it is strung; **Use on stage** saves it and opens the stage with it, and **Load default** goes back to the Gentleman on his twelve strings.

### The Studio

Open `studio.html` (or press **Studio** on the stage). It opens on a short example.

- **Tracks.** Camera, main bar, limb bar, and one per string handle. Move the playhead, then move something: with **Auto-key** on, every change sets a key there (off: a change is held until you press `K`, and let go when the playhead moves).
- **Viewport.** *Workspace*: look round freely; drag a bar, a string handle, the camera or the point it looks at. The camera's path is drawn. *Through camera*: the viewport is the shot, and moving the view moves the camera.
- **Timeline.** Click or drag the ruler to scrub; drag a diamond to retime a key; double-click a track to set a key; `Space` plays, `,` `.` step a frame, `←` `→` go to the previous / next key, `Del` removes the selected key, `⌘Z` undoes.
- **Bezier paths.** Whatever travels through space — the camera, what it looks at, a bar — goes along a cubic Bezier curve through its keys, never a line with corners. *Path roundness* on a key scales the curve there (0 makes a corner).
- **Easing.** Each key carries the timing curve for the stretch to the next key: a preset (linear, ease in / out / in-out, swift, overshoot, anticipate) or your own, drawn on the graph as a `cubic-bezier`. String handles move straight from key to key, eased.
- **Files.** Saved in this browser as you work; **Export** / **Import** JSON.

Nothing is posed directly: a key is a target for the control layer, exactly what a phone or a one-tap move produces, so strings, collisions and balance behave as on stage.

## How it fits together

| Path | What it is |
| --- | --- |
| `site/js/shared/rig-config.js` | The puppet as data: 19 bodies, 18 joints (limits, tone, torque), 2 control bars, 12 handles, 12 strings, 4 IK effectors. |
| `site/js/shared/puppet-shapes.js` | The puppets' solid form, once: a table of lathe-turned pieces per model (49 for the Gentleman; the Ballerina and the Knight are other tables on the same bodies). The rendered meshes, the physics colliders and the string collision shapes are all built from the chosen table. |
| `site/js/shared/modes.js` | The six control configurations and the Custom Rig JSON schema. |
| `site/js/shared/mapping.js` | Motion mapping engine (sensitivity, dead zone, smoothing, curve, clamp, invert). |
| `site/js/shared/string-path.js` | String-versus-puppet collision: routes a string over the surface of any piece it would cut through, its own limb included. Shared by the simulation and both renderers. |
| `site/js/shared/string-shape.js` | The shape a string is drawn with: on its route when tight, hanging free from its two ends when it has spare length, and the gradual change between the two. Shared by both renderers. |
| `site/js/shared/protocol.js` | Binary packets for the unreliable channel, JSON for the reliable one. |
| `site/js/shared/net.js` | Signaling client and WebRTC link (two data channels). |
| `site/js/stage/avbd.js` | The physics solver: Augmented Vertex Block Descent for rigid bodies — joints with limits and motors, frictional contacts, inextensible strings. No dependencies. |
| `site/js/stage/sim.js` | The puppet on that solver: control rig, string routing, contact detection, IK, balance, safety guards. |
| `site/js/shared/gestures.js` | The one-tap moves (bow, wave, cheer, salute, kicks…), shared by the stage that plays them and the phone that lists them. They take turns: tapping a new one makes the one playing bow out over a third of a second (stacked, they threw the puppet about). |
| `site/js/stage/world.js` | The puppet's world as every desktop page shows it: simulation, control layer, theatre, meshes, strings, and the loop that steps the physics and draws a frame. The stage, the Marionette editor and the Studio are all built on it. |
| `site/js/shared/marionette.js` | The saved marionette (model, strings and rods) and the eight traditional stringings. |
| `site/js/shared/timeline.js` | The Studio's keyframe engine: tracks, keys, `cubic-bezier` easing, Bezier paths, sampling. Plain data, no DOM. |
| `site/js/studio/*` | The two workbench pages: `editor.js` (Marionette editor), `studio.js` (Studio), the orbit camera and viewport picking, small UI helpers. |
| `site/js/stage/control.js` | Phone input → bar / handle / IK / motor targets; gait; idle animation. |
| `site/js/stage/debug.js` | Debug mode: movement routines and live measurements, loaded only with `?debug`. |
| `site/js/stage/scene.js` | Theatre set, lighting, post-processing, adaptive quality. |
| `site/js/controller/*` | Sensors + calibration, top-down board, touch, Custom Rig editor. |
| `site/signal.php` | Minimal PHP signaling (temporary session files). |
| `site/functions/api/signal.js` | The same contract as a Spacefast Function, for hosts that do not execute PHP. |

The client probes `signal.php` first and falls back to `/api/signal`. Spacefast does not execute uploaded PHP, so the published Space uses the Function; any PHP host uses `signal.php`.

Connectivity: STUN only. Devices on the same Wi-Fi connect directly; some carrier / corporate networks will not without a TURN relay — the pairing ticket and the phone's failure message both say to use the same Wi‑Fi.

## Physics notes

- **Solver.** The puppet is solved by *Augmented Vertex Block Descent* (Giles, Diaz, Yuksel, SIGGRAPH 2025), implemented in `avbd.js` after the paper and the first author's reference code. Each step is one implicit solve in which every body takes a Newton step on its own 6×6 block and every constraint then updates its multiplier and penalty. Joints, joint limits, the muscle-tone motors, contacts with friction and the strings are all rows of that one solve, so they are resolved against each other rather than one after another. It uses the reference's stabilisation and warm start (α = 0.99, γ = 0.999).
- **Physics takes what the frame has to spare.** The stage aims at 60 fps. Each frame it measures how long physics and everything else took, and moves between 120 and 960 physics steps per second (4–5 solver sweeps each) so that physics fits in what is left: smaller steps when there is room — accuracy rises steadily with the step rate, see `tools/solver-bench.mjs` — and larger ones on a slow machine or a heavy frame. The stats line (`d`) shows the current rate; `?fixed` in the URL pins it at 240 Hz × 5. Strings are re-routed round the limbs about 120 times a second whatever the step rate.
- **Rapier is geometry only.** It builds the convex hulls, gives their mass, centre of mass and inertia, and answers closest-point queries between them. It never steps the puppet.
- **Strings do not stretch and only pull.** A string is one hard, one-sided constraint on the length of its path, with a tension ceiling of a few times the puppet's weight (beyond it the string gives, as a puppeteer's hand would). A string that is suddenly far too short — pulled in hard, or re-tied while the puppet lies on the floor — is taken in at 2 m/s rather than in one step.
- **A link can be a rod.** With `kind: 'rod'` the same length constraint is two-sided: the rod holds its ends exactly its length apart, pushing as well as pulling, up to its strength. It has no slack, goes straight from handle to eye and does not wrap round anything (so, unlike a string, it can be drawn through a limb it is forced past). A rod knocked off its length — its handle snatched away faster than its strength can follow — comes back at 0.6 m/s.
- **Strings collide with the puppet,** including the limb they are tied to. Where a string would pass through a piece, via points are placed on its surface and the string becomes a polyline through them; each via point is a frictionless pulley, so the wood deflects the string and the string presses on the wood. The route is carried from one moment to the next — via points move with their limbs and slide to where the string presses — and a wrap is given up only when the string has really come off: the bend round the limb has opened, or the string has slid off the limb's end. A limb that pushes through a taut string therefore takes the string with it, hooked round its far side, instead of passing through; and the drawn string and the physics share one memory of what each string is caught on, so a loop of slack that has caught on a limb pulls on that limb when the string goes tight. The tie point is a screw eye standing 12 mm off the wood, so a string leaves the limb rather than lying on it.
- **A string is drawn as one chain.** Loose or tight, what is on screen is a chain of 45 points that falls a little each step (if the string has spare length), is kept to the string's length, and is kept out of the wood and off the floor — its points and the links between them. A tight string is the chain pulled as short as its way round the limbs allows; a slack one hangs, and a loop of slack lies on a shoe rather than falling through it. The chain never jumps to a shape worked out elsewhere: it is drawn towards the physics' tight route a few millimetres per step and put back outside the wood whenever a step would take it in, so a string moves continuously and one caught round a limb stays caught until the limb lets it go. It is checked against every piece near where it and its route actually lie (not just near the straight line between its ends, which a wrapped string or a wide loop is far from). A limb that swings onto a string takes the string with it — each point goes where the limb's face carries it, not out by the nearest side — and a string squeezed between two limbs (in the crook of a knee, between an arm and the body) stays in the gap instead of being thrown out of it. No correction moves a point more than two or three centimetres in a step. Slack close to the tie turns with the limb it is tied to (a loop beside a foot goes round with the foot instead of the shoe turning into it), and if the end of a string still cuts through its own limb after all that, just that stretch is put on the router's way round the limb, a point on every corner. What is drawn closes any gap to the chain by half per frame, and its sideways movement may grow at most 2.4-fold from one frame to the next (19 mm needs no run-up): a string set moving reaches any speed within a few frames, but cannot be in one place and somewhere else the next. Spare length is eased in (a string with a millimetre to spare would otherwise twitch by centimetres), a chain that has settled is frozen until something near it moves, and when a string is about to go tight the chain tells the router which side of each limb it is on. This is how the string is drawn, not a force on the puppet (a slack string exerts none). A snapped string dangles from its handle.
- **Strings and the floor.** No string goes under the stage floor: a loose one lies on it, and a tight one passing a limb that lies on the floor goes over the limb, not under it.
- **Strings have weight.** 6 g per metre: the part of a string lying on a limb rests on that limb, and a stretch hanging free is shared by whatever holds it up at either end. It is a few hundredths of a newton on a hand — small beside the wood, but not nothing.
- **Tangling is optional, and off.** With `k` (or the Tangles button, or `?knots`) the strings also catch on each other: the drawn chains cannot pass through one another, and where two strings press on each other, both under tension, that crossing holds — both are routed through it in the drawing and in the physics, and it moves to where the two pulls balance, so pulling one string drags on the other. Reset untangles. Off, strings pass through each other as before.
- **Joints have friction.** Every joint resists turning a little, in proportion to the inertia of the limb swinging from it. Without it a limb set swinging takes most of a minute to hang still (and the lightest parts never quite do); with it the puppet stands motionless a few seconds after it is let be.
- **What you see is what collides.** Every solid piece is a surface of revolution described once in `puppet-shapes.js`; the mesh is lathed from it, the collider is a convex hull of the same surface, and mass is spread evenly through it. Every part collides with every other part; only directly jointed neighbours are exempt. Contacts are created shortly before surfaces touch, which is what stops fast limbs passing through each other between steps.
- **Joint angles.** A hinge is measured by its turn about its axis; a ball joint by its rotation vector, which stays smooth for any pose a limb can reach. Joint locks narrow the limits to the current pose (a hard stop, not a stiff spring).
- **Known limits.** Strings do not collide with the control bars, and with each other only when tangling is switched on; a crossing that holds is a point both strings pass through, not a knot with friction, and it reaches the physics a frame late. Thrown about far harder than a phone can ask for (limbs at 3–4 m/s, half a metre of string hauled in and out), no string jumps and none is in its own limb (none in twenty minutes of it over sixty starts), but one still clips another limb in about 0.03 % of string-frames (a frame in several minutes of gentle play); `tools/string-test.mjs` measures all of it over several starts. A tight string wound round several limbs can still switch to a shorter route at once (drawn as a quick slide). Two knowing departures from the paper: angle rows keep a fixed penalty, and joint-limit multipliers take only a third of each update — with a full update they flipped on and off from sweep to sweep, and the result depended on whether the number of sweeps was odd or even.

## Tests (Node 22+)

```bash
node tools/sim-test.mjs          # hang, lift, shake, IK, collapse, recover, strings vs the real meshes
node tools/control-test.mjs      # protocol round trips, every mode, walking, two phones, locks
node tools/rod-test.mjs          # rods: push and pull, calm at rest and thrown about, restringing, the saved stringing
node tools/marionette-test.mjs   # every puppet on every traditional stringing: stands, keeps still, thrown about, reset; the saved document
node tools/studio-test.mjs       # the Studio's keyframe engine (easing, Bezier paths, files) and an animation played on the puppet
node tools/string-test.mjs       # drawn strings: still, idle, gentle play, thrown about, moves tapped in a hurry, hanging, lying, a foot jolted at random — jumps, strings in the wood, strings under the floor
node tools/tangle-test.mjs       # optional tangling: strings catch on each other, hold, drag, and do nothing when nothing touches
node tools/solver-bench.mjs      # solver settings compared on a hard scenario (calm, joint gaps, limits, overlap, cost)
```

## License

MIT — see `LICENSE`. Bundled third-party code in `site/vendor/` keeps its own licence: three.js r187 (MIT), Rapier 0.21 (Apache-2.0), qrcode-generator 2.0.4 (MIT). `site/js/stage/avbd.js` follows the AVBD reference solver by Chris Giles (MIT).
