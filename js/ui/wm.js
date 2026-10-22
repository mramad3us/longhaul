// ============================================================
// LONGHAUL — The console's window manager
//
// The console is the main view (the map and its sister displays) with
// DOCKS on its flanks and FLOATING WINDOWS over it:
//
//   a dock (left, right) holds a stack of PANELS: a header strip with
//     the panel's title and its controls, and a body. A panel collapses
//     to its strip; the dock's width is dragged on its splitter; a panel
//     can be popped out to float and docked back.
//   a floating WINDOW has a title bar (drag it), a resize grip, a close
//     button, and remembers where it was. A click raises it; Esc closes
//     the top one. Windows never end up out of reach (they are clamped
//     into the console on open and on resize).
//
// The game's dialogs (the station window, comms, boarding, the generic
// dialog…) are ADOPTED: their elements become windows, and their own
// modules keep showing and hiding them as before (a mutation observer
// sees them appear and raises them; the title bar's close button calls
// the module's own close).
//
// Layout is a per-viewer convenience, kept in localStorage (wrapped:
// private windows and blocked storage just start from the defaults).
// ============================================================

import { $ } from './dom.js';

const KEY = 'lh.layout.v1';
const MARGIN = 8;
let layout = load();
let layer = null;
let z = 100;
const windows = new Map();        // id → { el, head, body, opts }
const panels = new Map();         // id → { el, head, body, dock, opts, win? }

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch { /* storage blocked: defaults next time */ } }, 250);
}
export function resetLayout() {
  layout = {};
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

export function initWm(layerEl) {
  layer = layerEl;
  window.addEventListener('resize', () => { for (const w of windows.values()) if (visible(w.el)) clamp(w); });
}

const visible = (el) => el.style.display !== 'none' && !el.hidden;
const area = () => layer.getBoundingClientRect();

// ---- FLOATING WINDOWS ----

function chrome(id, title, { closable = true, dockable = false } = {}) {
  const head = document.createElement('div');
  head.className = 'win-head';
  head.innerHTML = `<span class="win-title"></span><span class="win-tools">${dockable ? '<button class="win-btn" data-win="dock" data-tip="Dock it">▣</button>' : ''}${closable ? '<button class="win-btn" data-win="close" data-tip="Close (Esc)">✕</button>' : ''}</span>`;
  head.querySelector('.win-title').textContent = title;
  return head;
}

/**
 * Make a floating window. opts: { title, body (element), w, h, x, y,
 * minW, minH, onClose, closable, resizable, dockable, onDock }.
 * Returns its element; it starts closed.
 */
export function createWindow(id, opts) {
  const el = document.createElement('section');
  el.className = `win ${opts.cls || ''}`;
  el.dataset.win = id;
  el.style.display = 'none';
  const head = chrome(id, opts.title || id, opts);
  const body = document.createElement('div');
  body.className = 'win-body';
  if (opts.body) body.appendChild(opts.body);
  el.append(head, body);
  if (opts.resizable !== false) el.appendChild(grip());
  layer.appendChild(el);
  const w = { el, head, body, opts };
  windows.set(id, w);
  wire(id, w);
  return el;
}

/**
 * Take over an existing element as a window (a dialog overlay the game
 * shows and hides itself). Its first `.dialog-title` (or opts.title) is
 * the title; opts.onClose is what the close button does.
 */
export function adoptWindow(id, el, opts = {}) {
  el.classList.add('win', 'win-adopted');
  el.classList.remove('dialog-overlay');
  el.dataset.win = id;
  const head = chrome(id, opts.title || '', opts);
  el.prepend(head);
  if (opts.resizable !== false) el.appendChild(grip());
  const w = { el, head, body: el, opts };
  windows.set(id, w);
  wire(id, w);
  // The game shows it by style.display: raise it and put it in its place when it appears
  let was = visible(el);
  new MutationObserver(() => {
    const now = visible(el);
    if (now && !was) { place(id, w); raise(w); syncTitle(w); }
    if (now) syncTitle(w);
    was = now;
  }).observe(el, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true });
  return el;
}

/** The window's title: given, or the first title inside its body. */
function syncTitle(w) {
  const t = w.opts.title || w.el.querySelector('.dialog-title, .station-name, .library-title')?.textContent || '';
  const span = w.head.querySelector('.win-title');
  if (span.textContent !== t) span.textContent = t;
}

function grip() {
  const g = document.createElement('div');
  g.className = 'win-grip';
  g.dataset.win = 'resize';
  return g;
}

