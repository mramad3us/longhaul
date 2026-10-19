# LONGHAUL

Hard science-fiction ship-captain game for the browser. You command a light freighter and its crew in a solar system divided between the United Nations, the Martian Congressional Republic and the Outer Planets Alliance. Everything runs on one simulated minute at a time: orbits, burns and flips, crew needs and watches, machinery wear, and torpedoes that can take days to arrive.

No build step, no dependencies: vanilla ES modules, IndexedDB saves.

## Play

```sh
./play.sh          # serves the folder on :8090 and opens the browser
```

Keys: `Space` pause · `1/2/3` time warp · `M` solar map · `R` scanner · `T` tactical · `W` combat · `C` battle stations · `E` systems · `D` duty roster · `L` missions · `J` jobs · `B` station · `Ctrl+S` quicksave.

## Test

```sh
npm test                 # all suites
node tests/run.mjs combat   # one suite (substring filter on "file › test name")
```

The tests are integration tests of the simulation (no DOM). They print the numbers that matter for balance (hit rates, flight times, fuel), so read their output, not just the ticks.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): module layout, the per-minute tick, motion models, level of detail, saves
- [docs/SHIPS.md](docs/SHIPS.md): ship classes, sizes, shapes and tech levels
- [docs/COMBAT.md](docs/COMBAT.md): sensors, weapons, ordnance flight, point defense, damage, fire control
- [docs/WORLD.md](docs/WORLD.md): factions and influence, hot zones, encounters, NPC behaviour, law, contracts
