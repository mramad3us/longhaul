// ============================================================
// LONGHAUL — The ship's AI on the console: one line, and the thing to do
//
// The AI's judgement is advisor.js (what matters now, most urgent
// first, each with the actions that answer it). This is its voice on the
// console: the bottom bar's line shows the most urgent advisory with its
// actions as buttons; a count beside it opens the full list (a window);
// ✕ dismisses one (the AI keeps quiet about it until the situation
// changes: advisor.js reads `memory.dismissed`).
//
// Its actions are plain descriptors; they run here, through the same
// functions the rest of the console calls (hooks).
//
// It looks a few times a second, not every frame, and only redraws the
// line when what it would say has changed. A warning that is new comes in
// with one brief flash; nothing loops.
// ============================================================

import { $, esc, setHTML, show, toggleClass } from './dom.js';
import { ui } from './context.js';
import { advise, AI_NAME } from './advisor.js';
import { createWindow, openWindow, isOpen, windowBody } from './wm.js';

const EVERY_MS = 250;
const LEVEL_NAME = ['info', 'advice', 'caution', 'warning'];
let hooks = {};
let memory = { dismissed: {} };
let last = 0, lastKey = '', list = [], shownKey = '';

export function initAiLine(h) {
  hooks = h;
  const line = $('#ai-line');
  line.addEventListener('click', onClick);
  const body = document.createElement('div');
  body.className = 'ai-list';
  createWindow('ai', { title: `${AI_NAME} · ADVISORIES`, body, w: 520, h: 380 });
  body.addEventListener('click', onClick);
}

export function resetAiLine() {
  memory = { dismissed: {} };
  lastKey = ''; shownKey = ''; list = [];
}

export function updateAi(state) {
  const now = performance.now();
  if (now - last < EVERY_MS) return;
  last = now;
  list = advise(state, memory) || [];
  const key = list.map(a => `${a.key}:${a.text}`).join('|');
  if (key === lastKey) return;
  lastKey = key;
  renderLine();
  if (isOpen('ai')) renderList();
}

function actionsHTML(a, max = 3) {
  return (a.actions || []).slice(0, max).map((x, i) => `<button class="btn-mini${i === 0 ? ' primary' : ''}" data-ai="${esc(a.key)}" data-i="${i}">${esc(x.label)}</button>`).join('');
}

function renderLine() {
  const line = $('#ai-line');
  const top = list[0];
  const lv = top ? LEVEL_NAME[levelOf(top)] : 'quiet';
  const more = list.length > 1 ? `<button class="ai-more" data-ai-more title="Everything the ship's AI is watching">+${list.length - 1}</button>` : '';
  const html = top
    ? `<span class="ai-name">${esc(AI_NAME)}</span><span class="ai-msg ai-${lv}">${esc(top.text)}</span><span class="ai-acts">${actionsHTML(top)}</span>${more}<button class="ai-x" data-ai-dismiss="${esc(top.key)}" title="Dismiss">✕</button>`
    : `<span class="ai-name">${esc(AI_NAME)}</span><span class="ai-msg ai-quiet">Nothing needs you.</span>`;
  setHTML(line, html);
  // a new warning or caution comes in with one flash; nothing loops
  if (top && top.key !== shownKey && levelOf(top) >= 2) { line.classList.remove('ai-flash'); void line.offsetWidth; line.classList.add('ai-flash'); }
  shownKey = top?.key || '';
  toggleClass(line, 'ai-is-warning', lv === 'warning');
  toggleClass(line, 'ai-is-caution', lv === 'caution');
}

function renderList() {
  const box = windowBody('ai')?.querySelector('.ai-list') || windowBody('ai');
  if (!box) return;
  setHTML(box, list.length ? list.map(a => `<div class="ai-row ai-${LEVEL_NAME[levelOf(a)]}">
      <div class="ai-row-text">${esc(a.text)}${a.detail ? `<small>${esc(a.detail)}</small>` : ''}</div>
      <div class="ai-row-acts">${actionsHTML(a, 4)}<button class="ai-x" data-ai-dismiss="${esc(a.key)}" title="Dismiss">✕</button></div></div>`).join('')
    : '<p class="info-dim">Nothing needs you.</p>');
}

const levelOf = (a) => typeof a.level === 'number' ? a.level : ({ info: 0, advice: 1, caution: 2, warning: 3 }[a.level] ?? 0);

function onClick(e) {
  const more = e.target.closest('[data-ai-more]');
  if (more) { openWindow('ai'); renderList(); return; }
  const dis = e.target.closest('[data-ai-dismiss]');
  if (dis) {
    memory.dismissed[dis.dataset.aiDismiss] = ui.state?.clock.minute ?? 0;
    lastKey = ''; last = 0;
    updateAi(ui.state);
    return;
  }
  const b = e.target.closest('[data-ai]');
  if (!b) return;
  const a = list.find(x => x.key === b.dataset.ai);
  const act = a?.actions?.[+b.dataset.i]?.act;
  if (act) run(act);
}

/** Do what an advisory's button says. */
export function run(act) {
  const h = hooks;
  switch (act.type) {
    case 'plot': h.plotRoute?.(act.target, act.dock ? { dock: true } : {}); break;
    case 'select': h.select?.(act.target); break;
    case 'open': h.open?.(act.window, act.id, act.tab); break;
    case 'toggle': if (act.what === 'combat') h.toggleCombat?.(); else if (act.what === 'suits') h.toggleSuits?.(); break;
    case 'respond': h.respond?.(act.request, act.option); break;
    case 'hail': h.hail?.(act.id); break;
    case 'request-docking': h.requestDocking?.(act.id); break;
    case 'request-departure': h.requestDeparture?.(act.id); break;
    case 'dock': h.dock?.(act.id); break;
    case 'speed': h.speed?.(act.value); break;
    case 'order': h.order?.(act.what); break;
    default: console.warn('[ai] no handler for', act);
  }
  last = 0;
}
