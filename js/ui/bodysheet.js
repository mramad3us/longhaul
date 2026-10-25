// ============================================================
// LONGHAUL — The sheet on a star, a planet, a moon, a rock
//
// What the ship's library knows of a body, on the CONTEXT panel when it is
// picked: what it is, its orbit, its turn and its day, its ground or cloud
// tops, its air, its field, moons and rings, and a few lines on the place.
// Where the simulation flies a figure (the radius, the pull, the orbit's
// radius and period, the turn, the air's column: ephemeris.js) the sheet
// gives the simulation's, so it agrees with every other display; the rest
// is the reference sheet's (sim/bodyfacts.js), marked where the charts fly
// it otherwise (every orbit a circle in the plane).
//
// A world (sim/worlds.js) adds the space it holds: the edge of planetary
// space, its high orbits (the parking orbit, the stationary orbit if it has
// one), low orbit, its ground control, and its airspaces round the
// equator, each with its controller and spaceport, and where there is a
// stationary orbit, a button to fly to it over that airspace.
// ============================================================

import { AU_M, AU_KM, G0 } from '../core/constants.js';
import { getBody, SUN } from '../sim/ephemeris.js';
import { STAR_FACTS, factsOf } from '../sim/bodyfacts.js';
import { worldOf, airspacesOf, orbitPeriodS, orbitSpeed, solarDayH, controlWords, atmosphere } from '../sim/worlds.js';
import { FACTIONS } from '../sim/factions.js';
import { esc } from './dom.js';

const row = (k, v, cls = '', tip = '') => `<div class="scanner-detail-row"${tip ? ` title="${esc(tip)}"` : ''}><span class="scanner-detail-key">${k}</span><span class="scanner-detail-val scanner-val-wrap ${cls}">${v}</span></div>`;
const head = (k) => `<div class="scanner-detail-sub">${k}</div>`;
const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
/** 6.42×10²³ */
function sci(x, digits = 3) {
  if (!x) return '0';
  const e = Math.floor(Math.log10(Math.abs(x))), m = x / 10 ** e;
  return `${m.toPrecision(digits)}×10${String(e).split('').map(c => SUP[c] ?? c).join('')}`;
}
const n0 = (x) => Math.round(x).toLocaleString();
const km = (m) => `${n0(m / 1000)} km`;
const dist = (m) => m > 0.05 * AU_M ? `${(m / AU_M).toFixed(3)} AU` : km(m);
/** A duration in hours: minutes, hours, days or years, as suits it. */
function dur(h) {
  const a = Math.abs(h);
  if (a < 1) return `${Math.round(a * 60)} min`;
  if (a < 48) return `${a.toFixed(a < 10 ? 2 : 1)} h`;
  if (a < 24 * 700) return `${(a / 24).toFixed(a < 24 * 10 ? 2 : 1)} days`;
  return `${(a / 24 / 365.25).toFixed(2)} years`;
}
const temp = (k) => `${Math.round(k - 273.15)} °C (${Math.round(k)} K)`;
const EARTH_KG = 5.972e24;

/** The sheet on a body by name: HTML rows (the CONTEXT panel's look). */
export function bodySheet(state, name) {
  const b = getBody(name);
  if (!b) return '';
  return b.type === 'star' ? starSheet(b) : planetSheet(state, b);
}

function starSheet(b) {
  const f = STAR_FACTS[b.name] || {};
  const out = [`<div class="ms-desc">${esc(f.desc || '')}</div>`, head('STAR')];
  out.push(row('CLASS', `${f.class} · ${esc(f.classWords || '')}`));
  out.push(row('MASS', `${sci(f.massKg)} kg · ${n0(f.massKg / EARTH_KG)} Earths`));
  out.push(row('RADIUS', km(b.radius * 1000)));
  out.push(row('DENSITY', `${(f.densityKgM3 / 1000).toFixed(2)} g/cm³`));
  out.push(row('LUMINOSITY', `${sci(f.lumW)} W`));
  out.push(row('SURFACE', `${n0(f.teffK)} K (its photosphere)`));
  out.push(row('CORE', `${(f.coreK / 1e6).toFixed(1)} million K`));
  out.push(row('AGE', `${f.ageGyr} billion years`));
  out.push(row('TURN', `${f.equatorialTurnD} days at its equator, ${f.polarTurnD} at its poles`));
  out.push(row('COMPOSITION', esc(f.composition || '')));
  out.push(row('ACTIVITY', esc(f.magnetic || '')));
  out.push(row('PULL', `${(b.gm * 1e9 / (b.radius * 1000) ** 2 / G0).toFixed(1)} G at its surface · escape ${n0(Math.sqrt(2 * b.gm * 1e9 / (b.radius * 1000)) / 1000)} km/s`));
  return out.join('');
}

