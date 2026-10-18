// ============================================================
// LONGHAUL — Viewport dust (motion cue)
// Streaks flow past the hull according to our velocity relative to
// the current reference (nothing to see when holding station).
// ============================================================

import { ui } from './context.js';
import { velocityReference, relativeTo } from './hud.js';

let timer = null;
let motion = { speed: 0, forward: 1 };

/** Called from the frame loop; cheap. */
export function updateParticleMotion(state) {
  const ref = velocityReference(state);
  const rel = ref ? relativeTo(state, ref.target) : null;
  if (!rel) { motion = { speed: Math.hypot(state.flight.vel.vx, state.flight.vel.vy) * 0.01, forward: 1 }; return; }
  const f = state.flight;
  const fwd = Math.cos(f.facing) * rel.dvx + Math.sin(f.facing) * rel.dvy;
  motion = { speed: rel.speed, forward: fwd >= 0 ? 1 : -1 };
}

export function startParticles() {
  stopParticles();
  const box = document.getElementById('viewport-particles');
  const spawn = () => {
    timer = setTimeout(spawn, rate());
    if (ui.screen !== 'game' || !ui.state || ui.state.speed === 0 || document.hidden) return;
    const k = Math.min(1, Math.log10(1 + motion.speed) / 6);      // 0 at rest … 1 at ~1000 km/s
    const p = document.createElement('div');
    p.className = 'particle';
    if (k < 0.05) {
      p.style.setProperty('--dx', `${(Math.random() - 0.5) * 20}px`);
      p.style.setProperty('--dy', `${(Math.random() - 0.5) * 20}px`);
      p.style.width = p.style.height = '2px';
      p.style.top = `${Math.random() * 100}%`;
    } else {
      const dir = motion.forward;   // moving forward → dust streams down past us
      p.style.setProperty('--dx', `${(Math.random() - 0.5) * 18 * (1 - k)}px`);
      p.style.setProperty('--dy', `${dir * (30 + k * 260)}px`);
      p.style.width = k > 0.3 ? '1px' : '2px';
      p.style.height = `${Math.max(2, 2 + k * 16)}px`;
      p.style.top = `${k > 0.15 ? (dir > 0 ? Math.random() * 25 : 75 + Math.random() * 25) : Math.random() * 100}%`;
    }
    p.style.left = `${Math.random() * 100}%`;
    const dur = Math.max(1.2, 6 - k * 4.5) + Math.random() * 1.5;
    p.style.animationDuration = `${dur}s`;
    if (Math.random() > 0.75) p.style.background = '#E2A355';
    box.appendChild(p);
    setTimeout(() => p.remove(), dur * 1000);
  };
  spawn();
}

function rate() {
  const k = Math.min(1, Math.log10(1 + motion.speed) / 6);
  const base = Math.max(110, 420 - k * 300);
  return ui.settings.reduceMotion ? base * 4 : base;
}

export function stopParticles() {
  clearTimeout(timer);
  timer = null;
  const box = document.getElementById('viewport-particles');
  if (box) box.innerHTML = '';
}
