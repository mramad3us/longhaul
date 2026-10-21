export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}

export function near(actual, expected, tol, msg = '') {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg} expected ${expected} ± ${tol}, got ${actual}`);
  }
}

export const fmt = (n, d = 1) => Number(n).toFixed(d);

/**
 * Fly the docking at a station from wherever we are (near its gate): ask
 * for a berth, let the docking computer bring us in. Returns minutes taken.
 */
export async function dockHere(s, stationId, advance, maxMin = 400) {
  const D = await import('../js/sim/docking.js');
  const TC = await import('../js/sim/traffic-control.js');
  const r = TC.requestDocking(s, stationId);
  if (!r.ok) throw new Error(`docking refused: ${r.text}`);
  const b = D.beginDocking(s, { kind: 'station', id: stationId }, { mode: 'auto' });
  if (!b.ok) throw new Error(`docking failed: ${b.text}`);
  let t = 0;
  while (t < maxMin && s.dock?.phase !== 'docked') { advance(s, 1); t++; if (s.autopilot?.phase === 'prepare') { const { overrideSecure } = await import('../js/sim/autopilot.js'); overrideSecure(s); } if (globalThis.DBGDOCK && t % 20 === 0) console.log('DBG', t, stationId, s.dock?.phase, s.autopilot?.phase, s.autopilot?.display, s.flight.thrustG.toFixed(3), JSON.stringify(s.autopilot?.plan?.target), s.lost); }
  if (s.dock?.phase !== 'docked') throw new Error(`not docked after ${t} min: ${s.dock?.phase}`);
  return t;
}
