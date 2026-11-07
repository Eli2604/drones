# drones: swarm flight control and 3D simulator

Flight-control algorithms for a cooperative drone swarm, plus a browser-based 3D simulator to verify and demonstrate them.

The swarm flies from an origin to a destination as one unit:

- **One leader, handed over when needed.** The swarm elects a leader. The leader hands over control when its battery runs low. If the leader disappears, the swarm elects a new one within ~2–3 s.
- **Reorganises on dropouts.** When a drone drops out (crash, radio loss or battery), the leader reassigns formation slots and the mission continues.
- **Low-energy radio.** Each drone transmits only as far as it needs to, and messages are relayed over several hops. Radio energy is ~85% below always-full-power.
- **Navigation without GPS.** Each drone dead-reckons from its own odometry. Radio packets double as range measurements between drones, which keep the formation geometry consistent. Grouped telemetry anchors the swarm's shared frame to the average of all odometers. Camera recognition of known landmarks corrects the absolute position.
- **Reacts to enemy fire.** A drone that is shot at jinks. It shares where the fire came from, the leader spreads the formation out and reroutes around located threats, and a commander under fire hands command to a drone out of range. This halves losses compared with no reaction (`npm run sweep:combat`).
- **Any formation, including 3D.** Pick from presets or design your own; the leader sends the slot geometry with its heartbeat.

## Run

Requires Node 18+ (no dependencies to install). Three.js loads from a CDN.

```bash
npm start              # http://localhost:5173
npm test               # algorithm tests (headless)
npm run sweep          # robustness sweep: 4 terrains x 40 seeds, 3 injected failures each
npm run sweep:combat   # enemy fire: losses with / without the swarm's reactions
npm run ui-check       # drives headless Chrome through the UI (needs npm start running)
```

### Using the simulator

| Control | What it does |
| --- | --- |
| **Demo scenario** (top left) | Leader loss, storm crossing, mountain pass + no-fly zone, ambush (anti-air), 3D formations showcase, dense fog |
| **Click places** (top bar) | Origin, Destination, Landmark, No-fly zone, AA site (anti-air), or 🎯 Shoot (click a drone to shoot it down) |
| **Terrain** | Preset, plus Max height, Roughness, Hill density, Sharp ridges, Carve valley |
| **Swarm / formation** (live) | 12 preset formations, many truly 3D (diamond = octahedron, star, sphere, box, helix), **Vertical spread**, Spacing, and **✎ Design custom formation…**: draw your own in a top and a side view |
| **Enemy fire** | Random or placed anti-air sites with range, rate of fire, hit probability, targeting (commander first / nearest / random); switch the swarm's reactions and commander handover on/off live |
| **Weather** (live) | Wind speed/direction, gusts, turbulence, rain, fog, or the presets Clear / Breezy / Storm / Fog |
| **Kill / fail a drone** | ✖ in the drones table, 🎯 Shoot mode in the 3D view, or select a drone (click it) and use the panel: Shoot down / Radio off / Battery fault. Failures can also be scheduled, or randomised (chaos mode) |
| **Operator** | Force a leader handover, or replan the route |
| **View** | Follow the swarm, position estimates (cyan ghosts = where each drone *thinks* it is), radio links, formation slots, trails, route |
| **Scenario file** | Export or import the full scenario as JSON, for reproducible demos |

Keys: `Space` start/pause · `K` kill leader · `Z` zoom to swarm · `O` overview · `F` follow · `Esc` back to view mode.

URL options for unattended demos: `?demo=ambush&autorun=1&speed=4&zoom=1&follow=1&skip=60`
(`demo` = `leader-loss` | `storm` | `mountain-pass` | `ambush` | `formation-3d` | `gnss-denied-fog`; `skip` fast-forwards N seconds; `designer=1` opens the formation designer).

## Layout

```text
src/core/      pure JS, no DOM; runs in Node and the browser
  sim.js           orchestrator: world, swarm, failure injection, metrics
  drone.js         one drone: election/handover protocol, guidance, control, physics, energy
  localization.js  dead reckoning + ranging + grouped telemetry + landmark fixes
  comms.js         radio model: adaptive power, loss, multi-hop, ranging, energy
  planner.js       energy/wind-aware A*, smoothing, terrain-following altitudes
  formation.js     formation geometry (2D/3D presets, custom) and slot assignment
  terrain.js, weather.js, config.js, demos.js, vec.js, rng.js
src/ui/        Three.js viewer, controls, formation designer
tests/         node:test suite
tools/         dev server, robustness/combat sweep, browser UI check
docs/          architecture and algorithm notes
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the algorithms work and what the simulator does and does not model.
