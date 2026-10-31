# Ships

Every ship belongs to a class in `js/sim/ship-classes.js`. A class is one design from one yard: a Martian Hellas-class frigate, an Earth-built Danube, a Belt refit of a forty-year-old freighter. An entity carries `cls` (class id), `tl` (its class's tech level) and `faction` (who flies it). Everything else (size, drive, armor, weapons, gear, hold, crew) comes from the class, and what the hull physically is (its parts in metres, its docking collars, its interior) is built from the class in `sim/hulls.js` and `sim/ship-layout.js`.

## Yards and tech levels

Who builds a ship fixes its tech level, and the tech level decides how it fights and what it costs to keep running.

- **Mars** builds the best ships in the system: TL3 civilian hulls, TL4 warships. Better sensors, quieter hulls, sharper fire control, machinery that rarely breaks. When it does break, it takes the most spares and the dearest yard time.
- **Earth** (UN yards) builds sound, ordinary TL2 ships, plus a few modern TL3 hulls (the Everest frigate, the Leviathan battleship). Most of its fleet is a generation old.
- **Independent** yards (Ganymede) build TL2 commercial hulls.
- **The Belt** flies TL1 refits: old hulls rebuilt from wrecks, jury-rigged systems. They break all the time, but a Belter fixes them quickly from a handful of parts, and the fix holds for days.

| | TL1 Jury-rigged | TL2 Commercial | TL3 Naval | TL4 Advanced naval |
|---|---|---|---|---|
| Sensors (detection range) | ×0.7 | ×1.0 | ×1.3 | ×1.6 |
| Stealth (own signature) | ×1.2 | ×1.0 | ×0.8 | ×0.55 |
| Armor bonus | +0 | +0 | +0.5 | +1 |
| Fire control (PDC factor) | ×0.8 | ×1.0 | ×1.15 | ×1.3 |
| Jinking G | ×0.8 | ×1.0 | ×1.1 | ×1.2 |
| Turns away from inbound torpedoes | no | yes | yes | yes |
| Wear rate | ×1.5 | ×1 | ×0.75 | ×0.55 |
| Time between faults | ×0.5 | ×1 | ×1.6 | ×2.4 |
| Spares per repair or service | ×0.5 | ×1 | ×1.6 | ×2.4 |
| Hands-on repair time | ×0.7 | ×1 | ×1.25 | ×1.5 |
| A jury-rig holds | 48–120 h | 12–36 h | 8–24 h | 4–12 h |
| Yard labour and spare-part prices | ×0.6 | ×1 | ×1.6 | ×2.5 |
| Condition when found (integrity) | 62–85% | 88–100% | 92–100% | 95–100% |

Weapon performance also scales with TL: PDC kill rate and reach, torpedo motors and seekers, railgun speed and accuracy (COMBAT.md).

Spares per repair are rounded up: a minor fault takes 1 / 1 / 2 / 3 parts by TL, a major one 2 / 3 / 5 / 8. The upkeep test in `tests/ship.test.mjs` prints what each level costs over 45 days aboard.

## Sizes and build

| Size | Structure (DP) | Cold radar signature | Reactor blast (DP at core, e-fold distance) |
|---|---|---|---|
| S small craft | 60 | 0.0008 AU (~120,000 km) | 300 · 400 m |
| M medium | 120 | 0.0015 AU | 600 · 800 m |
| L large | 300 | 0.004 AU | 1,200 · 1,500 m |
| XL capital | 800 | 0.01 AU (~1.5M km) | 2,500 · 3,000 m |

Structure is multiplied by build (`BUILD`). Warships are compartmentalized and spall-lined (×1.5), police hulls a little (×1.2), and civilian and irregular hulls are just hulls (×1). A hull's target radius is 15% of its length.

## Classes

Every kind of ship is built by at least two yards. ★ marks the classes we can start in. Strength is `classStrength`, the AI's own measure of a fresh, crewed and stocked hull. It counts torpedoes (better motors count more), guns laid by fire control, railguns and gear, times armor, point defense, drive and structure.

| Kind | Class (id) | Yard | TL | Size | Drive cruise/max G | Structure · armor | Weapons | Hold · berths | Strength |
|---|---|---|---|---|---|---|---|---|---|
| Prospector | Rockhopper prospecting skiff ★ (`rockhopper`) | BELT | 1 | S 28 m | 0.5 / 2 | 60 · 0 | 1× rock-cracking charges | 40 t · 0 | 1 |
| Prospector | Kestrel survey skiff ★ (`kestrel`) | EARTH | 2 | S 32 m | 0.7 / 3 | 60 · 0 | — | 50 t · 0 | 1 |
| Prospector | Arsia survey skiff ★ (`arsia`) | MARS | 3 | S 30 m | 1 / 5 | 60 · 0 | — | 35 t · 0 | 1 |
| Courier | Dart courier (Belt refit) ★ (`dart`) | BELT | 1 | S 38 m | 1 / 5 | 60 · 0 | — | 8 t · 2 | 1 |
| Courier | Hermes-pattern courier ★ (`hermes`) | EARTH | 2 | S 40 m | 1 / 6 | 60 · 0 | — | 10 t · 4 | 1 |
| Courier | Phobos express courier ★ (`phobos`) | MARS | 3 | S 42 m | 1.5 / 8 | 60 · 0 | — | 10 t · 4 | 1 |
| Cargo shuttle | Mule cargo shuttle ★ (`mule`) | BELT | 1 | S 35 m | 0.5 / 2 | 60 · 0 | — | 400 t · 6 | 1 |
| Cargo shuttle | Ascension cargo shuttle ★ (`ascension`) | EARTH | 2 | S 36 m | 0.6 / 3 | 60 · 0 | — | 380 t · 8 | 1 |
| Cargo shuttle | Deimos lighter ★ (`deimos`) | MARS | 3 | S 34 m | 1 / 4 | 60 · 0 | — | 320 t · 6 | 1 |
| Light freighter | Tramp freighter (Belt refit) ★ (`tramp`) | BELT | 1 | M 58 m | 0.7 / 6 | 120 · 0.5 | — | 18 t · 8 | 2 |
| Light freighter | Armed light freighter ★ (`light-freighter`) | IND | 2 | M 62 m | 1 / 10 | 120 · 1 | 2 PDC, 2 tubes (2/0) | 15 t · 12 | 45 |
| Light freighter | Meridian light freighter ★ (`meridian`) | EARTH | 2 | M 64 m | 1 / 7 | 120 · 1 | — | 25 t · 10 | 2 |
| Light freighter | Ares fast freighter ★ (`ares`) | MARS | 3 | M 60 m | 1.2 / 9 | 120 · 1 | — | 18 t · 8 | 3 |
| Bulk freighter | Ore scow (`ore-scow`) | BELT | 1 | L 200 m | 0.2 / 0.8 | 300 · 0.5 | — | 26,000 t · 0 | 2 |
| Bulk freighter | Bulk freighter (`freighter`) | EARTH | 2 | L 220 m | 0.3 / 1 | 300 · 1 | — | 30,000 t · 4 | 2 |
| Bulk freighter | Tharsis bulk carrier (`tharsis-bulk`) | MARS | 3 | L 230 m | 0.4 / 1.5 | 300 · 1 | — | 28,000 t · 4 | 3 |
| Ice hauler | Ice hauler (`ice-hauler`) | BELT | 1 | XL 1400 m | 0.3 / 1 | 800 · 0 | — | 100,000 t · 0 | 3 |
| Ice hauler | Aquarius water carrier (`water-carrier`) | EARTH | 2 | XL 1200 m | 0.3 / 1.2 | 800 · 0 | — | 90,000 t · 0 | 3 |
| Tanker | Belt tanker (`belt-tanker`) | BELT | 1 | L 280 m | 0.25 / 0.8 | 300 · 0 | — | 55,000 t · 0 | 2 |
| Tanker | Reaction-mass tanker (`tanker`) | EARTH | 2 | L 300 m | 0.3 / 1 | 300 · 0 | — | 60,000 t · 0 | 2 |
| Liner | Colony transport (Belt refit) (`colony-ship`) | BELT | 1 | L 380 m | 0.3 / 1 | 300 · 0 | — | 3,000 t · 2500 | 2 |
| Liner | Passenger liner (`liner`) | EARTH | 2 | L 350 m | 0.5 / 1.5 | 300 · 1 | 2 PDC | 2,000 t · 1500 | 10 |
| Liner | Valles Express liner (`valles-liner`) | MARS | 3 | L 330 m | 0.7 / 2 | 300 · 1 | 2 PDC | 1,500 t · 1200 | 17 |
| Mining ship | Mining barge (`mining-barge`) | BELT | 1 | L 180 m | 0.2 / 0.8 | 300 · 1 | 2× ore mass driver | 35,000 t · 0 | 4 |
| Mining ship | Mining tender (`mining-tender`) | EARTH | 2 | L 170 m | 0.3 / 1 | 300 · 1 | 1× ore mass driver | 30,000 t · 0 | 3 |
| Mining ship | Pallas ore processor (`pallas-refiner`) | MARS | 3 | L 200 m | 0.3 / 1.2 | 300 · 1.5 | 2× ore mass driver | 32,000 t · 0 | 5 |
| Patrol cutter | Militia cutter (Belt refit) ★ (`belt-cutter`) | BELT | 1 | M 52 m | 0.8 / 6 | 144 · 0.5 | 2 PDC, 2 tubes (4/0) | 5 t · 6 | 23 |
| Patrol cutter | Patrol cutter ★ (`cutter`) | EARTH | 2 | M 55 m | 1 / 8 | 144 · 1 | 3 PDC, 2 tubes (4/0) | 5 t · 6 | 82 |
| Patrol cutter | Martian Security cutter ★ (`mcr-cutter`) | MARS | 3 | M 55 m | 1 / 9 | 144 · 1.5 | 4 PDC, 2 tubes (6/0) | 5 t · 6 | 281 |
| Corvette | Refit corvette (ex-UNN Harrier) ★ (`opa-corvette`) | BELT | 1 | M 50 m | 0.8 / 8 | 180 · 1.5 | 3 PDC, 2 tubes (4/2) | 10 t · 4 | 58 |
| Corvette | Harrier-class corvette ★ (`unn-corvette`) | EARTH | 2 | M 50 m | 1 / 9 | 180 · 2 | 4 PDC, 2 tubes (6/4) | 5 t · 0 | 228 |
| Corvette | Tharsis-class corvette ★ (`mcrn-corvette`) | MARS | 4 | M 46 m | 1 / 12 | 180 · 2 | 6 PDC, 2 tubes (6/6) | 5 t · 0 | 1361 |
| Corvette | Stolen corvette (ex-UNN Harrier) ★ (`pirate-corvette`) | EARTH | 2 | M 50 m | 1 / 8 | 120 · 2 | 3 PDC, 2 tubes (6/0) | 60 t · 4 | 96 |
| Frigate | Refit frigate (ex-UNN Danube) (`opa-frigate`) | BELT | 1 | M 125 m | 0.6 / 6 | 180 · 2 | 5 PDC, 3 tubes (8/4) | 100 t · 10 | 135 |
| Frigate | Danube-class frigate (`unn-frigate`) | EARTH | 2 | M 125 m | 1 / 7 | 180 · 2.5 | 8 PDC, 4 tubes (12/8), 1 rail | 20 t · 0 | 820 |
| Frigate | Everest-class frigate (`unn-frigate-new`) | EARTH | 3 | M 120 m | 1 / 9 | 180 · 2.5 | 10 PDC, 4 tubes (12/12), 1 rail | 20 t · 0 | 2201 |
| Frigate | Hellas-class frigate (`mcrn-frigate`) | MARS | 4 | M 120 m | 1 / 10 | 180 · 3 | 12 PDC, 4 tubes (12/12), 1 rail | 20 t · 0 | 4993 |
| Destroyer | Atlas-class destroyer (`unn-destroyer`) | EARTH | 2 | L 230 m | 1 / 6 | 450 · 3 | 14 PDC, 6 tubes (16/16), 1 rail | 50 t · 0 | 3077 |
| Destroyer | Valles-class destroyer (`mcrn-destroyer`) | MARS | 4 | L 220 m | 1 / 8 | 450 · 3.5 | 18 PDC, 6 tubes (16/20), 2 rail | 50 t · 0 | 16669 |
| Battleship | Leviathan-class battleship (`unn-battleship`) | EARTH | 3 | XL 500 m | 0.5 / 4 | 1200 · 4 | 32 PDC, 12 tubes (40/60), 2 rail | 500 t · 0 | 44800 |
| Battleship | Olympus-class battleship (`mcrn-battleship`) | MARS | 4 | XL 480 m | 0.5 / 5 | 1200 · 4.5 | 40 PDC, 12 tubes (40/80), 3 rail | 500 t · 0 | 110162 |
| Gunship | Converted-freighter gunship (`opa-gunship`) | BELT | 1 | M 90 m | 0.5 / 5 | 180 · 1 | 4 PDC, 2 tubes (6/2) | 2,000 t · 20 | 60 |
| Gunship | Pirate gunship ★ (`pirate-gunship`) | BELT | 1 | M 70 m | 0.5 / 5 | 120 · 1 | 2 PDC, 2 tubes (8/0) | 800 t · 6 | 26 |
| Raider | Torch raider ★ (`pirate-raider`) | BELT | 1 | S 35 m | 1 / 7 | 60 · 0.5 | 1 PDC, 2 tubes (4/0) | 20 t · 2 | 11 |
| Raider | Armed runner (stolen courier) ★ (`pirate-runner`) | EARTH | 2 | S 40 m | 1 / 6 | 60 · 0.5 | 1 PDC, 1 tubes (3/0) | 10 t · 2 | 11 |

Civilian hulls are built for their trade and carry no weapons, with three named exceptions:

- **Liners** carry two anti-debris PDCs, as passenger law requires.
- **The armed light freighter** (independent, TL2) has two PDCs and two torpedo tubes on a self-defense license.
- **Mining ships** carry their trade's gear (ore mass drivers, rock-cracking charges). Their crews turn it on a ship that comes within a few kilometres (`MINING_GEAR` in weapons.js). It is useless against torpedoes and outranged by any PDC.

Civilian crews don't jink under fire (`evasive: false`).

Spawning asks for a *kind* and a faction (`rollIdentity({ kind: 'frigate', faction: 'UN' })`), and the faction fields its own designs, weighted by `factions`. A faction that builds nothing of that kind (the OPA has no destroyers) fields the nearest thing it has. Pirates fly torch raiders, stolen couriers, gunships and the odd stolen corvette.

## Hulls

Every class has a physical hull (`hullOf`, `sim/hulls.js`): parts in metres, built the way spacecraft are built. Nothing is streamlined: pressure hulls are boxes stacked along the thrust axis (a torch ship is a tower whose decks are floors under thrust), tanks are cylinders, radiators are flat panels edge-on to the drive, the drive bell is at the stern, and armor, PDC turrets, tube doors, a keel railgun and mining drivers sit where they would. Proportions follow the kind (a shuttle is wide and flat, a courier slim, an ice hauler a 1.4 km berg on a spine). The classes a small crew can fly are built from their deck program, so the hull's boxes are the decks of the interior.

**Collars** (S crew hatch, M docking collar, L cargo cradle: docs/DOCKING.md) sit on the hull surface at a face: the nose (x+), the flanks (y±), a flank collar out on a short neck past whatever stands proud of the skin round it (radiators, tubes, mounts: `hulls.js collarsClear`; a fin the neck goes through is cut round it). On our ship each opens onto an airlock on a deck of the interior.

**No hull is rated for atmospheric entry**: a fusion drive would burn the spaceport it came down on, and RCS can't hold a hull up in a world's pull. Every hull carries what lands for it in its bays (`BAYS`; a sheet's ATMOSPHERE line, `landsBy`): a gig under a small hull's keel (the prospectors, couriers, station shuttles, raiders), a pinnace in a cutter, a corvette, a light freighter or a frigate, cargo landers and pinnaces in the big hulls. The carried craft are rated themselves: lifting bodies on ceramic bellies and skids (FLIGHT.md).

**Crew complements** are part of the design: `crew` is the rated range (the fewest who can keep watches, the most it berths), `crewStd` what a ship of the class usually carries. Every hull out there has its own number in the range, around the usual one, fixed by its identity (`manifest.complementOf`).

| Class | Crew rated | Usually | Hull (L × W × H) | Collars | Atmosphere |
|---|---|---|---|---|---|
| Rockhopper prospecting skiff | 1–3 | 2 | 28 × 10 × 8 m | S port flank | — |
| Kestrel survey skiff | 2–4 | 3 | 32 × 12 × 10 m | S port flank | — |
| Arsia survey skiff | 2–3 | 2 | 30 × 11 × 9 m | S port flank | — |
| Dart courier (Belt refit) | 1–3 | 2 | 38 × 7 × 6 m | S nose · S port flank | — |
| Hermes-pattern courier | 2–3 | 2 | 40 × 7 × 6 m | S nose · S port flank | belly |
| Phobos express courier | 2–3 | 2 | 42 × 8 × 7 m | S nose · S port flank | — |
| Mule cargo shuttle | 1–3 | 2 | 35 × 15 × 8 m | M port flank · L starboard flank | — |
| Ascension cargo shuttle | 2–3 | 2 | 36 × 15 × 9 m | M port flank · L starboard flank | belly |
| Deimos lighter | 2–3 | 2 | 34 × 14 × 8 m | M port flank · L starboard flank | belly |
| Tramp freighter (Belt refit) | 2–6 | 4 | 58 × 15 × 13 m | M nose · M port flank | — |
| Armed light freighter | 3–8 | 5 | 62 × 16 × 14 m | M nose · M port flank | — |
| Meridian light freighter | 3–6 | 4 | 64 × 17 × 14 m | M nose · M port flank | — |
| Ares fast freighter | 3–6 | 4 | 60 × 16 × 13 m | M nose · M port flank | — |
| Ore scow | 6–12 | 8 | 200 × 34 × 34 m | M port flank · L starboard flank | — |
| Bulk freighter | 8–16 | 10 | 220 × 37 × 37 m | M port flank · L starboard flank | — |
| Tharsis bulk carrier | 6–12 | 8 | 230 × 39 × 39 m | M port flank · L starboard flank | — |
| Ice hauler | 25–50 | 35 | 1400 × 168 × 168 m | M port flank | — |
| Aquarius water carrier | 20–40 | 28 | 1200 × 144 × 144 m | M port flank | — |
| Belt tanker | 6–12 | 8 | 280 × 34 × 31 m | M port flank · L starboard flank | — |
| Reaction-mass tanker | 8–14 | 10 | 300 × 36 × 33 m | M port flank · L starboard flank | — |
| Colony transport (Belt refit) | 30–60 | 45 | 380 × 61 × 57 m | M port flank · M starboard flank · L starboard flank | — |
| Passenger liner | 40–80 | 60 | 350 × 56 × 53 m | M port flank · M starboard flank · L starboard flank | — |
| Valles Express liner | 40–70 | 52 | 330 × 53 × 50 m | M port flank · M starboard flank · L starboard flank | — |
| Mining barge | 10–20 | 14 | 180 × 54 × 36 m | M port flank · L starboard flank | — |
| Mining tender | 8–16 | 11 | 170 × 51 × 34 m | M port flank · L starboard flank | — |
| Pallas ore processor | 8–14 | 11 | 200 × 60 × 40 m | M port flank · L starboard flank | — |
| Militia cutter (Belt refit) | 4–9 | 6 | 52 × 12 × 10 m | M nose · S port flank | — |
| Patrol cutter | 6–10 | 8 | 55 × 13 × 11 m | M nose · S port flank | — |
| Martian Security cutter | 6–10 | 8 | 55 × 13 × 11 m | M nose · S port flank | — |
| Refit corvette (ex-UNN Harrier) | 5–12 | 8 | 50 × 11 × 9 m | M nose · M port flank | — |
| Harrier-class corvette | 6–12 | 10 | 50 × 11 × 9 m | M nose · M port flank | tail |
| Tharsis-class corvette | 6–12 | 9 | 46 × 10 × 8 m | M nose · M port flank | tail |
| Stolen corvette (ex-UNN Harrier) | 5–10 | 7 | 50 × 11 × 9 m | M nose · M port flank | — |
| Refit frigate (ex-UNN Danube) | 20–40 | 28 | 125 × 20 × 18 m | M nose · M port flank · M starboard flank | — |
| Danube-class frigate | 20–40 | 32 | 125 × 20 × 18 m | M nose · M port flank · M starboard flank | — |
| Everest-class frigate | 20–40 | 30 | 120 × 19 × 17 m | M nose · M port flank · M starboard flank | — |
| Hellas-class frigate | 20–40 | 26 | 120 × 19 × 17 m | M nose · M port flank · M starboard flank | — |
| Atlas-class destroyer | 60–120 | 90 | 230 × 32 × 28 m | M nose · M port flank · M starboard flank | — |
| Valles-class destroyer | 60–120 | 80 | 220 × 31 × 26 m | M nose · M port flank · M starboard flank | — |
| Leviathan-class battleship | 200–400 | 320 | 500 × 75 × 65 m | M port flank · M starboard flank · M starboard flank · M nose · L port flank | — |
| Olympus-class battleship | 200–400 | 280 | 480 × 72 × 62 m | M port flank · M starboard flank · M starboard flank · M nose · L port flank | — |
| Converted-freighter gunship | 15–30 | 20 | 90 × 22 × 18 m | M nose · M port flank | — |
| Pirate gunship | 6–12 | 8 | 70 × 17 × 14 m | M nose · M port flank | — |
| Torch raider | 3–6 | 4 | 35 × 6 × 5 m | S nose · S port flank | — |
| Armed runner (stolen courier) | 2–5 | 3 | 40 × 7 × 6 m | S nose · S port flank | belly |

The tactical display, the docking camera, the ship picker and the library draw hulls from these models flat (`ui/hull-art.js`): from above, from below or along a flank as the pose shows it. The exterior view (a drone's camera) and the telescope render them as lit solids on the GPU (`ui/gl/hullmesh.js`, `ui/gl/ships3d.js`): every module a plated can with its frame rings and ports, what a hull carries outside (collars with their latches, RCS quads, radiator frames and manifolds, welded tanks, the drive bell and its gimbal frame, PDC turrets, sensor dishes), in each hull's pose, in sunlight.

## Our ship

At a new game we pick a military license (none, UN, MCR or OPA: WORLD.md, military service) and any class a crew of eight or fewer can fly (`PLAYABLE`: S and M hulls with a minimum crew of 8 or less, 23 classes), and sign on up to its berthed maximum (12 at most: `maxCrew`). A navy's corvette needs that navy's license (the picker shows the others locked); the stolen ex-UNN Harrier can be taken, and is illegal everywhere. The choice sets `ship.classId` and `ship.tl`:

- **Interior.** Each playable class has its own deck program (sim/ship-layout.js): which decks, bow to stern, each drawn from a deck template and fitted to the class (SHIPBOARD.md). Small craft are 7 tiles wide, the rest 9. Without point defense the turret wells are plated over, without tubes the launcher bay is hold space, a ship with nothing to fire has a couch where fire control would be. The hull is cut for airlocks where its collars are, and for a cargo door.
- **Machinery.** Systems follow the fit (`systemsFor`): no PDCs means no `pdc` system to wear, no tubes means no `launcher`. They start in the condition of the class's TL and wear, fault and are repaired at its rates.
- **Drive.** The class's maximum G is the limit (`flight.maxG`). The drive is rated for 70% of it (`ratedG`); past that it is overdriven, with double fuel and a containment risk. Route options above the limit aren't offered.
- **Stores.** Hold, berths, a warship's brig (holding cells apart from any passenger berths: corvettes 6, frigates 12, destroyers 24, battleships 60, on a brig deck of their own; a police cutter's brig is its passenger deck), PDC rounds (20,000 per mount) and magazine come from the class, and a rack of camera drones by size (S 2, M 3, L 4, XL 6; sim/drones.js). A navy hull in private hands starts without its nuclear warheads.
- **Upkeep.** Spare parts at a station are priced at the ship's TL (`priceOf`), and a dockside overhaul is billed at its TL and structure (`overhaulQuote`).

The default is the armed light freighter: two PDCs and two tubes, an M collar on the nose and one on the port flank by the hold. Its nine decks are the bridge (helm, ops, the weapons console), crew quarters (four racks for a crew of eight on watches), the mess, utility, two passenger decks (twelve berths), the hold (the launcher with its magazine, the crew airlock, a cargo door), the engine deck (two PDC turrets in its hull) and the reactor. A new game starts in a berth at Ceres.

## How the tiers fight

`tests/combat.test.mjs` stages skirmishes 225,000 km apart and prints the results. The better-built ship wins:

- As the AI fights, a hopelessly outgunned ship breaks off at once (`ROLES.*.breakOff`). Belt refits and Earth's TL2 frigate run from a Martian frigate.
- With nobody allowed to break off, measured over 30 bouts each (seeds 700–729; the duel test runs six of them):

  | Bout | Better ship wins | Both destroyed | Undecided | Weaker ship wins |
  |---|---|---|---|---|
  | Belt refit frigate vs Martian frigate | 30 | 0 | 0 | 0 |
  | Earth TL2 frigate vs Martian frigate | 30 | 0 | 0 | 0 |
  | Earth TL3 Everest vs Martian Hellas | 20 | 2 | 5 | 3 |
  | Belt refit corvette vs Earth corvette | 28 | 2 | 0 | 0 |
  | Earth corvette vs Martian corvette | 29 | 0 | 1 | 0 |

  Earth's best frigate is the only hull of its size with a chance against Mars: it wins about one bout in ten. Martian torpedoes talk to their ship more quietly (a FAST torpedo in datalink shows to the target's short-range suite by its TL's stealth: COMBAT.md), so the Everest sees them coming later than the Hellas sees its own. (The duels are chaotic: the same code gives 3 to 9 Everest wins in 30 with only the crew size of the watching ship changed, so the duel test runs twelve bouts and only asserts that the Everest doesn't win most of them.)
- Flying a Belt refit corvette, or the armed light freighter, against a Martian frigate, we are crippled or killed every time, and the frigate takes no damage. The armed freighter does see off a pirate gunship.

## Identities

`rollIdentity({ cls?, kind?, category?, faction?, near?, sub?, state? })` picks a class (weighted by who flies it), then a faction, a sub-faction (by the class's category: WORLD.md) and a name. A ship's TL is its class's. Civilian traffic around a station is mostly of the station's own flag (`near`).

**Names** (`sim/names.js`) are patterns filled from word lists by culture (Earth's corporate and sentimental names, Mars's earnest frontier ones, the Belt's Lang Belta and humour, the independents' gallows humour), by trade (prospectors, couriers, haulers, liners… each have their words) and by sub-faction (a company's big hulls carry its code some of the time: LKC, HAD, GAC, BSS; each pirate clan names its hulls to its own legend). Navies prefix their hulls (UNN, MCRN; OPA warships carry bare Belter names); police carry their service's code (UNS, MSS, SH) and often a number; pirates never announce themselves. The civilian pools run to 0.7–1.5 million names each (about 1 repeat in 2,000 at a game's scale), and a game's **registry** (runtime only: rebuilt from the entities on load) makes a repeat impossible: on a clash the generator rolls again, then numbers the name in its own style ("Ceres Dawn II", "UNN Ravi (FFG-214)").
