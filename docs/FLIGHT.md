# Flight and navigation

Modules: `sim/ephemeris.js` (bodies), `sim/flight.js` (our ship's dynamics), `sim/guidance.js` (pure guidance laws), `sim/lambert.js`, `sim/nav.js` (targets, plans, estimates, route options), `sim/stance.js` (stances kept on a target), `sim/autopilot.js` (flying a plan or a stance, station-keeping, warp limits).

## The solar system

Planets, moons and the major asteroids move on analytic circular orbits (`ephemeris.js`, the only place body positions are computed). Heliocentric periods follow Kepler's third law from GM☉, so a free body at a planet's radius co-orbits with it exactly. Positions are in AU, velocities in m/s, angles in radians in the solar frame.

## Gravity (`gravity.js`) and the ground (`terrain.js`)

Free flight (our ship, NPCs at the helm, torpedoes, drifting hulks) falls under the Sun and every body with mass within three times its sphere of influence: Ceres pulls 0.28 m/s² at its surface and 0.019 G at its port's gate, Luna 0.014 G at its yards' orbit, Jupiter 0.011 G at Ganymede. A body's pull is taken from where it is at the moment asked (integrators pass the time; the minute tick sets `setGravityEpoch` for those that don't), since a minute's error in Ceres' place is a thousand kilometres.

Holding a place costs the thrust between how the place moves and how we would fall there: a slot in a holding pattern (a free orbit) costs nothing; hovering at a surface port's gate costs most of the rock's pull (0.0175 G at Ceres, kept on RCS when the drive is down, as RCS gives 0.02 G); resting on the ground costs nothing. Hovering off a berth while docking costs the same (`docking.hoverG`).

**The ground.** A ship that stops thrusting by a rock falls: from Ceres' gate it hits in about 17 minutes at some 200 m/s. Flying free near a body, the nav computer calls the ground out at 30, 10, 3 and 1 minutes to impact (only the last minute while a route is flying: the guard below watches for it). Contact is judged against the turning surface: up to 2 m/s a touch; above, hull damage with the square of the speed, the whole hull at 50 m/s. A ship that survives rests on the surface (a hold on the ground) until a route lifts it. NPC hulls that come down are wrecked and left on the surface; torpedoes are spent.

