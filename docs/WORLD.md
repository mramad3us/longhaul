# The world: powers, politics, conflict, law, service

## Factions (`sim/factions.js`)

| Id | Power | Navy | Police | Tech (civil / police / navy) |
|---|---|---|---|---|
| `UN` | United Nations (Earth, Luna) | UNN | UN Security | 2 / 3 / 3 |
| `MCR` | Martian Congressional Republic | MCRN | Martian Security | 3 / 3 / 4 |
| `OPA` | Outer Planets Alliance (Belt, outer moons) | OPA | Star Helix Security | 1 / 2 / 2 |
| `independent` | | | | 2 |
| `pirate` | | | | 1 (2 for their best) |

### Sub-factions

A power is a coalition (`SUBFACTIONS`). Its sub-factions share its influence and pull it their way; the independents have no top, and each of theirs is its own master. The pirate clans are independents too, outlaws to all: their ships keep the faction `pirate` and carry the clan as `sub`.

| Power | Sub-factions (agenda) |
|---|---|
| UN | UNN Fleet Command (hawk) · Earth Intelligence Directorate (covert) · Assembly Peace Caucus (dove) · Luna-Kepler Consolidated (profit) · UN Security (police) |
| MCR | MCRN Admiralty (hawk) · Martian Naval Intelligence (covert) · Congressional Unity Caucus (dove) · Hecate Arms & Drive (profit) · Martian Security (police) |
| OPA | Tycho Council (moderate) · Ceres Free Belt (militant) · Belt Unions (labor) · Star Helix Security (police) |
| independent | Ganymede Agricultural Concord · Vesta Miners' Cooperative · Free Traders' Guild · Pur'n'Kleen Water · Brannock Security Services (mercenary) |
| pirate clans | Rust Queens (Hygiea, Vesta, Ceres) · Hungry Dark (Jupiter's moons) · Knife Season (Pallas, Juno, Hygiea) · Ghost Belt (Saturn and beyond) |

New hulls fly under a sub-faction by their category (`fleet` weights: a share of a power's civilian hulls are its company's, its warships its navy's, its cutters its police's); the rest are private. A pirate takes the clan of the rocks it lies up at.

## Spheres of influence

Each power projects influence from the bodies it holds (`INFLUENCE_SOURCES`), with strength s and Gaussian falloff over radius r. The OPA also projects from the Belt as a whole (a ring at 2.75 ± 0.5 AU). Contributions combine like independent probabilities, 1 − Π(1 − cᵢ), so overlap reinforces without exceeding 1. The sources ride the ephemeris, so borders move with the planets: Earth and Mars drift in and out of reach, and the space between them is sometimes nobody's.

`controlAt(x, y, minute)` returns the leading power (if its influence is at least 0.25), its level (patrol density), a rival if the space is contested (the rival has at least 60% of the leader's influence), and whether the space is lawless (under 0.15). Ganymede is contested between Earth and Mars; Pallas between Mars and the Belt; the gulf beyond the Belt is lawless.

## Who is out there (`sim/traffic.js`, `sim/forces.js`)

A new game has **3,000 traffic ships** (`DEFAULT_TRAFFIC`), nine in ten of them under way. They fly between the stations on analytic courses and make **port calls** there (DOCKING.md): a berth only for the work that needs one, the layover in the holding pattern, and out through the gate when it leaves (from a berth or a slot). The long legs between ports are straight courses between moving ends, and one can pass through a planet on the way (the Earth or Mars, for Luna's and Phobos' yards): they are drawn so far from us that it is rarely seen, and routing them round is still to come. A ship picks its next port by distance and flag: weight 3 for its own power's ports, 1.5 where either side is independent, 1 otherwise, divided by (0.5 + distance in AU). So the Belt trades mostly with itself, and Earth–Mars is a busy lane. A ship with shuttles sometimes calls at a settled world instead (a **planetary call**, a fifth of its departures with one within 2.5 AU): into the world's parking orbit, held there while its shuttles work its freight and passengers down (3 to 72 hours), then on to a port (FLIGHT.md).

Every power also keeps hulls in space. They are real entities on rails, indexed in `world.forces`:

| Force | Strength | Where |
|---|---|---|
| Police | 3 cutters per station of a power with police | a beat: an orbit 0.002–0.012 AU around the station's body |
| UNN | 56 hulls | berthed at Luna Shipyards |
| MCRN | 12 hulls | berthed at Phobos Naval Yard |
| OPA | 8 hulls | berthed at Tycho and Ceres |
| Command ships | UN 3 (Leviathan battleships), MCR 3 (Olympus battleships), OPA 2 (converted gunships) | berthed at their yards until a fight calls for one |
| Pirates | about 24 at large, plus 5 per pirate zone, each of its clan | lying up cold, 0.004–0.03 AU from Belt and outer bodies held below 0.45 |
| A proxy's raiders | 4 per proxy war, of the proxy's own kind (refit corvettes and cutters for the mercenaries, raiders for a clan, militia hulls for the cells) | at its raiding ground, until the war is over |

Earth and Mars are matched in total strength, not in numbers. The UNN is a big fleet of TL2 corvettes and frigates a generation old (mean class strength about 1,200). The MCRN is a small fleet of TL4 hulls (about 5,900 each, so 56 × 1,200 ≈ 12 × 5,900). The OPA's refits are a militia.

When a hot zone is born, each side commits a share of its navy (at least one hull): standoff 15% / 15%, blockade 25% for the blockader and 8% for the other side, skirmish 25% / 25%, front 40% / 40%, insurgency 10% of the inner power, proxy war 8% of the target power. So a UN–Mars skirmish draws 14 UNN hulls against 3 MCRN. They take berthed hulls, commissioning more if none are in. The squadron flies out on a filed 1G course to the zone's anchor (a hidden mark on the zone's orbit) and holds station there. When the zone ends, it flies home. A pirate zone gathers a pack of 5 on the spot; when it ends they stay at large. A proxy war's raiders gather the same way, and go home with the money when it ends.

**Command ships.** Every power in a fight (both sides of a naval zone, the inner power of an insurgency, the target of a proxy war) sends a berthed command ship to the rear of it: a post 0.4 × the zone's radius out from its anchor, on its own side. It holds there, on rails like a station, for as long as the zone lasts: the forward command its licensed captains report to (military service, below). It doesn't wake by our coming near, only when it is attacked; with a captain alongside when its zone ends, it waits for us to cast off before it goes home. A power with none in port sends none.

**The yards.** A daily census counts every power's hulls and what its yards already have on the slips, and lays down what is missing: police to their number per station, navies to strength, command ships to their number. A hull takes its time to build (`BUILD_DAYS`: a cutter 3 days, a corvette 4, a gunship 6, a frigate 8, a destroyer 14, a battleship 30; ±20%, and 40% faster for a power at war), and each power's yards build a few at a time (UN 4, MCR 2, OPA 2). A new hull is launched at its power's yard and flies out to its berth or beat; sabotage at a yard (politics) puts its slips back days. Pirates are kept to their number by the clans (up to 3 a day, at their lairs); beyond 1.5× their number they disperse, never in front of us.

**Traffic** lost is replaced the same way: a new hull is laid down for each one gone, launched 1–4 days later out of a yard of its flag (Luna; Phobos; Tycho or Ceres; Ganymede or Vesta for the independents), and takes up the trade from there.

**The live window.** Within `WAKE_AU` = 0.1 AU of us (about our long sensor reach, 50 light-seconds), a hull on rails comes alive as an agent: police on routine patrol, navies with their zone and their enemies (every power theirs is at war with, and the other side of a skirmish or front they were sent to), pirates lurking, a proxy's raiders after their prey. At most 3 police, 12 warships, 2 pirates and 3 proxy raiders are awake at once, the nearest first; command ships stay at anchor. A woken police cutter on **routine** leaves law-abiding ships alone (and a power's patrols never stop its own contractors of rank 1 or more for a random check). Past 0.25 AU, with no business left with us, it goes back on rails: a course from where it is (a coasting fix) to its post or home, or lying up near the nearest body. It isn't woken by proximity again for 12 hours. Traffic woken for a fight (a pirate's prey) goes back on its route the same way. A crippled hull is left out of the forces and removed.

