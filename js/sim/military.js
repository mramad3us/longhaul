// ============================================================
// LONGHAUL — Military work: what a contractor is sent to do
//
// A captain flying its power's flag (service.js) is offered military
// missions. A command ship (forces.js) posts nothing else for as long as
// its fight lasts; a station of its power (or an independent one) near a
// fight posts them too, now and then (MIL_SHARE of its board). Each is
// issued in the name of one of the power's sub-factions (factions.js) and
// asks a rank (service.js RANK_FOR):
//
//   INTEL    gather intelligence on the enemy's dispositions: a sensor
//            lock inside 300,000 km on COUNT different enemy warships (or
//            a proxy's raiders), held LOCK minutes each. Any rank.
//   HOLD     defend a control point at a war front (conflict.js keeps
//            who holds each): stay within 75,000 km of it for hours while
//            enemy squadrons come at it in waves, with a few of our own
//            warships. The point stays ours if we see it through. Rank 1.
//   STRIKE   destroy a high-value target: an enemy destroyer or frigate on
//            detached duty, a proxy's ringleader, a cell's gunship; it has
//            escorts and it fights back. Only in a war (or on a proxy or
//            an insurgency, whose raiders are fair game). Rank 2. A navy
//            squawks; a proxy's or a cell's runs dark and is named only by
//            its drive signature, when the brief has it (sensors.js).
//   COVERT   a sub-faction's quiet job against a rival inside our own
//            power (politics.js in-fighting): hold a lock on one of the
//            rival's ships for a while without being identified by it. If
//            they make us, it never happened, and our reputation pays.
//            Rank 1.
// Every one is reported back at a port of our power (any of its stations
// or command ships). Pay rises with rank; reputation comes with it.
// ============================================================

import { DAY_MIN } from '../core/constants.js';
import { random, randInt, randRange, pick, weightedPick, chance } from '../core/rng.js';
import { getWorld } from './world.js';
import { createEntity, newSignature } from './entities.js';
import { rollIdentity, CLASSES } from './ship-classes.js';
import { FACTIONS, SUBFACTIONS, subName } from './factions.js';
import { zonePos } from './conflict.js';
import { atWar, enemiesOf } from './politics.js';
import { spawnAgent } from './agents.js';
import { PLAYER, sees } from './combatants.js';
import { REVEAL, identifyHunt, huntNamed } from './sensors.js';
import { proxyIdentity } from './forces.js';
import { flagOf, payFactor, rankOf, rankName, RANK_FOR, addRep } from './service.js';

export const MIL_TYPES = new Set(['INTEL', 'HOLD', 'STRIKE', 'COVERT']);
export const MIL_LABEL = { INTEL: 'MIL · INTELLIGENCE', HOLD: 'MIL · HOLD THE POINT', STRIKE: 'MIL · STRIKE (HVT)', COVERT: 'MIL · COVERT' };
export const MIL_SHARE = 0.15;           // share of a station's board slots near our power's fights
const MIL_REACH_AU = 0.6;                // fights this near a station shape its board
const HVT_SIG_ON_FILE = 0.5;             // share of strikes whose brief carries the target's drive signature
export const HOLD_RADIUS_AU = 0.0005;    // 75,000 km round a control point
export const LOCK_RANGE_AU = 0.002;      // 300,000 km: intelligence and covert locks
const HOLD_AWAY_MAX = 120;               // minutes off the point (after reaching it) before it is given up
const HOLD_WAVES = 4;
const NAVAL = new Set(['standoff', 'blockade', 'skirmish', 'front']);

const distAU = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** The other side of a zone, from our power's point of view ('$proxy' for a proxy's raiders, '$cells' for an insurgency's). */
function enemySide(z, L) {
  if (z.kind === 'proxy') return '$proxy';
  if (z.kind === 'insurgency') return '$cells';
  return z.factions.find(f => f !== L) || null;
}

/** Our power's fights a port can post work for. */
function zonesFor(state, port, L) {
  const zones = state.politics.zones;
  if (port.tags?.command) return zones.filter(z => z.id === port.tags.command.zone);
  if (port.faction !== L && port.faction !== 'independent') return [];
  const now = state.clock.minute;
  return zones.filter(z => z.factions.includes(L) && z.kind !== 'pirates' && distAU(zonePos(z, now), port.pos) <= MIL_REACH_AU);
}

