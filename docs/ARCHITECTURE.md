# Architecture

## Layers

| Folder | What lives there | Rules |
|---|---|---|
| `js/core/` | clock (integer game-minutes), seeded RNG, event bus, constants | no game knowledge |
| `js/sim/` | the whole simulation | pure: never touches the DOM; reports facts on the bus |
| `js/ui/` | DOM, canvases, dialogs | reads sim state, calls sim functions, listens to the bus |

`js/main.js` boots `js/ui/app.js`, which creates or loads a game and runs a `GameLoop` (`sim/game.js`) from `requestAnimationFrame`.

## State

One plain, serializable object holds the game. Keys starting with `$` are runtime-only (caches, per-minute scratch, an open comms channel) and are stripped from saves. `sim/save.js` saves and loads it. A save from any other schema (the current one is 6: v0.12 rebuilt the interiors, the stations and their orbits) is refused with a message to start a new game; there are no migrations. A save of the current schema is brought up to date in place (`upgradeState`) for anything that can be filled in.

Main branches of the state:

| Key | Module | |
|---|---|---|
| `flight`, `autopilot` | flight.js, autopilot.js, nav.js, guidance.js, stance.js | our ship's motion, plans (routes and stances) and guidance |
| `ship` (`decks`, `crew`, `classId`, `tl`) | ship-layout.js, crew.js, crew-ai.js | interior, people |
| `systems`, `reactor`, `lifeSupport`, `jobs` | systems.js, reactor.js, life-support.js, jobs.js | machinery and the work it makes |
| `hull`, `magazine`, `combat` | combat.js, damage.js | structure, torpedoes aboard, fire control |
| `law` | law.js | standing and wanted level with each power |
| `politics` | conflict.js | tension, hot zones, encounter pacing |
| `entities` | world.js and many | every other object in space (stations carry their berth table, and a combat state once they are in a fight) |
| `dock` | docking.js | the dock under way: target, berth, our collar, phase, our place in the berth's frame |
| `tc` | traffic-control.js | the station whose space we are in, the zone, our clearances, the warnings given |
| `boarding` | boarding.js | a boarding party's operation |
| `dossier` | manifest.js | what we have learned about other ships (crew, passengers, routes) and from where |
| `intel` | intel.js | the plot: reports with an age (lost contacts, traffic digests, news), the inbox of news in flight, the zones we have heard of |
| `traffic` | traffic.js, forces.js | population target, and whether the background forces run |
| `missions`, `contracts`, `comms`, `sensors` | … | |

## The minute

`minuteTick` (sim/game.js) advances one game-minute in a fixed order, the same at 1 min/s and at 1 day/s:

