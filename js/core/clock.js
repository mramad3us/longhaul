// ============================================================
// LONGHAUL — Game clock
// One integer counter (elapsed game-minutes) is the only time base.
// Calendar values are derived, never stored or advanced separately.
// ============================================================

import { DAY_MIN } from './constants.js';

export function createClock(start = { year: 2351, month: 3, day: 22, hour: 8, minute: 0 }) {
  return { start: { ...start }, minute: 0 };
}

export function simDays(state) {
  return state.clock.minute / DAY_MIN;
}

function startMs(clock) {
  const s = clock.start;
  return Date.UTC(s.year, s.month - 1, s.day, s.hour, s.minute);
}

/** Calendar date/time for the clock's current minute (or `minute` override). */
export function calendar(clock, minute = clock.minute) {
  const d = new Date(startMs(clock) + minute * 60_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

const p2 = (n) => String(n).padStart(2, '0');

export function formatDate(clock, minute) {
  const c = calendar(clock, minute);
  return `${c.year}.${p2(c.month)}.${p2(c.day)}`;
}

export function formatTime(clock, minute) {
  const c = calendar(clock, minute);
  return `${p2(c.hour)}:${p2(c.minute)}`;
}

export function formatStamp(clock, minute) {
  return `${formatDate(clock, minute)} ${formatTime(clock, minute)}`;
}

/** Human duration from game-minutes: "45 min", "3h 20m", "2d 4h". */
export function formatDuration(minutes) {
  if (!isFinite(minutes)) return '—';
  if (minutes < 1) return '< 1 min';
  // (rounded to the unit shown first, then split: 59.6 min is "1h", not "0h 60m"; 23.6 h is "1d", not "0d 24h")
  if (minutes < 59.5) return `${Math.round(minutes)} min`;
  if (minutes < DAY_MIN - 30) {
    const total = Math.round(minutes);
    const h = Math.floor(total / 60), m = total % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const hours = Math.round(minutes / 60);
  const d = Math.floor(hours / 24), h = hours % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}
