// ============================================================
// LONGHAUL — DOM helpers & display formatting
// ============================================================

import { AU_KM } from '../core/constants.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const _text = new WeakMap();

/** Set textContent only when it changed (cheap per-frame updates). */
export function setText(el, value) {
  if (!el) return;
  const v = String(value);
  if (_text.get(el) === v) return;
  _text.set(el, v);
  el.textContent = v;
}

const _html = new WeakMap();

/** Set innerHTML only when it changed. Returns true if the DOM was rewritten. */
export function setHTML(el, html) {
  if (!el || _html.get(el) === html) return false;
  _html.set(el, html);
  el.innerHTML = html;
  return true;
}

export function show(el, visible = true, display = '') {
  if (!el) return;
  const want = visible ? display : 'none';
  if (el.style.display !== want) el.style.display = want;
}

export function toggleClass(el, cls, on) {
  if (el && el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

// ---- FORMATTERS ----

export function fmtSpeed(ms) {
  const a = Math.abs(ms);
  if (!isFinite(a)) return '—';
  if (a < 10) return `${a.toFixed(1)} m/s`;
  if (a < 1000) return `${Math.round(a)} m/s`;
  if (a < 1e6) return `${(a / 1000).toFixed(a < 1e4 ? 2 : 1)} km/s`;
  return `${(a / 1e6).toFixed(2)} Mm/s`;
}

export function fmtMeters(m) {
  if (!isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return fmtKm(m / 1000);
}

export function fmtKm(km) {
  if (!isFinite(km)) return '—';
  if (km < 10) return `${km.toFixed(2)} km`;
  if (km < 1000) return `${km.toFixed(km < 100 ? 1 : 0)} km`;
  if (km < 1e6) return `${(km / 1000).toFixed(km < 1e4 ? 1 : 0)}k km`;
  if (km < 0.02 * AU_KM) return `${(km / 1e6).toFixed(2)}M km`;
  return `${(km / AU_KM).toFixed(km < 10 * AU_KM ? 3 : 1)} AU`;
}

export const fmtAU = (au) => fmtKm(au * AU_KM);

export function fmtMass(kg) {
  if (kg < 1000) return `${Math.round(kg)} kg`;
  if (kg < 1e6) return `${(kg / 1000).toFixed(1)} t`;
  return `${(kg / 1e6).toFixed(2)} kt`;
}

export function fmtNum(n, digits = 0) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtG(g) {
  return `${g < 0.1 && g > 0 ? g.toFixed(2) : g.toFixed(1)}G`;
}

export function fmtAngle(rad) {
  const d = ((rad * 180 / Math.PI) % 360 + 360) % 360;
  return `${String(Math.round(d) % 360).padStart(3, '0')}°`;
}

/** Device-pixel-ratio aware canvas that tracks its container size. */
export class FitCanvas {
  constructor(container, { className = '' } = {}) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = `fit-canvas ${className}`.trim();
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.w = 0; this.h = 0; this.dpr = 1;
  }

  /** Resize backing store if needed. Returns false when the canvas isn't visible. */
  fit() {
    const r = this.container.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(r.width), h = Math.round(r.height);
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w; this.h = h; this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }
}

const RESOURCE_LABEL = { credits: 'MCR', fuel: 'kg fuel', water: 'L water', food: 'rations', medSupplies: 'med', o2Tank: 'kg O₂', n2Tank: 'kg N₂', power: '% power' };

/** "2,500 MCR · +200 kg fuel · +10 med" */
export function fmtRewards(r, sep = ' · ') {
  return Object.entries(r || {}).filter(([, v]) => v).map(([k, v]) =>
    k === 'credits' ? `${fmtNum(v)} MCR` : `+${fmtNum(v)} ${RESOURCE_LABEL[k] || k}`).join(sep);
}
