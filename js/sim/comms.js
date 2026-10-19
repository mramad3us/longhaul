// ============================================================
// LONGHAUL — Communications
// Radio contacts, transponder, distress beacons, hail dialogue.
// ============================================================

import { RANGE } from '../core/constants.js';
import { hashString } from '../core/rng.js';
import { getWorld } from './world.js';
import { radioRangeFactor } from './systems.js';
import { CLASSES } from './ship-classes.js';

export function createComms() {
  return {
    transponder: true,
    sos: false,
    sosAuto: false,          // SOS raised automatically by a blackout
    autoSosOnBlackout: true,
    radio: [],               // nearest entity ids in radio range (≤ 60, refreshed every 5 min)
    radioTotal: 0,
    heard: {},               // entity id → minute a distress call was last logged
    requests: [],            // open demands on us: inspections, pirate ultimatums, warnings, surrenders (agents.js)
    nextRequest: 1,
  };
}

const _q = [];
const RADIO_LIST = 60;

/** The k smallest by key, sorted — O(n·log k) with a bounded max-heap. */
function nearest(items, k, key) {
  if (k <= 0) return [];
  if (items.length <= k) return items.sort((a, b) => key(a) - key(b));
  const heap = [];   // max-heap of [key, item]
  const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] >= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const down = (i) => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] > heap[m][0]) m = l; if (r < heap.length && heap[r][0] > heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } };
  for (const it of items) {
    const kv = key(it);
    if (heap.length < k) { heap.push([kv, it]); up(heap.length - 1); }
    else if (kv < heap[0][0]) { heap[0] = [kv, it]; down(0); }
  }
  return heap.sort((a, b) => a[0] - b[0]).map(x => x[1]);
}

/** Per-minute: radio contacts, distress calls heard, auto-SOS. */
export function commsTick(state, emit = () => {}) {
  const c = state.comms;
  const world = getWorld(state);
  const pos = state.flight.pos;
  const now = state.clock.minute;

  // The array's condition sets how far we can talk and listen
  const reach = radioRangeFactor(state);

  // Radio roster: refreshed every few minutes, nearest first, capped for the UI
  if (now % 5 === 0 || !c.radio.length) {
    _q.length = 0;
    if (reach > 0) world.query(pos, RANGE.RADIO * reach, _q);
    // Stations and beacons always listed; then the nearest ships (bounded partial selection)
    const top = [];
    const others = [];
    for (const e of _q) {
      if (e.type === 'nav' || !(e.transponder || e.sos || e.type === 'station')) continue;
      if (e.type === 'station' || e.sos) top.push(e); else others.push(e);
    }
    const d2 = (e) => (e.pos.x - pos.x) ** 2 + (e.pos.y - pos.y) ** 2;
    top.sort((a, b) => d2(a) - d2(b));
    c.radio = [...top, ...nearest(others, Math.max(0, RADIO_LIST - top.length), d2)].map(e => e.id);
    c.radioTotal = top.length + others.length;
  }

  const blackout = state.reactor.blackout;
  if (blackout && c.autoSosOnBlackout && !c.sos) { c.sos = true; c.sosAuto = true; emit('sos-auto', {}); }
  if (!blackout && c.sosAuto) { c.sos = false; c.sosAuto = false; }

  const r2 = (RANGE.SOS * reach) ** 2;
  for (const e of world.beacons) {
    if ((e.pos.x - pos.x) ** 2 + (e.pos.y - pos.y) ** 2 > r2) continue;
    if (now - (c.heard[e.id] ?? -Infinity) < 120) continue;
    c.heard[e.id] = now;
    emit('sos-heard', { entity: e, distanceAU: Math.hypot(e.pos.x - pos.x, e.pos.y - pos.y) });
  }
  // forget stale entries so this map can't grow without bound
  if (now % 1440 === 0) for (const id of Object.keys(c.heard)) if (now - c.heard[id] > 2880 || !world.get(id)) delete c.heard[id];
}

export function toggleTransponder(state) {
  state.comms.transponder = !state.comms.transponder;
  return state.comms.transponder;
}

export function toggleSOS(state) {
  const c = state.comms;
  c.sos = !c.sos;
  c.sosAuto = false;
  return c.sos;
}

/** Signal strength 1..5 for a contact at distAU. */
export function signalBars(distAU) {
  return Math.max(1, Math.min(5, Math.round((1 - distAU / RANGE.RADIO) * 5)));
}