**The terrain guard.** Routes are planned through empty space, so the nav computer (and every NPC pilot) flies a guard over them near a body: when the line to the target passes through the rock, or the path on the present command (flown out in 30-second steps under the pull) meets the ground within 5 minutes (15 while climbing) plus, on a route only passing the rock with nothing holding the ship up against the pull, what saving it would take (a half turn, six minutes, and the time the drive needs to stop the fall), it climbs off the local vertical (straight up while within 20 km of the ground, where a turn to lean would cost height it hasn't got) and round the limb toward the target's side at the speed five minutes of the drive gives (400–1,200 m/s out, 1.8× that round, under a port's speed limit), the pull covered; then the route flies on. It overrides the flip interlock and traffic control's drive cap: pulling up beats throwing the crew about. A target behind a rock is come at round it instead: the route flies first to a point four radii out between our side and the target's, moving with the body, and on to the target when the line clears (`viaPoint`). The planner flies the same guard, so its estimates are what will be flown. While the crew strap in before a route, a ship not held by anything keeps its height (a climb out of a port is kept).

Bodies don't steer route *plans* yet (a route can graze a planet: guidance then takes a turn or two more), and there is no atmosphere: entry and flight in air come with planetside ports.

## Our ship's dynamics (`flight.js`)

The ship is a point mass with an attitude. The Epstein drive pushes along the nose.

| Constant | Value | |
|---|---|---|
| `SLEW_RATE` | π/6 rad/min | a full flip takes 6 minutes |
| `ALIGN_TOL` | 8° | the drive fires only with the nose this close to the commanded vector (and a lit lean turns no faster than this a minute) |
| `LEAN_MAX` | 30° | guidance commands this far off the nose are leaned to with the drive lit |
| `RCS_MAX_G` | 0.02 G | RCS translation without turning (fine approaches) |
| `FUEL_PER_G_MIN` | 0.05 kg per G per minute | main drive; RCS costs 0.6 |
| `RATED_G` | 7 G | the armed light freighter's rating. Every drive is rated for 70% of its class's maximum (`ratedG`); above that it is overdriven: double fuel, and each minute risks a containment failure (P = 0.00012 × (g − rated)²) |
| `DRIVE_MAX_G` | 10 G | the default limit. Our ship's class sets its own (2 G for a cargo shuttle, 12 G for a Martian corvette), and route options above it are not offered |

Each minute `flightStep` takes a desired non-gravitational acceleration from the controller (and optionally the attitude it wants), and integrates with velocity-Verlet. How the nose follows:
- under RCS strength the command is RCS translation, with no turn (the nose swings to the requested attitude meanwhile);
- a guidance command up to 30° off the nose (`LEAN_MAX`) is followed with the drive lit: the nose leans round no faster than 8°/min and the drive gives what lies along it, RCS trimming the rest. Evasive and hand-flown commands turn first, since firing off the vector would only misdirect them;
- anything further is a real turn at full slew (RCS condition sets the rate) with the drive cold until the nose is within 8°, and a turn under way finishes before the drive leans. Machinery caps the available G every minute (`systems.driveLimitG`):
- a damaged drive or reactor cooling: 3G
- dead cooling: 0.3G
- hull under 50%: 3G
- an open hull breach: 1G (damage control)

Guidance plans with whichever is lower, the route's G or this cap, and with the slew rate the RCS can give, so a damaged ship brakes early rather than overshooting.

## Guidance (`guidance.js`, pure)

- **Closing law**: rendezvous with a moving target, closed loop, worked in the target's frame. It commands the relative velocity that heads for the stop point at the largest speed it can still brake from, optionally capped by a cruise speed. That yields burn → flip → brake from rest, cancels sideways drift, and follows the target's own acceleration every minute. Arrived = within tolerance of the standoff and under 3 m/s relative. The details that keep it clean at high G:
  - **Whole-step braking.** The drive acts once a minute, and at 10G a minute sheds 5.9 km/s. So the braking curve is built from whole one-minute burns that end exactly on the mark, rather than the continuous √(2·a·d). Each step aims at where the curve will be when the step ends. A 50,000 km dash at 10G takes 36 minutes against an ideal 24, of which the flip takes 6 and the RCS docking about 9.
  - **Committed flips.** Two curves bound the closing speed. Above the braking curve, computed with the turn the nose still has to make, the ship must brake. Below the burning curve, computed as if a whole flip were still ahead, it may burn toward the target. Between them it coasts. A ship not yet closing (at rest, or drifting away) also burns only below the burning curve: 100 km from a target, one minute at full burn is already more than the flip can stop. A ship halfway through its flip finishes it, and a ship in braking attitude turns back only when it is more than 3% short of the curve: the curve shifts a little as the geometry turns, and coasting a few percent under it costs less than two flips.
  - **The hold turn.** If holding on the target takes more thrust than RCS can give (a ship under thrust, a station circling a moon), the ship must end the approach with its nose along that pull. The brake ends with a planned turn into it:
    - a **swing** when the pull lies mostly along the line of sight: the drive idles and the nose comes round at full rate while the target's own pull does the braking. Chasing a fleeing ship is this case: brake hard, turn back toward it, close throttled below its thrust;
    - a **sweep** otherwise: the nose comes round with the drive lit, like a gravity turn, the pace of the turn setting the deceleration. It is planned at 6°/min (less as fast as the pull itself turns) and may run at 8°/min to catch up.

    A turn under way keeps its kind.
  - **Swings by period.** A station circling a moon swings by a km/s or two every few hours, and the moon swings round its planet too. Each layer is followed only once the time to go is short against its period (fully at a quarter period). Until then it is left out of the velocity matched and planned against at its worst, and a followed swing still counts at its worst until the last twelfth of its period.
  - **Sharing the drive.** Sideways comes first: keeping up with the target's sideways pull plus half of what's left for correcting drift, which is taken out within the hour while the drive is lit (left for the coast, it would be trimmed off on RCS at twelve times the reaction mass). The line of sight gets the rest. When the sideways pull takes more than a quarter of the drive and the flip is under 120°, the flip is a lit sweep through the pull's direction instead of a cold swing.
  - **No turns that aren't meant.** In braking attitude nothing asks the nose to go further than it can lean to with the drive lit, and the law passes the attitude it wants with the thrust (the flight step holds to it for any command it can give from there). When a thrust is off the nose but within a lean, the law asks for exactly what the lean will deliver, so its next correction starts from what really happened.
  - **Terminal.** The last 25 km are flown on RCS (plus the drive's lean when holding takes the drive), unless the ship comes in too fast or drifting sideways more than RCS can take out in a couple of minutes.

  - **The near zone.** The closing law plans its approach from afar. Close in it has no room to plan the hold turn, and a ship that has fallen off its plan there has nothing to fall back on. Within 100 km of the stop point the keep law (below) takes over when the route starts there toward a target whose pull takes the drive, or when the approach opens on the target at more than 50 m/s. It hands back beyond 200 km.

  `tests/guidance.test.mjs` flies all of this: every station type at every route G, moons and bodies, economy cruise, a failing drive, slow RCS, hand flying, intercepts of ships coasting or under thrust in any direction, and 156 routes started within 100 km of a ship, the nose any way, the ship pulling any way at up to 1G. It counts big turns, wobbles and backing off. The known blemishes it allows are:
  - a 21 m/s back-off 13 km from Phobos Yard at 0.3G (two orbits at once pulling 30% of the drive);
  - up to 120 m/s when chasing a ship thrusting sideways with five-sixths of our thrust;
  - a wobble or two in a close start against a pull barely stronger than RCS, while the nose finds it.
- **Keep law**: onto a point that rides with a target, and kept there, from any state: the nose the wrong way, drifting, the target pulling hard in any direction. It plans nothing. Each minute it takes the fastest speed toward the point the ship can still stop from, either on RCS or on the drive after the turn it would need. It burns toward the point only below the curve that allows for a whole flip, and passes the target frame's pull through. A correction RCS can make in a few minutes turns nothing, and coming in the nose follows the thrust. Settled on the point, it pulls back on RCS, critically damped, and the drive only carries the target's pull. It flies stances, and the near zone of routes.
- **Transfer law**: a Lambert arc to where the target will be at the planned arrival. It burns onto the arc, coasts with hourly correction checks, and hands over to the closing law for braking.

The same `guidanceStep` drives the live autopilot, the planner's fast-forward estimate (`nav.simulatePlan`) and NPC ships (agents.js), so previews match what actually flies.

## Targets, plans and routes (`nav.js`)

A target is `{ kind: 'body' | 'entity' | 'player', id }`. Standoffs:

| Standoff | Distance |
|---|---|
| dock | to a station's approach gate (1 km), then docking (DOCKING.md) |
| gate | hold at a station's approach gate |
| formation | 2 km off a ship |
| close | 100,000 km |
| scanner | 15M km |
| parking orbit | clear of the body |

`planRoutes` builds and estimates options:

| Option | Profile |
|---|---|
| EXPRESS | 3G brachistochrone |
| STANDARD | 1G brachistochrone |
| BELTER | 0.3G brachistochrone |
| ECONOMY | 0.3G burn, then coast at a capped cruise speed |
| BALLISTIC | Lambert transfer with the minimum-Δv arrival time (rails targets only) |
| COMBAT 5G / ASSAULT 7G / FLANK 10G | battle stations only; FLANK overdrives the drive |

A thrusting target can only be caught by out-accelerating it.

**Speed limits into a port.** A plan into a port (a station, its gate, a berth's corridor, a holding slot) carries the port (`plan.port`) and keeps under traffic control's limits: no faster than what brakes down, at the closing law's margin, to 2,700 m/s at the approach (3,000 less 10%) and 180 m/s at the gate, looking ahead by four minutes at the capped speed (a flip's worth); round a small rock, 1,000 m/s within five of its radii (or three times an orbit's speed there, whichever is faster: round a moon the size of Luna that tier is above the approach limit and drops out). Far out the cap is the law's own braking curve, so it only bites near the port.

A route to a station ends at its **approach gate** (`routeTarget`): a point straight up from it, outside the keep-out zone, turning with it. The last stretch to a berth is docking (DOCKING.md). Inside a station's gate the nav computer holds the drive to 0.1 G (traffic control: no torch near a station), battle stations aside. A route plotted while docked undocks first (a departure clearance is ours to ask for), backs out through the hold point, and the docking computer climbs out of the corridor on the RCS in the berth's frame (0.02 G, to 180 m/s) to just through the gate (DOCKING.md). Then the route's **departure leg**: a burn from the gate would cross the port at speed and be cited, so a route that leaves a port (it starts at a berth, or in a station's approach, bound elsewhere) first flies out of the approach on the RCS alone, no plume (`departLeg`): the rock's pull held first, the rest of the RCS pushing out toward the side the route will burn for (asked of guidance once, at the gate; within a radius of a rock's ground the way out climbs at least 30° above the horizon), up to the zone's speed limit, to 1.05 approaches out (2,100 km), or on to three if the burn from there would come straight back across the port. Then the drive lights, already outbound. The crew strap in meanwhile (RCS is safe on their feet), and traffic control counts the ship as leaving throughout. From a berth at Ceres all of it takes about two hours; route estimates include it (`departMinutes`).

A route into a holding slot (`{ kind: 'slot' }`, holding.js) ends in the slot, 200 m off its point, and holds there in free fall.

## Autopilot (`autopilot.js`)

A route goes through three stages:
1. **Prepare**: all hands to couches and a pilot to the helm. It engages when everyone able is strapped in, or on the captain's override.
2. **Active**: guidance flies the plan, re-planning every minute.
3. **Arrive**: the ship holds station on the target.

Standing order: never past 1.5G with anyone on their feet unless overridden.

**Crew safety.** A flip throws anyone not strapped in, at any G (inertia.js). So the crew are called to the couches for every stretch in which the nav computer may turn the ship:
- preparing to engage;
- the flip, and the half hour before it;
- the first minutes of a burn, and any burn above 1.5G;
- the last hour of an approach, the near zone and the RCS terminal;
- a stance moving into place, getting ready to guard, or running from a torpedo.

They are released for long steady burns and coasts, and while a stance holds, watches or guards on a steady burn. Whatever the plan, the computer won't start a flip (a turn of more than 137° from rest) with anyone able still on their feet. It **holds the flip**, with the drive cold and time warp off, until they are in, until the captain orders FLIP NOW, or for 30 minutes at most (`TURN_HOLD_MAX_MIN`). A walk to the couches can take a quarter of an hour. Running from a torpedo doesn't wait. While the ship maneuvers with anyone up, amber lights flash round the screen and over the decks, and the nav chip reads MANEUVERING — SECURE ALL HANDS. If the flight computer is degraded, burns wander. If it's dead, a crew member at the helm flies the plan by hand: pointing error depends on piloting skill and state, and nobody at the helm means the ship coasts.

**Holding station** pins the ship at a fixed offset from its target: parked off a station, in formation with a ship, in orbit at a body. If the target is under thrust, holding means burning with it. Escort contracts use exactly this to fly with a convoy.

## Stances (`stance.js`)

A stance is a standing order to keep a relation to a target (a ship, a station, a body) until it is released. It is flown, not pinned. It rides on the autopilot: it waits for the crew to secure, is hand-flown when the flight computer is down, and shows in the route status. There are three orders:

| Order | Keeps |
|---|---|
| HOLD | station at the range, on the bearing it settles on. Off a ship under thrust it burns with it, and a ship that out-turns it shakes it loose until it catches up |
| KEEP OUT | the range open: between the range and twice it |
| KEEP WITHIN | the range closed: between half the range and the range. It keeps up with the target's pull across the line of sight, so a ship under way doesn't slide out of range sideways |

The guards act along the line of sight. The order's own limit is hard: the range may come up to it no faster than the drive could stop it there, with the turn still to make (whole-minute steps, as the closing law's curves). Short of it the guard throttles up smoothly, so a ship pulling away at 0.3G is matched with a growing share of its thrust, steady at 0.3G on the limit, rather than chased in bursts. The far side only stops the ship drifting on: out of sight for KEEP OUT, past the target for KEEP WITHIN. A guard handles a small overshoot itself; past its limit by 5% of the range (or three bands), the ship moves back to the stance point.

Getting into place is the closing law flown to the *stance point* (the range on the line from the target to us), so the ship closes or opens straight along the line of sight and never crosses the target. Within 100 km of the point the keep law brings it in. Once there, HOLD keeps the point inside a band:

| Band | Width | |
|---|---|---|
| TIGHT | 0.5% of the range, at least 200 m | the default under 20,000 km |
| LOOSE | 10%, at least 1 km | slower, cheaper corrections. Off a coasting target the drive stays cold: no plume |

Pushed out of three bands, the ship moves back. A stance on a ship needs the sensor track: the board opens out as the ship draws away, and a track lost for 10 minutes ends the stance.

**Ranges** are offered from what we carry and what the target is (`stanceRanges`): formation (2 km), our guns (60% of PDC reach: 3.6 km at TL2) or mining gear, TORPEDO (50,000 km, outside guns and railguns, or 1.5× a railgun's reach), LONG (300,000 km, where torpedoes take an hour or more), SHADOW (80% of what our sensors hold of it), where we are now, or any range typed in. Ranges inside the target's known guns are flagged.

**Doctrine.** With a torpedo we track inbound, a stance closes on its target no faster than 5 km/s. With a fire-control computer that plots the threat axis (TL2 and up), it turns away and burns at its G from any torpedo less than 45 minutes out, as the navies do (COMBAT.md), and takes up its place again once none is within the hour. Both can be switched off.

The crew may move about while a stance holds, watches or guards on a steady burn, and are called in whenever it may turn (see crew safety). Time warp runs at full speed while holding or watching cold.

`tests/stance.test.mjs` flies stances against coasting ships, ships thrusting in any direction, ships charging and running, and stations circling moons, and fights one through a torpedo attack and a save.

## Time warp

Speeds are 1 min/s, 1 h/s and 1 day/s (`SPEED_MIN_PER_SEC`). `maxSpeed` allows fast-forward only through quiet stretches:
- 1× while preparing, flipping, igniting, on approach or with the helm unmanned, or at battle stations
- 2× while burning or hand-flown

The tactical picture caps it further (COMBAT.md). Under warp, intermediate minutes are "lite": they skip sensor and world refresh work, and the last minute of each frame brings everything up to date.

## Inertial events (`inertia.js`)

When the drive lights, cuts or changes hard, or the ship flips, anyone not strapped in keeps their old motion and slides or flies across the deck. It plays out in real time (game time frozen) with per-tile collisions. Impacts go through the crew trauma model. Announced burns up to 1.5G give people time to brace; surprises above 0.5G throw them.