function planetSheet(state, b) {
  const f = factsOf(b.name) || {};
  const w = worldOf(b);
  const R = b.radius * 1000, GM = b.gm * 1e9, g = GM / (R * R);
  const parent = b.parent || SUN;
  const out = [];
  if (f.desc) out.push(`<div class="ms-desc">${esc(f.desc)}</div>`);
  // ---- what it is
  out.push(head('BODY'));
  const kind = b.type === 'moon' ? `moon of ${b.parent.name}` : b.type === 'asteroid' ? (b.name === 'Ceres' ? 'dwarf planet, the largest body in the Belt' : 'asteroid') : b.atmo?.surfaceKPa == null && b.atmo ? 'giant planet: no solid surface' : 'planet';
  out.push(row('TYPE', kind));
  out.push(row('RADIUS', `${km(R)}${f.shape ? ` · ${f.shape}` : ''}`));
  if (f.massKg) out.push(row('MASS', `${sci(f.massKg)} kg · ${f.massKg / EARTH_KG >= 0.01 ? (f.massKg / EARTH_KG).toFixed(3) : sci(f.massKg / EARTH_KG, 2)} Earths`));
  if (f.densityKgM3) out.push(row('DENSITY', `${(f.densityKgM3 / 1000).toFixed(2)} g/cm³`));
  out.push(row('SURFACE PULL', `${g.toFixed(g < 1 ? 3 : 2)} m/s² · ${(g / G0).toFixed(g / G0 < 0.1 ? 4 : 3)} G${w?.atmo?.giant ? ' (at the 1-bar level)' : ''}`));
  out.push(row('ESCAPE', `${(Math.sqrt(2 * GM / R) / 1000).toFixed(2)} km/s`));
  if (f.albedo != null) out.push(row('ALBEDO', `${f.albedo}`));
  // ---- its orbit (the charts': a circle in the plane)
  out.push(head('ORBIT'));
  const aM = b.a * AU_M, periodH = b.period * 24;
  out.push(row('ROUND', parent === SUN ? 'the Sun' : parent.name));
  out.push(row('DISTANCE', dist(aM)));
  out.push(row('PERIOD', dur(periodH)));
  out.push(row('SPEED', `${(2 * Math.PI * aM / (periodH * 3600) / 1000).toFixed(2)} km/s`));
  if (f.ecc != null) out.push(row('SHAPE', `eccentricity ${f.ecc} · inclination ${f.inclDeg}°`, 'scanner-val-dim', 'The real orbit; the charts fly every orbit as a circle in the plane'));
  const hill = aM * Math.cbrt(GM / (3 * parent.gm * 1e9));
  out.push(row('HILL SPHERE', km(hill), '', 'Where its pull holds a ship against its parent\'s tide'));
  // ---- its turn and its day
  out.push(head('SPIN'));
  const locked = b.type === 'moon';
  out.push(row('TURN', `${dur(Math.abs(b.rotH))}${b.rotH < 0 ? ', backward (retrograde)' : ''}${locked ? ' · one face always to ' + b.parent.name : ''}`));
  out.push(row('DAY', `${dur(solarDayH(b))} sunrise to sunrise`));
  if (f.tiltDeg != null) out.push(row('AXIAL TILT', `${f.tiltDeg}°`));
  // ---- ground or cloud tops
  if (f.tempK) {
    out.push(head(f.tempAt ? 'CLOUD TOPS' : 'SURFACE'));
    out.push(row('TEMPERATURE', `${temp(f.tempK.mean)}${f.tempAt ? ` ${f.tempAt}` : ''}`));
    if (f.tempK.max - f.tempK.min > 5) out.push(row('RANGE', `${Math.round(f.tempK.min - 273.15)} to ${Math.round(f.tempK.max - 273.15)} °C`));
  }
  // ---- the air
  out.push(head('ATMOSPHERE'));
  if (w?.atmo) {
    const a = w.atmo;
    out.push(row('MADE OF', esc(f.air || '—')));
    out.push(row(a.giant ? 'AT ITS RADIUS' : 'GROUND PRESSURE', a.giant ? '1 bar (no ground: the air goes on down)' : `${a.surfacePa >= 1e5 ? `${(a.surfacePa / 1e5).toFixed(a.surfacePa >= 1e6 ? 0 : 2)} bar` : `${(a.surfacePa / 1000).toFixed(2)} kPa`}`));
    out.push(row('DENSITY', `${a.rho0.toPrecision(3)} kg/m³ there (Earth's sea level: 1.22)`));
    out.push(row('SCALE HEIGHT', `${(a.scaleM / 1000).toFixed(1)} km (the air thins by e every scale height up)`));
    out.push(row('ENTRY INTERFACE', `${n0(a.interfaceM / 1000)} km up · ${atmosphere(w, a.interfaceM * 0.6).rho.toPrecision(2)} kg/m³ at ${n0(a.interfaceM * 0.6 / 1000)} km`));
  } else out.push(row('MADE OF', esc(f.air || 'none')));
  // ---- field, moons, rings
  out.push(head('FIELD · MOONS · RINGS'));
  if (f.magnetic) out.push(row('MAGNETIC', esc(f.magnetic)));
  const charted = b.moons?.map(m => m.name) || [];
  out.push(row('MOONS', `${f.moons ?? charted.length}${charted.length ? ` · charted: ${charted.join(', ')}` : ''}`));
  if (f.rings) out.push(row('RINGS', esc(f.rings)));
  // ---- the space a world holds
  if (w) out.push(...worldRows(w));
  return out.join('');
}

