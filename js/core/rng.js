// ============================================================
// LONGHAUL — Random number source
// All sim randomness goes through here so tests can seed it.
// ============================================================

let _next = Math.random;

/** Seed a deterministic generator (mulberry32). Pass null to restore Math.random. */
export function seedRandom(seed) {
  if (seed == null) { _next = Math.random; return; }
  let a = seed >>> 0;
  _next = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const random = () => _next();
export const randRange = (min, max) => min + _next() * (max - min);
export const randInt = (min, max) => Math.floor(min + _next() * (max - min + 1));
export const pick = (arr) => arr[Math.floor(_next() * arr.length)];
export const chance = (p) => _next() < p;

/** Standard normal deviate (Box–Muller). */
export function gaussian() {
  const u = 1 - _next(), v = _next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function weightedPick(items, weightOf = (i) => i.weight) {
  let total = 0;
  for (const it of items) total += weightOf(it);
  let r = _next() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

/** Stable 32-bit hash of a string (for per-entity cosmetic variation). */
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
