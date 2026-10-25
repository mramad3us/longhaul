// ============================================================
// LONGHAUL — Tests: the hull cameras' mounts, and the telescope's zoom steps
//
// Every playable hull gets its four fixed cameras on its own plating: the
// mast cameras over the dorsal plating at their end of the hull, the far
// end of the hull in the lower half of the frame; the flank cameras off
// their flank, a piece of it in the frame. The telescope zooms in steps,
// its widest field halved down to the digital limit, and the computer's
// step is the narrowest that takes in what it frames.
// ============================================================

import { assert, fmt } from './helpers.mjs';
import { PLAYABLE } from '../js/sim/ship-classes.js';
import { hullOf, partExtent } from '../js/sim/hulls.js';
import { SCOPES, WIDE_FIELD_RAD, WAVELENGTH_M, JITTER_RAD } from '../js/sim/telescope.js';
import { HULL_CAMS, mountOf } from '../js/ui/hullcam.js';
import { driveLights, lightK } from '../js/ui/exterior.js';
import { poseMatrix } from '../js/ui/exterior.js';
import { zoomLevels, autoZoom } from '../js/ui/telescope.js';

const HFOV = 80 * Math.PI / 180, ASPECT = 16 / 9;
const VFOV = 2 * Math.atan(Math.tan(HFOV / 2) / ASPECT);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map(v => v / l); };

/** A ship-frame point through a camera (up: the hull's dorsal): [x, y] in the frame's −1…1, or null behind it. */
function project(cam, p) {
  const f = norm(cam.dir), r = norm(cross(f, [0, 0, 1])), u = cross(r, f);
  const v = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
  const z = dot(v, f);
  if (z <= 0) return null;
  return [dot(v, r) / z / Math.tan(HFOV / 2), dot(v, u) / z / Math.tan(VFOV / 2)];
}
const inFrame = (q) => !!q && Math.abs(q[0]) <= 1 && Math.abs(q[1]) <= 1;
/** Is a point inside any of the hull's parts' boxes? */
const insideHull = (hull, p) => hull.parts.some(part => { const e = partExtent(part); return p[0] > e.x0 && p[0] < e.x1 && p[1] > e.y0 && p[1] < e.y1 && p[2] > e.z0 && p[2] < e.z1; });

