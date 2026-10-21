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

## Who is out there (`sim/traffic.js`, `sim/forces.js`)

A new game has **3,000 traffic ships** (`DEFAULT_TRAFFIC`), nine in ten of them under way. They fly between the stations on analytic courses and make **port calls** there (DOCKING.md): a berth only for the work that needs one, the layover in the holding pattern, and out through the gate when it leaves (from a berth or a slot). The long legs between ports are straight courses between moving ends, and one can pass through a planet on the way (the Earth or Mars, for Luna's and Phobos' yards): they are drawn so far from us that it is rarely seen, and routing them round is still to come. A ship picks its next port by distance and flag: weight 3 for its own power's ports, 1.5 where either side is independent, 1 otherwise, divided by (0.5 + distance in AU). So the Belt trades mostly with itself, and Earth–Mars is a busy lane.

Every power also keeps hulls in space. They are real entities on rails, indexed in `world.forces`:

| Force | Strength | Where |
|---|---|---|
| Police | 3 cutters per station of a power with police | a beat: an orbit 0.002–0.012 AU around the station's body |
| UNN | 56 hulls | berthed at Luna Shipyards |
| MCRN | 12 hulls | berthed at Phobos Naval Yard |
| OPA | 8 hulls | berthed at Tycho and Ceres |
| Pirates | about 24 at large, plus 5 per pirate zone | lying up cold, 0.004–0.03 AU from Belt and outer bodies held below 0.45 |

Earth and Mars are matched in total strength, not in numbers. The UNN is a big fleet of TL2 corvettes and frigates a generation old (mean class strength about 1,200). The MCRN is a small fleet of TL4 hulls (about 5,900 each, so 56 × 1,200 ≈ 12 × 5,900). The OPA's refits are a militia.

When a hot zone is born, each side commits a share of its navy (at least one hull): standoff 15% / 15%, blockade 25% for the blockader and 8% for the other side, skirmish 25% / 25%, insurgency 10% of the inner power. So a UN–Mars skirmish draws 14 UNN hulls against 3 MCRN. They take berthed hulls, commissioning more if none are in. The squadron flies out on a filed 1G course to the zone's anchor (a hidden mark on the zone's orbit) and holds station there. When the zone ends, it flies home. A pirate zone gathers a pack of 5 on the spot; when it ends they stay at large. A daily census makes losses good: police to their number, and navies at up to 5% of their strength a day. Pirates beyond 1.5× their number disperse, never in front of us.

**The live window.** Within `WAKE_AU` = 0.1 AU of us (about our long sensor reach, 50 light-seconds), a hull on rails comes alive as an agent: police on routine patrol, navies with their zone and its enemies, pirates lurking. At most 3 police, 10 warships and 2 pirates are awake at once, the nearest first. A woken police cutter on **routine** leaves law-abiding ships alone. Past 0.25 AU, with no business left with us, it goes back on rails: a course from where it is (a coasting fix) to its post or home, or lying up near the nearest body. It isn't woken by proximity again for 12 hours. Traffic woken for a fight (a pirate's prey) goes back on its route the same way. A crippled hull is left out of the forces and removed.

## Light lag and the plot (`sim/intel.js`)

Light crosses an AU in 8.3 minutes (one light-second is 0.002 AU, one light-minute 0.12 AU). Everything our sensors hold (long range is 15M km, 50 light-seconds) is less than one sim step old, so the sensor board is live; each contact carries its light time. Everything else we know is a **report** on the plot (`state.intel`), and every report has an age:

- **Our own tracks.** A contact that drops off the board leaves its last fix. The plot coasts it on its last velocity, inside a circle of 30 m/s × age + ½ · 0.05 G · age² (it may have burned since). It is forgotten after 5 days. A lost contact can be looked at, not flown to.
- **Traffic digests.** Every station's traffic control publishes every 6 hours (staggered by station). A digest lists up to 400 transponder ships within 0.03 AU of it: berthed there, flying a filed plan (from, to, departure, arrival, G), or a plain fix. It reaches us after the light time from that station, and only if the comms array works when it lands. A filed plan is flown forward on the plot, and the nav computer can plot a route to it. Ships without a transponder are never in a digest.
- **The newsfeed.** Zone news and losses leave from where they happened and reach us at light speed (`relay`). A zone is drawn once its news has arrived and stays until news of its end does. A wreck in the news is charted from then on.