## Light lag and the plot (`sim/intel.js`)

Light crosses an AU in 8.3 minutes (one light-second is 0.002 AU, one light-minute 0.12 AU). Everything our sensors hold (long range is 15M km, 50 light-seconds) is less than one sim step old, so the sensor board is live; each contact carries its light time. Everything else we know is a **report** on the plot (`state.intel`), and every report has an age:

- **Our own tracks.** A contact that drops off the board leaves its last fix. The plot coasts it on its last velocity, inside a circle of 30 m/s × age + ½ · 0.05 G · age² (it may have burned since). It is forgotten after 5 days. PLOT ROUTE flies to where the fix has coasted to, on the plot's numbers, never the ship's own (a route target `fix`: sim/nav.js), and our sensors take the route over (an intercept on the contact itself) the minute they hold it again.
- **Traffic digests.** Every station's traffic control publishes every 6 hours (staggered by station). A digest lists up to 400 transponder ships within 0.03 AU of it: berthed there, flying a filed plan (from, to, departure, arrival, G), or a plain fix. It reaches us after the light time from that station, and only if the comms array works when it lands. A filed plan is flown forward on the plot, and the nav computer can plot a route to it. Ships without a transponder are never in a digest.
- **The newsfeed.** Zone news and losses leave from where they happened and reach us at light speed (`relay`). A zone is drawn once its news has arrived and stays until news of its end does. A wreck in the news is charted from then on.