export default [
  {
    name: 'every playable hull has its four cameras on its own plating, outside it, a piece of the ship in each frame',
    fn: () => {
      const rows = [];
      for (const id of PLAYABLE) {
        const hull = hullOf(id), b = hull.bounds, L = b.x1 - b.x0;
        const cams = Object.fromEntries(HULL_CAMS.map(c => [c.id, mountOf(hull, c.id, VFOV)]));
        for (const [cid, cam] of Object.entries(cams)) {
          assert(Math.abs(Math.hypot(...cam.dir) - 1) < 1e-9, `${id} ${cid}: a unit look`);
          assert(!insideHull(hull, cam.pos), `${id} ${cid}: the camera sits outside the hull, not inside a part (${cam.pos.map(v => v.toFixed(1))})`);
          assert(cam.pos[0] >= b.x0 && cam.pos[0] <= b.x1, `${id} ${cid}: along the hull's length`);
        }
        // the mast cameras: over the dorsal plating, the far end of the hull in the lower half of the frame
        const bow = project(cams.fwd, [b.x1 - 0.02 * L, 0, b.z1 * 0.5]);
        const stern = project(cams.aft, [b.x0 + 0.02 * L, 0, b.z1 * 0.5]);
        assert(cams.fwd.dir[0] > 0.8 && cams.aft.dir[0] < -0.8, `${id}: FWD looks forward, AFT aft`);
        assert(inFrame(bow) && bow[1] < 0 && inFrame(stern) && stern[1] < 0, `${id}: the bow in FWD's frame, the stern in AFT's, below the middle (${bow?.map(v => v.toFixed(2))}, ${stern?.map(v => v.toFixed(2))})`);
        // the flank cameras: off their own side, the flank ahead of them in the frame
        assert(cams.port.pos[1] < b.y0 + 0.01 && cams.stbd.pos[1] > b.y1 - 0.01 || cams.port.pos[1] < 0 && cams.stbd.pos[1] > 0, `${id}: PORT off y−, STBD off y+`);
        for (const side of ['port', 'stbd']) {
          const cam = cams[side], s = side === 'port' ? -1 : 1;
          const flank = project(cam, [b.x1 - 0.1 * L, s * hull.W * 0.4, 0]);
          assert(inFrame(flank), `${id} ${side}: the flank toward the bow in the frame (${flank?.map(v => v.toFixed(2))})`);
        }
        rows.push(`${id} ${fmt(L, 0)} m: FWD at x ${fmt(cams.fwd.pos[0], 0)}, z ${fmt(cams.fwd.pos[2], 1)} · bow in frame at ${bow[1].toFixed(2)} · flank cams ${fmt(Math.abs(cams.port.pos[1]), 1)} m out`);
      }
      console.log(rows.map(r => `      ${r}`).join('\n'));
    },
  },
  {
    name: 'the telescope zooms in steps: its widest field halved to the digital limit; the computer picks the narrowest step that frames what it holds',
    fn: () => {
      const rows = [];
      for (const [tl, S] of Object.entries(SCOPES)) {
        // (the resolution scopeOf gives on a quiet ship)
        const sc = { ...S, resRad: Math.hypot(1.22 * WAVELENGTH_M / S.apertureM, JITTER_RAD) };
        const lv = zoomLevels(sc);
        assert(lv[0] === WIDE_FIELD_RAD, 'the widest first');
        for (let i = 1; i < lv.length - 1; i++) assert(Math.abs(lv[i - 1] / lv[i] - 2) < 1e-9, 'each step halves the field');
        assert(lv.at(-2) / lv.at(-1) <= 2 + 1e-9 && lv.at(-1) < lv.at(-2), 'the last step the digital limit');
        // a hull 0.01 rad across wants 0.01 / 0.55 of field: the step that takes it in, and the next narrower doesn't
        const want = 0.01 / 0.55, i = autoZoom(lv, want);
        assert(lv[i] >= want && (i === lv.length - 1 || lv[i + 1] < want), `auto: ${lv[i]} takes in ${want}, the next step doesn't`);
        assert(autoZoom(lv, 2) === 0 && autoZoom(lv, 1e-12) === lv.length - 1, 'too big for the widest: the widest; a point: the narrowest');
        rows.push(`TL${tl}: ${lv.length} steps, ${fmt(lv[0] * 180 / Math.PI, 0)}° to ${fmt(lv.at(-1) * 206265, 1)}″ (×${Math.round(lv[0] / lv.at(-1)).toLocaleString()})`);
      }
      console.log(`      ${rows.join(' · ')}`);
    },
  },
  {
    name: 'a lit drive through a lens with no filter: as bright as the telescope reckons it, its glare as far as its light against the Sun\'s; seen past its bow, a sixth of it from the jet beyond the hull',
    fn: () => {
      const hull = hullOf('freighter');
      const o = (facing) => ({ kind: 'hull', id: 'f', model: hull, plume: 1, massKg: 40_000_000, m: poseMatrix({ mx: 5000, my: 0, mz: 0, facing, view: 'top' }) });
      // side on, at 5 km in 1 AU's sunlight: 40,000 t at 1 G throws 625 W a square metre, near half the Sun's
      const side = driveLights([o(Math.PI / 2)], () => [0, 0, 0], 1)[0];
      const k = lightK(40_000_000 * 9.80665 * 500, side.d, 1);
      assert(Math.abs(side.k - k) < 1e-9 && side.k > 0.6 && side.k < 0.75 && side.direct === 1, `side on: ${fmt(side.k, 2)} × the Sun's glare, throat in sight`);
      // its nose toward us: its hull between us and its throat
      const bow = driveLights([o(Math.PI)], () => [0, 0, 0], 1)[0];
      assert(bow.direct === 0 && bow.k < side.k * 0.45 && bow.k > side.k * 0.3, `past its bow: ${fmt(bow.k, 2)}, no spikes`);
      // looking up its jet, the throat in sight; at 1.5 AU the Sun's own fainter, the drive's glare the larger
      const up = driveLights([o(0)], () => [0, 0, 0], 1.5)[0];
      assert(up.direct === 1 && up.k > side.k * 1.3, `up its jet from Mars' distance: ${fmt(up.k, 2)}`);
      const none = driveLights([{ ...o(0), plume: 0 }], () => [0, 0, 0], 1);
      assert(!none.length, 'a cold drive: nothing');
      console.log(`      a 40,000 t hull at 1 G, 5 km off: ${fmt(side.k, 2)} × the Sun's glare side on, ${fmt(bow.k, 2)} past its bow, ${fmt(up.k, 2)} up its jet from 1.5 AU`);
    },
  },
];