function wire(id, w) {
  w.el.addEventListener('pointerdown', () => raise(w), true);
  w.head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    drag(e, w, 'move');
  });
  w.head.addEventListener('click', (e) => {
    const b = e.target.closest('[data-win]');
    if (!b) return;
    if (b.dataset.win === 'close') closeWindow(id);
    if (b.dataset.win === 'dock') w.opts.onDock?.();
  });
  w.el.querySelector(':scope > .win-grip')?.addEventListener('pointerdown', (e) => drag(e, w, 'resize'));
}

function raise(w) {
  if (+w.el.style.zIndex === z) return;
  w.el.style.zIndex = String(++z);
  for (const o of windows.values()) o.el.classList.toggle('win-focus', o === w);
}

/** Where a window opens: where it was last, or its default, kept inside the console. */
function place(id, w) {
  const L = layout.win?.[id];
  const A = area();
  const W = L?.w ?? w.opts.w ?? Math.min(720, A.width - 80);
  const H = L?.h ?? w.opts.h ?? null;
  const x = L?.x ?? w.opts.x ?? Math.round((A.width - W) / 2);
  const y = L?.y ?? w.opts.y ?? Math.round(A.height * 0.08);
  Object.assign(w.el.style, { left: `${x}px`, top: `${y}px`, width: `${W}px` });
  w.el.style.height = H ? `${H}px` : '';
  clamp(w);
}

function clamp(w) {
  const A = area();
  const r = w.el.getBoundingClientRect();
  const x = Math.min(Math.max(MARGIN, r.left - A.left), Math.max(MARGIN, A.width - r.width - MARGIN));
  const y = Math.min(Math.max(MARGIN, r.top - A.top), Math.max(MARGIN, A.height - 40));
  w.el.style.left = `${x}px`;
  w.el.style.top = `${y}px`;
  if (r.height > A.height - MARGIN * 2) w.el.style.height = `${A.height - MARGIN * 2}px`;
}

function remember(id, w) {
  const A = area(), r = w.el.getBoundingClientRect();
  (layout.win ||= {})[id] = { x: Math.round(r.left - A.left), y: Math.round(r.top - A.top), w: Math.round(r.width), h: w.el.style.height ? Math.round(r.height) : undefined };
  save();
}