Stations, nav marks and contract targets are on published orbits: charted, not observed. The plot holds at most 6,000 records, dropping the stalest first. The solar map draws live contacts and charted orbits where they are, and reports where they should be by now: faded with age, with their circle when it says something, and as a point cloud past 1,500 in view. Light-time rings mark 1 light-second, 1 light-minute and 10 light-minutes around us. The tactical view shows only what our sensors hold.

## Politics (`sim/politics.js`)

Each pair of powers has a **relation** (−100 open war … +100 alliance) and a **phase**: allied (55+), friendly (20+), neutral, cold war (−20 and below), crisis (−45 and below), war. The bands between are read off the relation with 3 points of hysteresis; war is **declared** (from a crisis past −72) and ended by a **ceasefire**, as events. Two quantities move a pair, daily:

- **Pressure** (0–1) builds while they are not fighting: a drift of its own (the arms race: 0.0018/day for Earth–Mars, 0.0012 for the Belt pairs), the weight of both powers' hawks (+0.005 × lean), and incidents (+0.03 each: warships lost in a standoff, a proxy's money traced, a spy caught); it eases by 0.8% of itself a day. A crisis feeds itself (+0.012/day) unless it is the cooling after a ceasefire. The relation follows: each day it moves 4% of the way back to its baseline (UN–MCR −32, UN–OPA −10, MCR–OPA −15), less 1.8 × pressure, plus a random walk (σ 2). Past −72, war is declared with a chance of 30–60% a day (more with the hawks in charge).
- **Exhaustion** (0–1) builds in a war, 0.014 a day and more with losses. Past 0.4 a ceasefire becomes likely; it sets the relation to −50 (a crisis that cools), and pressure to 0.

Earth and Mars are never friends: their relation never rises above −25. Over two years (tests/service.test.mjs) they spend about 40% in a cold war, 45% in a crisis (with the cooling after each war) and 15% at war, with three or four wars; the Belt pairs stay neutral or in a cold war, and rarely go further. The old 0–1 **tension** is kept, read off the relation, for the zones' intensity and the boards.

**Sub-factions** share their power's influence (it sums to 1). Their agendas lean it: hawk and militant +1, profit +0.3, covert +0.2, labor −0.2, moderate −0.6, dove −1. Shares drift, are pulled back toward their usual weight, and swing with the times: a long crisis hands influence to the hawks, a war that drags on to the doves.

**In-fighting.** Each pair of sub-factions of one power has a rivalry (opposed agendas start further apart). A feud breaks out with a chance of 2% × rivalry a day: a leak, a budget fight, arrests, a press campaign, or sabotage at a yard (its hulls on the slips are delayed 2–6 days: forces.js). The winner takes a few points of influence from the loser. Most of it reaches the newsfeed; half the time it leaves a sub-faction wanting a quiet job done against its rival (a covert job, below).

**Proxies.** In a cold war or a crisis, a power pays someone to fight its rival (a chance of 1% + 4% × pressure a day per pair): the mercenaries, a clan, or the Ceres Free Belt's cells against an inner power. The side whose spies and militants have more say is the likelier payer. A proxy war lasts 15–45 days; its money is traced with a chance of 3% a day, an incident.

Political news leaves the capital it concerns (Earth, Mars, Ceres) and reaches us at light speed.

