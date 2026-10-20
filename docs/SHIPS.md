# Ships

Every ship belongs to a class in `js/sim/ship-classes.js`. A class is one design from one yard: a Martian Hellas-class frigate, an Earth-built Danube, a Belt refit of a forty-year-old freighter. An entity carries `cls` (class id), `tl` (its class's tech level) and `faction` (who flies it). Everything else (size, shape, drive, armor, weapons, gear, hold) comes from the class.

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

## Shapes

`SHAPES` describe silhouettes bow to stern as segments `[length fraction, half-width fraction]`. The first segment tapers to the bow. Optional features: `ring` (a spin habitat), `tanks` (spheres along the spine), `cargo` (a block segment), `fins`. The tactical display draws them at a size that grows with the logarithm of real length, so a 30 m skiff and a 1.4 km hauler are both readable. The new-game ship picker draws the same silhouettes in the yard's colour.

## Our ship

At a new game we pick any class a crew of eight or fewer can fly (`PLAYABLE`: S and M hulls with a minimum crew of 8 or less, 23 classes). The choice sets `ship.classId` and `ship.tl`:

- **Interior.** Every playable class shares the seven-deck plan (sim/ship-layout.js), fitted to the class. Without point defense the turret wells are plated over. Without tubes the launcher bay is hold space. A ship with nothing to fire has a couch where fire control would be.
- **Machinery.** Systems follow the fit (`systemsFor`): no PDCs means no `pdc` system to wear, no tubes means no `launcher`. They start in the condition of the class's TL and wear, fault and are repaired at its rates.
- **Drive.** The class's maximum G is the limit (`flight.maxG`). The drive is rated for 70% of it (`ratedG`); past that it is overdriven, with double fuel and a containment risk. Route options above the limit aren't offered.
- **Stores.** Hold, berths, PDC rounds (20,000 per mount) and magazine come from the class. A navy hull in private hands starts without its nuclear warheads.
- **Upkeep.** Spare parts at a station are priced at the ship's TL (`priceOf`), and a dockside overhaul is billed at its TL and structure (`overhaulQuote`).

The default is the armed light freighter: two PDCs and two tubes. Its interior houses the weapons console on the bridge, the torpedo launcher with magazine in the hold, and two PDC turrets in the engine-deck hull.

## How the tiers fight

`tests/combat.test.mjs` stages skirmishes 225,000 km apart and prints the results. The better-built ship wins:

- As the AI fights, a hopelessly outgunned ship breaks off at once (`ROLES.*.breakOff`). Belt refits and Earth's TL2 frigate run from a Martian frigate.
- With nobody allowed to break off, measured over 30 bouts each (seeds 700–729; the duel test runs six of them):

  | Bout | Better ship wins | Both destroyed | Undecided | Weaker ship wins |
  |---|---|---|---|---|
  | Belt refit frigate vs Martian frigate | 30 | 0 | 0 | 0 |
  | Earth TL2 frigate vs Martian frigate | 29 | 1 | 0 | 0 |
  | Earth TL3 Everest vs Martian Hellas | 19 | 6 | 2 | 3 |
  | Belt refit corvette vs Earth corvette | 30 | 0 | 0 | 0 |
  | Earth corvette vs Martian corvette | 26 | 3 | 0 | 1 |

  Earth's best frigate is the only hull of its size with a real chance against Mars: it wins one bout in ten and takes the Hellas down with it in one in five.
- Flying a Belt refit corvette, or the armed light freighter, against a Martian frigate, we are crippled or killed every time, and the frigate takes no damage. The armed freighter does see off a pirate gunship.

## Identities

`rollIdentity({ cls?, kind?, category?, faction?, near? })` picks a class (weighted by who flies it), then a faction and a name. A ship's TL is its class's. Civilian traffic around a station is mostly of the station's own flag (`near`). Navy ships get their navy's prefix (UNN, MCRN).
