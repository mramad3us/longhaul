# Architecture

## Layers

| Folder | What lives there | Rules |
|---|---|---|
| `js/core/` | clock (integer game-minutes), seeded RNG, event bus, constants | no game knowledge |
| `js/sim/` | the whole simulation | pure: never touches the DOM; reports facts on the bus |
| `js/ui/` | DOM, canvases, dialogs | reads sim state, calls sim functions, listens to the bus |

`js/main.js` boots `js/ui/app.js`, which creates or loads a game and runs a `GameLoop` (`sim/game.js`) from `requestAnimationFrame`.

## State

One plain, serializable object holds the game. Keys starting with `$` are runtime-only (caches, per-minute scratch) and are stripped from saves. `sim/save.js` saves and loads it. A save from any other schema (the current one is 5) is refused with a message to start a new game; there are no migrations.

Main branches of the state:

| Key | Module | |
|---|---|---|
| `flight`, `autopilot` | flight.js, autopilot.js, nav.js, guidance.js, stance.js | our ship's motion, plans (routes and stances) and guidance |
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

## UI modules (`js/ui/`)

| Module | |
|---|---|
| `app.js` | screens, game lifecycle, frame loop wiring, dev tools, the `window.__longhaul` debug handle (`state`, `loop`, `step(n)`) |
| `context.js` | the shared `ui` object: live state, loop, settings, selection |
| `hud.js` | top bar (clock, warp, battle stations, nav/space/threat chips), ship status, stores |
| `ship-view.js` | the SVG cross-section of the decks and crew (tile art in `js/svg-icons.js`) |
| `selection.js` | the side panel for a selected crew member or console |
| `nav.js` | the navigation modal: TACTICAL, SOLAR, SCANNER and COMBAT tabs; route planning; route and stance status |
| `stance.js` | the stance panel (order, range, drive, band, doctrine, preview), and one-click stances for fire control |
| `library.js` | the ship's library: reference pages built from the simulation's own tables (classes, tech, systems, fittings, weapons, navigation, factions, stations); anything marked `data-lib` opens its page |
| `tac.js`, `solar-map.js`, `scanner.js`, `combat.js` | the four canvases (`combat.js` also renders the fire-control panel) |
| `dialogs.js` | generic dialog, missions log, jobs, hail, distress calls and comm requests, station board and services |
| `shipboard.js` | engineering board, duty roster, words for activities and jobs |
| `presenter.js`, `fx.js`, `log.js`, `toast.js` | how events are shown |
| `persistence.js`, `settings.js`, `../storage.js` | IndexedDB saves and settings |

CSS lives in `css/main.css` (the original design system: tokens, pixel type, teal/amber) and `css/ui.css` (components added since v0.8, combat at the end).

## Tests (`tests/`)

`node tests/run.mjs [filter]`. Each `*.test.mjs` default-exports `[{ name, fn }]`.

| Suite | Covers |
|---|---|
| flight | Lambert, brachistochrones, economy cruise, ballistic transfers, intercepts |
| guidance | how approaches look from the bridge: turns, wobbles, backing off, for stations, moons, bodies, intercepts, failing machinery and close starts |
| stance | stances held against coasting, thrusting, charging and fleeing ships and stations, the doctrine under fire, saves |
| game | whole-game integration, saves, SOS, contracts, the 200k-entity scale budget |
| crew | medicine, inertial events, breaches, reactor procedures, juice, FLANK |
| ship | watches, needs, wear and repair, hand flying, life support failures |
| combat | classes, torpedoes and PDC, dead reckoning, railguns, damage, fire control, patrols, pirates, surrender, saves |
| factions | influence, hot zones, the director, bounties |

Tests are seeded (`seedRandom`). Suites that aren't about encounters switch them off with `s.politics.quietUntil = Infinity` and `s.missions.cooldown = 1e9`.
