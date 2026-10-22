// ============================================================
// LONGHAUL — Crew & rooms: the ship's internal cameras on the console
//
// A camera in every compartment (roomcam.js draws them). The CREW &
// ROOMS panel holds a grid of small feeds, bow to stern; a click on a
// crew member or a machine in a feed selects it (the CONTEXT panel shows
// them: selection.js), a double click (or the feed's ⤢) opens that
// camera in its own window, large; a right click is the compartment's
// own menu (vent it, seal it: selection.js). The feeds are where the crew
// are seen now: there is no cutaway of the ship.
//
// Cost: feeds are drawn only while they can be seen (the panel open, or
// the window), the small ones at a quarter of the frame rate (a camera
// mosaic needn't be smooth), the large one every frame.
// ============================================================

import { $, esc } from './dom.js';
import { ui } from './context.js';
import { RoomCam, camerasFor } from './roomcam.js';
import { createWindow, openWindow, isOpen, windowBody } from './wm.js';

let hooks = {};
let feeds = [];                 // { cam: RoomCam, el, deck }
let big = null;                 // { cam: RoomCam, deck }
let visible = true;
let frame = 0;

export function initCams(h) {
  hooks = h;   // { selectCrew(id), selectTile(tile, deck, x, y), deckMenu(deck, clientX, clientY) }
  const body = document.createElement('div');
  body.className = 'cam-big';
  body.innerHTML = '<canvas class="cam-canvas"></canvas>';
  createWindow('cam', { title: 'CAMERA', body, w: 760, h: 500, minW: 360, minH: 240 });
  const canvas = body.querySelector('canvas');
  big = { cam: new RoomCam(canvas, 0, picks()), deck: 0 };
  canvas.addEventListener('click', (e) => onPick(big.cam, e));
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); hooks.deckMenu?.(big.deck, e.clientX, e.clientY); });
}

const picks = () => ({ selectedCrew: () => ui.selection.crew });

export function setCamsVisible(on) { visible = on; }

/** A new game, or the crew changed: one feed per compartment. */
export function buildCams(state) {
  const grid = $('#cams');
  if (!grid) return;
  grid.innerHTML = '';
  feeds = camerasFor(state).map(c => {
    const el = document.createElement('figure');
    el.className = 'cam-feed';
    el.innerHTML = `<canvas class="cam-canvas"></canvas><figcaption><span>${esc(c.label)}</span><button class="win-btn cam-zoom" title="Open this camera large">⤢</button></figcaption>`;
    grid.appendChild(el);
    const cam = new RoomCam(el.querySelector('canvas'), c.deck, picks());
    el.querySelector('canvas').addEventListener('click', (e) => onPick(cam, e));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); hooks.deckMenu?.(c.deck, e.clientX, e.clientY); });
    el.addEventListener('dblclick', () => enlarge(c));
    el.querySelector('.cam-zoom').addEventListener('click', (e) => { e.stopPropagation(); enlarge(c); });
    return { cam, el, deck: c.deck, label: c.label };
  });
}

function enlarge(c) {
  big.deck = c.deck;
  big.cam.setDeck(c.deck);
  const head = document.querySelector('[data-win="cam"] .win-title');
  if (head) head.textContent = `${c.id} · ${c.label}`;
  openWindow('cam');
}

function onPick(cam, e) {
  const hit = cam.pick(e.clientX, e.clientY);
  if (!hit) return;
  if (hit.kind === 'crew') hooks.selectCrew?.(hit.id);
  else if (hit.kind === 'tile') hooks.selectTile?.(hit.tile, hit.deck, hit.x, hit.y);
}

/** Show a crew member on camera: their compartment's feed, large. */
export function showOnCamera(state, crewId) {
  const m = state.ship.crew.find(x => x.id === crewId);
  if (!m) return;
  const f = feeds.find(x => x.deck === deckOf(state, m.pos.sy));
  if (f) enlarge({ deck: f.deck, id: `CAM-${String(f.deck + 1).padStart(2, '0')}`, label: f.label });
}

function deckOf(state, sy) {
  let y = 0;
  for (let i = 0; i < state.ship.decks.length; i++) {
    const h = state.ship.decks[i].tiles.length;
    if (sy < y + h + 0.5) return i;
    y += h + 1;
  }
  return state.ship.decks.length - 1;
}

export function updateCams(state, alpha) {
  frame++;
  const now = performance.now();
  if (visible && frame % 4 === 0) for (const f of feeds) f.cam.draw(state, alpha, now);
  if (isOpen('cam')) big.cam.draw(state, alpha, now);
}

export { windowBody };