function drag(e, w, how) {
  e.preventDefault();
  const A = area();
  const r = w.el.getBoundingClientRect();
  const sx = e.clientX, sy = e.clientY;
  const id = w.el.dataset.win;
  document.body.classList.add(how === 'move' ? 'wm-moving' : 'wm-resizing');
  const minW = w.opts.minW || 280, minH = w.opts.minH || 160;
  const move = (ev) => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (how === 'move') {
      w.el.style.left = `${Math.min(Math.max(-r.width + 80, r.left - A.left + dx), A.width - 80)}px`;
      w.el.style.top = `${Math.min(Math.max(0, r.top - A.top + dy), A.height - 32)}px`;
    } else {
      w.el.style.width = `${Math.max(minW, r.width + dx)}px`;
      w.el.style.height = `${Math.max(minH, r.height + dy)}px`;
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.classList.remove('wm-moving', 'wm-resizing');
    remember(id, w);
    w.opts.onResize?.();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function openWindow(id) {
  const w = windows.get(id);
  if (!w) return;
  const was = visible(w.el);
  w.el.style.display = '';
  if (!was) { place(id, w); w.el.classList.add('win-in'); requestAnimationFrame(() => w.el.classList.remove('win-in')); }
  raise(w);
  syncTitle(w);
  w.opts.onOpen?.();
}

export function closeWindow(id) {
  const w = windows.get(id);
  if (!w || !visible(w.el)) return false;
  if (w.opts.onClose) { w.opts.onClose(); if (visible(w.el)) w.el.style.display = 'none'; }
  else w.el.style.display = 'none';
  return true;
}

export const isOpen = (id) => { const w = windows.get(id); return !!w && visible(w.el); };
export function toggleWindow(id) { if (isOpen(id)) closeWindow(id); else openWindow(id); }
export const windowBody = (id) => windows.get(id)?.body || null;

/** Close the top-most open window (Esc). Returns whether one was closed. */
export function closeTop() {
  let top = null;
  for (const w of windows.values()) if (visible(w.el) && (!top || +w.el.style.zIndex > +top.el.style.zIndex)) top = w;
  if (!top || top.opts.escape === false) return false;
  return closeWindow(top.el.dataset.win);
}

// ---- DOCKS AND PANELS ----

/**
 * A panel in a dock: { title, body (element), dock: 'left'|'right',
 * weight (share of the dock's height), collapsed, tools (html for the
 * header's right side), popOut (can float) }.
 */
export function createPanel(id, opts) {
  const dock = $(`#dock-${opts.dock}`);
  const el = document.createElement('section');
  el.className = 'panel';
  el.dataset.panel = id;
  const head = document.createElement('div');
  head.className = 'panel-head';
  head.innerHTML = `<button class="panel-toggle" data-tip="Collapse / expand"><span class="panel-caret"></span><span class="pnl-title"></span></button><span class="panel-tools">${opts.tools || ''}${opts.popOut ? '<button class="win-btn" data-panel-act="pop" data-tip="Float it">⧉</button>' : ''}</span>`;
  head.querySelector('.pnl-title').textContent = opts.title;
  const body = document.createElement('div');
  body.className = 'panel-body';
  if (opts.body) body.appendChild(opts.body);
  el.append(head, body);
  dock.appendChild(el);
  const p = { el, head, body, dock: opts.dock, opts };
  panels.set(id, p);
  const st = layout.panel?.[id];
  setCollapsed(id, st?.collapsed ?? !!opts.collapsed, false);
  el.style.flexGrow = String(st?.weight ?? opts.weight ?? 1);
  head.querySelector('.panel-toggle').addEventListener('click', () => setCollapsed(id, !el.classList.contains('collapsed')));
  head.addEventListener('click', (e) => { if (e.target.closest('[data-panel-act="pop"]')) popOut(id); });
  if (st?.floating) requestAnimationFrame(() => popOut(id));
  return { el, head, body };
}

export function setCollapsed(id, on, persist = true) {
  const p = panels.get(id);
  if (!p) return;
  p.el.classList.toggle('collapsed', on);
  if (persist) { ((layout.panel ||= {})[id] ||= {}).collapsed = on; save(); }
  p.opts.onToggle?.(!on);
}

export const panelOpen = (id) => { const p = panels.get(id); return !!p && !p.el.classList.contains('collapsed') && !p.floating; };

/** Float a panel: its body moves into a window; docking it back returns it. */
export function popOut(id) {
  const p = panels.get(id);
  if (!p || p.floating) return;
  if (!p.win) {
    p.win = createWindow(`panel:${id}`, {
      title: p.opts.title, w: p.opts.floatW || 360, h: p.opts.floatH || 420, dockable: true,
      onDock: () => dockBack(id), onClose: () => dockBack(id), onResize: () => p.opts.onToggle?.(true),
    });
  }
  windows.get(`panel:${id}`).body.appendChild(p.body);
  p.el.classList.add('floated');
  p.floating = true;
  openWindow(`panel:${id}`);
  ((layout.panel ||= {})[id] ||= {}).floating = true; save();
  p.opts.onToggle?.(true);
}

export function dockBack(id) {
  const p = panels.get(id);
  if (!p || !p.floating) return;
  p.el.appendChild(p.body);
  p.el.classList.remove('floated');
  p.floating = false;
  const w = windows.get(`panel:${id}`);
  if (w) w.el.style.display = 'none';
  ((layout.panel ||= {})[id] ||= {}).floating = false; save();
  p.opts.onToggle?.(!p.el.classList.contains('collapsed'));
}

/** The splitter between a dock and the main view: drag to set the dock's width. */
export function initSplitter(splitter, dockEl, side, { min = 220, max = 560, def = 300 } = {}) {
  const w = layout.dock?.[side] ?? def;
  dockEl.style.width = `${w}px`;
  if (layout.dock?.[`${side}Hidden`]) dockEl.classList.add('dock-hidden');
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const sx = e.clientX, w0 = dockEl.getBoundingClientRect().width;
    document.body.classList.add('wm-resizing-x');
    const move = (ev) => {
      const dx = side === 'left' ? ev.clientX - sx : sx - ev.clientX;
      dockEl.style.width = `${Math.min(max, Math.max(min, w0 + dx))}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('wm-resizing-x');
      (layout.dock ||= {})[side] = Math.round(dockEl.getBoundingClientRect().width); save();
      window.dispatchEvent(new Event('resize'));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  splitter.addEventListener('dblclick', () => toggleDock(dockEl, side));
}

/** Hide a dock entirely (more map), or bring it back. */
export function toggleDock(dockEl, side) {
  dockEl.classList.toggle('dock-hidden');
  (layout.dock ||= {})[`${side}Hidden`] = dockEl.classList.contains('dock-hidden'); save();
  window.dispatchEvent(new Event('resize'));
}
