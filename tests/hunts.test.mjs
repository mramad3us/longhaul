// The ships we hunt (sim/hunts.js) and what a contract keeps (ui/brief.js).
// A bounty is graded, and its drive signature is on file or not, always
// said (c.sigKnown); only the most wanted go without one, for a reason the
// brief gives. Which contact is the target: with the signature on file, a
// cold target is only a possible until it burns; with none, only its
// transponder names it; dark ships in the search area of the last fix are
// possibles, never named, until something shows who they are (another
// signature in the plume, a registry, a transponder, a mass that is no hull
// of its class). Destroying a possible that was the target still counts.
// And every contract keeps its brief and its timeline, signed to turned
// in, in the mission log and in a save.
import { assert, fmt } from './helpers.mjs';
import { seedRandom } from '../js/core/rng.js';
import { bus } from '../js/core/events.js';
import { AU_KM } from '../js/core/constants.js';
import { createGame } from '../js/sim/game.js';
import { serialize, deserialize } from '../js/sim/save.js';
import { getWorld } from '../js/sim/world.js';
import { sensorsTick, setSensorRange, contactById, REVEAL } from '../js/sim/sensors.js';
import { recordContacts } from '../js/sim/intel.js';
import { spawnAgent } from '../js/sim/agents.js';
import { missionTargets, missionSuspects } from '../js/sim/flags.js';
import { bountyOffer, BOUNTY_GRADES, CAPTAIN_HEADS, acceptContract, completeContract, contractsTick, upgradeContracts, bountyHeads, deliverable } from '../js/sim/contracts.js';
import { prisonerGroup, turnOver, ransomOffer, ransom, RANSOM, PIRATE_BOUNTY, NOTABLE_BOUNTY } from '../js/sim/prisoners.js';
import { surrender } from '../js/sim/agents.js';
import { dockedTo } from '../js/sim/docking.js';
import { wreckNpc } from '../js/sim/damage.js';
import { huntStatus, searchAU, unconfirmed } from '../js/sim/hunts.js';
import { briefOf } from '../js/ui/brief.js';
import { frameMarks, marksOf } from '../js/ui/marks.js';

function game(seed = 31) {
  seedRandom(seed);
  bus.clear();
  const s = createGame({ docked: false, crewCount: 4, traffic: 0, forces: false });
  s.politics.quietUntil = Infinity;
  s.missions.cooldown = 1e9;
  s.comms.transponder = false;
  return s;
}
const ZONE = { id: 'z-test', kind: 'pirates', body: 'Ceres' };
const look = (s) => { sensorsTick(s); recordContacts(s); };
/** One minute of the contracts' work, the board looked at first. */
const minute = (s, emit) => { look(s); contractsTick(s, emit); };

/**
 * A bounty signed at Ceres and us beside its target, the board up: a dark
 * ship 30,000 km off, held even cold, inside the search area (the target is
 * put there; the mark follows it, so the area is round us).
 */
function signed(s, { sigKnown = true } = {}) {
  const world = getWorld(s);
  const st = world.get('ceres-station');
  const c = bountyOffer(s, st, ZONE);
  c.sigKnown = sigKnown;
  if (!sigKnown) { c.signature = null; c.sigWhy = 'A test hull with nothing on file.'; }
  else c.signature ||= 'TEST-0001';
  st.board.missions.push(c);
  s.flight.pos = { ...st.pos }; s.flight.vel = { ...st.vel };
  const r = acceptContract(s, st.id, c.id);
  assert(r.ok, r.text);
  const t = world.get(c.targetId), mark = world.get(c.markId);
  // out where the pirate is: beside it, well clear of the station
  s.flight.pos = { x: mark.pos.x + 0.0002, y: mark.pos.y }; s.flight.vel = { ...mark.vel };
  t.pos = { x: mark.pos.x, y: mark.pos.y }; t.vel = { ...mark.vel }; t.thrust = 0;
  for (const id of c.escortIds || []) world.remove(world.get(id));
  setSensorRange(s, 2);
  return { c, t, mark, st, world };
}
/** A dark ship at an offset (AU) from a point, at its velocity. */
const darkShip = (s, at, dx, opts = {}) => spawnAgent(s, { role: 'civilian', faction: 'independent', cls: 'rockhopper', transponder: false, pos: { x: at.pos.x + dx, y: at.pos.y + 0.00004 }, vel: { ...at.vel }, ...opts });

