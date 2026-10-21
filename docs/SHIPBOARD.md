# Aboard: crew, machinery, air and power

Modules:
- `sim/ship-layout.js` (decks, fixtures, seats, paths) and `sim/tiles.js`
- `sim/crew.js` (people, physiology, medicine) and `sim/needs.js`
- `sim/duty.js` (watches) and `sim/crew-ai.js` (behaviour)
- `sim/jobs.js`, `sim/systems.js`, `sim/life-support.js`, `sim/reactor.js`

## The ship's interior

Each class a small crew can fly has a **deck program** (`DECK_PROGRAMS`, sim/ship-layout.js): which decks it has, bow to stern, each drawn from a deck template (7 tiles wide for small craft, 9 for the rest) and fitted to the class. The hull model (SHIPS.md) is built from the same program, so a collar on the outside opens onto an airlock on the right deck inside.

| Deck | What's there | Zone |
|---|---|---|
| Bridge | helm, ops, the weapons console (a couch on an unarmed hull), radio, transponder, couches; a nose collar's airlock in the bow plating | command |
| Quarters | racks (one for every two of the crew: bunks are shared between watches), a head; on small craft the galley too | crew |
| Mess | galley, tables, exercise rig, autodoc | crew |
| Utility | life support, water reclamation, machine shop | crew |
| Passengers | passenger acceleration berths (as many as the class is licensed for) and their own head, behind the deck's hatch; a police cutter's brig | pax |
| Cargo | the launcher bay, storage, the crew airlock, a cargo door | cargo |
| Engine | engineering station, drives, PDC turrets set in the hull | machinery |
| Reactor | reactor | reactor |

Passengers live aft of the crew's decks, forward of the hold: the crew's walk from the mess to the bridge is never through the passenger decks. Every ship has a secure seat for each of the crew it berths (the pilot's is the helm; extra couches go into storage space on the crew's decks first, then the hold) and a suit locker for each of them. Securing for a maneuver, the crew still on their feet are matched to free couches so that the longest walk is the shortest it can be (a ship is secure when the last one sits); station seats are couches too, for anyone left over.

Ship coordinates count tile rows from the bow across all decks, with a one-row gap between decks; one ladder shaft runs down the spine. Tiles define fixtures (`FIXTURE_KIND`), and each fixture has an access tile where crew stand to use it. Seats are either *secure* (couches, helm, ops, weapons, engineering station, autodoc: protection under G) or *restraints* (bunks: strapped in, not juiced). Paths come from cached Dijkstra trees over the walkable tiles. Each role calls home the deck holding its work (the helm, the engineering station, the autodoc…). Changing the layout means bumping `SAVE_SCHEMA`.

**Away.** Crew can be off the ship: a boarding party aboard another hull (DOCKING.md), or ashore on leave. Away, they are not on our decks, don't breathe our air or feel our G, don't eat our rations, and aren't counted for securing for maneuvers, for jobs or for the battle stations, nor hit when we are; the ship can't undock or leave without them.

**A death** lets go of what the dead held: their job goes back on the board, anyone they were carrying is set down, and the body is lifted off its seat (an autodoc, the helm). Paying someone off closes the jobs about them; a new hand never takes an old one's number.

**Signing on.** A crew can be up to the class's berthed maximum (12 at most). Past the eight who fly a ship come Security (fire control watch) and Deckhands (machine shop). Docked at a station with a hiring hall, four people look for a berth each day; we can sign them on for a fee or pay anyone off but the captain.

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
| fight a fire | anyone, in a suit, with an extinguisher |

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
- **Venting** any deck on its own (the compartment menu: click the deck's name, or right-click the deck) opens it to space at 10% of its pressure a minute; closing the vents repressurizes it from the tanks.
- **The SUITS order** (the switch beside COMBAT, key U) sends every hand to a locker for a suit and keeps it on, whatever the job, until it is lifted (then suits come off where the air is good). Under 1.5 G they leave a couch for it. With everyone suited a deck can be vented, or holed in a fight, with its people on it.
- An engineer in a suit seals the breach, then the deck repressurizes from the tanks (the deck's menu shows who is on the patch; it is the top-priority job). Lifting the SUITS order leaves suits on whoever is working a breach, a fire or a boarding.
- Hypoxia, CO₂ poisoning and decompression act on the body.

## Fire (`fire.js`)

A hit that gets inside the hull (a chance by the damage that reaches a deck), a ship coming down on a rock: any can start a fire on a deck. A fire has an intensity (0–1) that grows on the deck's oxygen and pressure (8% a minute on good air), burns the oxygen down and fills the air with smoke (breathed as CO₂, faster on a small deck), wrecks machinery on the deck (4% a minute per machine at full blaze) and burns whoever is on it (a suit keeps off most of it: BURNED). Above 70% it can reach the next deck through the shaft while the hatches are open. Nothing burns under 25 kPa or 12% oxygen.

A deck on fire is bad air: the unsuited on it go for a suit, and nobody walks into it for a meal. In bad air, at a breach and at a fire, crew run (2.5× their walk).

Putting it out: a firefighting job (CRITICAL; a hand suits up, then knocks it back 12% a minute at full efficiency), or vent the deck and starve it. A fire left alone burns its deck's air out in about twenty minutes, and what it wrecks meanwhile stays wrecked.

## Power (`reactor.js`)

The fusion reactor powers everything; batteries last a while without it. Procedures need an engineer physically at the reactor:

| Procedure | Time |
|---|---|
| shutdown | 12 h of work, then a 1 h countdown |
| startup | 5 h |
| patching a containment breach | 1 h |

A **containment failure** (from overdriving past 7G, or a hit on the reactor deck) gives 90 minutes to scram before the reactor goes supercritical and the ship is lost in a fusion detonation. Emergency shutoff dumps fuel after an hour; immediate shutoff dumps it all at once. A blackout kills sensors and displays, raises an automatic SOS, and may leave the flight computer unable to boot clean.
