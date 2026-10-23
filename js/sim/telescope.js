// ============================================================
// LONGHAUL — The telescope: what our optics can hold, and what they see
//
// Every ship has a telescope on a stabilized mount, part of its sensor
// suite, its mirror sized by tech level (SCOPES). It looks at one thing,
// from where we are. Space is big, and the numbers decide what it shows:
//
// RESOLUTION  A mirror D across resolves 1.22 λ/D (λ 550 nm): 1.3 µrad for
//   TL2's half metre, 13 m at 10,000 km. The mount shakes with the ship's
//   machinery (JITTER_RAD) and far more with the drive lit (per G), which
//   adds to that. A hull many resolution elements long is a shape; a few,
//   a smudge; under one, a point.
// LIGHT  A hull shines by the sunlight it throws back: its area across the
//   line of sight, its paint (HULL_ALBEDO, darker on stealthy hulls), the
//   sun's distance, and the phase (the sun behind us lights the side we
//   see; behind it, we see its night side). A drive plume is a star: a
//   fraction of the jet's power comes out as light (PLUME_W_PER_N of
//   thrust). Flashes: a nuclear or fusion detonation outshines everything
//   in the sky; a torpedo striking home (its speed more than its charge)
//   outshines a drive; a slug's impact, a torpedo shredded by a PDC,
//   briefly (FLASH_W).
// DETECTION  A video frame picks out a point down to MAG_LIMIT (16th
//   magnitude for half a metre of mirror, five more per ten times the
//   diameter, less with the sensors damaged). A cold hull a thousand km
//   off is a bright star; a million km off, in the Belt, it is at the
//   limit or under it, and the frame is black sky.
// LOCK  The mount holds a target in a field a few arcseconds across only on
//   a fine track: the board's fix and the ranging laser on the same mount.
//   That reaches SCOPES.lockKm (cut by damage to the sensors), and only to
//   something the board holds. Past it the telescope has nothing to hold.
// THE CAMERA zooms from its narrowest field (NATIVE_FIELD resolution
//   elements across) out to WIDE_FIELD_RAD, for a ship close by; zoomed
//   out, what it resolves is set by its sensor's pixels (SENSOR_ELEMENTS
//   across the field), not by the mirror (cameraRes).
// FILTERS  The mount carries a line filter for the torch's exhaust (a
//   fusion drive's light is a few emission lines; sunlight off a hull is
//   broadband) and neutral density behind it (FILTERS). PLUME takes a
//   drive down five magnitudes and a hull half of one: a hull beside its
//   own lit drive comes out of the glare; DEEP, nine against one, with the
//   frame darker and noisier. Through our own exhaust (looking aft with
//   the drive lit, AFT_BLIND) the camera is blind without one; with one it
//   sees, degraded: what the plume's plasma lets through, blurred by it
//   and shimmering (ownPlume).
// THE SKY  Planets, moons, asteroids and the Sun are held on the
//   ephemeris, at any range: nothing to lock but where the tables say. A
//   world shines by its albedo (GEOM_ALBEDO) at its phase; its picture is
//   as old as its light (bodySight). A body nearer than the target and
//   across the line of sight hides it (occulter). The Sun takes the solar
//   filter, which the mount puts in by itself, and within SUN_GLARE_RAD
//   of the boresight its scattered light washes the frame (sunOffAxis).
// ============================================================

import { AU_M, G0, DAY_MIN } from '../core/constants.js';
import { getWorld } from './world.js';
import { isTracked } from './sensors.js';
import { sensorRangeFactor } from './systems.js';
import { TECH } from './ship-classes.js';
import { hullOf } from './hulls.js';
import { stationModel } from './stations.js';
import { facingOf } from './docking.js';
import { BODIES, getBody, bodyPos } from './ephemeris.js';

