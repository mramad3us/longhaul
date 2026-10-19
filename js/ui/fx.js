// ============================================================
// LONGHAUL — Combat effects for the renderers
// The sim reports detonations, intercepts, hits and gunfire as events
// with positions; this keeps a short real-time list of them for the
// tactical display, the solar map and the threat board to draw.
// ============================================================

import { bus } from '../core/events.js';

export const FX_LIFE_MS = { detonation: 2600, intercept: 900, hit: 1600, pdc: 700, strafe: 700 };
const MAX = 200;
const list = [];

export function initFx() {
  bus.on('detonation', (p) => add('detonation', p));
  bus.on('torpedo-intercepted', (p) => add('intercept', p));
  bus.on('torpedo-hit', (p) => add('hit', p));
  bus.on('slug-hit', (p) => add('hit', p));
  bus.on('pdc-fired', (p) => add('pdc', p));
  bus.on('pdc-strafe', (p) => add('strafe', p));
}

function add(kind, p) {
  list.push({ kind, ...p, at: performance.now() });
  if (list.length > MAX) list.shift();
}

/** Live effects (oldest first); each has `age` 0–1 through its lifetime. */
export function fxList() {
  const now = performance.now();
  while (list.length && now - list[0].at > 3000) list.shift();
  for (const f of list) f.age = Math.min(1, (now - f.at) / FX_LIFE_MS[f.kind]);
  return list;
}

export function resetFx() {
  list.length = 0;
}
