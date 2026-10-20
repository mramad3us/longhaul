# The world: powers, conflict, law

## Factions (`sim/factions.js`)

| Id | Power | Navy | Police | Tech (civil / police / navy) |
|---|---|---|---|---|
| `UN` | United Nations (Earth, Luna) | UNN | UN Security | 2 / 3 / 3 |
| `MCR` | Martian Congressional Republic | MCRN | Martian Security | 3 / 3 / 4 |
| `OPA` | Outer Planets Alliance (Belt, outer moons) | OPA | Star Helix Security | 1 / 2 / 2 |
| `independent` | | | | 2 |
| `pirate` | | | | 1 (2 for their best) |

Saves from before v0.10 used `UNN`, `MCRN` and `Belter`; these are mapped to `UN`, `MCR` and `OPA`.

## Spheres of influence

Each power projects influence from the bodies it holds (`INFLUENCE_SOURCES`), with strength s and Gaussian falloff over radius r. The OPA also projects from the Belt as a whole (a ring at 2.75 ± 0.5 AU). Contributions combine like independent probabilities, 1 − Π(1 − cᵢ), so overlap reinforces without exceeding 1. The sources ride the ephemeris, so borders move with the planets: Earth and Mars drift in and out of reach, and the space between them is sometimes nobody's.

`controlAt(x, y, minute)` returns the leading power (if its influence is at least 0.25), its level (patrol density), a rival if the space is contested (the rival has at least 60% of the leader's influence), and whether the space is lawless (under 0.15). Ganymede is contested between Earth and Mars; Pallas between Mars and the Belt; the gulf beyond the Belt is lawless.

## Tension and hot zones (`sim/conflict.js`)

Each pair of powers has a tension (0 calm, 1 open war) that wanders daily, is pulled toward its baseline (UN–MCR 0.45, UN–OPA 0.3, MCR–OPA 0.35) and is pushed up by ongoing skirmishes.

Hot zones are born from the influence field, not from a script. Each day, with a chance that rises with tension, a flashpoint is chosen among the bodies where:

- two powers' reach overlaps: a **standoff**, a **blockade** (one navy stopping traffic to the other's station), or, above tension 0.6, a **skirmish**;
- nobody's writ runs well, in the Belt or beyond: **pirate activity**;
- an inner power holds a place with real Belter presence: an **insurgency**.

A zone sits at an offset from its body and moves with it. It has a radius (0.02–0.06 AU; skirmishes 0.01–0.03) and an intensity that drifts with the tension. A hot standoff can escalate into a skirmish. Zones end after 5–30 days, or when their intensity dies. At most six exist at once. Their birth, escalation and end come over the newsfeed.

Away from us, zones produce outcomes without simulating ships: hourly, with a chance scaled by kind and intensity, a ship is lost there and its wreck appears near the zone's body (salvage), at most four per zone.

## Encounters

The **director** runs hourly, only around our ship. From the local politics it rolls:

| Encounter | Rate per hour | |
|---|---|---|
| patrol | 6% × control level of the local power; +12% × intensity in a standoff | a cutter of that power on its beat |
| picket | 20% × intensity in a blockade | a cutter of the blockading navy, holding near the body |
| battle | 20% × intensity in a skirmish | two warships of the two navies, already at war |
| pirate | 4% × lawlessness away from stations; +12% × intensity in a pirate zone | a raider or gunship, running dark |
| ambush | 2% × lawlessness; +5% × intensity in a pirate zone | a pirate already on a civilian, with a mayday for us |

After each encounter the director rests 6–24 hours (`politics.quietUntil`), and it never keeps more than six ambient agents around us.

## NPC behaviour (`sim/agents.js`)

An agent is a driven ship with a role. It flies our own flight model and guidance laws.

- **Patrol / picket.** Watches the ships it can see. It stops ships that are suspect: wanted, running without a transponder, or caught in a random check (15%, or 60% inside a zone). It hails from about 300,000 km with an order to heave to. It goes after pirates it sees. If we are wanted at level 3, it fires on sight.
- **Pirate.** Lurks dark. It stalks us if it is at least half our strength (pirates bluff), or jumps nearby civilian traffic. From about 75,000 km it demands about 30% of our credits. Pay and it leaves; refuse and it attacks from about 100,000 km, aiming to disable (it wants a prize, not a fireball). Once our drive is out it stops launching torpedoes and makes a last demand: about 60% of our credits, or its guns. It slips away when law ships are near, and it breaks off when hurt.
- **Navy.** In a zone, fights the enemy navy. It warns off unidentified ships that come inside 75,000 km, and engages anyone who ignores it or whom its power wants at level 2+. Doctrine is KILL, with nuclear torpedoes against warships.
- **Civilian.** Flees from any ship or ordnance it can see coming for it, at full drive, with no jinking, and from us while we are within 0.01 AU after firing on it. A miner turns its mining gear on any attacker that comes within reach. It surrenders when disabled.
- **Convoy.** Flies to its destination (escort contracts) and docks there.

