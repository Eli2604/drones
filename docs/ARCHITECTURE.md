# Architecture and algorithms

The algorithm code (`src/core`) is plain JavaScript with no DOM or I/O. It is written so the decision logic can be ported to the flight controller. Each drone decides **only** from its own estimated state (`loc.est`) and what it heard over the radio. True positions are used by the simulator for physics and scoring, plus two sensors that really measure them: the downward rangefinder and the short-range proximity sensor.

Simulation step: `dt = 0.1 s`. Per tick:

1. Deliver last tick's radio packets. Each packet also samples a two-way range at that moment.
2. Each drone: protocol timers, then relays, then guidance, then control, then physics, then sensing (odometry, camera), then energy.
3. Check for mid-air collisions and record metrics.

## 1. Leadership: election, handover, merge

The protocol is Raft-like, with *terms* and a fitness score instead of votes. Score = battery % + connectivity + position confidence + an incumbency bonus.

| Situation | Mechanism |
| --- | --- |
| Normal flight | The leader sends a heartbeat (HB) every `hbInterval` (0.5 s). It carries the leader's estimate, velocity, heading, waypoint index, formation slots and the group-odometry anchor. Followers send STATUS every 1 s. |
| Leader silent > timeout (randomised 2–3.5 s) | The follower starts an election with term + 1 and broadcasts ELECT(score). Better-scored drones counter with their own ELECT. After 1.5 s the best candidate becomes leader. |
| Healthy leader hears a stale election | It defends by bumping its term and re-sending HB, so a lost packet doesn't depose it. |
| Leader battery < 30% | **Graceful handover** to the best-scored follower (HANDOVER message). If that message is lost, followers time out and elect normally. |
| Two leaders meet (partition heals) | The leader of the larger group wins. The winner bumps its term so all followers converge on it. |
| Radio-failed drone | It can't hear anyone, so it elects itself a swarm of one and continues the mission alone with its copy of the route. |

## 2. Formation and reorganisation

- Formations: `v`, `line`, `column`, `wedge`, `echelon`, `diamond` (octahedron shells), `star` (5 tilted arms), `circle`, `sphere` (Fibonacci points), `box` (3D lattice), `helix`, `grid`, and `custom` (operator-designed, in spacing units). Shapes are defined in spacing units: horizontal offsets scale with *Spacing*, vertical offsets with *Spacing × Vertical spread*. Slot 0 is the leader.
- The leader computes the slot table and **sends the geometry itself in the heartbeat** (9 bytes per slot), so followers never need to know the shape's definition. Any custom shape just works, and changing the formation in flight is a single heartbeat away.
- For 3D shapes, the route is planned so that the *lowest* slot still keeps the cruise height above terrain, and the *highest* slot stays under the altitude ceiling.
- The leader recomputes the slot assignment whenever membership changes. A member is lost when its STATUS times out or it sends LEAVE. Assignment is greedy minimum-distance, so drones move as little as possible. A new formation version goes out in the next HB.
- Followers fly to `leader estimate (extrapolated) + slot offset` with a velocity feed-forward. The leader slows down when followers lag (cohesion factor).
- Before departure, the leader holds until every member is airborne (or 25 s have passed).

## 3. Low-energy communication

- **Adaptive transmit power**: transmit range = 1.4 × distance to the 3rd-nearest neighbour, scaled up for rain/fog fade. Energy per packet ∝ range². A drone that heard nothing for 1.5 s "shouts" at maximum range.
- **Direct link for critical messages**: HB is sized to reach the farthest member and STATUS to reach the leader. Without this, heavy rain caused membership flapping.
- **Multi-hop flooding** with TTL (default 3) and *distance-based relay suppression*: a drone skips relaying if a very close drone already transmitted the message. (An earlier count-based rule silenced exactly the drones needed in a long column.)
- Packet sizes are compact (HB ≈ 50 B, STATUS ≈ 40 B). The UI shows energy relative to always-full-power: about 85% saved.

## 4. Navigation without GPS

Layered, each layer verified by tests (mean nav error over 20 seeds, 7 drones, no landmarks unless stated):

| Layer | What it fixes | Mean error |
| --- | --- | --- |
| Dead reckoning (optical-flow/IMU velocity with scale error, bias random walk, noise; barometric altitude) | – | 11.0 m |
| + Cooperative ranging (every packet = UWB range to the sender; nudge the estimate to agree) | **Relative** geometry: error spread between drones shrinks 3–5× | 12.3 m |
| + Grouped telemetry (each drone keeps a ranging-free odometry track; the leader broadcasts mean(odo − est); everyone shifts by it) | The shared frame becomes the fair average of N independent odometers (≈ 1/√N drift) | 5.7 m |
| + Landmark fixes (camera recognises a landmark with known geolocation, within min(camera range, visibility)) | Absolute drift | 2.4 m |

Ranging alone does not lower the *absolute* error. It aligns the drones with each other, but the shared frame becomes a lopsided average (message rates are asymmetric). The grouped-telemetry anchor is what turns "independent drifts" into an averaging benefit.

**Odometry prior.** Ranging can only observe distances. In collinear geometry (line abreast, column, echelon) the along-track direction is unobservable, and the estimate could slide. The formation controller would then fly the drone after the bad estimate, which caused runaway errors of hundreds of metres. Every relative correction (ranging and group anchor) is therefore clamped so the estimate never moves further from the drone's own odometry track than 1.5σ + 5 m of odometry uncertainty. Odometry uncertainty grows linearly from scale/bias errors and as a random walk from white noise, and shrinks only at landmark fixes.

## 5. Path planning

The leader plans on board with its elevation map, the no-fly zones and the mean wind:

