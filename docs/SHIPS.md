# Ships

Every ship belongs to a class in `js/sim/ship-classes.js`. An entity carries `cls` (class id), `tl` (tech level) and `faction`; everything else (size, shape, drive, armor, weapons) comes from the class.

## Tech levels

| TL | Who builds it | Sensors | Stealth (own signature) | Armor bonus |
|---|---|---|---|---|
| 1 Improvised | Belt workshops, pirates | ×0.7 | ×1.2 | +0 |
| 2 Commercial | Earth and independent yards, the OPA's best | ×1.0 | ×1.0 | +0 |
| 3 Naval | UN Navy | ×1.3 | ×0.8 | +0.5 |
| 4 Advanced naval | Martian Navy | ×1.6 | ×0.55 | +1 |

A class lists the TLs it exists at. The faction flying it picks within that range (`techFor`): MCRN warships are TL4, UNN TL3, OPA police TL2, Belter civilians TL1. Weapon performance also scales with TL (see COMBAT.md).

## Sizes

| Size | Structure (DP) | Cold radar signature | Reactor blast (DP at core, e-fold distance) |
|---|---|---|---|
| S small craft | 60 | 0.0008 AU (~120,000 km) | 300 · 400 m |
| M medium | 120 | 0.0015 AU | 600 · 800 m |
| L large | 300 | 0.004 AU | 1,200 · 1,500 m |
| XL capital | 800 | 0.01 AU (~1.5M km) | 2,500 · 3,000 m |

A hull's target radius is 15% of its length (the mean presented cross-section).

## Classes

| Class | Category | Size | Length | Drive cruise/max G | Armor | PDC | Tubes (magazine HE/nuke) | Rail | TL |
|---|---|---|---|---|---|---|---|---|---|
| Prospector skiff | civilian | S | 30 m | 0.5 / 2 | 0 | 0 | — | — | 1–2 |
| Fast courier | civilian | S | 40 m | 1 / 6 | 0 | 0 | — | — | 2–3 |
| Cargo shuttle | civilian | S | 35 m | 0.5 / 2 | 0 | 0 | — | — | 1–2 |
| Light freighter (ours) | civilian | M | 62 m | 1 / 10 | 1 | 2 | 2 (2/0, holds 6) | — | 2 |
| Bulk freighter | civilian | L | 220 m | 0.3 / 1 | 1 | 1 | — | — | 1–2 |
| Ice hauler | civilian | XL | 1,400 m | 0.3 / 1 | 0 | 0 | — | — | 1–2 |
| Tanker | civilian | L | 300 m | 0.3 / 1 | 0 | 1 | — | — | 1–2 |
| Passenger liner | civilian | L | 350 m | 0.5 / 1.5 | 1 | 2 | — | — | 2–3 |
| Mining barge | civilian | L | 180 m | 0.2 / 0.8 | 1 | 0 | — | — | 1–2 |
| Patrol cutter | authority | M | 55 m | 1 / 8 | 1 | 3 | 2 (4/0) | — | 2–3 |
| Corvette | military | M | 46 m | 1 / 12 | 2 | 6 | 2 (6/6) | — | 3–4 |
| Frigate | military | M | 120 m | 1 / 9 | 2.5 | 10 | 4 (12/12) | 1 | 3–4 |
| Destroyer | military | L | 220 m | 1 / 7 | 3 | 16 | 6 (16/20) | 1 | 3–4 |
| Battleship | military | XL | 480 m | 0.5 / 5 | 4 | 36 | 12 (40/80) | 2 | 3–4 |
| OPA gunship | military | M | 90 m | 0.5 / 5 | 1 | 4 | 2 (6/2) | — | 1–2 |
| Pirate raider | irregular | S | 35 m | 1 / 7 | 0.5 | 1 | 2 (4/0) | — | 1–2 |
| Pirate gunship | irregular | M | 70 m | 0.5 / 5 | 1 | 2 | 2 (8/0) | — | 1–2 |

Civilian hulls are built for their trade: cargo and berths, not guns. Most carry no point defense at all, and civilian crews don't jink under fire (`evasive: false`), so a torpedo coming for them almost never misses. Authority, military and irregular crews do jink.

## Shapes

`SHAPES` describe silhouettes bow to stern as segments `[length fraction, half-width fraction]`. The first segment tapers to the bow. Optional features: `ring` (a spin habitat), `tanks` (spheres along the spine), `cargo` (a block segment), `fins`. The tactical display draws them at a size that grows with the logarithm of real length, so a 30 m skiff and a 1.4 km hauler are both readable.

## Our ship

`ship.classId = 'light-freighter'`. Its interior (sim/ship-layout.js) carries the fit: a weapons console on the bridge (fire control, a secure seat), a torpedo launcher with magazine in the hold, and two PDC turrets set into the engine-deck hull. These fixtures house two ship systems, `pdc` and `launcher`, which wear, fault and are repaired like every other system (sim/systems.js).

## Identities

`rollIdentity({ cls?, category?, role?, faction?, near? })` picks a class weighted by who flies it, then a faction, a TL and a name. Civilian traffic around a station is mostly of the station's own flag (`near`). Navy ships get their navy's prefix (UNN, MCRN). Old saves are mapped to classes by name (`classForName`).
