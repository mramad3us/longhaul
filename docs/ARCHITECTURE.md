# Architecture

## Layers

| Folder | What lives there | Rules |
|---|---|---|
| `js/core/` | clock (integer game-minutes), seeded RNG, event bus, constants | no game knowledge |
| `js/sim/` | the whole simulation | pure: never touches the DOM; reports facts on the bus |
| `js/ui/` | DOM, canvases, dialogs | reads sim state, calls sim functions, listens to the bus |

`js/main.js` boots `js/ui/app.js`, which creates or loads a game and runs a `GameLoop` (`sim/game.js`) from `requestAnimationFrame`.

## State

One plain, serializable object holds the game. Keys starting with `$` are runtime-only (caches, per-minute scratch) and are stripped from saves. `sim/save.js` saves and loads it and migrates older schemas forward: v0.7, schema 2 (v0.8) and schema 3 (v0.9) all load into schema 4 (v0.10).

Main branches of the state:

| Key | Module | |
|---|---|---|
| `flight`, `autopilot` | flight.js, autopilot.js, nav.js, guidance.js | our ship's motion, plans and guidance |
| `ship` (`decks`, `crew`, `classId`, `tl`) | ship-layout.js, crew.js, crew-ai.js | interior, people |
| `systems`, `reactor`, `lifeSupport`, `jobs` | systems.js, reactor.js, life-support.js, jobs.js | machinery and the work it makes |
| `hull`, `magazine`, `combat` | combat.js, damage.js | structure, torpedoes aboard, fire control |
| `law` | law.js | standing and wanted level with each power |
| `politics` | conflict.js | tension, hot zones, encounter pacing |
| `entities` | world.js and many | every other object in space |
| `missions`, `contracts`, `comms`, `sensors`, `traffic` | … | |

## The minute

`minuteTick` (sim/game.js) advances one game-minute in a fixed order, the same at 1 min/s and at 1 day/s:

1. Machinery limits; the autopilot or a hand on the stick decides the command.
2. **Our ship flies** (`flightStep`).
3. Clock +1; the world brings entities near us up to date (`world.tick`).
4. **NPC ships fly** on the commands they chose last minute (`moveAgents`).
5. Station-keeping (holding formation with a station, a ship, a convoy).
6. **Ordnance flies** and is checked against its targets over the minute just flown (`combatMove`): intercepts, hits, detonations.
7. Inertial events, then people: G-loads, physiology, crew AI, needs.
8. Plant: life support, reactor. A reactor that goes supercritical destroys the ship.
9. Sensors and comms.
10. **The wider world**: combat decisions (NPCs choose next minute's command, fire weapons, make demands; our PDCs strafe), law, politics and the encounter director, distress calls, contracts, traffic.

All ships move before any torpedo is resolved, and every decision made in step 10 is flown in the next minute. This keeps cause and effect strictly ordered.

## Motion models (world.js)

| Model | Used by | Cost |
|---|---|---|
| `orbit`: analytic, on rails around a body | stations, parked ships, nav marks, wrecks off a body | O(1) at any time |
| `transit`: analytic brachistochrone between two rails entities | NPC traffic | O(1) |
| free: integrated under solar gravity and constant thrust | drifting hulks | substeps |
| `driven`: stepped every minute by a controller | NPC ships with a pilot (agents.js), torpedoes and slugs (ordnance.js) | bounded count |

The world indexes entities by id, in a spatial hash, and keeps small sets for stations, distress beacons and driven entities. `world.driven` is the only set the per-minute combat code iterates.

## Level of detail and scale

The target is more than 200,000 entities. The rules:

- Entities near us refresh every minute. The far world refreshes round-robin under a per-frame budget (`world.background`), so its positions are at most about an hour stale.
- Traffic never thinks. It becomes an **agent** (a driven ship with an AI) only when something near us needs it to act: a pirate picks it as prey, we open fire on it, a contract needs it. Agents leave the simulation when their business is done or we are far away.
- Conflict away from us has outcomes, not simulations: hot zones produce wrecks and news without running ships.
- Ordnance exists only where it was launched. The count is small, and every torpedo has a lifetime.

`tests/game.test.mjs › scale` checks the per-minute budget at 200k ships.

## Events

The sim emits facts (`torpedo-hit`, `crime`, `comm-request`, …). `ui/presenter.js` is the one place that decides how a fact is shown (log, toast, dialog). `ui/fx.js` keeps positioned combat effects for the canvases.
