# LONGHAUL

Hard science-fiction ship-captain game for the browser. You pick a ship (anything from a Belt prospecting skiff to a surplus Martian corvette) and command it and its crew in a solar system divided between the United Nations, the Martian Congressional Republic and the Outer Planets Alliance. Everything runs on one simulated minute at a time: orbits, burns and flips, crew needs and watches, machinery wear, and torpedoes that can take days to arrive.

No build step, no dependencies: vanilla ES modules, IndexedDB saves.

## Play

```sh
./play.sh          # serves the folder on :8090 and opens the browser
```

Keys: `Space` pause · `1/2/3` time warp · `M` solar map · `R` scanner · `T` tactical · `W` combat · `C` battle stations · `E` systems · `D` duty roster · `L` missions · `J` jobs · `B` station · `I` ship's library · `Ctrl+S` quicksave.

**Light is the speed limit on what you know.** Your sensors show what is within about a light-minute, live. The rest of the system is on the solar map as a plot of reports, each with an age: traffic-control digests from every station (berths and filed flight plans, reaching you after the light time from that station), the last fix of every contact that dropped off your board, and news of hot zones and losses. Thousands of ships trade, patrol, blockade and fight out there. Within reach of your sensors they come alive and act for themselves; far away, what happens to them is settled by outcomes, with real wrecks. The `INTEL` button on the solar map shows or hides the plot.

The **ship's library** (`I`) is the ship computer's reference: every ship class, yard and tech level, the machinery and fittings aboard, weapons, navigation and doctrine, factions and stations, read from the same tables the simulation runs on. It doesn't pause the game; ship classes on the scanner and fire-control panels, machines on the systems board, and fittings on the deck plan link to their pages.

## Test

```sh
npm test                 # all suites
node tests/run.mjs combat   # one suite (substring filter on "file › test name")
```

The tests are integration tests of the simulation (no DOM). They print the numbers that matter for balance (hit rates, flight times, fuel), so read their output, not just the ticks.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): module layout, the per-minute tick, motion models, level of detail, saves, UI modules, tests
- [docs/FLIGHT.md](docs/FLIGHT.md): solar system, flight dynamics, guidance, routes, stances, autopilot, time warp, inertial events
- [docs/SHIPBOARD.md](docs/SHIPBOARD.md): decks, crew physiology and needs, watches, crew behaviour, jobs, machinery, air, power
- [docs/SHIPS.md](docs/SHIPS.md): ship classes and the yards that build them, tech levels, upkeep, sizes, shapes, and the ship we start in
- [docs/COMBAT.md](docs/COMBAT.md): sensors, weapons, ordnance flight, point defense, damage, fire control and stances
- [docs/WORLD.md](docs/WORLD.md): factions and influence, the background population, light lag and the plot, hot zones, encounters, NPC behaviour, law, stations, contracts, distress calls
- [CLAUDE.md](CLAUDE.md): working conventions for this repository