Stations, nav marks and contract targets are on published orbits: charted, not observed. The plot holds at most 6,000 records, dropping the stalest first. The solar map draws live contacts and charted orbits where they are, and reports where they should be by now: faded with age, with their circle when it says something, and as a point cloud past 1,500 in view. Light-time rings mark 1 light-second, 1 light-minute and 10 light-minutes around us. The tactical view shows only what our sensors hold.

## Tension and hot zones (`sim/conflict.js`)

Each pair of powers has a tension (0 calm, 1 open war) that wanders daily, is pulled toward its baseline (UN–MCR 0.45, UN–OPA 0.3, MCR–OPA 0.35) and is pushed up by ongoing skirmishes.

Hot zones are born from the influence field, not from a script. Each day, with a chance that rises with tension, a flashpoint is chosen among the bodies where:

- two powers' reach overlaps: a **standoff**, a **blockade** (one navy stopping traffic to the other's station), or, above tension 0.6, a **skirmish**;
- nobody's writ runs well, in the Belt or beyond: **pirate activity**;
- an inner power holds a place with real Belter presence: an **insurgency**.

A zone sits at an offset from its body and moves with it. It has a radius (0.02–0.06 AU; skirmishes 0.01–0.03) and an intensity that drifts with the tension. A hot standoff can escalate into a skirmish. Zones end after 5–30 days, or when their intensity dies. At most six exist at once. Their birth, escalation and end come over the newsfeed.

Away from us, zones produce outcomes without flying ships. Every hour, with a chance scaled by kind and intensity, a zone costs one real ship, which becomes a wreck where it was, held with the zone's body (salvage). At most four wrecks per zone:

- **Skirmish and standoff:** only when both sides have hulls on station. The side facing the stronger squadron (summed class strength) loses a hull.
- **Pirate zone:** a pack on station takes a traffic ship in transit through the zone.
- **Blockade:** the blockader disables a traffic ship running it.
- **Insurgency:** a loss is rolled up from the zone's politics.

With nobody there, nothing happens: the squadrons may still be on their way. Test suites without the forces roll every loss up from the politics. News of the loss reaches us at light speed.

## Encounters

The **director** runs hourly, only around our ship. From the local politics it rolls the table below. It first calls on ships that are already there:

- **Patrol:** a police cutter awake on routine, or one on rails within 0.05 AU, is sent to look at us.
- **Pirate:** a pirate already awake around us is the encounter; otherwise the nearest one lying up within 0.05 AU wakes.
- **Battle and picket:** if the zone's warships are already awake around us, that is the encounter.
- **Ambush:** a traffic ship in transit within 0.015 AU is the one that gets jumped.

Only when nobody suitable is near does it bring a ship in, as before:

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

Each power keeps **standing** (−100 to 100), a **wanted level** for us, and the **citations** we owe it (fines from traffic control: DOCKING.md; a week unpaid makes us SUSPECT): CLEAN, SUSPECT (stopped and searched; a fine settles it), WANTED (heave to or be disabled), HOSTILE (shot on sight).

A crime is recorded against the victim's power and the power whose space it happened in. Escalations count once per victim: fired on 1, disabled 2, destroyed 3, +1 if the victim was military or police. Each crime costs 10 standing per severity point. Firing on pirates, wanted criminals, wrecks or anyone who shot first is not a crime; destroying pirates earns a little standing with the local power. Resisting an inspection raises our wanted level to WANTED.

**Contraband**: smuggled cargo (illegal where its contract says) and nuclear torpedoes in UN or Martian space. An inspection seizes it and levies 1,000 + 1,500 per consignment + 1,000 per warhead + 1,500 per wanted level. Paying in full clears the record. Wanted levels fade one step per ten quiet days; standing drifts back toward neutral. Stations of a power that puts our standing below −20 won't give us work.

**Arms**: PDC rounds sell everywhere (0.05 MCR each). HE torpedoes (1,800 MCR) sell at OPA, independent and pirate stations, and at UN or Martian yards only if our standing is 20 or more. Nuclear torpedoes (6,000 MCR) sell only at OPA stations, to friends (OPA standing 0 or more).

## Stations, contracts and distress calls

