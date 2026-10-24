# Stations, traffic control, docking and boarding

Modules: `sim/stations.js` (where stations are, their models, berths, gates, the anchorage), `sim/mating.js` (how two hulls meet at a collar), `sim/traffic-control.js` (zones, clearances, the rules, the radio), `sim/docking.js` (the final approach, proximity operations, the hard seal, undocking), `sim/station-defense.js` (stations' guns), `sim/boarding.js` (our people aboard another hull), `sim/leases.js` (berth leases), `sim/crew-services.js` (the hiring hall, shore leave). The UI is `ui/stage.js`, `ui/exterior.js`, `ui/docking-hud.js`, `ui/comms.js`, `ui/boarding.js`.

A dock under way brings up the EXTERIOR display with the docking display over it (its collar camera looks down the collar's axis). The outside view of the dock is our drone's, if one is out (sim/drones.js); without one it is blank. A drone already out keeps up with the final approach (0.1 G), but none can be launched with the drive lit.

## Stations

There are two kinds, as there would be: **surface ports** built on an asteroid or a small moon, and **orbital stations**. A surface port sits on its body at the body's true radius and turns with it (sim/ephemeris.js carries every body's radius, rotation, GM and atmosphere); an orbital station is on a Keplerian orbit.

| Station | Site | Size | Berths | Gate | Defenses |
|---|---|---|---|---|---|
| Ceres Station | Ceres' surface (r 470 km, a 9.07 h day: the port moves at 90 m/s) | 4.4 km | 26 (4 gantry towers, 2 cargo cradles) | 100 km | 16 PDC (TL2), 4 silos |
| Pallas Station | Pallas' surface (256 km, 7.8 h) | 3 km | 10 | 60 km | 8 PDC (TL1), 2 silos |
| Vesta Depot | Vesta's surface (263 km, 5.3 h) | 1.6 km | 7 | 50 km | 6 PDC |
| Hygiea Ring | 2,000 km round Hygiea (65 h) | 1 km | 10 | 50 km | 6 PDC (TL1), 2 silos |
| Tycho Station | 1,500 km round Juno (75 h) | 4.2 km | 19 | 80 km | 12 PDC, 4 silos |
| Luna Shipyards | 6,000 km round Luna (11.6 h) | 5.2 km | 22 (2 naval cradles) | 100 km | 30 PDC (TL3), 8 silos, 2 railguns |
| Phobos Naval Yard | Phobos' surface (11 km, tidally locked) | 3.6 km | 10 | 60 km | 24 PDC (TL4), 8 silos, 4 railguns |
| Ganymede Station | 10,000 km round Ganymede (17.5 h) | 3.3 km | 21 | 80 km | 10 PDC, 2 silos |

Each station has a frame that turns with it (x up from the body's centre, y along its motion). Its parts and berths are laid out in that frame; `berthPose` turns a berth into the solar frame, with the velocity of the turn.

Round every station:

- the **approach gate**, a rails point straight up from it (`gateKm`). Routes to a station end there (`nav.routeTarget`), outside the keep-out zone.
- the **holding pattern** (`holding.js`): 300 slots 5 km apart on an orbit where a ship falls freely and keeps its place with no thrust. Over a surface port on a turning rock it is the synchronous orbit (Ceres 1,192 km from its centre, 722 km up; Vesta 545 km; Pallas 649 km): the slots string out east and west of the port's meridian and stay over the same ground, as far as a slot's line down to the gate clears the rock. Round an orbital station it is the station's own orbit, ahead of it and behind from 200 km out. Phobos is too small to orbit (its synchronous orbit is outside its sphere of influence): its yard's slots ride Phobos' own orbit round Mars. Every slot is in port space.
- the **anchorage**, a Keplerian parking orbit further out (`anchorKm` up): the overflow when the pattern is full.
- its **berths**: a collar of a size class, with adaptors (a berth for M collars takes S too); gantry arms on surface ports (a ship hangs nose-up beside the tower by a flank collar), arms on a docking spine on orbital ones, and cargo cradles for L collars.

**Traffic makes port calls** (`traffic.js` CALLS). On arrival at the gate a ship decides what it is there for, by its kind: the work that needs a berth and how long it takes, and its layover after. A berth is held only for the work, then the ship moves out to a slot for its layover, or leaves:

| Kind | Berth work | Chance of berth work | Layover in the pattern |
|---|---|---|---|
| Prospector | 1–3 h (sell the haul, the claim data) | 70% | 6–48 h |
| Courier | 0.5–1.5 h | 95% | 0–4 h |
| Shuttle | 1–3 h | 90% | 0–3 h |
| Light freighter | 2–6 h | 85% | 0–24 h (waiting on a charter) |
| Bulk freighter | 6–16 h (a cargo cradle) | 50% (else by lighters from its slot) | 0–12 h |
| Tanker | 4–10 h | 50% (else by tender) | 0–6 h |
| Liner | 3–8 h | 50% (else by shuttle) | none: away on schedule |
| Mining barge | 6–12 h (ore to the smelter) | 50% | 12–72 h |
| Ice hauler (XL: no berth takes it) | by tender from its slot, 12–36 h | | 0–6 h |

A ship that finds no berth free waits in a slot and asks again every 30–90 minutes; after 4 hours it does the work by tender, 1.6 times slower. Traffic control keeps a quarter of the port's berths back for the arrivals it clears (`RESERVE`). Every move inside a port goes through the gate (berth ↔ gate ↔ slot), so no ship climbs out of a port through the rock under it; out of a slot, a ship goes straight onto its long leg. Navies berth at their yards the same way. In steady state about 92% of traffic is under way (passages take days, calls hours) and a busy port has a few berths working and some 20–50 ships holding.

## Collars and how hulls meet

Every hull has collars (sim/hulls.js): S crew hatches, M docking collars, L cargo cradles. Collars of one size are androgynous; any two S, M or L collars mate.

| Collar | Diameter | Capture: closing | off the axis | angle | roll |
|---|---|---|---|---|---|
| S crew hatch | 1 m | ≤ 0.3 m/s | ≤ 0.15 m | ≤ 4° | ≤ 6° |
| M docking collar | 2.2 m | ≤ 0.25 m/s | ≤ 0.3 m | ≤ 3° | ≤ 5° |
| L cargo cradle | 6 m | ≤ 0.15 m/s | ≤ 0.5 m | ≤ 2° | ≤ 4° |

A mated hull's pose is worked in three dimensions (`mating.js`): the collar normals oppose, a ship latched by its flank lies along the berth's `up`, a ship docked by its nose goes nose-in with its starboard along `up`. The plane then shows the hull from above, below (mirrored) or along its flank.

## Traffic control

| Zone | Reach | Rule |
|---|---|---|
| Control space | 30,000 km | transponder required: running dark is warned after 5 min, cited after 30 |
| The approach | 2,000 km | approach clearance required (6 h); uncleared, warned at once, cited after 15 min (300 MCR), reported after 45 (SUSPECT). Those minutes run only while the ship isn't flying a route in to this port (inbound, it is told to hail), and while it isn't leaving; sat at the hold point off a berth with no route or lease, an hour counts as leaving, then it is loitering |
| Keep-out | inside 0.92 gates (the gate itself just outside, with room to drift) | docking clearance (a berth, 2 h) or a departure clearance (30 min); a trespasser gets a final warning, then after 5 minutes (20 for a ship inbound to the gate, given time to correct) it is a crime (severity 1, 2 at a naval yard) and the yard opens fire. Under 200 m/s coming in. Inside the gate the nav computer holds the drive to 0.1 G (`keepOutDriveCap`): no torch near a station |

Docking somewhere else from a station's berth or its frame (docked, backing out, holding, climbing out, or on a final approach) goes out first: undock, climb out through the gate, then the new docking begins (`dock.next`). At the hold point off a berth, coming back in needs a docking clearance (the one we came in on was used): the panel offers REQUEST DOCKING, and traffic control gives back the berth we left if it is still ours, the lease with it. A dock whose target is gone (blown up, broken up) lets go in any phase; nothing we are docking with is retired from the world while we are. Evicted for overstaying, we are not cited for undocking without clearance as well.

Clearances are asked for by hailing traffic control (the comms window, or the HAIL button on the traffic-control chip). **The nav computer does not ask for us**: a docking flight plotted from afar ends at the gate and holds there, awaiting clearance. Once cleared, the docking computer takes over at once (or plots the route in, from afar); the chip carries a DOCK button while a clearance stands.

**Holding clearance**: a slot in the pattern, the free one nearest us, for 24 hours (asked again, renewed). It is clearance to be in port: no loitering citations while it stands, and the nav computer plots the way into the slot (the chip's TO SLOT button). A slot is free orbit: no fuel to keep it. Traffic control refuses a power's wanted ships (WANTED or worse), anyone under −20 standing with it, a captain flying the flag of a power it is in a crisis or at war with (WORLD.md, military service), strangers at a naval yard (Phobos berths MCRN hulls, its own contractors, and others with standing 30), and everyone when its docks are shot out. With no berth free it says when one should clear. An emergency (low fuel, a holed hull, someone dying, a containment failure) gets a berth from the reserve.

Citations (`law.cite`) are fines owed to the station's power: paid at its stations, or settled by an inspection. A week unpaid makes us SUSPECT there. Undocking without a departure clearance is a citation; a collision with a berth over 1 m/s is another.

Near a hub the radio is busy, and it is the real traffic: traffic control clears the ships actually due out of their berths and the arrivals on its filed plans, posts its berth board and the day's advisories, every 5 to 13 minutes (half as often in the outer control space). Our nav computer calls out zone changes, ranges (2,000 km down to 2 km, closing only) and clearance timers. All of it goes to the log and to the radio in the console's bottom bar, which shows the last two transmissions for a few seconds each.

## Docking

| Phase | |
|---|---|
| inbound | a route to the gate (or alongside a ship), flown by the autopilot |
| awaiting | holding at the gate for docking clearance |
| approach | the final approach, flown by the docking computer in the berth's frame on the drive at 0.1 G, no faster than 150 m/s and no faster than it can stop, to the corridor's mouth 1 km out along the collar's axis (300 m for a ship) |
| prox | proximity operations, second by second on the RCS (auto or by hand) |
| capture | soft capture inside the envelope; 2 min to hard dock |
| seal | 3 min to equalize; then **docked**: the berth is ours |
| undock | 2 min to vent the lock and unlatch |
| separate | backing out on RCS to the hold point, 150 m out (slow off the collar, 1 m/s clear of it); with a route waiting, on through it without stopping |
| holding | station-keeping in the berth's frame until a route takes us away, or we clear off (CLEAR OFF) |
| outbound | leaving a station: up the corridor to just through the gate (1.03 gates out), on the RCS alone (0.02 G, under 180 m/s), still in the berth's frame, round the station's side if the gate lies beyond it, from wherever we are (backing out, holding, or stopped dead on a final approach turned back); there the dock lets us go. A route goes on out of the approach on RCS before its drive lights (FLIGHT.md, the departure leg); with none, we hold at the gate (leaving, as far as traffic control is concerned) |

**The frame.** From the final approach on, our ship is held in the berth's frame: its place is the berth's plus our offset, turning with the station. The body's gravity, which station and ship share, is left out of the motion: a station circling a moon quickly would otherwise take more drive to keep up with than traffic control allows inside the gate. What holding against it costs is charged (`hoverG`): to the drive on the final approach, which flies on it anyway, and to the RCS everywhere else, so the torch never lights by a berth. Nothing in the frame meets the ground. That is why a departure stays in it to the gate: a hold point by a surface port is a hundred metres over the rock, and the RCS can't hold a ship up against even Ceres' pull (0.027 G against 0.02 G). Let go there, the ship falls.

**Time.** Proximity operations integrate in whole seconds inside the current minute (`dock.t`). At time ×1 the game loop flies them a second at a time, at the dock's rate (×1, ×5, ×20, ×60 game seconds a real second; hand-flying wants ×1 or ×5), so the view always shows where the ship is, and the minute tick flies whatever is left of the minute (`finishMinute`), so a headless run and the browser fly the same thing. Nothing else in the sim changes inside a minute. Hand-flown docking caps time warp at 1×.

**Proximity operations** are worked in the collar's frame: x out along its axis (range), y along its `up`, z out of the plane, and the attitude errors yaw, pitch and roll. Nobody arrives exactly on the axis: the docking computer starts from a few metres out of the plane and a few degrees off. RCS authority is by size (S 0.25, M 0.12, L 0.05, XL 0.02 m/s² a axis; 3 / 2 / 1 / 0.5 °/s), better yards fitting more, and a damaged RCS gives less.

- **AUTO**: closing speed in proportion to range (2% of it a second), no faster than half the RCS could stop in time, slowest at the collar (40% of the capture speed); lateral error and attitude nulled first; it waits at 10 m until it is lined up. After a bump it backs off 20 m and tries again; after four it gives up and backs out.
- **MANUAL**: W/S close and open, A/D left and right, R/F up and down (accelerating while held), ←/→ yaw, ↑/↓ pitch, Q/E roll, X kill drift. The attitude computer holds what the stick doesn't command. The docking camera looks down the collar's axis: the target collar's rings grow as the range closes, the diamond is where the drift takes us in 5 s, the horizon line rolls with the roll error, and the tapes show range and closing speed against the computer's.

Contact outside the envelope bounces. Past twice the capture speed the berth's collar is damaged (out of service for 12 h). With real energy behind it (our mass at the closing speed, past the first 200 kJ) the hull takes damage through the usual hit model: a 3,500 t freighter hitting at 1 m/s takes about 26 DP.

`tests/docking.test.mjs` docks at every station from its gate: 22–28 minutes, no bumps, contact at 0.10 m/s, 0.03 kg of RCS. A careful scripted pilot docks by hand; a careless one keeps hitting at 1.2 m/s and loses half the hull.

**Ship to ship.** The other ship has to hold still: one that agreed to a rendezvous on the radio (it is woken off its rails and cuts its drive: `dock-hold`), one that has struck, a disabled or dead hull. Docked, we can trade over the collar (their prices are well over a station's; a charity case gives it away), take survivors off, and board through the collar. A ship we are joined to that lights its drive tears the collar loose.

## Berth leases (`leases.js`)

A berth is let, not given: there are always ships at the anchorage waiting for one.

| | |
|---|---|
| Working lease | 6 hours from the hard seal, free with the docking clearance |
| Long lease | bought ahead by the hour (+6, +12, +24, +72 h), a week ahead at most, by hailing the station or from the station window's BERTH tab |
| Rate | 6 / 12 / 25 MCR an hour for the S / M / L collar we hold; ×2 at a naval yard; ×1.5 when under a quarter of the port's berths are free |
| An hour before | traffic control says so |
| Lease up | told to extend or depart; 30 minutes' grace |
| Overstaying | a citation (8 hours' berth, 100 MCR at least) and another every 2 hours |
| 6 hours over | crew ashore are sent back aboard, then the dock releases its clamps and we back out to the hold point |

Shore leave needs the berth until the crew are back: sending them ashore buys the missing hours with it. The lease ends when we undock; docking with a ship takes none. The HUD's dock chip shows what is left.

## Boarding

A boarding party is chosen from the crew (`sim/boarding.js`), through a mated collar or by EVA (within 2 km, matched in motion, a suit for everyone):

1. **muster**: the party suits up (always for an EVA; for a collar when the other side may fight) and goes to the lock (crew AI task `board`).
2. **cross**: 2 minutes through the collar, or the distance at 2 m/s on suit thrusters.
3. **breach**: a hatch nobody opens is cut: 6 minutes behind a collar, 10 by EVA.
4. **fight**, if anyone resists, minute by minute.
5. **secured**: orders aboard. SEARCH (20 min: the exact crew and passenger count, the hold, contraband), TAKE STORES (40: reaction mass, water, rations, med, spares, PDC rounds, torpedoes, as much as we hold), TAKE CARGO (40, while still mated at the collar), TAKE PRISONERS (15: into the brig's cells, which a warship has, then any free berths; passengers keep to their berths), SCUTTLE (10: the reactor goes in 30 minutes). A hull's stores, hold and credit store are taken once: boarding it again finds them gone.
6. **return**, and the party is aboard again: across the collar still mated, or within EVA range. Out of reach, they wait aboard and say so; a route waits for them too.

An EVA crosses open space: nobody goes without a suit. Crew ashore aren't waited for at the muster.

While away the party is off our ship: not on its decks, not breathing its air, not at its stations. Routes wait for them and we cannot undock.

Who resists: a navy crew fights for every compartment (all of them, quality 0.75), police hard (85%, 0.6), pirates nearly as hard (90%, 0.55), a civilian crew mostly hides (30%, 0.3). A beaten ship fights at 60%. A crew that struck hardly fights at all, though holdouts are possible (30% chance aboard a pirate, 12% otherwise). Each minute both sides trade hits in proportion to their strength: a boarder's is security skill, health and spirits, and the defenders get the cover. Our wounded take real injuries. Defenders give up when most of them are down (military crews fight to the last tenth); the party falls back when most of it is, and anyone it can't carry is taken prisoner, to be freed if that ship is boarded again.

Boarding a lawful ship that hasn't invited us (opened its locks, asked for rescue) is piracy: severity 3, HOSTILE with its power. Boarding pirates, the wanted, or a ship that fought us and struck is not.

Prisoners (`sim/prisoners.js`) are dealt with at a station, docked. **Turned over** to the local authority: pirates and a wanted ship's crew earn the bounty (800 MCR a head, their captain three times that) and standing with the station's power; a power's enemies (at war or in a crisis with it) earn standing with it, reputation with our command if it is our flag's power, and cost standing with their own side; anyone else is let go, and their power remembers we held them. **Ransomed**, the high-profile ones (a navy ship's captain and officers, 6,000 MCR each; police officers 3,000; a pirate captain 2,500, one a bounty was out on 8,000; a strike target's commander 25,000): their own side pays through the station's brokers, the local power losing 3 standing for each of its criminals or enemies bought free; the rank and file stay aboard. Survivors taken off a ship go ashore at the next station we dock at (300 MCR a head salvage money, and standing with their flag).

Stations can't be boarded yet: `boardable()` says so. The phases are the same for a station's docking ring or a habitat section, when that comes.

### Salvage

A wreck can be boarded like any hull (its survivors don't fight) and salvaged: each **SALVAGE** run is 45 minutes of cutting, and gives by chance (better with a good engineer in the party) scrap for the machine shop (95% while much is left), spare parts, and stores from tanks that held (reaction mass, water, oxygen, rations, medical supplies). A wreck holds 55% of what it held after each run, so the easy pickings go first and it is soon stripped bare. Wrecks shift: a party member can be hurt (8% a run, less with a good engineer). Salvaging a wreck is lawful.

**CRACK ITS ACCOUNTS** (30 minutes, any secured hull): into the computer core for its credit store, 300–2,500 MCR by size (half again from a pirate), at 25% + engineering/150 (90% at most); a core that locks us out wipes itself. Taking a lawful ship's credits is theft.

## Station defenses

A station's guns (`station-defense.js`) are its DISARM section, its docks the DISABLE section, its sensors and power plant the rest. Only stations near us or on alert are looked at in a minute. A station fires on whoever has fired on it, on us if its power has us HOSTILE and we are within 450,000 km, on a trespasser in a naval yard's keep-out zone after the final warning, and on pirates within its reach. It torpedoes in salvos sized to the target's point defense, fires railguns (the naval yards) and rakes with PDCs close in, and calls its power's police and warships nearby to the fight. Its PDCs also cover the ships in its berths and holding within 60 km against torpedoes. It stands down after a quiet half-day.

Attacking a station is a crime one step worse than the same attack on a civilian ship. A station whose power plant is shot out blacks out (no guns, no services); one whose structure is gone is broken: no berths, no services, no guns.

## Crew ashore

At a station with a hiring hall, four people are looking for a berth each day, with a role, skills and a signing fee; we can sign on up to the most crew our hull berths (12 at most) and pay anyone off but the captain. Shore leave sends the crew ashore for eight hours (60 MCR a head); they come back rested, fed, washed and in better spirits, and the ship can't undock until they are aboard. The berth's lease must cover the run (above).