## Hot zones (`sim/conflict.js`)

Hot zones are born from the influence field and the state of the powers, not from a script. Each day, with a chance of 20% + 50% × the mean tension, a flashpoint is chosen among the bodies where:

- two powers' reach overlaps: a naval **standoff** in a cold war; a standoff, a **blockade** (one navy stopping traffic to the other's station) or a **skirmish** in a crisis; a skirmish or a blockade in a war;
- nobody's writ runs well, in the Belt or beyond: **pirate activity**, a clan's work;
- an inner power holds a place with real Belter presence: an **insurgency** (the Ceres Free Belt's cells).

Two kinds come straight from politics:

- Every war has a **front** at the body both powers reach furthest (Ganymede, or Mars itself when Earth is close): radius 0.04–0.07 AU, intensity 0.85, 40% of each navy, and two or three **control points** that the squadrons fight over (the side that loses a ship there may lose a point). It ends with the war.
- Every proxy war has its **raiding ground**: a body out in the Belt or beyond where the target power's reach is real but thin. The proxy's raiders prey on that power's shipping.

A zone sits at an offset from its body and moves with it. It has a radius (0.02–0.06 AU; skirmishes 0.01–0.03) and an intensity that follows its powers (toward 0.85 at war, 0.6 in a crisis, 0.4 in a cold war). A standoff turns into a skirmish when its powers go to war (or, rarely, in a hot crisis); a ceasefire silences a skirmish back into a standoff and ends the front. Zones end after 5–30 days, when their intensity dies, or when their powers make peace (a naval zone between powers no longer at odds). At most eight flashpoints exist at once (ten with fronts and raiding grounds). Their birth, escalation and end come over the newsfeed.

Away from us, zones produce outcomes without flying ships. Every hour, with a chance scaled by kind and intensity, a zone costs one real ship, which becomes a wreck where it was, held with the zone's body (salvage). At most four wrecks per zone (ten at a front):

- **Skirmish, front and standoff:** only when both sides have hulls on station. The side facing the stronger squadron (summed class strength) loses a hull.
- **Pirate zone:** a pack on station takes a traffic ship in transit through the zone.
- **Proxy war:** the proxy's raiders take a ship of the target power's in transit.
- **Blockade:** the blockader disables a traffic ship running it.
- **Insurgency:** a loss is rolled up from the zone's politics.

Every loss between two powers is an incident (politics): it feeds a crisis, or wears a war down. With nobody there, nothing happens: the squadrons may still be on their way. Test suites without the forces roll every loss up from the politics. News of the loss reaches us at light speed.

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
| raid | 10% × intensity in a proxy war | one of the proxy's raiders, running dark, after the target power's ships |

Battles are rolled in fronts as in skirmishes (30% × intensity).

After each encounter the director rests 6–24 hours (`politics.quietUntil`), and it never keeps more than six ambient agents around us.

## NPC behaviour (`sim/agents.js`)

An agent is a driven ship with a role. It flies our own flight model and guidance laws.

- **Patrol / picket.** Watches the ships it can see. It stops ships that are suspect: wanted, running without a transponder, or caught in a random check (15%, or 60% inside a zone). It hails from about 300,000 km with an order to heave to. It goes after pirates it sees. If we are wanted at level 3, it fires on sight. A stop is made only inside its **jurisdiction** (`law.inJurisdiction`): the space its power holds or contests, or the zone it was sent to enforce (a blockade, a standoff). It doesn't order one to a ship whose course, as it flies it now, takes it out of that before the cutter could be alongside, and if we leave mid-intercept the order is withdrawn. One stop at a time: none while another order is open or another cutter is coming alongside or searching us, none in port (on a station's approach, in a berth, under the docking computer) or while we are in a fight, and a power whose inspectors stamped our papers waves us through for two days (`INSPECTED_MIN`) unless we give it new cause (a higher wanted level). A licensed captain flying one of its own navy's hulls under its banner is never stopped by that power's security, short of a warrant (WANTED).
- **Pirate.** Lurks dark. It stalks us if it is at least half our strength (pirates bluff), or jumps nearby civilian traffic. From about 75,000 km it demands about 30% of our credits. Pay and it leaves; refuse and it attacks from about 100,000 km, aiming to disable (it wants a prize, not a fireball). Once our drive is out it stops launching torpedoes and makes a last demand: about 60% of our credits, or its guns. It slips away when law ships are near, breaks off when hurt or outgunned, and runs when a ship it can't fight finds it and comes for it, as any ship runs (COMBAT.md: a sprint its crew can take, then 6G; dark once out of reach; cornered, it strikes).
- **Navy.** Fights its enemies' warships and patrols wherever it meets them (never their civilians). In a zone it warns off unidentified ships that come inside 75,000 km, and engages anyone who ignores it or whom its power wants at level 2+. A captain flying an enemy power's flag it engages once it knows who it is (transponder, or a good look); one flying the flag of a power it is in a crisis with it warns off its zone, and engages if it comes on. One of its own navy's hulls flown without the license (or a stolen one) it engages too. When someone attacks a flagged captain, the navies and patrols of its power's friends nearby come to its help. Doctrine is KILL, with nuclear torpedoes against warships.
- **A proxy's raiders** fly as pirates, but take only the target power's ships, and stalk only the captains flying its flag.
- **Civilian.** Flees from any ship or ordnance it can see coming for it, as any ship runs (COMBAT.md), with no jinking, and from us while we are within 0.01 AU after firing on it. A miner turns its mining gear on any attacker that comes within reach. It surrenders when disabled.
- **Convoy.** Flies to its destination (escort contracts) and docks there.

