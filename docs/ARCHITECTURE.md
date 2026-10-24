# Architecture

## Layers

| Folder | What lives there | Rules |
|---|---|---|
| `js/core/` | clock (integer game-minutes), seeded RNG, event bus, constants | no game knowledge |
| `js/sim/` | the whole simulation | pure: never touches the DOM; reports facts on the bus |
| `js/ui/` | DOM, canvases, dialogs | reads sim state, calls sim functions, listens to the bus |

`js/main.js` boots `js/ui/app.js`, which creates or loads a game and runs a `GameLoop` (`sim/game.js`) from `requestAnimationFrame`.

## State

One plain, serializable object holds the game. Keys starting with `$` are runtime-only (caches, per-minute scratch, an open comms channel) and are stripped from saves. `sim/save.js` saves and loads it. A save from any other schema (the current one is 7: v0.17 brought licenses, sub-factions and the powers' relations; 6 was v0.12's interiors, stations and orbits) is refused with a message to start a new game; there are no migrations. A save of the current schema is brought up to date in place (`upgradeState`) for anything that can be filled in.

Main branches of the state:

| Key | Module | |
|---|---|---|
| `flight`, `autopilot` | flight.js, autopilot.js, nav.js, guidance.js, stance.js | our ship's motion, plans (routes and stances) and guidance |
| `ship` (`decks`, `crew`, `classId`, `tl`) | ship-layout.js, crew.js, crew-ai.js | interior, people |
| `systems`, `reactor`, `lifeSupport`, `jobs` | systems.js, reactor.js, life-support.js, jobs.js | machinery and the work it makes |
| `hull`, `magazine`, `combat` | combat.js, damage.js | structure, torpedoes aboard, fire control |
| `law` | law.js | standing and wanted level with each power |
| `politics` | politics.js, conflict.js | the powers' relations and phases, sub-factions' influence and rivalries, proxies, covert feuds, headlines; hot zones, encounter pacing |
| `service` | service.js, military.js | our license, reputation and rank, call-ups, the service record |
| `yards` | forces.js | hulls on the slips (and when each is built), each power's slips |
| `entities` | world.js and many | every other object in space (stations carry their berth table, and a combat state once they are in a fight) |
| `dock` | docking.js | the dock under way: target, berth, our collar, phase, our place in the berth's frame |
| `tc` | traffic-control.js | the station whose space we are in, the zone, our clearances, the warnings given |
| `boarding` | boarding.js | a boarding party's operation |
| `passengers`, `berths`, `brig` | manifest.js, prisoners.js | who rides with us: passengers in their berths, prisoners in the brig (then any free berth), each prisoner group with its ship, its side and its officers (turned over in port, or ransomed) |
| `dossier` | manifest.js | what we have learned about other ships (crew, passengers, routes) and from where |
| `intel` | intel.js | the plot: reports with an age (lost contacts, traffic digests, news), the inbox of news in flight, the zones we have heard of |
| `navFlags` | flags.js | the captain's flags on ships and stations, lettered A to Z, each for as long as we hold a track of it |
| `drone` | drones.js | the camera drone out, if one is: launching, on station, coming home (the rack is `resources.drones`) |
| `traffic` | traffic.js, forces.js | population target, replacements on the slips, and whether the background forces run |
| `missions`, `contracts`, `comms`, `sensors` | … | |

## The minute

`minuteTick` (sim/game.js) advances one game-minute in a fixed order, the same at 1 min/s and at 1 day/s:

0. The gravity epoch is set to the minute (`setGravityEpoch`): everything flown this minute falls under the bodies where they are now (gravity.js).
1. Machinery limits (and the 0.1 G cap inside a station's gate, lifted while pulling up off a rock); the dock moves along its phases; the autopilot or a hand on the stick decides the command, with the terrain guard over it (terrain.js).
2. **Our ship flies** (`flightStep`), or, held by a dock, flies the rest of the minute second by second in the berth's frame (`finishMinute`).
3. Clock +1; the world brings entities near us up to date (`world.tick`).
4. **NPC ships fly** on the commands they chose last minute, their pilots' terrain guard over them (`moveAgents`); one that came down on a rock is wrecked there.
5. Station-keeping (holding formation with a station, a ship, a convoy, a slot), or the dock puts us where it holds us (`dockHold`); either costs the thrust gravity doesn't give.
6. **Ordnance flies** and is checked against its targets over the minute just flown (`combatMove`): intercepts, hits, detonations; rounds that meet the ground are spent. Then, if we flew free, the ground (`terrainTick`: call-outs, contact). A drone out keeps up, or is left behind by this minute's thrust (`dronesTick`), and is called home for a burn coming.
7. Inertial events, then people: G-loads, physiology, crew AI, needs.
8. Plant: fires (fire.js), life support, reactor. A reactor that goes supercritical destroys the ship.
9. Sensors (contacts that drop off the board go onto the plot) and comms; traffic control (zones, rules, the radio); the dossier's thermal counts.
10. **The wider world**: combat decisions (NPCs choose next minute's command, fire weapons, make demands; our PDCs strafe), law, politics (daily: relations, influence, feuds, proxies, zones) and the encounter director, our service (call-ups, reporting aboard, daily reputation), distress calls, contracts (military work among them), traffic, the background forces (hulls that came within reach wake; daily, the census and the yards), the intel inbox (digests are published, reports that have arrived at light speed are delivered), and last the captain's flags (one whose track the plot has let go goes too; one back on the board is called out).

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

`tests/game.test.mjs › scale` checks the per-minute budget at 200k ships (about 6 ms per game-minute with ~25,000 of them within sensor range of Ceres; since v0.17 the names, which take a lot of short-lived string work to make 200k of, lead V8's pretenuring heuristics to slow the later minutes by about a quarter, measured and left: it is a constant, not a growth), and `tests/intel.test.mjs › scale` the default system (3,000 traffic, the forces): about 0.06 ms per game-minute, and a 2.5 MB save. The 200k timing is sensitive to machine load.

## Events

The sim emits facts (`torpedo-hit`, `crime`, `comm-request`, …). `ui/presenter.js` is the one place that decides how a fact is shown (log, toast, dialog). `ui/fx.js` keeps positioned combat effects for the canvases.

## UI modules (`js/ui/`)

The screen is the ship's flight console: a top rail, the main view (the ship's displays, under their tab bar and the flight band) between two docks of panels, the ship's AI and the radio along the bottom, and floating windows over it all. Nothing floats over a display but the card for what is picked on it: the nav status, traffic control, the route's progress, prompts and messages are lines of the layout (the flight band), and every display places its names through one pass that never prints one over another (`labels.js`). None of it touches the simulation.

| Module | |
|---|---|
| `app.js` | screens, game lifecycle, frame loop wiring, what the AI's buttons do, dev tools, the `window.__longhaul` debug handle (`state`, `loop`, `step(n)`, `start(state)` to play a state built by hand) |
| `console.js` | what goes where: the panels in the docks (SHIP and CREW & ROOMS on the left, CONTEXT and ROUTE on the right), the windows the dialogs become, the exterior cameras' window (they take their bar with them), the log drawer |
| `wm.js` | the window manager: docked panels (collapse, pop out, dock back), dock splitters, floating windows (move, resize, raise, Esc closes the top one), dialogs adopted as windows; the layout is a per-viewer convenience kept in localStorage |
| `tooltip.js` | the console's own tooltips (anything with a `title`), and the pixel-art pointers set as CSS variables (every stylesheet's `cursor` goes through them), each art pixel a whole number of screen pixels, the arrow the system's size and none over 32 px, drawn again on a screen of another density; the displays show the hand over what they can pick (`dom.js` `pointAt`) |
| `hud.js` | the top rail (the ship, flag chip, whose space, clock, warp, annunciators: a hostile or a torpedo inbound, master caution, battle stations, suits), the flight band's nav status and traffic control chips, and the SHIP panel (status, systems, stores) |
| `nav.js` | the main view: SOLAR, LOCAL, SCANNER, WEAPONS and EXTERIOR tabs (the map's view and layer buttons fold into menus on a narrow bar); the card on the display for what is picked; flagging it (`F`) and the list of flags in the CONTEXT panel; LOOK on a contact (`Z`: the telescope on it); route planning (the ROUTE panel); route and stance status (in full in the ROUTE panel; in the flight band, the progress, the secure-for-burn prompt and the hold's buttons) |
| `labels.js` | names on a display, placed most important first beside their marks, never over another name or a mark (the solar map, the scanner, the threat board, the exterior); a name can carry coloured tags after it |
| `marks.js` | the nav computer's marks as every display and list draws them (what is marked is sim/flags.js): a ship running dark hollow and called DARK, a magenta diamond and the job on what our work points at, a lettered yellow pennant on the captain's flags; the chips that say the same in lists and panels |
| `solar-map.js` | the solar map: bodies, the Belt, influence, and what we know: live contacts, charted orbits, the plot's reports aged and with their uncertainty, light-time rings, our velocity and route, the nav computer's marks; layer filters (stations, ships), a pick list for crowds, and search by name for what we know and know where it is (nav.js) |
| `tac.js`, `scanner.js`, `combat.js` | local space, the scanner, the weapons board (`combat.js` also renders the fire-control panel). Ships are clickable on all of them: local space and the scanner open the contact card, the solar map the body or report card, the weapons board targets |
| `stage.js` | the exterior cameras: a drone of ours or the telescope, and their bar (DRONE/TELESCOPE, DEPLOY/RECALL, LOOK AT PICK, FILTER; with no drone out the display is blank, and says why); the telescope's target, a contact or a world; their place, the EXTERIOR tab or a window; comes up by itself for a dock under way (the docking display, over the drone's picture if one is out) and for our torpedoes' last minutes (the telescope on their target, until what followed has played out), and goes back to what it replaced; marks the tab when there is something outside |
| `telescope.js`, `scope-sky.js`, `scope-fx.js` | the telescope's picture (sim/telescope.js): the mount (slewing, holding, holding on where a target blown apart was going), the field (the whole target, or the narrowest), the exposure, the filters, our own exhaust and the Sun's glare; the target as the optics make it (a shape blurred to the resolution and lit by the Sun, a point, a plume by its aspect, nothing), others in the field, the readouts. `scope-sky.js`: the stars, and worlds and the Sun cast pixel by pixel from surfaces made in code (whole, or only where the frame shows them). `scope-fx.js`: a fight as it would look (bursts, hits, intercepts, PDC tracers, the sensor whiting out, blooming, its ghosts, radiation snow), at true scale, on the wall clock |
| `exterior.js`, `hull-art.js` | the drone's picture: the exterior at true scale, drawn at the moment between sim minutes the frame stands for (rails exactly, free flight carried on its velocity and thrust, a step the sim takes in one go spread over a third of a second) (the rock under a surface port, stations, berthed ships posed at their collars, our hull, the corridor); drawing any hull or station from its model, also for local space, the ship picker, the library and the contact card |
| `docking-hud.js` | the docking display: the docking camera, tapes, the capture envelope, AUTO/MANUAL, rates, abort, undock, and the hand-flying keys |
| `cams.js`, `roomcam.js` | CREW & ROOMS: a camera in every compartment, small feeds in the panel and one large in a window. `roomcam.js` builds the room in 3D from the deck's tile grid (bulkheads, hatches, fixtures, lit per pixel), cached per deck, size and lighting (normal, battle stations, emergency, blackout, vacuum, fire), and draws the crew in their postures over it; picking a crew member or a machine on a feed selects it |
| `selection.js` | the CONTEXT panel's crew and machine card, and a compartment's menu (right-click its camera) |
| `advisor.js`, `ai-line.js` | VIGIL, the ship's AI: `advisor.js` is pure logic over the state (what needs the captain now, most urgent first, each with one-click actions; tests/advisor.test.mjs); `ai-line.js` shows the top advisory in the bottom bar and the rest in a window, and runs its actions through `app.js` |
| `stance.js` | the stance panel (order, range, drive, band, doctrine, preview), and one-click stances for fire control |
| `comms.js`, `ticker.js` | the comms window (channels, conversation, what we know of them, trade over the collar), and the radio in the bottom bar |
| `boarding.js` | the boarding window: the party, then the operation as it runs |
| `context.js` | the shared `ui` object: live state, loop, settings, selection |
| `library.js` | the ship's library: reference pages built from the simulation's own tables (classes, tech, systems, fittings, weapons, navigation, factions, stations); anything marked `data-lib` opens its page |
| `dialogs.js` | generic dialog, missions log (orders, distress calls, contracts), jobs, distress calls and comm requests, the station window (board, deliveries, services, hiring, leave, the traffic board), which is also a command ship's (missions, report, supplies) |
| `service.js` | the service record (V): license and flag, rank and reputation, relations with every faction and why, the hot zones we have heard of (by faction, where guns are wanted first, MAP and PLOT), the powers' phases, the sub-factions' influence, orders, political news; the flag chip on the rail |
| `shipboard.js` | engineering board, duty roster, words for activities and jobs |
| `presenter.js`, `fx.js`, `log.js`, `toast.js` | how events are shown (`toast.js`: the latest two messages, at the flight band's free end) |
| `persistence.js`, `settings.js`, `../storage.js` | IndexedDB saves and settings |

CSS: `css/main.css` (the original design system and the menus), `css/ui.css` (components added since v0.8, combat at the end), `css/stage.css` (the exterior, docking, comms, boarding, the map's search), then the console's own: `css/console-type.css` (the type over the older rules) and `css/console.css` (its tokens, which also remap the older variables; the rail, docks, panels, the main view and its flight band, windows, tooltips, the AI line, the room cameras, the exterior cameras' bar). The console's type is IBM Plex Sans Condensed and IBM Plex Mono (`fonts/`, latin subsets).

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
| chase | torpedoes against a ship running (full G early, the reach forecast, running dry), ships that run within their crews' limits (the sprint, going dark, cornered and striking), a pirate found and running, patrols' jurisdiction and one stop at a time, a route to a lost contact's last fix, a bounty's mark off a moon, the brig |
| factions | influence, hot zones, the director, bounties |
| service | the powers' relations over two years, licenses and the flag, contraband, the flag in a fight, rank, command ships and call-ups, military missions (intelligence, strike, hold), the yards and traffic replacement |
| names | name variety over 200,000 rolls, uniqueness in a game, determinism, the registry on load |
| intel | light lag, the plot and its accuracy, traffic digests, lost contacts, the background forces (strength, deployment, unseen war, the live window), upgrading v0.10 saves, the default system's cost |
| docking | hulls and interiors that agree, stations where they should be, berths and the anchorage, traffic control's rules, docking at every station by the computer and by hand, undocking, ship to ship, boarding, salvage, station guns, manifests, the hiring hall and leave, berth leases, saves mid-dock |
| port | gravity near the rocks and what holding costs, the ground and its call-outs, the terrain guard on routes round a rock, holding patterns at every port, traffic's port calls, port space and holding clearance |
| fire | fires grow and are fought; venting starves them; the SUITS order |
| flags | ships running dark, mission targets, the captain's flags, naming a hunted ship |
| cameras | the camera drone (out and home, left behind by a burn, waited for by a route, endurance, saves, bought in port); the telescope (resolved, point, night side, plume, the lock, flashes, our own plume, the filters, worlds and the Sun, occultation); time at 1× for our torpedoes' arrival |

Tests are seeded (`seedRandom`). Suites that aren't about encounters switch them off with `s.politics.quietUntil = Infinity` and `s.missions.cooldown = 1e9`. Suites that aren't about docking start holding at Ceres' gate (`createGame({ docked: false })`) instead of in a berth; `tests/helpers.mjs` has `dockHere` for the ones that need to dock.