Eight stations (`sim/stations.js`; where they are, their berths, traffic control and docking: DOCKING.md):
- OPA: Ceres, Pallas (surface ports), Hygiea Ring, Tycho (orbiting Juno)
- UN: Luna Shipyards (orbiting Luna)
- MCR: Phobos Naval Yard (on Phobos)
- independent: Vesta Depot (on Vesta), Ganymede (orbiting it)

The contract board, news, the traffic board, clearances and fines are radio work, from anywhere in radio range. Signing for a contract takes being **in port**: docked, or inside the station's port space (its approach, 2,000 km, where its holding pattern is: `holding.PORT_M`). Work that ends in a report (a survey, an investigation, a bounty, recon, an escort brought in) is turned in from port too. Everything that crosses a collar takes a hard seal in one of the station's berths ("docked": docking.js): loading cargo and passengers, delivering them, fuel, salvage and medevacs, every service, the hiring hall and shore leave. Docked, you can buy fuel, water, food, gases, med supplies, spare parts and ammunition, and pay for a dockside overhaul (hull, every system, suits, containment). Spare parts and the overhaul are priced at our ship's tech level (×0.6 for a Belt refit up to ×2.5 for Martian kit), and hull plating by the size of its structure. Hailing a station opens a channel to its traffic control (below). Boards refresh every 12 hours while in long sensor range. Every contract is a physical errand with something to fly to (`sim/contracts.js`):

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

## Hailing (`sim/dialogue.js`)

Hailing opens a channel, and a channel is a conversation: topics we can raise and what the other side says back, by who they are, how they see us, and where we stand. The comms window (`H`) lists the stations and ships in radio range (stations first, with signal and light lag), the conversation, and a card of what we know of them.

| Counterpart | Topics |
|---|---|
| Station (traffic control) | approach, docking (or an emergency berth), departure, cancel; the traffic board (berths, the anchorage, and the manifests of the ships berthed: their declared crews); news; the registry on any ship in range; the contract board; services, the hiring hall, shore leave (docked); pay citations; hand over prisoners |
| Civilian | identify, souls aboard, where bound, what they have seen (real zones on our plot, real pirates near them), a rendezvous to dock, buying supplies over the collar, help when we are in trouble, a warning about pirates near them, an order to heave to (a crime against a lawful ship) |
| Police | identify, souls, our record, settle our record, report a pirate contact (they go after it), surrender to them when wanted |
| Navy | identify, souls (not to strangers), passage through their zone (standing 10, clean, transponder on), news |
| Pirate | who are you, a counter-offer of half when they demand, a bribe to go away, threats (they leave if we are much the stronger) |
| A crew that struck, or a dead hull | souls aboard, open your locks (boarding is then by invitation), an offer to take survivors off, hold still while we come alongside |

**Attitude** (−1 … 1) is the other side's view of us: its power's standing and wanted level, whether we fired on it, our transponder, and its trade (stations and civilians take most callers at their word; navies and pirates trust nobody). Honest ships tell the truth about their souls aboard; a hostile one may not; pirates don't say. Voices follow the flag (a Belter station speaks Lang Belta in its English).

## Who is aboard (`sim/manifest.js`)

Every ship has people aboard: its class's complement (SHIPS.md), its own number in the range fixed by its identity, fewer after casualties, and passengers on liners. We never see inside another hull; what we know has a source and an age, the best source winning:

| Source | Gives |
|---|---|
| Registry | once identified, the class: its rated complement |
| Manifest | traffic control's declarations: in station digests (berthed ships and filed plans), and the traffic board when asked |
| Hail | what they say when asked (honest ships truthfully; a ship that dislikes us may inflate it, pirates won't say) |
| Scan | a long close look (inside 100 km, 90 minutes of track): a thermal count of the living, ± a third (a sixth with ops on watch), the locked contact and the nearest few; looked at once a day: our own estimate is logged when it changes; a count the ship declared (hailed, a manifest) is never replaced by it, only checked, quietly when the heat bears it out, logged and marked doubtful when it doesn't (a ship that dislikes us may lie); a count taken aboard is not looked at |
| Boarded | a count taken aboard: exact |

The dossier keeps what we learned (1,500 ships at most, the oldest dropped). Notable learning is logged; the contact panel and the comms card show it.