/** Can we transmit at all? (array working, ship powered) */
export const canTransmit = (state) => radioRangeFactor(state) > 0;

// ---- HAIL DIALOGUE ----

const HAIL = {
  'station:OPA': [
    'Static crackles, then a voice — low, Belter-accented, unhurried. The station operator asks your business. Behind it, the hum of spin gravity and distant welding.',
    'A long pause. Then a clipped voice, suspicious: "State your registry and purpose, inyalowda." The OPA dock controller waits.',
    'The channel opens with a burst of Belter patois, then switches to accented English. "Hoy, kopeng. What brings you to our rock?"',
  ],
  'station:UN': [
    'The response is immediate and professional. A UN traffic controller reads back your transponder ident and requests your approach vector.',
    'After an authentication handshake, a crisp voice: "Copy your hail. State your business and stand by for traffic routing."',
  ],
  'station:MCR': [
    'A Martian operator responds with clipped efficiency, checks your transponder against their database, then asks your purpose. Everything by the book.',
    'The channel clicks open. "MCRN traffic control. We have your ident. Transmit docking credentials or state the nature of your approach."',
  ],
  'station:independent': [
    'The operator responds after a delay, neutral and businesslike. "Receiving your hail. How can we assist?"',
    'A slightly bored voice: "Go ahead with your traffic."',
  ],
  'navy:MCR': [
    'The Martian warship answers with cold precision. An officer asks — in a tone more command than question — why you are hailing a Congressional Republic Navy vessel.',
    'Tight-beam, encrypted. A weapons officer: "We read your transponder. Keep your distance and state your intent." You can almost hear the targeting computers spin up.',
  ],
  'navy:UN': [
    'A UN Navy comms officer answers with practiced formality, confirms your position and registry, then asks your purpose in a way that suggests they already know.',
    '"UN Naval vessel acknowledging your hail. What is the nature of your communication?"',
  ],
  'navy:OPA': [
    'A gruff voice over a noisy channel — the gunship\'s bridge sounds crowded. "OPA vessel. Keep your hands off your weapons board and we\'ll get along fine, kopeng."',
  ],
  police: [
    'A patrol officer answers with practiced boredom, reads your registry back to you and asks where you are headed.',
    '"Patrol vessel receiving. Keep your transponder on and your nose clean, and we have no business with you."',
  ],
  pirate: [
    'A laugh, then a voice with no name: "You lost, friend? Or are you shopping?"',
    'Static, then a flat voice: "Keep talking. We\'re measuring you for a cargo net."',
  ],
  surrendered: [
    'A shaky voice: "We\'re not resisting. Drive\'s cold, tubes are open. Whatever you want."',
  ],
  'ship:OPA': [
    'Background noise — someone arguing, cut off. A wary voice: "Yeah, we hear you. What do you want, ke?"',
    'A rough Belter voice: "Hoy. You hailing us? Better be worth the juice on this antenna."',
    'After a long silence, a voice heavy with the bone-deep weariness of too many hours in the black. "Go ahead. We\'re listening."',
  ],
  'ship:independent': [
    'A neutral voice: "Receiving you. Go ahead with your traffic."',
    'Someone answers, distracted — sounds like they were running diagnostics. "Yeah, we\'re here. What do you need?"',
    'A cautious voice through static. "We read you. Not much to trade, but we can talk."',
  ],
};

/** Which set of lines a ship answers with: its service first, then its flag. */
function hailKey(e) {
  if (e.type === 'station') return `station:${e.faction}`;
  if (e.combat?.status === 'surrendered') return 'surrendered';
  const cat = CLASSES[e.cls]?.category;
  if (e.faction === 'pirate' || cat === 'irregular') return 'pirate';
  if (cat === 'military') return `navy:${e.faction}`;
  if (cat === 'authority') return 'police';
  return `ship:${e.faction}`;
}

export function hailDialogue(entity) {
  if (!entity) return 'No response on this channel.';
  if (entity.tags?.wreck) return 'Nothing on any band. The hulk tumbles slowly, venting the last of its air.';
  if (!entity.transponder && !entity.sos) return 'The channel stays dead. If anyone is aboard, they are not answering.';
  const lines = HAIL[hailKey(entity)] || HAIL[`${entity.type}:independent`] || HAIL['ship:independent'];
  return lines[hashString(entity.id) % lines.length];
}
