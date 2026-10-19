// ============================================================
// LONGHAUL — Duty roster
// Three eight-hour watches. Each crew member has a station and a watch:
// eight hours on station, eight off (meals, the head, the exercise rig,
// company), eight asleep. A small crew can't cover every station round
// the clock — what to cover, and when, is the captain's call.
// ============================================================

export const STATIONS = {
  helm: {
    label: 'Helm', fixture: 'helm', seat: true, skill: 'piloting',
    desc: 'A pilot at the controls. If the flight computer fails they take over at once; nobody on watch means the ship coasts until someone gets there.',
  },
  ops: {
    label: 'Ops', fixture: 'ops', seat: true, skill: 'security',
    desc: 'Sensors and comms. Contacts are identified twice as fast, range is longer, and debris is often spotted in time to dodge.',
  },
  engineering: {
    label: 'Engineering', fixture: 'engStation', seat: true, skill: 'engineering',
    desc: 'Watches the drive, reactor and plant. Faults are caught early (40% fewer breakdowns); does maintenance rounds.',
  },
  workshop: {
    label: 'Machine shop', fixture: 'workbench', seat: false, skill: 'engineering',
    desc: 'Maintenance and repairs, and refurbishing scrap into spare parts.',
  },
  medbay: {
    label: 'Sick bay', fixture: 'medbay', seat: false, skill: 'medical',
    desc: 'A medic beside the autodoc: treatment 50% faster, first aid on hand.',
  },
  galley: {
    label: 'Galley', fixture: 'galley', seat: false, skill: null,
    desc: 'Hot meals, cooked to order. Good food is the cheapest morale on any ship.',
  },
};

export const STATION_IDS = Object.keys(STATIONS);

export const SHIFTS = [
  { label: '00–08', start: 0 },
  { label: '08–16', start: 8 },
  { label: '16–24', start: 16 },
];

/** Station and watch each role is given by default. */
const DEFAULT_DUTY = {
  Captain: ['helm', 2], Pilot: ['helm', 1], Engineer: ['engineering', 1], Medic: ['medbay', 1],
  Gunner: ['ops', 0], Mechanic: ['workshop', 2], Scientist: ['ops', 2], Cook: ['galley', 1],
};

export function defaultDuty(role) {
  const [station, shift] = DEFAULT_DUTY[role] || ['none', 1];
  return { station, shift };
}

/** Ship's clock: minute of the day (0–1439). */
export function minuteOfDay(state, minute = state.clock.minute) {
  const s = state.clock.start;
  return (((s.hour * 60 + s.minute + minute) % 1440) + 1440) % 1440;
}

/**
 * Where someone's day is at: 'duty' (eight hours from the watch start),
 * then 'free', then 'sleep' before the next watch.
 */
export function scheduleBlock(state, m, minute = state.clock.minute) {
  const rel = ((minuteOfDay(state, minute) - SHIFTS[m.duty.shift].start * 60) % 1440 + 1440) % 1440;
  if (rel < 480) return m.duty.station === 'none' ? 'free' : 'duty';
  return rel < 960 ? 'free' : 'sleep';
}

/** Minutes until the current block ends. */
export function minutesLeftInBlock(state, m) {
  const rel = ((minuteOfDay(state) - SHIFTS[m.duty.shift].start * 60) % 1440 + 1440) % 1440;
  return 480 - (rel % 480);
}

/** Crew scheduled on a station during a given watch. */
export function rostered(state, station, shift) {
  return state.ship.crew.filter(m => !m.dead && m.duty.station === station && m.duty.shift === shift);
}

/** Which watch is on now (0–2). */
export const currentShift = (state) => Math.floor(minuteOfDay(state) / 480);

export function setDuty(state, m, station, shift) {
  if (station != null && (station === 'none' || STATIONS[station])) m.duty.station = station;
  if (shift != null && SHIFTS[shift]) m.duty.shift = shift;
}
