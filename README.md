# drones: swarm flight control and 3D simulator

Flight-control algorithms for a cooperative drone swarm, plus a browser-based 3D simulator to verify and demonstrate them.

The swarm flies from an origin to a destination as one unit:
- **One leader, handed over when needed.** The swarm elects a leader. The leader hands over control when its battery runs low. If the leader disappears, the swarm elects a new one within ~2–3 s.
- **Reorganises on dropouts.** When a drone drops out (crash, radio loss or battery), the leader reassigns formation slots and the mission continues.
- **Low-energy radio.** Each drone transmits only as far as it needs to, and messages are relayed over several hops. Radio energy is ~85% below always-full-power.
- **Navigation without GPS.** Each drone dead-reckons from its own odometry. Radio packets double as range measurements between drones, which keep the formation geometry consistent. Grouped telemetry anchors the swarm's shared frame to the average of all odometers. Camera recognition of known landmarks corrects the absolute position.

## Run

Requires Node 18+ (no dependencies to install). Three.js loads from a CDN.

```bash
npm start          # http://localhost:5173
npm test           # algorithm tests (headless)
npm run sweep      # robustness sweep: 4 terrains x 40 seeds, 3 injected failures each
```

### Using the simulator

| | |
|---|---|
| **Demo scenario** (top left) | Ready-made scenarios: leader loss, storm crossing, mountain pass + no-fly zone, dense fog |
| **Set origin / destination** | Click a mode, then click the terrain. Changing the destination mid-flight makes the leader replan |
| **Add landmark / no-fly zone** | Places a recognisable landmark, or a 150 m no-fly cylinder (the route is replanned) |
| **Weather** (live) | Wind speed/direction, gusts, turbulence, rain, fog, or the presets Clear / Breezy / Storm / Fog |
| **Failures** | Inject a crash, radio failure or battery fault on the leader, the selected drone or a random drone; schedule failures at a given time; chaos mode |
| **Operator** | Force a leader handover, or replan the route |
| **View** | Follow the swarm, position estimates (cyan ghosts = where each drone *thinks* it is), radio links, formation slots, trails, route |
| **Scenario file** | Export or import the full scenario as JSON, for reproducible demos |

Keys: `Space` start/pause · `K` kill leader · `Z` zoom to swarm · `O` overview · `F` follow · `Esc` back to view mode.

URL options for unattended demos: `?demo=storm&autorun=1&speed=4&zoom=1&follow=1&skip=60`
(`demo` = `leader-loss` | `storm` | `mountain-pass` | `gnss-denied-fog`; `skip` fast-forwards N seconds).

## Layout

```
src/core/      pure JS, no DOM; runs in Node and the browser
  sim.js           orchestrator: world, swarm, failure injection, metrics
  drone.js         one drone: election/handover protocol, guidance, control, physics, energy
  localization.js  dead reckoning + ranging + grouped telemetry + landmark fixes
  comms.js         radio model: adaptive power, loss, multi-hop, ranging, energy
  planner.js       energy/wind-aware A*, smoothing, terrain-following altitudes
  formation.js     formation geometry and slot assignment
  terrain.js, weather.js, config.js, demos.js, vec.js, rng.js
src/ui/        Three.js viewer and controls
tests/         node:test suite
tools/         dev server, robustness sweep
docs/          architecture and algorithm notes
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the algorithms work and what the simulator does and does not model.