function worldRows(w) {
  const out = [head('PLANETARY SPACE')];
  out.push(row('EDGE', `${km(w.wellM)} from its centre: its pull ${0.01} G, half what an RCS pushes. Inside, a ship orbits or holds on its drive: planetary flight`));
  out.push(row('HIGH ORBIT', `the parking orbit, ${km(w.parkM)} out: round in ${dur(orbitPeriodS(w, w.parkM) / 3600)} at ${(orbitSpeed(w, w.parkM) / 1000).toFixed(2)} km/s`, 'scanner-val-accent'));
  out.push(row('STATIONARY', w.sync ? `${km(w.sync)} out: round in a sidereal day, over one ground point` : `none: ${esc(w.syncWhy)}`, w.sync ? 'scanner-val-accent' : 'scanner-val-dim'));
  out.push(row('LOW ORBIT', `${km(w.low[0] - w.R)} to ${km(w.low[1] - w.R)} up: ground control's to clear (not yet)`, 'scanner-val-dim'));
  out.push(row('GROUND CONTROL', controlWords(w)));
  out.push(row('APPROACH', 'no final approach yet: the nav computer keeps out of the air and off the ground', 'scanner-val-dim'));
  const air = airspacesOf(w);
  if (air.length) {
    out.push(head(`AIRSPACES · ${air.length}`));
    for (const a of air) {
      const who = a.authority ? FACTIONS[a.authority]?.short || 'independent' : 'unclaimed';
      const btn = w.sync ? `<button class="route-zoom-btn ms-inline-btn" data-act="orbit-over" data-air="${a.id}" title="Plot a route to the stationary orbit over the ${esc(a.name)} airspace">ORBIT OVER</button>` : '';
      out.push(row(esc(a.name.toUpperCase()), `${esc(a.controller)} · ${who} · ${esc(a.port.name)}${btn}`));
    }
  }
  return out;
}