- A* on a 96 × 96 grid. Cost = distance × (1 + altitude preference + headwind penalty) + climb penalty. Cells are blocked where terrain + clearance exceeds the altitude ceiling or a no-fly zone (+ formation corridor) intersects.
- Line-of-sight smoothing that never crosses blocked cells or large terrain bumps the grid route avoided.
- Legs are subdivided to ≤ 120 m. Each waypoint altitude clears the highest ground within the formation corridor on both adjoining legs, so holding max(previous, next) altitude is always safe.
- Replanning happens on a new destination, a new no-fly zone, an operator request, or when a new leader has no route.

## 6. Guidance safety layers (in order)

1. Path / slot following.
2. **Terrain look-ahead** on the map (up to 90 m ahead): climb early, and slow horizontally if the climb rate can't clear a slope.
3. **Collision avoidance** from the proximity sensor (60 m, closest-point-of-approach). It cancels the closing velocity and separates vertically by id. It runs last so nothing overrides it.
4. Hard floor from the downward rangefinder (minimum height above ground) and the altitude ceiling.
5. Battery: land when below 15% *or* when remaining energy only just covers the descent from the current height. Use an emergency descent rate (6 m/s) if the margin is critical.

## 7. Enemy fire

**Threat model (ground truth, unknown to the swarm):** anti-air sites with an engagement range. They need line of sight, so terrain masks them; flying low behind hills is real cover. Each site fires at intervals of `interval` ± 20%. Hit probability = `hitProb` × (1 − 0.6·distance/range) × 0.45 if the target is evading × a speed factor. Targeting: commander first, nearest, or random.

**Swarm reaction** (`threats.reaction`, live-switchable):

| Level | Behaviour |
| --- | --- |
| Individual | A drone that is shot at performs evasive jinks for 4 s: random lateral ±7 m/s and vertical moves every 0.8 s. Collision avoidance still runs last. |
| Sensing | The target and drones within 220 m see the muzzle flash or tracer and estimate where the fire came from (error 15 m + 6% of distance). |
| Sharing | A THREAT message (flooded, 20 B) carries the estimated position. Every drone merges reports into its threat map; repeated reports refine the position. |
| Group | The formation disperses (horizontal ×1.7) for 20 s after the latest alarm. Every member remembers the alarm, so a new leader keeps the dispersal. |
| Route | On a newly located threat the leader replans around all known threats (range + 60 m margin). If no such route exists, it accepts the exposure. |
| Command | A commander under fire hands command to a healthy member *outside* the threat's estimated range. Handing over to a drone still in range was measured to be worse: it moves the target and costs a reshuffle. |

Measured (`npm run sweep:combat`, 3 random sites, commander targeted, 9 drones, 20 seeds):

| Variant | Arrived | Drones lost | Commanders lost | Mean arrival |
| --- | --- | --- | --- | --- |
| No reaction | 15/20 | 5.30 | 3.95 | 234 s |
| Reaction, no commander handover | 19/20 | 2.35 | 1.00 | 373 s |
| Full reaction | 18/20 | 2.25 | 1.00 | 352 s |

Reacting halves losses. The price is a longer route around located threats. Commander handover adds only a small gain on top. Non-arrivals with reaction on are runs where the whole swarm was shot down, typically by a site near the destination.

**Operator kills** use the same path as any failure (`injectFailure(id, 'shot')`): ✖ in the table, 🎯 Shoot mode, or the selected-drone panel.

## 8. Weather model

Wind = mean + gusts (spatio-temporal) + turbulence. Weather affects flight (quadratic drag relative to air), hover power (rain), odometry and ranging noise, radio range (rain/fog fade), camera visibility and recognition probability.

## Verification

- `npm test`: election, leader-crash re-election + reorganisation, battery handover + landing, mission completion with failures, the localisation layers, estimator bias with perfect sensors, planner no-fly/ceiling, slot assignment.
- `npm run sweep`: Monte-Carlo over terrains and seeds with a leader crash (30 s), a random radio failure (70 s) and a leader battery fault (100 s). Current result: 240/240 runs clean (no collisions, terrain strikes, battery depletion or split-brain).

Bugs the sweep and instrumentation caught, kept here so they aren't reintroduced:

- Range and estimate sampled at different instants, causing a systematic along-track bias.
- Odometry integrating the previous tick's velocity (estimate lags truth by v·dt). The zero-noise test guards this.
- Radio-based collision avoidance too stale; replaced by the proximity sensor.
- Terrain look-ahead overriding collision avoidance.
- Count-based relay suppression breaking propagation in column formations.
- Estimate runaway in collinear formations (line/echelon): unobservable along-track error amplified by the formation controller. Fixed with the odometry prior; verified per formation.
- A commander handover that only moved the target. Fixed by handing over to a drone outside the threat's range.

`npm run ui-check` drives the real UI in headless Chrome. It covers: killing from the table, selecting in 3D, the selection panel, 🎯 shoot mode, the designer (add, drag height, apply, the leader flies it), terrain sliders, placing AA sites, and checks for uncaught page errors.

## Not modelled / next steps

- Attitude dynamics: drones are point masses with acceleration limits.
- Real radio PHY / MAC: there are no collisions between packets, latency is one tick, and loss is distance-based.
- Landmark recognition is an oracle with noise (no image processing). Landmark identity is assumed correct.
- Enemy fire is hitscan: no projectile flight time, and all sites share the same range. Electronic warfare (jamming, GNSS spoofing) is not modelled.
- The terrain map (DEM) is assumed exact.
- A security layer (message authentication) is needed before real flights. A spoofed HB or ELECT could take over the swarm.
- Porting path: `drone.js` protocol and guidance → the companion computer; `localization.js` → an EKF with real sensor models.