/** Can a port post military work for us at all (and how much of its board)? 1 = all of it. */
export function milShare(state, port) {
  const L = flagOf(state);
  if (!L || !zonesFor(state, port, L).length) return 0;
  return port.tags?.command ? 1 : MIL_SHARE;
}

/** Why we can't sign for this one (null: we can). */
export function milRefusal(state, c) {
  if (flagOf(state) !== c.faction) return `Military work for ${FACTIONS[c.faction].navy} contractors flying its flag.`;
  if (rankOf(state) < (c.rankMin || 0)) return `Needs the rank of ${rankName(state, c.faction, c.rankMin)}.`;
  return null;
}

// ---- GENERATION ----

/** One military mission for a port's board (or null). */
export function generateMil(state, port, id) {
  const L = flagOf(state);
  if (!L) return null;
  const zones = zonesFor(state, port, L);
  if (!zones.length) return null;
  const covert = state.politics.covert.filter(x => x.power === L);
  const options = [];
  for (const z of zones) {
    const E = enemySide(z, L);
    if (!E) continue;
    if (E !== '$cells') options.push({ type: 'INTEL', z, E, w: 3 });     // (an insurgency's cells have no squadron to watch)
    if ((NAVAL.has(z.kind) && atWar(state, L, E)) || E === '$proxy' || E === '$cells') options.push({ type: 'STRIKE', z, E, w: 2 });
    if (z.kind === 'front' && z.points?.some(p => p.held === L)) options.push({ type: 'HOLD', z, E, w: 2.5 });
  }
  if (covert.length) options.push({ type: 'COVERT', cv: pick(covert), w: 1 });
  if (!options.length) return null;
  const o = weightedPick(options, x => x.w);
  const now = state.clock.minute;
  const pay = payFactor(state);
  const base = {
    id, type: o.type, mil: true, faction: L, station: port.id, stationName: port.name, offeredAt: now, phase: 'offered',
    zone: o.z?.id || null, zoneBody: o.z?.body || null,
  };
  const navy = FACTIONS[L].navy;
  switch (o.type) {
    case 'INTEL': {
      const count = randInt(2, 3), lockMin = randInt(10, 20);
      const who = o.E === '$proxy' ? `the ${subName(o.z.sub) || 'proxy'} raiders` : o.E === '$cells' ? `the ${subName(o.z.sub) || 'Belter'} cells' ships` : `${FACTIONS[o.E].navy} warships`;
      const issuer = pick([`${L === 'UN' ? 'un' : L === 'MCR' ? 'mcr' : 'opa'}-intel`, fleetOf(L)].filter(x => SUBFACTIONS[x]));
      return { ...base, enemy: o.E, sub: o.z.sub || null, count, lockMin, tracked: {}, issuer, rankMin: 0, rep: 25,
        title: `Intelligence: ${who} near ${o.z.body}`,
        description: `${subName(issuer) || navy} wants the enemy's dispositions near ${o.z.body}. Put a sensor lock on ${count} different ${who} inside 300,000 km and hold each for ${lockMin} minutes. Then report to any ${FACTIONS[L].short} port.`,
        reward: { credits: Math.round(randInt(5000, 12000) * pay) }, deadline: randInt(2, 5) * DAY_MIN, expires: now + randInt(12, 36) * 60 };
    }
    case 'HOLD': {
      const pt = pick(o.z.points.filter(p => p.held === L));
      const hours = randInt(4, 8);
      return { ...base, enemy: o.E, point: pt.name, pointPhase: pt.phase, zoneR: o.z.r, holdMin: hours * 60, held: 0, away: 0, waves: 0, arrived: false, issuer: fleetOf(L), rankMin: RANK_FOR.hold, rep: 50,
        title: `Hold point ${pt.name} at ${o.z.body}`,
        description: `Control point ${pt.name} at the ${o.z.body} front is ours and ${FACTIONS[o.E].navy} wants it back. Get within 75,000 km of it and stay there ${hours} hours while their squadrons come at it; ${navy} warships hold it with you. Leave it for two hours and it is lost.`,
        reward: { credits: Math.round(randInt(10000, 25000) * pay), pdcRounds: 5000 }, deadline: 2 * DAY_MIN, expires: now + randInt(6, 18) * 60 };
    }
    case 'STRIKE': {
      const ship = o.E === '$proxy' ? rollIdentity({ ...proxyIdentity(o.z.sub), sub: o.z.sub, state })
        : o.E === '$cells' ? rollIdentity({ cls: pick(['opa-gunship', 'opa-corvette']), faction: 'OPA', sub: 'opa-ceres', state })
        : rollIdentity({ kind: pick(['destroyer', 'frigate', 'frigate']), category: 'military', faction: o.E, state });
      const escorts = randInt(1, 2);
      const outlaw = o.E === '$proxy' || o.E === '$cells';
      const who = outlaw ? `the ${subName(ship.sub) || 'raiders'}' ${ship.shipClass}` : `the ${FACTIONS[o.E].navy} ${ship.shipClass}`;
      const signature = chance(HVT_SIG_ON_FILE) ? newSignature() : null;
      return { ...base, enemy: o.E, ship, signature, escorts, body: o.z.body, zoneR: o.z.r, zonePhase: o.z.phase, issuer: fleetOf(L), rankMin: RANK_FOR.strike, rep: 60,
        title: `Strike: ${ship.name}`,
        description: `High-value target: ${who} "${ship.name}", with ${escorts} escort${escorts > 1 ? 's' : ''}, last fixed near ${o.z.body}. Find it and destroy it (its surrender will do). Report to any ${FACTIONS[L].short} port.${signature
          ? ` Its drive signature is on file (${signature}).` : outlaw ? ' It runs dark, and its drive signature is not on file.' : ''}`,
        reward: { credits: Math.round(randInt(12000, 30000) * pay) }, deadline: randInt(3, 6) * DAY_MIN, expires: now + randInt(12, 36) * 60 };
    }
    case 'COVERT': {
      const { sub: client, rival } = o.cv;
      const R = SUBFACTIONS[rival];
      const kind = R.fleet?.military ? 'corvette' : 'courier';
      const ship = rollIdentity({ kind, category: R.fleet?.military ? 'military' : 'civilian', faction: L, sub: rival, state });
      const scanMin = randInt(30, 90);
      const body = port.orbit?.body || port.tags?.command?.body || 'Ceres';
      return { ...base, client, rival, ship, scanMin, scanned: 0, watched: 0, body, distAU: randRange(0.004, 0.02), issuer: client, rankMin: RANK_FOR.covert, rep: 30,
        title: `Covert: watch the ${R.short}`,
        description: `The ${subName(client)} wants eyes on the ${R.name}: their ${ship.shipClass} "${ship.name}" is holding off ${body}. Hold a sensor lock inside 300,000 km for ${scanMin} minutes without being identified (transponder off, keep your distance). If they make you, we never met.`,
        reward: { credits: Math.round(randInt(6000, 14000) * pay) }, deadline: randInt(3, 7) * DAY_MIN, expires: now + randInt(1, 3) * DAY_MIN };
    }
  }
  return null;
}

