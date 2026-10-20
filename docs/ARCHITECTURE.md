# Architecture

## Layers

| Folder | What lives there | Rules |
|---|---|---|
| `js/core/` | clock (integer game-minutes), seeded RNG, event bus, constants | no game knowledge |
| `js/sim/` | the whole simulation | pure: never touches the DOM; reports facts on the bus |
| `js/ui/` | DOM, canvases, dialogs | reads sim state, calls sim functions, listens to the bus |

`js/main.js` boots `js/ui/app.js`, which creates or loads a game and runs a `GameLoop` (`sim/game.js`) from `requestAnimationFrame`.

## State

One plain, serializable object holds the game. Keys starting with `$` are runtime-only (caches, per-minute scratch) and are stripped from saves. `sim/save.js` saves and loads it. A save from any other schema (the current one is 5) is refused with a message to start a new game; there are no migrations. A save of the current schema from v0.10 is brought up to date in place (`upgradeState`): it gets a plot, its traffic is raised to the default population, and the background forces are raised.

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
| `intel` | intel.js | the plot: reports with an age (lost contacts, traffic digests, news), the inbox of news in flight, the zones we have heard of |
| `traffic` | traffic.js, forces.js | population target, and whether the background forces run |
| `missions`, `contracts`, `comms`, `sensors` | … | |

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
9. Sensors (contacts that drop off the board go onto the plot) and comms.
10. **The wider world**: combat decisions (NPCs choose next minute's command, fire weapons, make demands; our PDCs strafe), law, politics and the encounter director, distress calls, contracts, traffic, the background forces (hulls that came within reach wake), and the intel inbox (digests are published, reports that have arrived at light speed are delivered).

All ships move before any torpedo is resolved, and every decision made in step 10 is flown in the next minute. This keeps cause and effect strictly ordered.

## Motion models (world.js)

| Model | Used by | Cost |
|---|---|---|
| `orbit`: analytic, on rails around a body | stations, parked ships, nav marks, wrecks off a body | O(1) at any time |
| `transit`: analytic brachistochrone between two rails entities, or from a coasting fix | NPC traffic, background forces | O(1) |
| free: integrated under solar gravity and constant thrust | drifting hulks | substeps |
| `driven`: stepped every minute by a controller | NPC ships with a pilot (agents.js), torpedoes and slugs (ordnance.js) | bounded count |

The world indexes entities by id, in a spatial hash, and keeps small sets: stations, distress beacons, driven entities, and the background forces (`world.forces`, a few hundred hulls). `world.driven` is the only set the per-minute combat code iterates. The forces' wake check walks `world.forces` once a minute.

## Level of detail and scale

The target is more than 200,000 entities. The rules:

- Entities near us refresh every minute. The far world refreshes round-robin under a per-frame budget (`world.background`), so its positions are at most about an hour stale.
- Traffic never thinks. It becomes an **agent** (a driven ship with an AI) only when something near us needs it to act: a pirate picks it as prey, we open fire on it, a contract needs it.
- The background forces (police, navies, pirates: forces.js) are on rails too, and wake as agents within 0.1 AU of us. Agents from the population go back on rails when their business is done and we are far away; walk-ons from the director and contracts leave the simulation.
- Conflict away from us has outcomes, not simulations: each hour a zone may cost one of the real ships on station there, or one in its lanes, which becomes a wreck.
- What the player knows is bounded too: the plot holds at most 6,000 reports, digests are capped at 400 ships, and the inbox holds a few dozen items in flight (intel.js).
- Ordnance exists only where it was launched. The count is small, and every torpedo has a lifetime.

`tests/game.test.mjs › scale` checks the per-minute budget at 200k ships, and `tests/intel.test.mjs › scale` the default system (3,000 traffic, the forces): about 0.07 ms per game-minute, and a 2 MB save. The 200k timing is sensitive to machine load.

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
| `solar-map.js` | the solar map: bodies, influence, and what we know: live contacts, charted orbits, the plot's reports aged and with their uncertainty, light-time rings |
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
| intel | light lag, the plot and its accuracy, traffic digests, lost contacts, the background forces (strength, deployment, unseen war, the live window), upgrading v0.10 saves, the default system's cost |

Tests are seeded (`seedRandom`). Suites that aren't about encounters switch them off with `s.politics.quietUntil = Infinity` and `s.missions.cooldown = 1e9`.