In a fight an agent keeps its doctrine's standoff range (pirates 100,000 km, police 50,000 km, navies 20,000 km, inside railgun range). It launches salvos sized to saturate the enemy's point defense, fires railguns when it has them, rakes the enemy with PDCs at close range, and jinks when ordnance is close or the enemy is near. Ships out to disable stop launching once the target is crippled and close in to finish it with guns; navies don't. Ships at TL2 and above turn away from inbound torpedoes (COMBAT.md). Agents retreat when badly hurt or outgunned.

Encounters ask for a kind of ship and a faction, and the faction fields its own design. Patrols are cutters (a Belt refit, a UN cutter or a Martian Security cutter). Pirates are torch raiders, stolen couriers, gunships or a stolen corvette. Skirmishes are corvettes, frigates and destroyers of each side's navy (SHIPS.md).

**Requests** are how agents talk to us. Each has options and a 15-minute deadline:

| Request | Options | Silence means |
|---|---|---|
| inspect (patrol) | heave to · run | comply if we sit still, run if we keep burning |
| demand (pirate) | pay · refuse | refuse |
| warning (navy) | transponder on and stand off · ignore | comply if we are still and broadcasting |
| surrender (beaten enemy) | accept · ignore | ignore |

An inspection takes 45 minutes alongside. Burning away or opening the distance counts as resisting.

## Law (`sim/law.js`)

Each power keeps **standing** (−100 to 100) and a **wanted level** for us: CLEAN, SUSPECT (stopped and searched; a fine settles it), WANTED (heave to or be disabled), HOSTILE (shot on sight).

A crime is recorded against the victim's power and the power whose space it happened in. Escalations count once per victim: fired on 1, disabled 2, destroyed 3, +1 if the victim was military or police. Each crime costs 10 standing per severity point. Firing on pirates, wanted criminals, wrecks or anyone who shot first is not a crime; destroying pirates earns a little standing with the local power. Resisting an inspection raises our wanted level to WANTED.

**Contraband**: smuggled cargo (illegal where its contract says) and nuclear torpedoes in UN or Martian space. An inspection seizes it and levies 1,000 + 1,500 per consignment + 1,000 per warhead + 1,500 per wanted level. Paying in full clears the record. Wanted levels fade one step per ten quiet days; standing drifts back toward neutral. Stations of a power that puts our standing below −20 won't give us work.

**Arms**: PDC rounds sell everywhere (0.05 MCR each). HE torpedoes (1,800 MCR) sell at OPA, independent and pirate stations, and at UN or Martian yards only if our standing is 20 or more. Nuclear torpedoes (6,000 MCR) sell only at OPA stations, to friends (OPA standing 0 or more).

## Stations, contracts and distress calls

Eight stations (`sim/entities.js`):
- OPA: Ceres, Pallas, Hygiea Ring, Tycho (at Juno)
- UN: Luna Shipyards
- MCR: Phobos Naval Yard
- independent: Vesta Depot, Ganymede

"Docked" means holding station within 50 km. Docked, you can buy fuel, water, food, gases, med supplies, spare parts and ammunition, and pay for a dockside overhaul (hull, every system, suits, containment). Spare parts and the overhaul are priced at our ship's tech level (×0.6 for a Belt refit up to ×2.5 for Martian kit), and hull plating by the size of its structure. Hailing a station in radio range opens its board. Boards refresh every 12 hours while in long sensor range. Every contract is a physical errand with something to fly to (`sim/contracts.js`):

| Contract | Work |
|---|---|
| CARGO / PASSENGERS / FUEL | load at the station, deliver at the destination (VIP passengers pay a bonus for a fast trip) |
| INVESTIGATE / MEDEVAC | rendezvous with a ship, hail it in formation, return (medevac casualties need berths) |
| SALVAGE | hold formation with a derelict while the crew strips it (2 h), return |
| SURVEY | loiter within 150,000 km of a survey mark for the required time, return |

**Distress calls** (`sim/missions.js`) come in four kinds: fuel-dry drifters, dead drives, runaway torches stuck at high G, and scrammed reactors. Each comes with a survival timer and a feasibility estimate from the nav computer. Accept, intercept, hold formation within 10 km and hail to rescue.

Stations near hot zones (within 0.6 AU) also post conflict work, up to 40% of their board:

| Contract | Work | Pay |
|---|---|---|
| BOUNTY | find a wanted pirate near the last reported position (it runs cold); destroy it, or disable it and accept its surrender (+50%); return | 3,000–8,000 |
| ESCORT | join a convoy ship within 10 km at its station. It departs at ≤ 0.5G, and raiders strike partway along the route. Keep it alive; collect at the destination | 2,500–5,000 + distance, PDC rounds |
| SMUGGLE | carry contraband through a blockade, or into inner-planet space. An inspection that finds it ends the job | 6,000–12,000 + distance |
| RECON | get within 300,000 km of a navy picket and hold a sensor lock on it for 30–90 minutes. Identification by that navy blows the job (and costs standing) | 4,000–9,000 |

**UNDER ATTACK** distress calls come from the director's ambushes. Accepting puts the victim under our point defense. Once the raiders are dead, beaten, gone or have lost interest, hold formation and hail to complete.