In a fight an agent keeps its doctrine's standoff range (pirates 100,000 km, police 50,000 km, navies 20,000 km, inside railgun range). It launches salvos sized to saturate the enemy's point defense, fires railguns when it has them, rakes the enemy with PDCs at close range, and jinks when ordnance is close or the enemy is near. Ships out to disable stop launching once the target is crippled and close in to finish it with guns; navies don't. Ships at TL2 and above turn away from inbound torpedoes (COMBAT.md). Agents retreat when badly hurt or outgunned.

Encounters ask for a kind of ship and a faction, and the faction fields its own design. Patrols are cutters (a Belt refit, a UN cutter or a Martian Security cutter). Pirates are torch raiders, stolen couriers, gunships or a stolen corvette. Skirmishes are corvettes, frigates and destroyers of each side's navy (SHIPS.md).

**Requests** are how agents talk to us. Each has options and a 15-minute deadline:

| Request | Options | Silence means |
|---|---|---|
| inspect (patrol) | heave to · run | comply if we sit still, run if we keep burning |
| demand (pirate) | pay · refuse | refuse |
| warning (navy) | transponder on and stand off · ignore | comply if we are still and broadcasting |
| surrender (beaten or run-down enemy) | accept · ignore | ignore (run down, it then fights it out) |

An inspection takes 45 minutes alongside. Burning away or opening the distance counts as resisting.

## Law (`sim/law.js`)

Each power keeps **standing** (−100 to 100), a **wanted level** for us, and the **citations** we owe it (fines from traffic control: DOCKING.md; a week unpaid makes us SUSPECT): CLEAN, SUSPECT (stopped and searched; a fine settles it), WANTED (heave to or be disabled), HOSTILE (shot on sight). After a search the power's patrols wave us through for two days, unless we give them new cause.

A crime is recorded against the victim's power and the power whose space it happened in. Escalations count once per victim: fired on 1, disabled 2, destroyed 3, +1 if the victim was military or police. Each crime costs 10 standing per severity point. Firing on pirates, wanted criminals (a proxy's raiders among them), wrecks or anyone who shot first is not a crime; destroying pirates earns a little standing with the local power. Resisting an inspection raises our wanted level to WANTED. A captain flying a power's flag (below) who fires on the warships or patrols of a power at war with its own is at war, not committing a crime (that power's standing still drops with every hit); firing on its civilians is a crime as ever. A crime against our own power's people costs reputation, and from severity 2 the license.

