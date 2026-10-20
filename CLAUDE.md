# LONGHAUL: working notes

A hard sci-fi ship-captain browser game (Expanse-inspired). Vanilla ES modules, no build step, no runtime dependencies, IndexedDB saves. Start with `README.md` and `docs/`. They describe the systems and carry the balance numbers.

## Commands

- `npm test`, or `node tests/run.mjs <filter>`: the simulation test suites (no DOM). They print balance figures, so read them.
- `./play.sh`: serve on :8090 and open the browser.
- Browser smoke test: serve the folder (`python3 -m http.server <port>`), then drive it with `playwright-core` (install it in a scratch dir) and the system Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, headless). Start a game through `[data-action="new-game"]` → `[data-action="start-game"]`. `window.__longhaul` exposes `state`, `loop`, `step(n)`, and modules can be imported in `page.evaluate` (`await import('/js/sim/agents.js')`). Collect `pageerror` and console errors.

## Rules of the code

- **The sim is pure.** `js/sim/` never touches the DOM. It reports facts through the `emit` it is given (the bus); `js/ui/presenter.js` decides how they are shown.
- **One minute at a time.** Everything advances in `minuteTick` (sim/game.js), in a fixed order (docs/ARCHITECTURE.md). Decisions made in a minute are flown the next minute. Keep it that way.
- **State is plain data.** Keys starting with `$` are runtime-only and stripped from saves. A save from another `SAVE_SCHEMA` is refused (no migrations). Prefer additive changes that `upgradeState` (sim/game.js) can fill in on load, so players keep their games; bump `SAVE_SCHEMA` only for a change that can't be filled in. Layout changes refit old saves by deck id.
- **Scale target is 200k+ entities.** No per-minute work over all entities. Use the spatial hash, `world.driven` (agents and ordnance), `world.stations` and `world.beacons`. Far-away things get outcomes, not simulation. Traffic becomes an agent only when something near the player needs it to act.
- **Randomness only through `core/rng.js`**, so tests can seed it.
- **Units.** Positions are in AU, velocities in m/s, distances inside combat and guidance code in metres, and the UI shows km. Constants carry their unit in the name (`standoffM`, `launchAU`, `rangeM`). A wrong unit once made pirates charge to 800 km instead of 800,000 km, so check them.
- **Style.** Every module opens with a header block explaining the model in prose. Comments explain *why*. Match the surrounding density and naming.

## Process

- Keep `README.md`, `docs/*.md` and the module headers in step with the code. When a constant or behaviour that the docs quote changes, update the docs in the same change.
- Balance is checked by the tests' printed numbers (combat.test.mjs, factions.test.mjs). Re-read them after tuning.
- Suites not about encounters switch them off: `s.politics.quietUntil = Infinity; s.missions.cooldown = 1e9;`.
- Work happens on branch `overhaul`. `main` was fast-forwarded to it at v0.10.0. Release commits are titled `vX.Y.Z: short summary`, and `js/version.js` is bumped with them. Commit, push or merge only when asked.
- If an auto-mode safety check blocks running commands (combat-heavy conversations have triggered it), say so and ask the user to switch permission modes, rather than working around it.
