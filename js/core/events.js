// ============================================================
// LONGHAUL — Event bus
// The sim emits facts ("crew-died", "arrived"); the UI decides how
// to present them. The sim never touches the DOM.
// ============================================================

export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(type, fn) {
    let list = this._handlers.get(type);
    if (!list) { list = []; this._handlers.set(type, list); }
    list.push(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const list = this._handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    const list = this._handlers.get(type);
    if (list) for (const fn of list.slice()) fn(payload);
    const any = this._handlers.get('*');
    if (any) for (const fn of any.slice()) fn(type, payload);
  }

  clear() {
    this._handlers.clear();
  }
}

/** Shared bus between sim and UI. Tests may attach their own listeners. */
export const bus = new EventBus();