**Contraband**: smuggled cargo (illegal where its contract says), nuclear torpedoes (legal only to a licensed captain: in its own power's space, and, under Earth's and Mars's rule, nowhere else in theirs), and a military hull flown without its license. An inspection seizes the cargo and the warheads and levies 1,000 + 1,500 per consignment + 1,000 per warhead + 10,000 for an unlicensed hull + 1,500 per wanted level. Paying in full clears the record, except a hull's: it can't be seized at sea, so the record stays open (SUSPECT; WANTED with the navy whose hull it is) as long as we fly it. Wanted levels fade one step per ten quiet days; standing drifts back toward neutral. Stations of a power that puts our standing below −20 won't give us work.

**Arms**: PDC rounds sell everywhere (0.05 MCR each). HE torpedoes (1,800 MCR) sell at OPA, independent and pirate stations, at UN or Martian yards only if our standing is 20 or more, and from command ships to their contractors. Nuclear torpedoes (6,000 MCR) are military kit: only to a licensed captain, at its own power's stations that sell arms, or from its command ship from rank 3.

## Military service (`sim/service.js`, `sim/military.js`)

**The license.** A captain may hold one power's military license (UN, MCR or OPA) at a time: chosen on the new-game screen (the game then starts at that power's yards: Luna, Phobos, Tycho; a civilian starts at Ceres, and the starting standing with the licensing power is at least 20), applied for at any station of the power (in port; standing 10 or better, a clean record with it), handed back at will (at its stations, or in the service record; either way a confirmation that says what it costs comes first, so it is never one click), and revoked for a crime of severity 2 against its people or for being WANTED by it (it can't be applied for again for 30 days, and half the reputation is gone). A navy's hulls (the three navy corvettes) need its license; the stolen ex-UNN Harrier needs one nobody gives, and is illegal everywhere.

**The flag.** A license and one of its navy's hulls make the captain that power's **contractor**: it flies its flag, and the ship carries its navy's prefix wherever it is shown or hailed (the Longhaul is the *MCRN Longhaul*, or the *UNN Longhaul*; OPA hulls carry bare names: `service.ourName`). A license in a civilian hull does nothing else (nuclear torpedoes become legal). Under a flag every faction sees us through our power:

relation(X) = relation(our power, X) + our standing with X / 10

| Relation | They treat us as |
|---|---|
| our power | ours: its patrols wave us through from rank 1 |
| 40 or more | a friend: their warships and patrols nearby help us when we are attacked |
| −35 or less | hostile: their warships warn us off their zones and engage if we come on; their stations won't clear us in |
| −60 or less | an enemy: their warships and patrols engage us on sight once they know us (transponder, or a good look), their stations' guns fire on us |

Pirates are everyone's enemy, the independents nobody's. Without a flag, each power judges us on our own standing, as before. Hails read the same relation (dialogue.js attitude).

**Reputation and rank.** A contractor earns reputation with its power, kept per power and apart from standing: 1 a day in service; for each enemy hull it destroys (a cutter 10, corvette 15, gunship 20, frigate 30, destroyer 60, battleship 150; a command ship half again; a pirate's or a proxy's about a third); for each military mission (25–60); for reporting aboard a command ship (5). Failed missions cost half their reward, crimes against its own side 25 per severity point, a blown covert job 20. Reputation makes rank:

| Rank | Reputation | UNN | MCRN | OPA |
|---|---|---|---|---|
| 0 | 0 | Ensign | Ensign | Volunteer |
| 1 | 40 | Lieutenant (j.g.) | Lieutenant | Hand |
| 2 | 120 | Lieutenant | Lieutenant Commander | Bosmang |
| 3 | 300 | Lieutenant Commander | Commander | Kapteng |
| 4 | 600 | Commander | Captain | Fleet Kapteng |
| 5 | 1,000 | Captain | Commodore | Kommodore |
| 6 | 1,600 | Commodore | Rear Admiral | Admiral |

Rank raises military pay by 15% a step, opens the harder missions (holding a point from rank 1, covert jobs from 1, strikes from 2), gets nuclear warheads issued by command ships from rank 3, and from rank 1 our own side's patrols don't stop us for a random check.

**Call-ups.** When a fight of our power (a naval zone it is in, an insurgency against it, a proxy war on its shipping) has a command ship within 2.5 AU of us, command orders us to report to it. The order travels at light speed (the mission log lists it under ORDERS, with the way to the command ship). A command ship takes its own contractors alongside at its post (the route panel's DOCK on it: a rendezvous, then the docking computer). Alongside we have reported; for as long as its fight lasts its supplies, field repairs and torpedoes cost a tenth of the price.

**Military missions** are posted on every slot of a command ship's board while its fight lasts, and on 15% of the slots of a station of our power (or an independent one) within 0.6 AU of one of our power's fights. Only a contractor of that power can sign (alongside a command ship, in port at a station), and only at the rank each asks. They are marked MIL on the boards, in our power's colour, with the sub-faction that issues them. Each is reported at any port of our power: its stations or its command ships.

| Mission | Work | Rank | Pay |
|---|---|---|---|
| INTELLIGENCE | a sensor lock inside 300,000 km on 2–3 different enemy warships (or a proxy's raiders), held 10–20 minutes each | any | 5,000–12,000 |
| HOLD THE POINT | at a war front, get within 75,000 km of a control point our side holds and stay 4–8 hours; three of our warships hold it with us, and the enemy sends 2–3 ships at it every 1.5–2.5 hours (four waves at most). Two hours off it and it is lost | 1 | 10,000–25,000, PDC rounds |
| STRIKE (HVT) | destroy (or take the surrender of) a high-value target: an enemy destroyer or frigate on detached duty with 1–2 escorts (in a war only), a proxy's ringleader, a cell's gunship. A navy's squawks (its signature in the fleet catalogue); a proxy's or a cell's runs dark, named by its transponder or its drive signature, on file four times in five (the brief says why not); until then, possibles as for a bounty | 2 | 12,000–30,000 |
| COVERT | for one of our power's sub-factions, against a rival inside it: hold a lock on the rival's ship for 30–90 minutes without being identified by it (transponder off, keep away). If it makes us, the job is blown | 1 | 6,000–14,000 |

Pay is rolled at posting and multiplied by our rank's pay factor. A mission whose fight ends before it is done fails.

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
| PLANETSIDE | load small, dear freight (medical supplies, seed stock, parts, 100 kg to 4 t) for a spaceport on a settled world within 3.5 AU (the nearer likelier), take it into a high orbit there and land it by shuttle; paid by radio when it is on the pad, a part at a time if it takes more than one run (FLIGHT.md: shuttles). Signing needs a shuttle that can make that world's ground |
| INVESTIGATE / MEDEVAC | rendezvous with a ship, hail it in formation, return (medevac casualties need berths) |
| SALVAGE | hold formation with a derelict while the crew strips it (2 h), return |
| SURVEY | loiter within 150,000 km of a survey mark for the required time, return |

**Distress calls** (`sim/missions.js`) come in four kinds: fuel-dry drifters, dead drives, runaway torches stuck at high G, and scrammed reactors. Each comes with a survival timer and a feasibility estimate from the nav computer. Accept, intercept, hold formation within 10 km and hail to rescue.

Stations near hot zones (within 0.6 AU) also post conflict work, up to 40% of their board (and military work for a contractor of a power fighting near them: above):

| Contract | Work | Pay |
|---|---|---|
| BOUNTY | find a wanted pirate near its last fix, a mark where a ship left there would lie (off a moon, held off its planet: `world.restingOrbit`), somewhere inside the brief's search area round it (50,000–500,000 km, wider the older the fix); put it out of action (destroyed: a wreck, or a reactor's fireball, which leaves none; or its colours struck: its surrender accepted); return. The fee is for the ship; on top, a fixed sum a head for its crew brought back alive (its captain worth four of them): board it (the wreck or the struck hull: a struck ship waits a day), take them prisoner, and hand them over with the contract, docked at the station that posted it (`bountyHeads`). A struck ship left adrift earns nothing more. Graded (below). It runs cold and dark, and runs from a ship it can't fight that finds it | 2,000–32,000 by grade, and by the head |
| ESCORT | join a convoy ship within 10 km where it waits for us, 3 km out past its station's approach gate (inside the gate no ship comes uncleared; a route to the station ends at the gate). It departs at ≤ 0.5G for the destination's gate, raiders strike partway along the route, and it goes in to a berth there. Keep it alive; collect at the destination | 2,500–5,000 + distance, PDC rounds |
| SMUGGLE | carry contraband through a blockade, or into inner-planet space. An inspection that finds it ends the job | 6,000–12,000 + distance |
| RECON | get within 300,000 km of a navy picket and hold a sensor lock on it for 30–90 minutes. Identification by that navy blows the job (and costs standing) | 4,000–9,000 |

**Bounties are graded** (`BOUNTY_GRADES`), the higher grades more often near the pirates' own hot zones:

| Grade | Share | Ship | Runs with | Last fix (h before posting) | Pay | A head brought back (captain) | Days | No signature on file |
|---|---|---|---|---|---|---|---|---|
| PETTY | 35% | armed runner, torch raider | — | 3–16 | 2,000–4,000 | 900 (3,600) | 5–10 | never |
| WANTED | 40% | torch raider, gunship | — | 6–30 | 3,500–7,500 | 1,000 (4,000) | 6–12 | never |
| NOTORIOUS | 18% | gunship, stolen corvette | 0–1 raiders | 12–48 | 8,000–15,000 | 1,200 (4,800) | 8–16 | never |
| MOST WANTED | 7% | stolen corvette | 1–2 raiders | 24–96 | 18,000–32,000 | 1,500 (6,000) | 10–20 | 40% |

A head brought back is worth more than the 800 MCR (a captain 2,400) any pirate turned over earns. Ransomed to their friends instead, a bounty's captain fetches three quarters of what the contract pays for them (`RANSOM_SHARE`), and any other pirate captain three quarters of their turn-over bounty (1,800).

A torpedo's warhead (70 DP) is more than a runner's or a torch raider's whole structure (60): one wrecks them wherever it lands, and only the wreck's survivors are left to bring back. A gunship or a stolen corvette (120) survives one, its drive out if DISABLE put it there, and strikes its colours. PDC fire on DISABLE, or a railgun slug (45 DP), wears a small raider's drive out before its hull goes.

**The brief** says what the authorities know: what the pirate is wanted for, its hull, crew, guns and drive, the last fix (where, when, who saw it, the search area), and above all whether its **drive signature is on file** (`c.sigKnown`, always set). About two bounties in a hundred, all of them MOST WANTED, are posted with none, and the brief gives the reason (a drive swapped at a yard that keeps no books, a hull stolen and refitted off the record, a captain who never burned where a sensor that lived could see). A strike's outlaw target goes without one one time in five, with its reason; a navy's warship is always in the fleet catalogue.

**Which contact is it** (`sim/hunts.js`). The hunted ship is on no registry: a long look never names it. Only its transponder names it (a crew striking its colours squawks), or the signature on file, read in its plume while its drive is lit; with none on file, a burn proves nothing. Until then, every dark ship nobody has named seen inside the search area is a **possible**, and so is anything followed from there while the board holds it: the displays mark it with a dashed diamond and BOUNTY? (STRIKE?), never with the target's name, and the contact panel says why it can't be confirmed yet. A possible is **ruled out** when it shows who it is: it squawks another name, a long look matches it on a registry, its plume carries another signature than the one on file, or its mass (a 30-minute look) is more than a third off the target's class. Destroying a possible that was the target still earns the bounty (the station reads the sensor logs); destroying one that wasn't is whatever it was, piracy if it was a lawful ship running dark. The nav computer calls each possible and each ruling out.

**The mission log** keeps every contract's brief and its timeline (what the nav computer called out about it, stamped, signed to turned in or failed), folded under its row, for the work in hand and the last 40 finished; a station's board shows the same brief before signing.

**UNDER ATTACK** distress calls come from the director's ambushes. Accepting puts the victim under our point defense. Once the raiders are dead, beaten, gone or have lost interest, hold formation and hail to complete.

## Hailing (`sim/dialogue.js`)

Hailing opens a channel, and a channel is a conversation: topics we can raise and what the other side says back, by who they are, how they see us, and where we stand. The comms window (`H`) lists the stations and ships in radio range (stations first, with signal and light lag), the conversation, and a card of what we know of them.

| Counterpart | Topics |
|---|---|
| Station (traffic control) | approach, docking (or an emergency berth), departure, cancel; the traffic board (berths, the anchorage, and the manifests of the ships berthed: their declared crews); news; the registry on any ship in range; the contract board; services, the hiring hall, shore leave (docked); pay citations; prisoners: turn them over to the authority, or ransom their officers to their own side (DOCKING.md); apply for the power's military license (in port), or hand ours back (a second, confirming choice) |
| Civilian | identify, souls aboard, where bound, what they have seen (real zones on our plot, real pirates near them), a rendezvous to dock, buying supplies over the collar, help when we are in trouble, a warning about pirates near them, an order to heave to (a crime against a lawful ship) |
| Police | identify, souls, our record, settle our record, report a pirate contact (they go after it), surrender to them when wanted |
| Navy | identify, souls (not to strangers), passage through their zone (standing 10, clean, transponder on), news |
| Our command ship | report in (our orders, the board, the prices), the mission board, supplies and repairs (alongside), how the fight is going |
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
