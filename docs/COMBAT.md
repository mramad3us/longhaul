# Combat

Nothing in LONGHAUL glows. There are three weapon families: point-defense cannons, torpedoes and railguns. All of them obey the same flight physics as the ships that carry them. Modules:

| Module | Role |
|---|---|
| `sim/weapons.js` | performance tables by tech level, warheads, profiles, evasion math |
| `sim/sensors.js` | one detection model for everybody |
| `sim/combatants.js` | uniform view of any ship (ours or an NPC's): kinematics, combat profile, NPC hull state |
| `sim/ordnance.js` | torpedoes and slugs in flight; terminal resolution; PDC strafing |
| `sim/damage.js` | hits, aim, sections, reactor failures, fusion detonations |
| `sim/combat.js` | our fire control and the per-minute fight |
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
| torpedo, coasting | 0.0002 AU (~30,000 km) |
| railgun slug | 0.00003 AU (~4,500 km) |

An observer sees a target inside signature × its sensor quality. Quality depends on tech level and damage; for us it also improves with an ops watchstander. A torpedo's own seeker has quality 0.3. Our display band (SHORT/MED/LONG) caps how far the board looks. NPCs identify an unknown ship by tracking it for 60 minutes; a transponder identifies instantly.

## Torpedoes

A torpedo is a small fusion missile: an entity of type `ordnance`, driven, integrated every minute under gravity and its own thrust.

| TL | Max G | Δv |
|---|---|---|
| 1 | 12 | 100 km/s |
| 2 | 18 | 150 km/s |
| 3 | 25 | 250 km/s |
| 4 | 32 | 400 km/s |

**Profiles** set the closing speed the torpedo builds and then holds. The speed is limited by how fast its seeker can close and still hold terminal lock, which depends on tech level:

- **FAST** (TL1 15, TL2 20, TL3 25, TL4 30 km/s): a short flight and little time inside point defense. The plume is seen early, though, and a target that runs makes the torpedo burn to keep up.
- **COLD COAST** (40% of FAST): boost, then coast dark. Invisible beyond ~30,000 km until the last minutes, so the target doesn't run. Slow, and point defense gets a long look.

Launched at a target 6 million km away, a TL2 cold torpedo flies for about nine days; across half an AU, for weeks. Civilians run only from ordnance they can see arriving within two hours: no hauler carries the reaction mass to run for days.

**Guidance** runs once a minute and is flown the next minute:

1. *Track.* Update the target track if the seeker sees the target, or if the launcher still does and is within datalink (radio) range. Otherwise fly on the last known track, dead-reckoned. A target that went cold and changed course is aimed at where it would have been. If the torpedo reaches the predicted point and finds nothing, it self-destructs.
2. *Closing.* Burn down the line of sight whenever the closing speed falls below the profile's. A ship running from a torpedo forces it to spend Δv, and a torpedo chasing a 1G target for hours runs dry.
3. *Miss.* Predict the miss at closest approach (zero-effort miss, extrapolating the target's thrust over a short horizon). When it exceeds a deadband, correct it with a deadbeat burn. Inside ten minutes, correct every minute.

**Endgame.** Every minute, the closest approach between each torpedo and its target over the minute just flown is found from their start and end states (1 s segments, constant relative acceleration). If it passes inside the **capture basket** (what the torpedo's remaining acceleration can close in its last 8 seconds, plus what its spare thrust can answer of a last-minute dodge), it is resolved:

- **Point defense.** Each PDC battery covering the target fires while the torpedo crosses its envelope: exposure = envelope ÷ closing speed, at most 20 s. Kill hazard = mounts × kill rate × fire-control factor × exposure. Torpedoes arriving within 5 s of each other share the guns (salvos saturate), and rounds are spent per engagement. Covering batteries are the target itself, our PDCs over ships we protect (escort charges, rescue victims), and NPC wingmen.
- **Homing.** A survivor hits with P = 1 − (target evasive G ÷ torpedo G available)², clamped to 5–97%. A civilian that doesn't jink is all but certain to be hit.
- **Warheads.**
  - HE (70 DP) needs the hit and lands on a section chosen by aim.
  - Nuclear (600 DP at the core, e-folding over 300 m) fuzes at closest approach even when homing fails. Its blast hits everything nearby.

| PDC by TL | Kill rate /mount-s | Anti-torpedo envelope | Gun range vs hulls | Dispersion |
|---|---|---|---|---|
| 1 | 0.25 | 25 km | 4 km | 1.0 mrad |
| 2 | 0.4 | 40 km | 6 km | 0.7 mrad |
| 3 | 0.5 | 55 km | 10 km | 0.5 mrad |
| 4 | 0.55 | 70 km | 15 km | 0.35 mrad |

Fire-control factor: our PDCs run at 0.6 on automatic, and at 0.7 + 0.6 × security skill/100 with a gunner at the weapons console. NPC factors depend on the crew (military 1.1, authority 1, pirates 0.85, civilians 0.8), scaled by crew losses and sensor damage. A mount fires 50 rounds per second.

Typical outcomes (printed by `tests/combat.test.mjs`):

- An unarmed hauler 300,000 km away is hit 12 times out of 12.
- A single torpedo against an MCRN corvette's six TL4 mounts never gets through (0/10); six-torpedo salvos land about one hit in five.
- Our two TL2 mounts stop 11 of 12 single pirate torpedoes with a gunner at fire control, and 9 of 12 on automatic. Pirate salvos of two are much more dangerous.
- One HE hit takes about half our hull.

## Railguns

A slug is unguided. At firing, fire control solves for the intercept, assuming the target keeps its current thrust, and launches the slug at the gun's speed (TL2 20, TL3 30, TL4 45 km/s) on top of the ship's velocity. When the slug passes the target, the miss is taken from the actual motion and combined with Gaussian errors: the gun's angular dispersion (TL2 4, TL3 2, TL4 1 µrad × range) and the target's jinking over the flight time. Hit if within the target radius.

Jinking: the target picks a new random thrust direction every 8 s at its evasive G. Over a flight time t, the position uncertainty is σ = a·min(t²/2, √(8/3)·t^1.5). A ship holding still is hit at long range; a jinking one, only at knife-fight range.

## PDCs against hulls

Inside gun range a ship can rake another with PDC fire. Each minute the stream's dispersion (angle × range, plus jinking over the rounds' time of flight at 1.2 km/s) is compared with the target radius. Damage = 6 DP × mounts × fire-control factor × P(burst hits). It burns 30% duty × 50 rounds/s × mounts of ammunition.

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

On each deck hit with DP d: a hull breach with P = d/40; each system housed on that deck faults with P = d/45 (major above 35 DP); each person on that deck is wounded with P = d/90, through the same trauma model as being thrown around; on the reactor deck, containment fails with P = d/70 (90 minutes to scram). A KILL hit of 50+ DP on the reactor can end the ship outright. Hull integrity falls by DP ÷ 120; under 50% the hull can't take burns above 3G, and at 0 the ship breaks up. A dockside overhaul restores the hull.

**NPC hulls** (`e.combat`, created when a ship first matters to a fight) track structure and four sections. Drive under 25%: disabled, and civilians, pirates and police offer to surrender. No structure: a wreck that drifts on as salvage. A damaged reactor counts down 3–30 minutes to detonation; a trained crew may scram it in time. A KILL hit that tears into the reactor can set it off immediately.

**Fusion detonations** damage every hull within reach by blast DP × e^(−d / scale). Killing a pirate raider at 2 km is safe; killing a frigate at 2 km is not.

## Our fire control

The COMBAT tab (`W`) shows the threat board (log range, 1 km to 10M km) and the fire-control panel:

- **Target**: any ship our sensors hold (click it on the board, or TARGET from the scanner).
- **Torpedoes**: choose HE or NUKE and FAST or COLD COAST, then FIRE. One per loaded tube; the autoloader takes 3 minutes per tube (6 if the launcher is degraded).
- **Point defense**: AUTO shoots down torpedoes; HOLD stays silent; ENGAGE also rakes the target whenever it comes inside gun range.
- **Aim**: DISABLE, DISARM or KILL.
- **Evasive** (battle stations only): 2.5G of random jinking. It throws off homing, railguns and PDC aim, burns reaction mass at about half that G, and puts the load on the crew. It also lights our plume.

At **battle stations** the best shot takes the weapons console, the best engineer the engineering station, the next best eye ops, and the pilot the helm. Everyone else goes to a couch.

Time warp is capped by the tactical picture: 1× when a torpedo is under 30 minutes out, a hostile is inside 75,000 km, or a demand awaits an answer; 2× within six hours or 750,000 km.

Shooting at a lawful ship is a crime (WORLD.md). Shooting back at whoever fired first never is.