0. The gravity epoch is set to the minute (`setGravityEpoch`): everything flown this minute falls under the bodies where they are now (gravity.js).
1. Machinery limits (and the 0.1 G cap inside a station's gate, lifted while pulling up off a rock); the dock moves along its phases; the autopilot or a hand on the stick decides the command, with the terrain guard over it (terrain.js).
2. **Our ship flies** (`flightStep`), or, held by a dock, flies the rest of the minute second by second in the berth's frame (`finishMinute`).
3. Clock +1; the world brings entities near us up to date (`world.tick`).
4. **NPC ships fly** on the commands they chose last minute, their pilots' terrain guard over them (`moveAgents`); one that came down on a rock is wrecked there.
5. Station-keeping (holding formation with a station, a ship, a convoy, a slot), or the dock puts us where it holds us (`dockHold`); either costs the thrust gravity doesn't give.
6. **Ordnance flies** and is checked against its targets over the minute just flown (`combatMove`): intercepts, hits, detonations; rounds that meet the ground are spent. Then, if we flew free, the ground (`terrainTick`: call-outs, contact).
7. Inertial events, then people: G-loads, physiology, crew AI, needs.
8. Plant: fires (fire.js), life support, reactor. A reactor that goes supercritical destroys the ship.
9. Sensors (contacts that drop off the board go onto the plot) and comms; traffic control (zones, rules, the radio); the dossier's thermal counts.
10. **The wider world**: combat decisions (NPCs choose next minute's command, fire weapons, make demands; our PDCs strafe), law, politics and the encounter director, distress calls, contracts, traffic, the background forces (hulls that came within reach wake), and the intel inbox (digests are published, reports that have arrived at light speed are delivered).

In step 10 also: station defenses, a boarding's minute, crew back from leave, our berth's lease.

All ships move before any torpedo is resolved, and every decision made in step 10 is flown in the next minute. This keeps cause and effect strictly ordered.

**The one exception inside a minute** is docking (docking.js): from the final approach on, our ship's place relative to the berth is integrated in whole seconds (`dock.t`). The game loop may fly those seconds one at a time at a slower rate (hand-flying), and the minute tick flies whatever is left of the minute, so headless runs and the browser agree. Nothing else changes inside a minute.

## Motion models (world.js)

| Model | Used by | Cost |
|---|---|---|
| `orbit`: analytic, on rails around a body | stations, parked ships, nav marks, wrecks off a body | O(1) at any time |
| `transit`: analytic brachistochrone between two rails entities, or from a coasting fix | NPC traffic, background forces | O(1) |
| free: integrated under solar gravity and constant thrust | drifting hulks | substeps |
| `driven`: stepped every minute by a controller | NPC ships with a pilot (agents.js), torpedoes and slugs (ordnance.js) | bounded count |

The world indexes entities by id, in a spatial hash, and keeps small sets: stations, distress beacons, driven entities, and the background forces (`world.forces`, a few hundred hulls). `world.driven` is the only set the per-minute combat code iterates. Traffic control and station defenses look only at `world.stations` (a busy port's hash cell holds thousands of ships). The forces' wake check walks `world.forces` once a minute.

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
| `stage.js` | the main view's slots and layouts: cruise (the interior), near (an inset exterior camera), prox (the exterior and the docking display, the interior inset), docked (the interior beside the exterior); `atmo` is reserved for entry. Everything laid over the view (route, traffic control, docking display, the inset, prompts, the hold indicator, the radio ticker) stacks in one column to the right of the ship (`#stage-col`, css/stage.css), so no window covers another |
| `exterior.js`, `hull-art.js` | the exterior at true scale, drawn at the moment between sim minutes the frame stands for (rails exactly, free flight carried on its velocity and thrust, a step the sim takes in one go spread over a third of a second) (the rock under a surface port, stations, berthed ships posed at their collars, our hull, the corridor); drawing any hull or station from its model, also for the tactical display, the ship picker, the library and the contact panel |
| `docking-hud.js` | the docking display: the docking camera, tapes, the capture envelope, AUTO/MANUAL, rates, abort, undock, and the hand-flying keys |
| `comms.js`, `ticker.js` | the comms window (channels, conversation, what we know of them, trade over the collar), and the radio ticker over the main view |
| `boarding.js` | the boarding window: the party, then the operation as it runs |
| `context.js` | the shared `ui` object: live state, loop, settings, selection |
| `hud.js` | top bar (clock, warp, battle stations, nav/space/threat chips), ship status, stores |
| `ship-view.js` | the SVG cross-section of the decks and crew (tile art in `js/svg-icons.js`) |
| `selection.js` | the side panel for a selected crew member or console |
| `nav.js` | the navigation modal: TACTICAL, SOLAR, SCANNER and COMBAT tabs; route planning; route and stance status |
| `solar-map.js` | the solar map: bodies, influence, and what we know: live contacts, charted orbits, the plot's reports aged and with their uncertainty, light-time rings; layer filters (stations, ships), a pick list for crowds, and search by name (nav.js) |
| `stance.js` | the stance panel (order, range, drive, band, doctrine, preview), and one-click stances for fire control |
| `library.js` | the ship's library: reference pages built from the simulation's own tables (classes, tech, systems, fittings, weapons, navigation, factions, stations); anything marked `data-lib` opens its page |
| `tac.js`, `solar-map.js`, `scanner.js`, `combat.js` | the four canvases (`combat.js` also renders the fire-control panel). Ships are clickable on all four: the tactical view and the scanner open the contact panel, the solar map the body or report panel, the combat board targets |
| `dialogs.js` | generic dialog, missions log, jobs, distress calls and comm requests, the station window (board, deliveries, services, hiring, leave, the traffic board) |
| `shipboard.js` | engineering board, duty roster, words for activities and jobs |
| `presenter.js`, `fx.js`, `log.js`, `toast.js` | how events are shown |
| `persistence.js`, `settings.js`, `../storage.js` | IndexedDB saves and settings |

CSS lives in `css/main.css` (the original design system: tokens, pixel type, teal/amber), `css/ui.css` (components added since v0.8, combat at the end) and `css/stage.css` (the stage, the exterior, docking, comms, boarding, the map's search).

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
| docking | hulls and interiors that agree, stations where they should be, berths and the anchorage, traffic control's rules, docking at every station by the computer and by hand, undocking, ship to ship, boarding, salvage, station guns, manifests, the hiring hall and leave, berth leases, saves mid-dock |
| port | gravity near the rocks and what holding costs, the ground and its call-outs, the terrain guard on routes round a rock, holding patterns at every port, traffic's port calls, port space and holding clearance |
| fire | fires grow and are fought; venting starves them; the SUITS order |

Tests are seeded (`seedRandom`). Suites that aren't about encounters switch them off with `s.politics.quietUntil = Infinity` and `s.missions.cooldown = 1e9`. Suites that aren't about docking start holding at Ceres' gate (`createGame({ docked: false })`) instead of in a berth; `tests/helpers.mjs` has `dockHere` for the ones that need to dock.