export const WAVELENGTH_M = 550e-9;
export const SCOPES = {
  1: { apertureM: 0.3, lockKm: 400_000 },
  2: { apertureM: 0.5, lockKm: 1_000_000 },
  3: { apertureM: 0.8, lockKm: 1_500_000 },
  4: { apertureM: 1.2, lockKm: 2_000_000 },
};
export const JITTER_RAD = 0.4e-6;          // the mount on a quiet ship
export const BURN_JITTER_RAD = 2e-6;       // …and per G of our own thrust
export const MAG_LIMIT = 16;               // a video frame, half a metre of mirror
export const HULL_ALBEDO = 0.15;
export const PLUME_W_PER_N = 500;          // visible light per newton of a fusion torch's thrust
// Visible light of a flash, averaged over a video frame (W). A torpedo striking home is a tonne
// arriving at some 20 km/s (~2e11 J, more than its charge), brighter than a big ship's drive;
// a slug's impact much less; a torpedo torn apart by a PDC stream, a spark.
export const FLASH_W = { nuclear: 1e15, fusion: 3e15, he: 3e11, kinetic: 2e10, intercept: 1e10 };
export const AFT_BLIND = 0.26;             // rad (15°) round our own drive's axis, with it lit
export const NATIVE_FIELD = 512;           // the camera's narrowest field (full magnification), in resolution elements across
export const WIDE_FIELD_RAD = 0.6;         // its widest (34°): a ship a few km off is degrees across
export const SENSOR_ELEMENTS = 1024;       // zoomed out, the sensor's pixels resolve this many elements across the field
/** The mount's filters: magnitudes taken off a drive's light, a hull's, a flash's; how much of our own exhaust's glare is left. */
export const FILTERS = {
  off: { id: 'off', label: 'OFF', plume: 0, hull: 0, flash: 0, own: 1 },
  plume: { id: 'plume', label: 'PLUME', plume: 5, hull: 0.5, flash: 3, own: 0.45 },
  deep: { id: 'deep', label: 'DEEP', plume: 9, hull: 1.2, flash: 7, own: 0.2 },
};
export const FILTER_ORDER = ['off', 'plume', 'deep'];
export const SUN_GLARE_RAD = 0.17;         // 10°: within this of the boresight the Sun's scattered light washes the frame
// Geometric albedos: what share of sunlight a world throws back at full phase
export const GEOM_ALBEDO = {
  Mercury: 0.14, Venus: 0.69, Earth: 0.43, Luna: 0.12, Mars: 0.17, Phobos: 0.07, Deimos: 0.07,
  Jupiter: 0.54, Io: 0.63, Europa: 0.67, Ganymede: 0.43, Callisto: 0.22,
  Saturn: 0.5, Mimas: 0.96, Enceladus: 1.38, Tethys: 1.23, Dione: 1.0, Rhea: 0.95, Titan: 0.22, Iapetus: 0.6,
  Uranus: 0.49, Neptune: 0.44, Ceres: 0.09, Vesta: 0.42, Pallas: 0.16, Hygiea: 0.07, Juno: 0.24, Interamnia: 0.07,
};

const SUN_MAG = -26.74;                    // the Sun's apparent magnitude from 1 AU
const SOLAR_FLUX = 1361;                   // W/m² at 1 AU
const TORPEDO = { L: 6, W: 0.8 };          // m

/** Our telescope now: { apertureM, resRad, magLimit, lockM, working }. */
export function scopeOf(state) {
  const S = SCOPES[state.ship.tl || 2] || SCOPES[2];
  const perf = sensorRangeFactor(state);
  const g = Math.max(state.flight.thrustG || 0, state.$jinkG || 0);
  const diff = 1.22 * WAVELENGTH_M / S.apertureM;
  const jitter = (JITTER_RAD + g * BURN_JITTER_RAD) / perf;
  return {
    apertureM: S.apertureM, diffRad: diff, resRad: Math.hypot(diff, jitter),
    magLimit: MAG_LIMIT + 5 * Math.log10(S.apertureM / 0.5) + 2.5 * Math.log10(perf),
    lockM: S.lockKm * 1000 * perf, working: !state.reactor?.blackout,
  };
}

