// ============================================================
// LONGHAUL — The console: what goes where on the flight deck's screen
//
// The main view is the ship's displays (the system, local space, the
// scanner, weapons, the exterior cameras: nav.js), under their tab bar and
// the flight band (what the ship is doing, what wants an answer, the
// latest messages: a line of the layout, so nothing floats over the
// display but the card for what is picked on it). Around it:
//
//   LEFT DOCK    SHIP: what the ship is doing and what it has (drive,
//                attitude, the reference velocity, hull, systems, stores)
//                CREW & ROOMS: a camera in every compartment (roomcam.js)
//   RIGHT DOCK   CONTEXT: whatever is selected (a body, a station, a
//                contact, a report, a crew member, a machine)
//                ROUTE: the planner and the route under way
//   BOTTOM       the ship's AI (advisor.js): one line, with the thing to
//                do about it; the radio; the log, which opens as a drawer
//   WINDOWS      everything else floats (wm.js): engineering, the roster,
//                missions, comms, a station, boarding, the library, the
//                service record, an enlarged camera, the exterior cameras
//                (with their bar) when they are pulled out of the main view.
//
// Panels and windows are laid out by the viewer and remembered (wm.js);
// none of this touches the simulation.
// ============================================================

import { $, show, toggleClass } from './dom.js';
import { ui } from './context.js';
import { setLogExpanded } from './log.js';
import {
  initWm, createPanel, createWindow, adoptWindow, openWindow, closeWindow, isOpen, setCollapsed, panelOpen,
  initSplitter, closeTop,
} from './wm.js';

let hooks = {};
let exteriorFloating = false;

export function initConsole(h) {
  hooks = h;   // { closeDialog(id), closeComms(), closeBoarding(), closeShuttle(), closeLibrary(), closeStation(), onExteriorPlaced() }
  initWm($('#wm-layer'));
  const stash = (id) => { const n = $(id); n.remove(); n.removeAttribute('id'); return n; };

  createPanel('ship', { dock: 'left', title: 'SHIP', body: stash('#panel-ship-body'), fit: true, popOut: true });
  createPanel('rooms', { dock: 'left', title: 'CREW & ROOMS', body: stash('#panel-rooms-body'), weight: 1, popOut: true, floatW: 560, floatH: 420,
    onToggle: (on) => hooks.roomsVisible?.(on) });
  const dev = $('#panel-dev-body');
  createPanel('dev', { dock: 'left', title: 'DEV', body: stash('#panel-dev-body'), weight: 0.6, collapsed: true });
  dev.closest('.panel')?.classList.add('dev-only');

  createPanel('context', { dock: 'right', title: 'CONTEXT', body: stash('#panel-context-body'), weight: 1.4, popOut: true });
  createPanel('route', { dock: 'right', title: 'ROUTE', body: stash('#panel-route-body'), fit: true, popOut: true });

  initSplitter($('#split-left'), $('#dock-left'), 'left', { def: 300 });
  initSplitter($('#split-right'), $('#dock-right'), 'right', { def: 340 });

  // The game's own dialogs float as windows
  adoptWindow('generic', $('#dialog-generic'), { onClose: () => hooks.closeDialog?.('#dialog-generic'), w: 640 });
  adoptWindow('event', $('#dialog-event'), { onClose: () => hooks.closeDialog?.('#dialog-event'), w: 560, escape: false });
  adoptWindow('station', $('#dialog-station'), { onClose: () => hooks.closeDialog?.('#dialog-station'), w: 760, h: 640 });
  adoptWindow('comms', $('#dialog-comms'), { onClose: () => hooks.closeComms?.(), title: 'COMMS', w: 900, h: 600 });
  adoptWindow('boarding', $('#dialog-boarding'), { onClose: () => hooks.closeBoarding?.(), title: 'BOARDING', w: 640 });
  adoptWindow('shuttle', $('#dialog-shuttle'), { onClose: () => hooks.closeShuttle?.(), title: 'SHUTTLES', w: 700 });
  adoptWindow('markets', $('#dialog-markets'), { onClose: () => hooks.closeMarkets?.(), title: 'MARKETS', w: 1080, h: 640 });
  adoptWindow('library', $('#library'), { onClose: () => hooks.closeLibrary?.(), title: "SHIP'S LIBRARY", w: 980, h: 640 });
  $('#wm-layer').appendChild($('#library'));

  // The exterior cameras, pulled out of the main view
  createWindow('exterior', { title: 'EXTERIOR CAMERAS', w: 640, h: 460, dockable: true, onDock: () => setExteriorFloating(false), onClose: () => setExteriorFloating(false),
    onResize: () => window.dispatchEvent(new Event('resize')) });
  $('#exterior-float').addEventListener('click', () => setExteriorFloating(true));

  // The log drawer
  $('#log-expand-btn').addEventListener('click', () => toggleLog());
}

export function toggleLog(on = !$('#log-container').classList.contains('open')) {
  toggleClass($('#log-container'), 'open', on);
  toggleClass($('#log-expand-btn'), 'active', on);
  setLogExpanded(on);
}

/** The exterior cameras in their own window (true) or in the main view's EXTERIOR display. */
export function setExteriorFloating(on) {
  if (on === exteriorFloating) return;
  exteriorFloating = on;
  const host = on ? document.querySelector('[data-win="exterior"] .win-body') : $('#mv-exterior');
  host.append($('#cam-deck'));
  if (on) openWindow('exterior'); else closeWindow('exterior');
  toggleClass($('#mv-tab-exterior'), 'floated', on);
  hooks.onExteriorPlaced?.(on);
  window.dispatchEvent(new Event('resize'));
}
export const exteriorIsFloating = () => exteriorFloating;

/** Esc: the top window first. */
export const closeTopWindow = () => closeTop();

export { openWindow, closeWindow, isOpen, setCollapsed, panelOpen, show };
export const showPanel = (id) => setCollapsed(id, false);
export const consoleUi = () => ui;
