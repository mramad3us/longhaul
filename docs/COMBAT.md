# Combat

Nothing in LONGHAUL glows. There are three weapon families: point-defense cannons, torpedoes and railguns. All of them obey the same flight physics as the ships that carry them. A fourth thing isn't a weapon at all: mining gear, which a miner can turn on a ship that comes close. How well all of it works depends on the tech level the ship was built to (SHIPS.md). Modules:

| Module | Role |
|---|---|
| `sim/weapons.js` | performance tables by tech level, warheads, profiles, evasion math |
| `sim/sensors.js` | one detection model for everybody |
| `sim/combatants.js` | uniform view of any ship (ours or an NPC's): kinematics, combat profile, NPC hull state |
| `sim/ordnance.js` | torpedoes and slugs in flight; terminal resolution; PDC strafing |
| `sim/damage.js` | hits, aim, sections, reactor failures, fusion detonations |
| `sim/combat.js` | our fire control and the per-minute fight |
| `sim/telescope.js` | what our telescope can hold, and what it sees of it: contacts, worlds, the Sun, flashes, through its filters (`ui/telescope.js` draws it) |
| `sim/agents.js` | NPC pilots: how they fight, flee, demand and surrender |

## Seeing

Every target has a **signature range**, the distance at which a standard (quality 1) sensor suite holds it:

| Target | Signature |
|---|---|
| transponder on, or distress beacon | 0.1 AU (radio) |
| drive lit | 0.1 AU (the plume) |
| station | 0.2 AU |
| cold, silent hull | by size (SHIPS.md) × stealth of its TL |
| torpedo, drive lit | 0.05 AU |
| torpedo, coasting in datalink with its ship (FAST) | 0.001 AU × its TL's stealth (~150,000 km at TL2, ~82,000 km at TL4) |
| torpedo, coasting silent (COLD COAST, or out of link) | 0.0002 AU (~30,000 km) |
| railgun slug | 0.00003 AU (~4,500 km) |

An observer sees a target inside signature × its sensor quality. Quality depends on tech level and damage; for us it also improves with an ops watchstander. A torpedo's own seeker has quality 0.3. Our display band (SHORT/MED/LONG) caps how far the board looks. NPCs identify an unknown ship by tracking it for 60 minutes; a transponder identifies instantly. So do we, with one exception: a ship we hunt (a bounty, a strike target) is on no registry for a long look to match. Only its transponder names it, or its drive signature, when the brief has it on file (`c.sigKnown`) and we see it in its plume (a signature is read only while the drive is lit). Until then it is one more dark contact: no name on any display or route, and the search box does not find it; the dark contacts in the search area of its last fix are marked as possibles (BOUNTY?, a dashed diamond) until one is named or ruled out (WORLD.md, `sim/hunts.js`).

A torpedo talks to its ship both ways: the ship feeds it the track, it reports where it is. Talking is emitting, so a FAST torpedo in link shows to the short-range suite (thermal, EM, lidar) with its drive cold; a COLD COAST one only listens. Our own torpedoes are on our board wherever the band reaches, by their telemetry, and every display draws them flying at where they have their target, not at where the target really is.

Everything on the board is under a light-minute away, so it is live to within one sim step; the scanner shows each contact's light time. Only what the sensors hold is drawn on the tactical view and live on the solar map. A contact that drops off the board stays on the plot as its last fix, aging (WORLD.md, *Light lag and the plot*).

Whether a contact squawks is known the moment the board holds it: the radio hears its transponder or it doesn't (a distress beacon counts). Every display marks a ship running **dark** (no transponder, wrecks included) the same way: its mark hollow where a squawking ship's is solid, and DARK (or WRECK) after its name, or in place of a name we don't know yet; a lost contact's last fix on the plot keeps it, as a broken ring. The nav computer also marks what our signed work points at (a magenta diamond and the job: BOUNTY, SALVAGE, CARGO, TURN IN, DISTRESS, CALL-UP; a hunted ship only once it is named, its last-seen mark until then) and the captain's own **flags**: up to 26, lettered A to Z, on any ship or station we have a track of (`F`, or FLAG on the card and the contact panel). A flag lasts as long as the track: the nav computer calls a flagged contact out when it comes back on the board, and drops the flag when the plot forgets the ship (sim/flags.js).

## The telescope

The board says where a contact is; the telescope shows it (`sim/telescope.js`; drawn by `ui/telescope.js`, its sky by `ui/scope-sky.js`, a fight by `ui/scope-fx.js`, on the EXTERIOR display: `Z`, or LOOK on a contact's or a world's card or panel). One thing at a time, a contact or a world, from where we are, as the optics make it. Everything is drawn from numbers: nothing is loaded, and the game plays offline.

| TL | Mirror | Resolves | Reaches (a video frame) | Holds a target to |
|---|---|---|---|---|
| 1 | 0.3 m | 2.2 µrad | mag 14.9 | 400,000 km |
| 2 | 0.5 m | 1.3 µrad | mag 16.0 | 1,000,000 km |
| 3 | 0.8 m | 0.8 µrad | mag 17.0 | 1,500,000 km |
| 4 | 1.2 m | 0.6 µrad | mag 17.9 | 2,000,000 km |

- **Resolution** is the diffraction limit, 1.22 λ/D at 550 nm, worsened by the mount's shake: 0.4 µrad on a quiet ship, 2 µrad more per G of our own thrust, more with the sensors damaged. A hull six or more resolution elements long is a shape: the solid seen along the line of sight (rolled as its crew left it: a little of its back or belly shows), lit by the Sun at its phase and blurred to the resolution; from 1.5, a smudge; less, a point. Twelve elements and more, the frame takes in the whole of it (its length or its height filling 55% of the frame), zooming in past the optics' narrowest field digitally (to 24 resolution elements across: a far hull blurred, as it is) or out as far as a ship close by takes, to 34°: zoomed out, the sensor's pixels set the resolution (1,024 elements across the field), not the mirror. Otherwise it is the camera's narrowest field, 512 elements across.
- **Light.** A hull shines by reflected sunlight: its area across the line of sight, albedo 0.15 times its TL's stealth, the Sun's distance and the phase (a Lambert sphere: the Sun behind us shows its day side, behind it its night side, a silhouette with a lit limb). A 100 m hull in the Belt is magnitude 0.6 at 1,000 km, 8 at 30,000 km, 13 at 300,000 km and 15.6 at a million: at TL2's limit. A drive is a star: 500 W of light per newton of thrust, so a ship at 1 G is magnitude 4 at 700,000 km, some fourteen magnitudes brighter than its own hull. Its glare goes by its aspect: seen from the side, a star at the stern and a short cone of exhaust; looking up its exhaust (its nose away from us), the plume's light washes over the hull; nose toward us, the hull hides its drive and the glare rims its silhouette. Flashes (averaged over a frame): a nuclear detonation 10¹⁵ W, a reactor letting go 3·10¹⁵ W (each blinds the frame at any range it can hold), a torpedo striking home 3·10¹¹ W (its speed more than its charge: brighter than a drive), a slug's impact 2·10¹⁰ W, a torpedo shredded by a PDC 10¹⁰ W.
- **Filters.** FILTER on the camera's bar steps through the mount's plume filters (lit amber when one would help). A fusion drive's light is a few emission lines, sunlight off a hull is broadband: PLUME takes a drive down 5 magnitudes and a hull 0.5 (a flash 3); DEEP 9 against 1.2 (a flash 7), the frame darker and noisier. They bring a hull out of its own drive's glare. Looking aft through our own lit drive (15° round its axis) the frame is blind without one; with one it sees, degraded: washed, blurred (by the plume's plasma: two to four times the resolution) and shimmering.
- **Exposure.** The camera is exposed for the brightest thing in the frame: with a sunlit hull or a world's disc there are no stars; with a plume, only the bright ones; with nothing, the sky down to the limit and the sensor's noise. Something under the limit is not drawn: what is shown is what the camera would see, which far out is mostly black. The readouts give the exposure and the gain, the filter in, and how old the light is.
- **Zoom.** The camera zooms in steps (`zoomLevels`): its widest field (34°) halved step by step past the optics' narrowest (512 resolution elements across) digitally to 24 elements across: 15 steps at TL1, 17 at TL4 (to 3.4″, ×36,000). The computer picks the narrowest step that takes in the whole of what it holds (`autoZoom`: a hull or a world framed to 55% and 62% of the frame; anything smaller, the optics' narrowest); the captain picks another with − and + on the bar, `+`/`−`, or the wheel, and it holds until AUTO or a new target (a burst's pull-back is the computer's only). The readout gives the field, the zoom, and the computer's pick beside the captain's.
- **Lock.** The mount holds a target in a field a few arcseconds across only on a fine track (the board's fix and the ranging laser on one mount), to the range above (times the sensors' condition), and only a contact the board holds. Past it the display says how far it is and how far the mount reaches. A new target is slewed to, fast and eased (the stars streak), then held exactly.
- **Worlds and the Sun.** Planets, moons, asteroids and the Sun are held on the ephemeris, at any range, their pictures as old as their light. A world is drawn as a sphere at its phase, turning with its rotation: belts, zones and storms on the giants, Saturn in its rings, Earth's oceans, continents and cloud and its cities on the night side, the Moon's maria and craters, Mars' rust and caps, Io's volcanoes, Europa's cracks; the air of a world with one scatters light round its limb, a ring all round when it is backlit; small rocks are not round. Brightness by geometric albedo (Jupiter −2.3 and 41″ from the Belt, Saturn +1.2, the Sun −24.5 and 11.5′). The Sun is seen through the solar filter, which the mount puts in by itself (12.5 magnitudes): a limb-darkened disc, granulation, sunspots in groups turning with it; within 10° of the boresight its scattered light washes the frame. A world nearer than a target and across the line of sight hides it (OCCULTED), and one that crosses the Sun is a silhouette on its face.
- **A fight, seen.** A nuclear burst whites out the sensor (with a bloom streak, the flash's ghosts in the optics, and close in the snow of its radiation on the detector), then a shell of plasma kilometres across, edge-bright and lumpy, cooling from white through gold to red; a reactor letting go is the same in a blue-white plasma, with a shock ring racing out and the ship's plates tumbling away. A torpedo striking home is a white strike on the hull's face, a fireball tens of metres across, a spray of fragments out of the hole, the air venting in a white puff and the breach glowing on; at long range mostly the sensor's flare round it. A PDC fires in flickering muzzle flashes at the turrets the hull carries and tracer streams reaching for the torpedo (at us, rounds blooming out of the muzzle and racing off the frame). Rounds fly at their speed (1,200 m/s from the muzzle, plus the closing speed), on the wall clock as every effect: at 6 km the first of a burst lands some five seconds after the guns open up, at 9 km seven and a half, and the stream keeps arriving that long after they stop (the readout counts down to the first hit). Our own guns raking what we hold: tracers coming in from the frame's edges and converging on it (rounds flying away from us: fast at first, crawling in at the end), walked along the hull by the gunner, the hits landing on the faces we see, as many as the burst did damage, each a white-hot strike lighting the plating, sparks thrown off the face, a puff of vaporised metal, a spot glowing on and cooling, flakes of plating; the misses going on past it. An intercept is a spark, fragments and a little fire. Effects run on the wall clock, at true scale where they happened, moving on with what they happened to, and the camera pulls back to take in a burst near what it holds. A target blown apart leaves the mount holding on where it was going (its debris keeps its velocity), the frame still.
- **The arrival.** When our torpedoes are in their last 3 minutes to a target the telescope can hold, the EXTERIOR display comes up on it by itself (or its window, if it floats), time runs at 1×, and it stays through whatever happens to them, shot down, hit or missed, and until what followed has played out (a target blown apart is held on seven seconds), then goes back to what was showing. A torpedo drawn past its target in the minute being drawn is not drawn (the sim settles that minute whole; the flash follows when it does).

## Torpedoes

A torpedo is a small fusion missile: an entity of type `ordnance`, driven, integrated every minute under gravity and its own thrust.

| TL | Max G | Δv |
|---|---|---|
| 1 | 12 | 100 km/s |
| 2 | 18 | 150 km/s |
| 3 | 25 | 250 km/s |
| 4 | 32 | 400 km/s |

**Profiles** set the closing speed the torpedo builds and then holds. The speed is limited by how fast its seeker can close and still hold terminal lock, which depends on tech level:

- **FAST** (TL1 15, TL2 20, TL3 25, TL4 30 km/s): a short flight and little time inside point defense. The plume is seen early, though, and in datalink with us it shows to the target's short-range suite even coasting.
- **COLD COAST** (40% of FAST): boost, then coast dark, its datalink listening only. Invisible beyond ~30,000 km until the last minutes, so the target doesn't run. Slow, and point defense gets a long look.

A seeker holds its terminal lock up to a quarter past FAST (`SEEKER_SLACK`, weapons.js); closing faster, the chance it holds falls with the square of the excess. So a torpedo too fast for its seeker brakes on the way in (below).

Launched at a target 6 million km away, a TL2 cold torpedo flies for about nine days; across half an AU, for weeks. Civilians run only from ordnance they can see arriving within two hours: no hauler carries the reaction mass to run for days.

**Guidance** runs once a minute and is flown the next minute:

1. *Track.* Update the target track if the seeker sees the target, or if the launcher still does and is within datalink (radio) range. Otherwise fly on the last known track, dead-reckoned. A target that went cold and changed course is aimed at where it would have been. If the torpedo reaches the predicted point and finds nothing, it self-destructs.
2. *Closing.* Burn down the line of sight whenever the closing speed falls below the profile's. Against a ship **running** (accelerating away down the line of sight), holding that speed would take matching its burn minute for minute for as long as it runs, and no torpedo has that Δv. So it builds more, at the motor's full G, on the Δv it has past a reserve for the last seconds (20 s of full thrust): as much closing speed as the runner's own burn will bleed back down to the profile's by arrival (v² = v_profile² + 2·a·d), and coasts in dark on it. Closing faster than its seeker could follow at arrival (a runner that stopped running, a launch from a ship closing hard), it brakes down to that speed, late and as hard as it must: Δv spent. A shot's reach is finite: a TL4 torpedo runs down a corvette running at 8G from 375,000 km in about an hour, and from 3 million km it runs dry (`tests/chase.test.mjs`). `torpedoForecast` says, before launch, whether a shot gets there with the target keeping its burn; fire control shows it as REACH, and NPC crews don't launch a shot that can't.
3. *Miss.* Predict the miss at closest approach (zero-effort miss, extrapolating the target's thrust over a short horizon). When it exceeds a deadband, correct it with a deadbeat burn. Inside ten minutes, correct every minute.

**Endgame.** Every minute, the closest approach between each torpedo and its target over the minute just flown is found from their start and end states (1 s segments, constant relative acceleration). If it passes inside the **capture basket** (what the torpedo's remaining acceleration can close in its last 8 seconds, plus what its spare thrust can answer of a last-minute dodge), it is resolved:

- **Point defense.** Each PDC battery covering the target fires while the torpedo crosses its envelope: exposure = envelope ÷ closing speed, at most 20 s. Kill hazard = mounts × kill rate × fire-control factor × exposure. Torpedoes arriving within 5 s of each other share the guns (salvos saturate), and rounds are spent per engagement. Covering batteries are the target itself, our PDCs over ships we protect (escort charges, rescue victims), and NPC wingmen.
- **Homing.** A survivor hits with P = 1 − (target evasive G ÷ torpedo G available)², clamped to 5–97%, times the lock: 1 up to its seeker's limit, (limit ÷ closing speed)² past it. A civilian that doesn't jink is all but certain to be hit.
- **Warheads.**
  - HE (70 DP) needs the hit and lands on a section chosen by aim.
  - Nuclear (600 DP at the core, e-folding over 300 m) fuzes at closest approach even when homing fails. Its blast hits everything nearby.

| PDC by TL | Kill rate /mount-s | Anti-torpedo envelope | Gun range vs hulls | Dispersion |
|---|---|---|---|---|
| 1 | 0.25 | 25 km | 4 km | 1.0 mrad |
| 2 | 0.4 | 40 km | 6 km | 0.7 mrad |
| 3 | 0.5 | 55 km | 10 km | 0.5 mrad |
| 4 | 0.55 | 70 km | 15 km | 0.35 mrad |

Fire-control factor: our PDCs run at 0.6 on automatic, and at 0.7 + 0.6 × security skill/100 with a gunner at the weapons console. NPC factors depend on the crew (military 1.1, authority 1, pirates 0.85, civilians 0.8), scaled by crew losses and sensor damage. Every factor is then multiplied by the ship's fire control (TL1 ×0.8, TL2 ×1, TL3 ×1.15, TL4 ×1.3), which covers the radar, the gun laying and the targeting AI. A mount fires 50 rounds per second.

Typical outcomes (printed by `tests/combat.test.mjs`):

- An unarmed hauler 300,000 km away is hit 12 times out of 12.
- A single torpedo against an MCRN corvette's six TL4 mounts never gets through (0/10); six-torpedo salvos land about one hit in six.
- Our two TL2 mounts stop 11 of 12 single pirate torpedoes with a gunner at fire control, and 9 of 12 on automatic. Pirate salvos of two are much more dangerous.
- One HE hit takes about half our hull.

## Railguns

A slug is unguided. At firing, fire control solves for the intercept, assuming the target keeps its current thrust, and launches the slug at the gun's speed (TL2 20, TL3 30, TL4 45 km/s) on top of the ship's velocity. When the slug passes the target, the miss is taken from the actual motion and combined with Gaussian errors: the gun's angular dispersion (TL2 4, TL3 2, TL4 1 µrad × range) and the target's jinking over the flight time. Hit if within the target radius.

Jinking: the target picks a new random thrust direction every 8 s at its evasive G. An NPC jinks at half its available G (at most 3G), times its TL's jinking factor (0.8–1.2). Over a flight time t, the position uncertainty is σ = a·min(t²/2, √(8/3)·t^1.5). A ship holding still is hit at long range; a jinking one, only at knife-fight range. At 2,000 km a TL3 railgun hits a coasting target 29 times in 30 and a jinking one once.

## PDCs against hulls

Inside gun range a ship can rake another with PDC fire. Each minute the stream's dispersion (angle × range, plus jinking over the rounds' time of flight at 1.2 km/s) is compared with the target radius. Damage = 6 DP × mounts × fire-control factor × P(burst hits). It burns 30% duty × 50 rounds/s × mounts of ammunition.

## Mining gear

Mining ships carry their trade's tools (`MINING_GEAR`), resolved each minute like PDC strafing: the gear's dispersion × range, plus the target's jinking over the projectile's flight, against the target radius. Damage = DP × mounts × fire-control factor × P(hit). It throws rock, so it never runs dry, and it can't touch a torpedo.

| Gear | Reach | Projectile | Dispersion | DP per mount-minute |
|---|---|---|---|---|
| Rock-cracking charges (prospectors) | 3 km | 300 m/s | 4 mrad | 3 |
| Ore mass driver (mining ships) | 8 km | 2.5 km/s | 2.5 mrad | 4 |

A civilian miner turns its gear on any hostile inside reach while it runs. That includes us: rake a mining barge from 4 km and it throws back about 6 DP. Pirates take a miner for toothless and close in on it. On ENGAGE our own gear fires at the target whenever it is inside reach.

## Doctrine and the tiers

Ships at TL2 and up have a fire-control computer that plots the threat axis (`TECH.counterBurn`). When torpedoes are inbound within 45 minutes (`COUNTER_BURN_S`, weapons.js), they turn away and burn from the nearest one. The torpedoes then arrive slowly, spend a long time inside the PDC envelope, and have to spend Δv to catch up. A ship that keeps charging meets them at a hundred km/s or more and gets half a second of point defense against each. A jury-rigged TL1 ship holds its course and jinks. Two more rules follow from the same arithmetic:
- With any torpedo inbound, a TL2+ crew closes on the enemy at no more than 5 km/s (`UNDER_FIRE_CLOSE_MS`), because every m/s of closing speed is added to the enemy's torpedoes.
- A torpedo outlives the ship that fired it. Warships (navy, patrol, picket) keep jinking and turning away until the last one inbound is accounted for, whatever they are doing.

Our ship follows the same doctrine while it keeps a stance (below and FLIGHT.md), if its own fire control has the computer for it.

Agents fly to an enemy on where it is and how it moves, not on its thrust. That thrust is a reaction to us, and two ships each matching the other's burn would fly side by side and never meet. Against an enemy their drive also fires only once the nose is on the vector (no lit lean, FLIGHT.md): a fighting ship's commands jump about as it dodges and counter-burns, and leaning would misdirect them.

Agents weigh a fight with `strength` (combatants.js). Offense is torpedoes (TL motor G ÷ 18), guns × fire control, railguns and gear. Defense is armor, point defense, drive and the square root of the structure left. A ship breaks off when its strength falls below `breakOff` (0.35) of its enemy's. Pirates stalk ships up to twice their strength (`PIRATE_NERVE` 0.5), because a demand is a bluff; a pirate lying dark that is found by a ship it can't take on (each holds the other, and the range is closing) runs before it is shot at.

**Running** (`run`, agents.js) is done as a captain with people aboard would:
- A sprint at the drive's best while the crew can take it, then what a juiced crew takes for days: 6G (`SUSTAIN_G`, crew.js `HIGH_DOSE_G`). Past that every minute costs strokes at the rate it costs ours (`STROKE_RISK`, 0.06% per person-minute per G past 6), NPC crews included, and fewer hands lay the guns worse. A captain spends a tenth of the crew on the sprint (`SPRINT_LOSS`): a corvette running at 8G eases off after about an hour and a half, and nobody holds 8G for hours.
- A ship running silent (no transponder) cuts its drive and coasts dark once it is 1.2× out past what the pursuer's sensors hold of its cold hull, and stays dark until it is found again. Its last fix then points down its coasting line (the plot, and a route to it: WORLD.md). It keeps burning while torpedoes it has seen coming are still due, so they spend their Δv running it down.
- Run down all the same (the pursuer on it within the hour, its own best burn and all), it is cornered. A crew that ever strikes, strikes: to another ship at once, to us with an offer (ACCEPT, or let it fight it out). One that doesn't (a navy's) turns and fights to the end.
- A ship leaving with nobody after it (paid off, done looting, an inspection over) goes at its cruise G.

The upshot (printed by the duel tests, SHIPS.md): between hulls of a size, the better-built ship wins. A Belt junker cannot beat a Martian frigate, and neither can our armed freighter. Only Earth's best (TL3) frigate has an outside chance against the Martian one.

## Damage

A hit is DP delivered to a section, or (nuclear, fusion blast) to the whole hull. Armor sheds 12% per point (at most 60%; half as effective against blasts).

**Aim** (our guns, NPC doctrine) decides where focused hits land:

| Aim | Weights (drive / reactor / weapons / sensors / hull) |
|---|---|
| DISABLE | 0.6 / 0.05 / 0.1 / 0 / 0.25 |
| DISARM | 0.05 / 0 / 0.6 / 0.15 / 0.2 |
| KILL | 0.2 / 0.5 / 0 / 0.15 / 0.15 |

How well a weapon aims blends those weights with an unaimed spread: railgun 0.8, PDC 0.7, HE torpedo 0.5.

**Our ship.** Each section is a set of decks:

- drive → Engine
- reactor → Reactor
- weapons → Cargo and Engine (launcher, turrets)
- sensors → Bridge
- hull → living decks

On each deck hit with DP d: a hull breach with P = d/40; each system housed on that deck faults with P = d/45 (major above 35 DP); each person on that deck is wounded with P = d/90, through the same trauma model as being thrown around; on the reactor deck, containment fails with P = d/70 (90 minutes to scram). A KILL hit of 50+ DP on the reactor can end the ship outright. Hull integrity falls by DP ÷ the hull's structure (120 for the armed freighter); under 50% the hull can't take burns above 3G, and at 0 the ship breaks up. A dockside overhaul restores the hull.

**NPC hulls** (`e.combat`, created when a ship first matters to a fight) track structure and four sections. Drive under 25%: disabled, and civilians, pirates and police offer to surrender. No structure: a wreck that drifts on as salvage. A damaged reactor counts down 3–30 minutes to detonation; a trained crew may scram it in time (not a wreck's survivors, nor anyone against charges we set). A KILL hit that tears into the reactor can set it off immediately. A countdown on a hull nobody pilots (a wreck a blast set failing, a prize we scuttled) is kept on a short list, `state.combat.fuses`, and counted down each minute with the rest (`fusesTick`); a hulk already counted when it broke up is not counted again when it goes up. Charges we set (SCUTTLE, DOCKING.md) burn 2 hours (`SCUTTLE_FUSE_MIN`): time for the party to come home and the crew to strap in before the route can fly. A reactor's blast hurts out to `blastClearM` (where it falls under 2 DP: a small craft's 2.1 km, a medium hull's 4.6 km, a large one's 9.6 km, a capital ship's 21 km); while the party is across, or we are inside that, VIGIL keeps the count and the distance to get clear. In a fuse's last 2 minutes (`FUSE_WATCH_MIN`), within 0.01 AU of us, time runs at 1× and the telescope comes up on the hull by itself if it can hold it, and holds on through the blast (the fireball 12 seconds, cooling).

**Scars.** Every hit leaves a mark where it landed (`e.combat.scars`, ours `state.hull.scars` with the deck it holed): the section, how hard (its share of the hull's points), what made it, when, and a place on the section worked from a hash of the hull and the hit, never the dice (the game's random stream is the same with or without them). The worst 24 are kept. The ship's outside is drawn from them (`ui/gl/damage.js`, below).

**Fusion detonations** damage every hull within reach by blast DP × e^(−d / scale). Killing a pirate raider at 2 km is safe; killing a frigate at 2 km is not.

**Damage, seen.** The drone and the telescope draw each scar on the hull where its section is (the drive at the bell and the engineering deck, the reactor on its deck, the guns on their mounts, our hits on the deck they holed). A torpedo's warhead is a hole metres across, its edge torn and curled out, scorched round, white-hot for the first moments and dull red for minutes (an e-folding of 4 minutes), the dark inside of the hull showing through, the air going out of it in a short bright jet for 25 minutes (ours for as long as the deck holds pressure); a slug punches a small clean hole; PDC fire and mining gear pepper a patch of plating metres across with pits; a blast scorches a side; a scrape leaves bare metal. A ship with its reactor hurt shows fewer lit ports, flickering. A wreck is dark and tumbling (1.5–5.5° a minute, nothing holding its attitude), most (about two in three) broken-backed at the module joint nearest its worst wound, the after piece bent away about the spine, the tear glowing for its first twenty minutes; round it a field of fragments (bent plates, torn panels, spars, tank shell, machinery, radiator fins) drifting off, most nearly with it, so a wreck days old still has its cloud. A ship blown apart (an investigation's debris: `sim/damage.js` blownPieces) has no hull: 80 pieces (more for a big hull, to 150) spreading from where it was since it broke up, each at the speed the break gave it, as one over its size squared and most of them slowly (a twentieth of the hull across: up to about 2 mm/s; the five heaviest, a tenth to a fifth of it, barely moving), so a skiff's dozen nearest pieces lie within 10 m after six hours, 35 m after three days, 90 m after ten, the rest kilometres out and going; among them ice, flakes and chunks glinting as they tumble. The telescope frames that dozen and its brightness is the pieces' (a skiff's about three magnitudes under its whole hull); the tactical display shows a scatter, the contact sheet and the comms card the hull in pieces. A hit seen through the telescope lands where its scar is.

## Our fire control

The COMBAT tab (`W`) shows the threat board (log range, 1 km to 10M km) and the fire-control panel:

- **Target**: any ship our sensors hold (click it on the board, or TARGET from the scanner or the tactical view, where clicking a ship opens the same contact panel).
- **Stance**: where the nav computer keeps us relative to the target, flown until released. One click holds at a weapon's range: GUNS (60% of PDC reach, 3.6 km at TL2), GEAR for a miner, TORPEDO (50,000 km, outside guns and railguns), LONG (300,000 km). MORE… opens the stance panel: HOLD, KEEP OUT or KEEP WITHIN, any range (formation, the edge of our sensors, where we are, or typed in), the G to fly it at, a TIGHT or LOOSE band, and the doctrine under fire. That means turning away from torpedoes less than 45 minutes out (TL2 and up) and closing no faster than 5 km/s while one is inbound. Ranges inside the target's known guns are flagged.
- **Torpedoes**: choose HE or NUKE and FAST or COLD COAST, then FIRE. One per loaded tube; the autoloader takes 3 minutes per tube (6 if the launcher is degraded). REACH says whether a torpedo launched now gets there, the target keeping its burn: in reach and about how long, or OUT OF REACH and how far short it runs dry.
- **Point defense**: AUTO shoots down torpedoes; HOLD stays silent; ENGAGE also rakes the target whenever it comes inside gun range.
- **Aim**: DISABLE, DISARM or KILL.
- **Evasive** (battle stations only): 2.5G of random jinking, times our TL's jinking factor. It throws off homing, railguns and PDC aim, burns reaction mass at about half that G, and puts the load on the crew. It also lights our plume.

The panel shows only what the ship carries. A hull without tubes has no torpedo section. A miner's guns section is its mining gear. An unarmed hull is told so.

At **battle stations** the best shot takes the weapons console, the best engineer the engineering station, the next best eye ops, and the pilot the helm. Everyone else goes to a couch.

Time warp is capped by the tactical picture: 1× when a torpedo is under 30 minutes out, a hostile is inside 75,000 km, a demand awaits an answer, one of our own torpedoes is in its last 3 minutes to its target (`OWN_ARRIVAL_S`: its arrival is watched, below), or a reactor on a fuse near us is in its last 2 minutes; 2× within six hours or 750,000 km.

Shooting at a lawful ship is a crime (WORLD.md). Shooting back at whoever fired first never is.

## Stations

Stations fight too (`station-defense.js`, DOCKING.md): PDC emplacements, torpedo silos, railguns at the naval yards, armor and a structure of thousands of DP. Fire control can target a station. Its sections are its docks (DISABLE), defenses (DISARM), sensors and power plant (KILL: losing it blacks the station out). Its PDCs cover the ships in its berths and holding within 60 km. Attacking a station is a crime one step worse than the same attack on a civilian ship.

**Fire.** Damage that reaches a deck of ours can start a fire there (up to a 50% chance, by the damage: SHIPBOARD.md). Before a fight, the SUITS order puts everyone in a suit, so a burning deck can be vented with its crew on it.

## Boarding

A ship can be taken by boarding: a party of our crew through a mated collar or by EVA, against however many of its crew resist (DOCKING.md). A wreck can be salvaged, run after run, and any secured hull's accounts cracked for its credits.
