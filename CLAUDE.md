# LONGHAUL: working notes

A hard sci-fi ship-captain browser game (Expanse-inspired). Vanilla ES modules, no build step, no runtime dependencies, IndexedDB saves. Start with `README.md` and `docs/`. They describe the systems and carry the balance numbers.

## Commands

- `npm test`, or `node tests/run.mjs <filter>`: the simulation test suites (no DOM). They print balance figures, so read them. `game › scale` (200k ships) is timed and can fail when the machine is busy; rerun it alone before suspecting the code. `SKIP=200k npm test` runs everything else (while the user plays, leave the timed test out).
- `./play.sh`: serve on :8090 (with `Cache-Control: no-store`, and a listen queue deep enough for the ~80 modules a load asks for at once) and open the browser. A plain caching server lets Chrome mix old and new modules after an update, and the game then fails to load with "does not provide an export named …". If that happens, hard-reload (Cmd+Shift+R).
- `python3 tools/crew-assets.py "<Universal Base Characters[Standard] folder>"`: rebuild `assets/crew/` (the crew's rigged bodies, CC0, Quaternius) from the kit; only when changing how the bodies are packed. Needs Pillow.
- Browser smoke test: serve the folder (`python3 -m http.server <port>`; its listen queue of 5 resets the odd module request, about one start in thirty, so a start that times out with ERR_CONNECTION_RESET is the server, not the game), then drive it with `playwright-core` (install it in a scratch dir) and the system Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, headless). Start a game through `[data-action="new-game"]` → `[data-action="start-game"]`. `window.__longhaul` exposes `state`, `loop`, `step(n)`, `start(state)` (play a state built with `createGame` and set up by hand), and modules can be imported in `page.evaluate` (`await import('/js/sim/agents.js')`). Collect `pageerror` and console errors.

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
- Gravity is real near bodies (`sim/gravity.js`): a test that flies its own minute loop instead of `minuteTick` calls `setGravityEpoch(minute)` each minute, and a test of flight or combat that isn't about the rocks moves 0.02 AU away from them (a ship let go at Ceres' gate falls).
- Work happens on branch `overhaul` (current version v1.12.8). `main` was last fast-forwarded to it at v0.10.0. Every round of changes bumps `js/version.js`, and a bump is committed as `vX.Y.Z: short summary` and pushed. Other commits, and merges, only when asked.
- Versioning from v1.12: v1.11.0 was the last release to bump the minor directly. Work on a minor goes out in PATCH bumps (1.12.0, 1.12.1, 1.12.2…), as many as needed, each round and each batch of the user's patch requests. Only when the user declares a release candidate and validates it does the minor move (1.13.0), and the patches start again. Never bump the minor on your own.
- The user often plays from the working copy while asking for changes. Then build and test in a scratch copy and apply the patch only when they say go. The untracked `memory/` folder at the repo root is old and is never committed.
- Kill any server you start for a smoke test.
- If an auto-mode safety check blocks running commands (combat-heavy conversations have triggered it), say so and ask the user to switch permission modes, rather than working around it.