const fleetOf = (L) => ({ UN: 'unn-fleet', MCR: 'mcrn-fleet', OPA: 'opa-tycho' }[L]);

// ---- ON SIGNING ----

/** Put what a mission needs into the world. */
export function spawnMil(state, c) {
  const world = getWorld(state);
  const now = state.clock.minute;
  const z = state.politics.zones.find(x => x.id === c.zone);
  c.acceptedAt = now;
  if (c.type === 'INTEL') {
    // The enemy's anchor at the zone, for plotting (the squadron holds there)
    const anchor = z && world.get(`anchor-${z.id}`);
    const mark = anchor || world.add(createEntity({ id: world.newId('mark'), name: `Enemy dispositions · ${c.zoneBody}`, type: 'nav', transponder: false,
      orbit: { body: c.zoneBody, r: z?.r ?? 0.005, phase: z?.phase ?? 0, period: 0 }, tags: { contract: c.id } }));
    c.targetId = mark.id; c.targetName = mark.name;
    return;
  }
  if (c.type === 'HOLD') {
    const mark = world.add(createEntity({ id: world.newId('mark'), name: `Control point ${c.point} · ${c.zoneBody}`, type: 'nav', transponder: false,
      orbit: { body: c.zoneBody, r: Math.max(0.003, c.zoneR + 0.006), phase: c.pointPhase, period: 0 }, tags: { contract: c.id } }));
    c.markId = mark.id; c.targetId = mark.id; c.targetName = mark.name;
    c.allies = [];
    for (let i = 0; i < 3; i++) {
      const s = around(mark, 0.0003);
      const e = spawnAgent(state, { role: 'navy', kind: pick(['corvette', 'frigate']), category: 'military', faction: c.faction, pos: s.pos, vel: s.vel,
        home: { kind: 'entity', id: mark.id }, zone: c.zone, enemies: [c.enemy, ...enemiesOf(state, c.faction)], contract: c.id, tags: { contract: c.id } });
      c.allies.push(e.id);
    }
    c.nextWave = null;
    return;
  }
  if (c.type === 'STRIKE') {
    const mark = world.add(createEntity({ id: world.newId('mark'), name: `Last fix: ${c.ship.name}`, type: 'nav', transponder: false,
      orbit: { body: c.body, r: Math.max(0.003, c.zoneR + randRange(0.004, 0.012)), phase: c.zonePhase + randRange(-0.6, 0.6), period: 0 }, tags: { contract: c.id } }));
    const outlaw = c.enemy === '$proxy' || c.enemy === '$cells';
    const enemies = [c.faction];
    const at = around(mark, 0.0004);
    const t = spawnAgent(state, { role: 'navy', cls: c.ship.cls, faction: c.ship.faction, sub: c.ship.sub, name: c.ship.name, pos: at.pos, vel: at.vel, signature: c.signature || undefined,
      home: { kind: 'entity', id: mark.id }, zone: c.zone, enemies, contract: c.id, transponder: !outlaw, tags: { contract: c.id, hvt: true, ...(outlaw ? { wanted: true } : {}) } });
    for (let i = 0; i < c.escorts; i++) {
      const s = around(t, 0.0002);
      const esc = outlaw ? { ...proxyIdentity(c.ship.sub), sub: c.ship.sub } : { kind: 'corvette', category: 'military', faction: c.ship.faction };
      spawnAgent(state, { role: 'navy', ...esc, pos: s.pos, vel: s.vel, home: { kind: 'entity', id: mark.id }, zone: c.zone, enemies, contract: c.id, transponder: !outlaw,
        tags: { contract: c.id, ...(outlaw ? { wanted: true } : {}) } });
    }
    c.markId = mark.id; c.targetId = t.id; c.targetName = t.name;
    return;
  }
  if (c.type === 'COVERT') {
    // A ship of the rival's, holding off the body on rails: it watches whoever comes near
    const orbit = { body: c.body, r: c.distAU, phase: random() * Math.PI * 2, period: 0 };
    const e = world.add(createEntity({ id: world.newId('ship'), name: c.ship.name, type: 'ship', faction: c.ship.faction, cls: c.ship.cls, tl: c.ship.tl,
      shipClass: c.ship.shipClass, mass: c.ship.mass, orbit, tags: { contract: c.id } }));
    e.sub = c.rival;
    c.targetId = e.id; c.targetName = e.name;
  }
}

