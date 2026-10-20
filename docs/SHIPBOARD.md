# Aboard: crew, machinery, air and power

Modules:
- `sim/ship-layout.js` (decks, fixtures, seats, paths) and `sim/tiles.js`
- `sim/crew.js` (people, physiology, medicine) and `sim/needs.js`
- `sim/duty.js` (watches) and `sim/crew-ai.js` (behaviour)
- `sim/jobs.js`, `sim/systems.js`, `sim/life-support.js`, `sim/reactor.js`

## The ship's interior

Seven decks stacked on the torch, bow first:

| Deck | What's there |
|---|---|
| Bridge | radio, ops, helm, weapons console, couch, transponder |
| Quarters | bunks, head |
| Mess | galley, tables, exercise rig, autodoc |
| Utility | life support, water reclamation, machine shop |
| Cargo | torpedo launcher, storage |
| Engine | engineering station, drives, PDC turrets set in the hull |
| Reactor | reactor |

One ladder shaft runs down the spine. Ship coordinates count tile rows from the bow across all decks, with a one-row gap between decks. Tiles define fixtures (`FIXTURE_KIND`), and each fixture has an access tile where crew stand to use it. Seats are either *secure* (couches, helm, ops, weapons, engineering station, autodoc: protection under G) or *restraints* (bunks: strapped in, not juiced). Paths come from cached Dijkstra trees over the walkable tiles. Every playable class shares this plan, fitted to the class (SHIPS.md): turret wells plated over without PDCs, hold space for the launcher bay without tubes, a couch for fire control on an unarmed hull. Changing the layout means bumping `SAVE_SCHEMA`.

## People (`crew.js`, `needs.js`)

Roles: Captain, Pilot, Engineer, Medic, Gunner, Mechanic, Scientist, Cook. Each crew member has four skills (piloting, security, engineering, medical) that improve with practice, plus a body (six parts), a heart, consciousness, morale and conditions.

**G-loads.** Above 1.5G an unsecured person strains; above 2.5G they are injured; at 8G they are crushed. A secure seat gives juice when G > 1.5:
- the standard dose makes 3G feel like 1G and costs 1 med unit per person
- above 6G a high dose (4.5× protection) costs 2 units in all, plus a booster a day, and carries a stroke risk for every minute above 6G

A dose stays in the blood for an hour, so a flip or a lull between combat burns is covered: a burn costs one dose per person, not one per leg. The bill comes when it wears off:
- **hangover** (standard dose): up to 3 days, scaled by the peak G. Work efficiency ×0.85, lower morale, and hard G risks brain bleeds.
- **crash** (high dose): heart stress +40 and heart health −15, which barely mends while it lasts. It runs 6 days plus 1.5 h for every hour on the high dose, capped at 10 days. Work efficiency ×0.6, morale down hard, twice the brain-bleed risk. Cardiac stress builds at dangerous loads, and a failing heart goes critical: death within minutes unless someone gives first aid.

**Medicine.** Critical crew are stabilized and carried to the autodoc by whoever is free with medical skill. The autodoc heals over hours using med supplies; it runs faster with a medic on watch and slower when damaged.

**Needs** (0–100): rest, food, hygiene, recreation. They decay with time awake and are met at the bunks, galley, head, exercise rig and mess table. Sleeping in a couch is slow; long burns feed people through the couch line. Needs set morale, and morale and fatigue set work efficiency. A death aboard lowers everyone's morale for days.

## Watches (`duty.js`)

There are three eight-hour watches. Each person has a station and a watch: eight hours on station, eight off, eight asleep (bunks are shared between watches).

| Station | Effect when manned |
|---|---|
| Helm | takes over at once if the flight computer fails |
| Ops | ×2 contact tracking, longer sensor reach, often spots debris in time to dodge |
| Weapons | PDCs laid by hand instead of automatic |
| Engineering | 40% fewer breakdowns, plus maintenance rounds |
| Machine shop | repairs, and refurbishing scrap into spare parts |
| Sick bay | autodoc treatment 50% faster |
| Galley | hot meals |

A small crew can't cover everything; that's the captain's call (the ROSTER screen).

## Behaviour (`crew-ai.js`)