export default [
  {
    name: 'a bounty pays for the ship put out of action, and by the head for its crew brought back alive (its captain four times more); a struck ship left adrift earns nothing more; its captain ransomed fetches less than the contract',
    fn: () => {
      // docked at Ceres, where the bounty is posted and turned in
      const play = (seed, how, take) => {
        seedRandom(seed);
        bus.clear();
        const s = createGame({ crewCount: 6, traffic: 0, forces: false, classId: 'mcrn-corvette', license: 'MCR' });
        s.politics.quietUntil = Infinity; s.missions.cooldown = 1e9;
        const st = dockedTo(s);
        const c = bountyOffer(s, st, ZONE);
        st.board.missions.push(c);
        assert(acceptContract(s, st.id, c.id).ok, 'signed');
        assert(c.perHead === BOUNTY_GRADES.find(g => g.grade === c.grade).perHead && c.captainHead === c.perHead * CAPTAIN_HEADS && c.aliveBonus == null, 'paid by the head, no surrender bonus');
        const t = getWorld(s).get(c.targetId);
        const fee = c.reward.credits;
        if (how === 'wreck') wreckNpc(s, t, 'player'); else { t.agent.hostile = []; surrender(s, t); }
        contractsTick(s);
        assert(c.phase === 'return' && c.reward.credits === fee, `${how}: the job is done, the fee as posted (${c.reward.credits})`);
        if (take) s.passengers.push(prisonerGroup(s, t, take));
        return { s, st, c, fee };
      };
      // struck and left adrift: the fee, nothing more
      {
        const { s, st, c, fee } = play(41, 'surrender', 0);
        const cr = s.resources.credits.current;
        const r = completeContract(s, c.id, st.id);
        assert(r.ok && s.resources.credits.current - cr === fee && !c.brought, `nobody brought back: ${s.resources.credits.current - cr} (fee ${fee})`);
      }
      // wrecked, its captain and three of its crew taken off the hulk
      {
        const { s, st, c, fee } = play(42, 'wreck', 4);
        const h = bountyHeads(s, c);
        assert(h.heads === 4 && h.captains === 1 && h.pay === 3 * c.perHead + c.captainHead, `four, the captain among them: ${JSON.stringify(h)}`);
        // turned over as ordinary prisoners: they stay aboard for the contract
        const crT = s.resources.credits.current;
        const tr = turnOver(s, st);
        assert(s.resources.credits.current === crT && bountyHeads(s, c).heads === 4 && /stay aboard for the bounty/.test(tr.text), `held for the contract: ${tr.text}`);
        // undocked, in port: the contract wants a berth to hand them over
        const dock = s.dock;
        s.dock = null;
        const no = completeContract(s, c.id, st.id);
        assert(!no.ok && /Dock/.test(no.text), `their crew cross at a collar: ${no.text}`);
        s.dock = dock;
        const cr = s.resources.credits.current;
        const r = completeContract(s, c.id, st.id);
        const got = s.resources.credits.current - cr;
        console.log(`      ${c.gradeLabel}: fee ${fee.toLocaleString()} MCR · its crew ${c.perHead} a head, its captain ${c.captainHead} · four brought back: ${got.toLocaleString()} MCR · "${r.text}"`);
        assert(r.ok && got === fee + h.pay && c.brought?.heads === 4, 'the fee and the heads');
        assert(!s.passengers.some(p => p.kind === 'prisoners'), 'handed over with it');
      }
      // or its captain ransomed to their friends: still on offer, for less than the contract pays to bring them in
      {
        const { s, st, c, fee } = play(44, 'wreck', 4);
        const gi = s.passengers.filter(p => p.kind === 'prisoners').findIndex(g => g.from === c.targetId);
        const o = ransomOffer(s, st, gi);
        console.log(`      its captain ransomed to their clan: ${o.amount.toLocaleString()} MCR, against ${c.captainHead.toLocaleString()} brought in · any pirate captain: ${RANSOM.irregular.toLocaleString()} against ${(PIRATE_BOUNTY * NOTABLE_BOUNTY).toLocaleString()} turned over`);
        assert(o.ok && o.forBounty && o.amount > 0 && o.amount < c.captainHead, `less than the contract: ${o.amount} vs ${c.captainHead}`);
        assert(RANSOM.irregular < PIRATE_BOUNTY * NOTABLE_BOUNTY, 'a pirate captain\'s friends pay less than the law');
        assert(BOUNTY_GRADES.every(g => g.perHead > PIRATE_BOUNTY && g.perHead * CAPTAIN_HEADS > PIRATE_BOUNTY * NOTABLE_BOUNTY), 'a bounty\'s crew are worth more brought in than any pirate turned over');
        const cr = s.resources.credits.current;
        ransom(s, st, gi);
        assert(s.resources.credits.current - cr === o.amount, 'paid');
        const h = bountyHeads(s, c);
        assert(h.heads === 3 && h.captains === 0 && h.pay === 3 * c.perHead, `the rest still go in with the contract: ${JSON.stringify(h)}`);
        const r = completeContract(s, c.id, st.id);
        assert(r.ok && c.brought.heads === 3, 'three brought back');
      }
    },
  },
  {
    name: 'a save from before 1.3: a bounty taken by surrender loses the half-again it was credited, and is paid by the head instead',
    fn: () => {
      const s = game(43);
      s.contracts.active.push({ id: 'c-old3', type: 'BOUNTY', phase: 'return', outcome: 'captured', grade: 3, reward: { credits: 15000 }, aliveBonus: 0.5, signature: 'X', targetId: 'z' });
      upgradeContracts(s);
      const c = s.contracts.active.at(-1);
      assert(c.reward.credits === 10000 && c.perHead === 1200 && c.captainHead === 4800 && c.aliveBonus == null, JSON.stringify(c));
    },
  },
  {
    name: 'bounties are graded, and whether the drive signature is on file is always said: only the most wanted go without, about 2 in 100, each with its reason',
    fn: () => {
      const s = game(32);
      const st = getWorld(s).get('ceres-station');
      const N = 3000, by = {}, unknown = [];
      let areaMin = Infinity, areaMax = 0;
      for (let i = 0; i < N; i++) {
        const c = bountyOffer(s, st, i % 2 ? ZONE : null);
        assert(typeof c.sigKnown === 'boolean', 'sigKnown is always set');
        assert(c.sigKnown ? /^[A-Z0-9-]+$/.test(c.signature) && !c.sigWhy : c.signature === null && c.sigWhy?.length > 20, `signature and reason agree: ${JSON.stringify({ k: c.sigKnown, s: c.signature, w: c.sigWhy })}`);
        assert(c.fix && c.fix.at < c.offeredAt && c.fix.rKm >= 50_000 && c.fix.rKm <= 500_000 && c.fix.by && c.wanted.length, 'a last fix with its age, source and search area; the counts it is wanted on');
        by[c.gradeLabel] = (by[c.gradeLabel] || 0) + 1;
        if (!c.sigKnown) unknown.push(c);
        areaMin = Math.min(areaMin, c.fix.rKm); areaMax = Math.max(areaMax, c.fix.rKm);
      }
      const share = unknown.length / N;
      console.log(`      ${N} bounties: ${BOUNTY_GRADES.map(g => `${g.label} ${by[g.label] || 0}`).join(' · ')} · no signature on file ${unknown.length} (${fmt(100 * share, 1)}%) · search areas ${fmt(areaMin / 1000)}k–${fmt(areaMax / 1000)}k km`);
      assert(unknown.every(c => c.grade === 4), 'only the most wanted are posted without a signature');
      assert(share > 0.01 && share < 0.05, `very rare (${fmt(100 * share, 1)}%)`);
      assert(unknown.every(c => /No drive signature on file/.test(c.description)), 'and the board says so');
    },
  },
  {
    name: 'signature on file, the target cold: a possible, unnamed, until it burns; then confirmed by its signature',
    fn: () => {
      const s = game(33);
      const { c, t } = signed(s, { sigKnown: true });
      assert(t.signature === c.signature, 'the pirate flies the signature on file');
      for (let i = 0; i < 3; i++) minute(s);
      assert(huntStatus(c, t.id) === 'possible' && !c.identified, `cold: a possible (${huntStatus(c, t.id)})`);
      assert(!missionTargets(s).has(t.id) && missionSuspects(s).get(t.id) === 'BOUNTY', 'marked as a maybe, not as the target');
      const m = marksOf(frameMarks(s), t.id, true);
      assert(m.maybe === 'BOUNTY' && !m.mission, 'the displays: BOUNTY?, dashed');
      assert(!contactById(s, t.id).name, 'no name on the board');
      assert(/drive cold/.test(unconfirmed(s, c, t)), 'why not yet: the drive is cold');
      t.thrust = 1;
      minute(s);
      assert(c.identified === 'signature' && huntStatus(c, t.id) === 'confirmed', 'its plume shows the signature on file');
      look(s);
      assert(missionTargets(s).get(t.id) === 'BOUNTY' && !missionSuspects(s).size && contactById(s, t.id).name === c.targetName, 'named and marked BOUNTY');
      assert(c.log.some(l => /possibly our target/.test(l.text)) && c.log.some(l => /signature .* matched/.test(l.text)), 'the timeline has both');
    },
  },
  {
    name: 'no signature on file: a burn proves nothing; only its transponder names it',
    fn: () => {
      const s = game(34);
      const { c, t } = signed(s, { sigKnown: false });
      t.thrust = 1.5;
      for (let i = 0; i < 5; i++) minute(s);
      assert(!c.identified && huntStatus(c, t.id) === 'possible', 'burning, still only a possible');
      assert(/no signature on file/.test(unconfirmed(s, c, t)), `why not: ${unconfirmed(s, c, t)}`);
      const sec = briefOf(s, c).find(x => x.head === 'TARGET');
      const sig = sec.rows.find(r => r[0] === 'DRIVE SIGNATURE'), why = sec.rows.find(r => r[0] === 'WHY NOT');
      assert(sig[1] === 'NOT ON FILE' && why?.[1] === c.sigWhy, 'the brief says so, and why');
      t.transponder = true;
      minute(s);
      assert(c.identified === 'transponder', 'its transponder names it');
    },
  },
  {
    name: 'possibles: dark ships in the search area, ruled out by another signature, a registry, a transponder, a mass; none outside the area',
    fn: () => {
      const s = game(35);
      const { c, t, mark } = signed(s, { sigKnown: true });
      const burner = darkShip(s, t, 0.0001), looked = darkShip(s, t, -0.0001), squawk = darkShip(s, t, 0.00015), heavy = darkShip(s, t, -0.00015, { cls: 'freighter' });
      for (let i = 0; i < 2; i++) minute(s);
      const all = [t, burner, looked, squawk, heavy];
      assert(all.every(e => huntStatus(c, e.id) === 'possible'), `all five dark ships in the area are possibles (${all.map(e => huntStatus(c, e.id)).join(', ')})`);
      burner.thrust = 1;
      s.sensors.scan[looked.id] = REVEAL.PROFILE;
      squawk.transponder = true;
      s.sensors.scan[heavy.id] = REVEAL.MASS;
      minute(s);
      const why = (e) => c.ruledOut[e.id]?.why || '';
      console.log(`      ruled out: ${[burner, looked, squawk, heavy].map(e => `"${why(e)}"`).join(' · ')}`);
      assert(/plume reads/.test(why(burner)) && /registry/.test(why(looked)) && /squawking/.test(why(squawk)) && /is no/.test(why(heavy)), 'each for what showed it');
      assert(huntStatus(c, t.id) === 'possible' && c.suspects.length === 1, 'the target is the one left');
      // a dark ship outside the search area is nobody's possible
      const far = darkShip(s, mark, searchAU(c) * 1.3);
      s.flight.pos = { x: far.pos.x + 0.0002, y: far.pos.y };
      minute(s);
      assert(!huntStatus(c, far.id), 'outside the search area: not a possible');
    },
  },
  {
    name: 'a possible destroyed that was the target pays: the logs settle it; the brief and the timeline stay with the contract, in the log and in a save',
    fn: () => {
      const s = game(36);
      const { c, t, st } = signed(s, { sigKnown: false });
      for (let i = 0; i < 2; i++) minute(s);
      assert(huntStatus(c, t.id) === 'possible', 'a possible');
      wreckNpc(s, t, 'player');
      minute(s);
      assert(c.phase === 'return' && c.outcome === 'destroyed' && c.identified === 'logs', `the bounty stands done (${c.phase}, ${c.identified})`);
      // a save in between keeps it all
      const back = deserialize(serialize(s)).state;
      const cb = back.contracts.active.find(x => x.id === c.id);
      assert(cb.sigKnown === false && cb.sigWhy === c.sigWhy && cb.fix.rKm === c.fix.rKm && cb.log.length === c.log.length, 'a save carries the brief and the timeline');
      s.flight.pos = { ...st.pos }; s.flight.vel = { ...st.vel };
      const r = completeContract(s, c.id, st.id);
      assert(r.ok, r.text);
      const done = s.contracts.history.at(-1);
      assert(done === c && c.paid?.credits === c.reward.credits, 'in the log of finished work, with what it paid');
      const heads = briefOf(s, c).map(x => x.head);
      assert(['CONTRACT', 'PAY', 'TASK', 'TARGET', 'LAST FIX', 'STATUS', 'TIMELINE'].every(h => heads.includes(h)), `the brief's sections: ${heads.join(', ')}`);
      const tl = briefOf(s, c).find(x => x.head === 'TIMELINE').rows.map(r => r[1]);
      console.log(`      timeline: ${tl.join(' | ')}`);
      assert(/^Signed at/.test(tl[0]) && /^Turned in at/.test(tl.at(-1)), 'signed to turned in');
    },
  },
  {
    name: 'a save from before 1.1: a hunt\'s signature on file if it carried one, graded as the common run',
    fn: () => {
      const s = game(37);
      s.contracts.active.push({ id: 'c-old1', type: 'BOUNTY', phase: 'active', signature: 'AB-1', targetId: 'x' }, { id: 'c-old2', type: 'BOUNTY', phase: 'active', signature: null, targetId: 'y' });
      upgradeContracts(s);
      const [a, b] = s.contracts.active.slice(-2);
      assert(a.sigKnown === true && b.sigKnown === false && b.sigWhy && a.gradeLabel === 'WANTED', 'filled in');
      const rows = briefOf(s, b).flatMap(x => x.rows.map(r => r[0]));
      assert(rows.includes('SEARCH AREA'), 'and its brief still reads (a default search area)');
    },
  },
];