/** A place and velocity just off an entity (AU). */
function around(e, rAU) {
  const a = random() * Math.PI * 2;
  return { pos: { x: e.pos.x + Math.cos(a) * rAU, y: e.pos.y + Math.sin(a) * rAU }, vel: { vx: e.vel.vx, vy: e.vel.vy } };
}

// ---- PER MINUTE ----

/**
 * A military mission's progress this minute. `fail(reason)` ends it;
 * `done(text)` sends it home to be reported.
 */
export function milProgress(state, c, emit, { fail, done }) {
  if (c.phase !== 'active') return;
  const world = getWorld(state);
  const now = state.clock.minute;
  const us = state.flight.pos;
  const z = c.zone ? state.politics.zones.find(x => x.id === c.zone) : null;
  if (c.zone && !z && c.type !== 'COVERT') { fail('The fighting there is over'); return; }
  switch (c.type) {
    case 'INTEL': {
      const id = state.sensors.locked;
      const t = id && world.get(id);
      if (!t || !isEnemy(c, t) || distAU(t.pos, us) > LOCK_RANGE_AU) return;
      c.tracked[id] = (c.tracked[id] || 0) + 1;
      if (c.tracked[id] === 1) emit('contract-progress', { contract: c, text: `Lock on the ${t.name} — recording its signature` });
      const got = Object.values(c.tracked).filter(m => m >= c.lockMin).length;
      if (c.tracked[id] === c.lockMin) emit('contract-progress', { contract: c, text: `${t.name} logged (${got} of ${c.count})` });
      if (got >= c.count) done(`Intelligence gathered — report to any ${FACTIONS[c.faction].short} port`);
      return;
    }
    case 'HOLD': {
      const mark = world.get(c.markId);
      if (!mark) { fail('The point was lost'); return; }
      const inside = distAU(mark.pos, us) <= HOLD_RADIUS_AU;
      if (inside && !c.arrived) {
        c.arrived = true;
        c.nextWave = now + randInt(30, 60);
        emit('contract-progress', { contract: c, text: `On point ${c.point}. Hold for ${Math.round(c.holdMin / 60)} hours` });
      }
      if (!c.arrived) return;
      if (inside) { c.held++; c.away = 0; } else if (++c.away > HOLD_AWAY_MAX) { fail(`Point ${c.point} abandoned`); losePoint(state, z, c); return; }
      if (c.waves < HOLD_WAVES && now >= c.nextWave) {
        c.waves++;
        c.nextWave = now + randInt(90, 150);
        const n = randInt(2, 3);
        const ang = random() * Math.PI * 2;
        for (let i = 0; i < n; i++) {
          const pos = { x: mark.pos.x + Math.cos(ang) * 0.008 + randRange(-0.0005, 0.0005), y: mark.pos.y + Math.sin(ang) * 0.008 + randRange(-0.0005, 0.0005) };
          spawnAgent(state, { role: 'navy', kind: pick(['corvette', 'corvette', 'frigate', 'destroyer']), category: 'military', faction: c.enemy, pos, vel: { ...mark.vel },
            home: { kind: 'entity', id: mark.id }, zone: c.zone, enemies: [c.faction, ...enemiesOf(state, c.enemy)], contract: c.id, tags: { contract: c.id } });
        }
        emit('contract-progress', { contract: c, text: `${FACTIONS[c.enemy].navy} squadron inbound on point ${c.point}: ${n} ships` });
      }
      if (c.held >= c.holdMin) {
        const pt = z?.points?.find(p => p.name === c.point);
        if (pt) pt.held = c.faction;
        done(`Point ${c.point} held — report to any ${FACTIONS[c.faction].short} port`);
      }
      return;
    }
    case 'STRIKE': {
      const t = world.get(c.targetId);
      if (!t) { fail(`The ${c.targetName} got away`); return; }
      if (identifyHunt(state, c)) emit('contract-progress', { contract: c, text: huntNamed(c) });
      if (t.combat?.status === 'wreck' || t.combat?.status === 'surrendered') done(`${c.targetName} ${t.combat.status === 'wreck' ? 'destroyed' : 'has struck'} — report to any ${FACTIONS[c.faction].short} port`);
      return;
    }
    case 'COVERT': {
      const t = world.get(c.targetId);
      if (!t) { fail('The target is gone'); return; }
      const d = distAU(t.pos, us);
      // They see us, and know who we are: transponder on, or a long enough look
      if (sees(state, t.id, PLAYER)) {
        c.watched++;
        if (state.comms.transponder || c.watched >= REVEAL.PROFILE) {
          addRep(state, -20, `exposed on a covert job for the ${SUBFACTIONS[c.client]?.short}`, emit);
          fail(`The ${c.targetName} made us — the ${SUBFACTIONS[c.client]?.short} never heard of us`);
          return;
        }
      } else c.watched = Math.max(0, c.watched - 2);
      if (state.sensors.locked === t.id && d <= LOCK_RANGE_AU) {
        c.scanned++;
        if (c.scanned === 1) emit('contract-progress', { contract: c, text: `Lock on the ${c.targetName} — stay quiet` });
        if (c.scanned >= c.scanMin) done(`Take on the ${c.targetName} recorded — report to any ${FACTIONS[c.faction].short} port`);
      }
    }
  }
}

/** A ship that counts for an intelligence job: a warship of the enemy power, or the proxy's raiders. */
function isEnemy(c, t) {
  if (t.type !== 'ship' || t.combat?.status === 'wreck') return false;
  if (c.enemy === '$proxy') return !!t.tags?.proxy || (c.sub && t.sub === c.sub);
  if (c.enemy === '$cells') return t.sub === 'opa-ceres';
  const cat = CLASSES[t.cls]?.category;
  return t.faction === c.enemy && (cat === 'military' || cat === 'authority');
}

function losePoint(state, z, c) {
  const pt = z?.points?.find(p => p.name === c.point);
  if (pt && chance(0.7)) pt.held = c.enemy;
}

/** Can this military mission be reported at this port? (Any port of its power: its stations and command ships.) */
export const milTurnIn = (c, port) => c.mil && c.phase === 'return' && !!port && port.faction === c.faction && (port.type === 'station' || !!port.tags?.command);