Everyone runs one task at a time and switches only to something more important. Priority levels:

| Level | Task |
|---|---|
| 0 | being carried |
| 1 | secure for maneuvers |
| 2 | bad air → EVA suit |
| 3 | critical jobs |
| 4 | urgent jobs |
| 5 | own injuries |
| 6 | needs that can't wait |
| 7 | routine jobs |
| 8 | the roster |
| 9 | off-watch life |
| 10 | idle |

Critical jobs (a rescue, a dead flight computer, failing life support) wake sleepers. Routine work belongs to whoever holds the engineering or machine-shop watch. When the crew must secure (a burn above 1.5G, any stretch in which the nav computer may turn the ship, battle stations: FLIGHT.md):
- the pilot takes the helm
- at battle stations the best shot takes the weapons console, the best engineer the engineering station and the next best eye ops
- everyone else goes to a couch

People move along real paths. In free fall, hand over hand is slow (about half a tile per minute), so call battle stations early. The nav computer won't flip with anyone still on their way to a couch: it holds the turn for them (FLIGHT.md).

## Jobs (`jobs.js`)

Subsystems post jobs; crew-ai assigns them by skill, distance and watch. Each job needs a minimum skill.

| Job | Who |
|---|---|
| rescue | medical 20 |
| repair, maintain | engineering 15 |
| fabricate | engineering 25 |
| reactor procedure | engineering 15 |
| helm | piloting 15 |
| seal a breach | engineering 10, in a suit |

Priorities are CRITICAL, HIGH and NORMAL.

## Machinery (`systems.js`)

Twelve systems: flight computer, drive, reactor cooling, RCS, sensors, comms, life support, water reclamation, galley, autodoc, point defense, torpedo launcher. Each has an integrity (0–100) that wears with time and use (hard burns most), and a fault hazard that climbs steeply as integrity falls.
- A fault leaves a system DEGRADED (half performance) or FAILED until an engineer repairs it at the machine with spare parts (1 for a minor fault, 3 for a major one, at TL2).
- Without parts, a repair is jury-rigged (PATCHED: half performance, gives out after 12–36 hours at TL2).
- The ship's tech level scales all of it (SHIPS.md). A Belt refit wears 1.5× faster and faults twice as often, but its repairs take half the parts and its jury-rigs hold 2–5 days. Martian kit wears at 0.55× and faults 2.4× less often, but its repairs take 2.4× the parts and half again the time, and a jury-rig on it holds 4–12 hours.
- Machinery follows the fit: a ship without PDCs or tubes has no `pdc` or `launcher` system.
- Maintenance below 75% integrity restores it. Spent parts become scrap, which the machine shop refurbishes.
- Micrometeoroids strike rarely; an ops watch can dodge them.
- Combat hits fault the systems housed on the deck that was hit (COMBAT.md).

Each system's effects are listed in `SYSTEMS[id].effects` and applied through small helpers (`driveLimitG`, `sensorRangeFactor`, `waterRecovery`…).

## Air (`life-support.js`)

Each deck has its own atmosphere (pressure, O₂, N₂, CO₂). The plant scrubs CO₂ and injects O₂ and N₂ from tanks. Gas exchanges through the ladder shaft, and pressure doors hold across a big difference.
- A breach vents a deck within minutes. Crew in bad air go for EVA suits (48 h of O₂); couches and station seats have a 2-hour emergency hood.
- An engineer in a suit seals the breach, then the deck repressurizes from the tanks.
- Hypoxia, CO₂ poisoning and decompression act on the body.

## Power (`reactor.js`)

The fusion reactor powers everything; batteries last a while without it. Procedures need an engineer physically at the reactor:

| Procedure | Time |
|---|---|
| shutdown | 12 h of work, then a 1 h countdown |
| startup | 5 h |
| patching a containment breach | 1 h |

A **containment failure** (from overdriving past 7G, or a hit on the reactor deck) gives 90 minutes to scram before the reactor goes supercritical and the ship is lost in a fusion detonation. Emergency shutoff dumps fuel after an hour; immediate shutoff dumps it all at once. A blackout kills sensors and displays, raises an automatic SOS, and may leave the flight computer unable to boot clean.