/** Lambert sphere phase function: the share of a full disc's light at phase angle α. */
export const lambert = (a) => (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;

/** Apparent magnitude of a sunlit surface: area (m²) across the line of sight, at distM, sunAU from the Sun. */
export function reflectMag(areaM2, albedo, sunAU, distM, phase) {
  const f = albedo * areaM2 * lambert(phase) / (Math.PI * distM * distM * sunAU * sunAU);
  return f > 0 ? SUN_MAG - 2.5 * Math.log10(f) : Infinity;
}

/** Apparent magnitude of a source putting out `watts` of light in every direction, distM away. */
export const pointMag = (watts, distM) => watts > 0 ? SUN_MAG - 2.5 * Math.log10(watts / (4 * Math.PI * distM * distM) / SOLAR_FLUX) : Infinity;

/** A flash of `kind` (FLASH_W) at distM: its magnitude. */
export const flashMag = (kind, distM) => pointMag(FLASH_W[kind] || 0, distM);

/** The shape the telescope sees of an entity: { L, W (m), station } (stations by their size). */
function bodyOf(e) {
  if (e.type === 'ordnance') return { L: TORPEDO.L, W: TORPEDO.W };
  if (e.type === 'station') { const s = stationModel(e.id)?.sizeM || 1000; return { L: s, W: s * 0.6, station: true }; }
  const h = hullOf(e.cls);
  return h ? { L: h.L, W: h.W } : { L: 60, W: 12 };
}

const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/**
 * Can the telescope hold this target? { ok, why ('blind' | 'track' |
 * 'range'), distM, text }. Only a contact the board holds, inside the lock.
 */
export function scopeLock(state, id, sc = scopeOf(state)) {
  if (!sc.working) return { ok: false, why: 'blind', text: 'No power to the sensors' };
  const e = id ? getWorld(state).get(id) : null;
  if (!e || !isTracked(state, id)) return { ok: false, why: 'track', text: 'Not on the board: nothing to point at' };
  const f = state.flight.pos;
  const distM = Math.hypot(e.pos.x - f.x, e.pos.y - f.y) * AU_M;
  if (distM > sc.lockM) return { ok: false, why: 'range', distM, text: `The mount holds a target to ${(sc.lockM / 1e9).toFixed(sc.lockM < 1e9 ? 2 : 1)}M km` };
  return { ok: true, distM };
}

/**
 * What the telescope makes of entity `e` (at `pos`, seen from `from`, both
 * AU): { distM, lagS, bearing, resRad, angRad (its length across the line
 * of sight), elements (that, in resolution elements), hullMag, plumeMag,
 * magLimit, phase, sunRight, noseRight, foreshorten, regime }. `regime`:
 * 'resolved' (a shape), 'blob' (a smudge), 'point', 'plume' (only its
 * drive, the hull lost in the glare or too faint), 'none' (nothing above
 * the noise).
 */
export function sightOf(state, e, pos = e.pos, from = state.flight.pos, sc = scopeOf(state), filter = FILTERS.off) {
  const dx = (pos.x - from.x) * AU_M, dy = (pos.y - from.y) * AU_M;
  const distM = Math.max(1, Math.hypot(dx, dy));
  const bearing = Math.atan2(dy, dx);
  const body = bodyOf(e);
  // the hull's axis against the line of sight: its length shows as L·|sin|, never less than its girth
  const facing = e.type === 'station' ? bearing + Math.PI / 2 : facingOf(e);
  const sinA = Math.abs(Math.sin(facing - bearing));
  const foreshorten = Math.max(sinA, body.W / body.L);
  const angRad = body.L * foreshorten / distM;
  const area = body.L * body.W * sinA + Math.PI / 4 * body.W * body.W * (1 - sinA);
  // phase: at the target, the angle between the Sun and us
  const sunAU = Math.max(0.05, Math.hypot(pos.x, pos.y));
  const toSun = Math.atan2(-pos.y, -pos.x);
  const phase = Math.abs(angDiff(toSun, bearing + Math.PI));
  const stealth = e.type === 'ship' ? TECH[e.tl || 2]?.stealth ?? 1 : 1;
  // (through a filter: a drive's light cut far more than a hull's)
  const hullMag = reflectMag(area, HULL_ALBEDO * stealth, sunAU, distM, phase) + filter.hull;
  const thrustN = (e.thrust || 0) * G0 * (e.mass || 1) * 1000;
  const plumeMag = thrustN > 0 ? pointMag(thrustN * PLUME_W_PER_N, distM) + filter.plume : Infinity;
  const elements = angRad / sc.resRad;
  // (looking along +bearing with the plane's up as up, the screen's right is bearing − 90°)
  const sunRight = Math.sin(bearing - toSun) > 0;
  const noseRight = Math.sin(bearing - facing) > 0;
  // (1: its nose points away from us, so its drive, and the plume, points at us; −1: it points at us)
  const away = Math.cos(facing - bearing);
  const seen = hullMag <= sc.magLimit, lit = plumeMag <= sc.magLimit;
  let regime = elements >= 6 ? 'resolved' : seen && elements >= 1.5 ? 'blob' : seen ? 'point' : lit ? 'plume' : 'none';
  // a lit drive outshines an unresolved hull by magnitudes: the glare is all there is
  if ((regime === 'point' || regime === 'blob') && lit && plumeMag < hullMag - 5) regime = 'plume';
  return { distM, lagS: distM / 299_792_458, bearing, resRad: sc.resRad, resM: sc.resRad * distM, angRad, elements, hullMag, plumeMag, magLimit: sc.magLimit,
    phase, sunRight, noseRight, away, sinA, foreshorten, regime, station: !!body.station };
}

/** What the camera resolves with a field `fieldRad` across: the optics, or zoomed out, its pixels. */
export const cameraRes = (sc, fieldRad) => Math.max(sc.resRad, fieldRad / SENSOR_ELEMENTS);

/** Blinded by our own drive: looking aft (within AFT_BLIND of the exhaust) with it lit. */
export function ownPlumeBlinds(state, bearing) {
  const f = state.flight;
  return (f.thrustG || 0) > 0.01 && Math.abs(angDiff(bearing, (f.facing || 0) + Math.PI)) < AFT_BLIND;
}

/**
 * Looking through our own exhaust: { wash (0–1: the glare left over the
 * frame), see (whether anything shows through), blur (× the resolution),
 * contrast }, or null when it isn't in the way. Unfiltered, blind; with a
 * filter, degraded: deeper filters see more, and darker.
 */
export function ownPlume(state, bearing, filter = FILTERS.off) {
  if (!ownPlumeBlinds(state, bearing)) return null;
  const g = state.flight.thrustG || 0;
  const thick = Math.min(1, 0.55 + 0.25 * g);          // a harder burn, a brighter, denser plume
  const wash = Math.min(0.96, 0.96 * filter.own * (0.7 + 0.3 * thick));
  return { wash, see: filter.own < 1, blur: 1 + 3 * thick * filter.own + 1.5 * thick, contrast: Math.max(0.25, 1 - wash * 0.9) };
}

// ---- THE SKY ----

/** The Sun: angle off the boresight `bearing` from `from` (rad). */
export const sunOffAxis = (from, bearing) => Math.abs(angDiff(Math.atan2(-from.y, -from.x), bearing));

const _bp = { x: 0, y: 0 };

/**
 * What the telescope makes of a world (an ephemeris body) at minute `tm`,
 * from `from`: { body, distM, lagS, bearing, pos (where its light left it),
 * angRad (its diameter), radRad, phase, sunRight, mag, sun }.
 */
export function bodySight(body, tm, from, sc = null) {
  bodyPos(body, tm / DAY_MIN, _bp);
  let distM = Math.max(1, Math.hypot(_bp.x - from.x, _bp.y - from.y) * AU_M);
  // (where it was when the light we see left it)
  const lagS = distM / 299_792_458;
  const pos = bodyPos(body, (tm - lagS / 60) / DAY_MIN, { x: 0, y: 0 });
  distM = Math.max(body.radius * 1000 * 1.0001, Math.hypot(pos.x - from.x, pos.y - from.y) * AU_M);
  const bearing = Math.atan2(pos.y - from.y, pos.x - from.x);
  const R = body.radius * 1000;
  const radRad = Math.asin(Math.min(1, R / distM));
  const sun = body.type === 'star';
  const sunAU = Math.max(0.05, Math.hypot(pos.x, pos.y));
  const toSun = Math.atan2(-pos.y, -pos.x);
  const phase = sun ? 0 : Math.abs(angDiff(toSun, bearing + Math.PI));
  const mag = sun ? -26.74 + 5 * Math.log10(distM / AU_M) : reflectMag(Math.PI * R * R, GEOM_ALBEDO[body.name] ?? 0.15, sunAU, distM, phase);
  return { body, distM, lagS, bearing, pos, angRad: 2 * radRad, radRad, phase, sunRight: Math.sin(bearing - toSun) > 0, mag, sun,
    elements: sc ? 2 * radRad / sc.resRad : null };
}

/** The bodies across a field `fieldRad` wide round `bearing`, from `from`, at `tm`: bodySight each, farthest first. */
export function bodiesInField(tm, from, bearing, fieldRad) {
  const out = [];
  for (const b of BODIES) {
    const v = bodySight(b, tm, from);
    if (Math.abs(angDiff(v.bearing, bearing)) < fieldRad * 0.75 + v.radRad) out.push(v);
  }
  return out.sort((a, b) => b.distM - a.distM);
}

/** A world nearer than `distM` that covers the line of sight `bearing` (the target is behind it), or null. */
export function occulter(tm, from, bearing, distM) {
  for (const b of BODIES) {
    const v = bodySight(b, tm, from);
    if (v.distM < distM && Math.abs(angDiff(v.bearing, bearing)) < v.radRad) return v;
  }
  return null;
}

/** Can the telescope hold this target ({ kind: 'entity' | 'body', id })? As scopeLock; the sky is always held. */
export function lockOn(state, target, sc = scopeOf(state)) {
  if (!target) return { ok: false, why: 'none' };
  if (target.kind === 'body') return sc.working ? (getBody(target.id) ? { ok: true } : { ok: false, why: 'track' }) : { ok: false, why: 'blind', text: 'No power to the sensors' };
  return scopeLock(state, target.id, sc);
}
