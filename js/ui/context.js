// ============================================================
// LONGHAUL — Shared UI context
// The one place UI modules find the live game, the loop, the user's
// settings and the current selection. Sim state never lives here.
// ============================================================

export const ui = {
  state: null,        // live game state (sim)
  loop: null,         // GameLoop
  alpha: 1,           // render interpolation within the current minute
  screen: 'landing',
  settings: {
    autosaveMinutes: 5,
    showPerf: false,
    devMode: false,
    reduceMotion: false,
    confirmBurns: true,
  },
  selection: { crew: null, tile: null },   // crew id | { tile, deck, x, y }
  nav: { open: false, tab: 'tactical', tacZoom: 0, modalZoom: 0, target: null },
  pausedForDialog: false,
};

export const inGame = () => ui.screen === 'game' && ui.state != null;
