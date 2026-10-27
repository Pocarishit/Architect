// Blueprint canvas engine: state, camera, rendering, gestures, keyboard, clipboard, history.
import { h, s, isTypingTarget } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { uid, clamp, store, prefersReducedMotion } from '../core/util.js';
import { createNode, updateNode, fitText } from './render.js';
import {
  TEXTUAL, CONNECTABLE, rectOf, unionRects, intersects, contains, pointIn,
  rectFromPoints, lineGeom, distToSeg, penPath, simplify, center,
} from './geometry.js';
import { css } from './palette.js';

export const CLIP_MARK = 'ARCHITECT/BLUEPRINT/1\n';
const MIN_Z = 0.05;
const MAX_Z = 8;

const DEFAULTS = {
  sticky: { w: 200, h: 200, fill: '#FFFFFF', text: '' },
  text: { w: 280, h: 34, text: '', color: 'auto', fontSize: 22, align: 'left' },
  shape: { w: 180, h: 120, kind: 'rect', fill: 'none', stroke: 'auto', strokeWidth: 2, text: '', fontSize: 16, align: 'center' },
  frame: { w: 800, h: 500, title: 'Frame', fill: 'none' },
  line: { stroke: 'auto', strokeWidth: 2, route: 'straight', startCap: 'none', endCap: 'arrow', dash: 'solid' },
};

// Style properties remembered per type, so the next element looks like the last one you styled.
const STYLE_KEYS = {
  sticky: ['fill', 'font', 'align', 'bold', 'italic', 'color', 'fontSize'],
  text: ['color', 'font', 'fontSize', 'align', 'bold', 'italic', 'fill'],
  shape: ['fill', 'stroke', 'strokeWidth', 'dash', 'color', 'font', 'fontSize', 'align', 'bold', 'italic'],
  line: ['stroke', 'strokeWidth', 'route', 'startCap', 'endCap', 'dash'],
  frame: ['fill'],
};

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Editor {
  constructor(host, { elements = [], camera = null, mediaUrl = () => null } = {}) {
    this.host = host;
    this.mediaUrl = mediaUrl;
    this.els = (elements || []).filter((e) => e && e.id && e.type);
    this.byId = new Map(this.els.map((e) => [e.id, e]));
    this.sel = new Set();
    this.tool = 'select';
    this.opts = { shape: 'rect', line: 'arrow', pen: 'pen', penColor: 'auto', penWidth: 3, hlColor: '#F0B429', sticky: '#FFFFFF', ...store.get('architect.board.opts', {}) };
    this.lastStyle = store.get('architect.board.style', {});
    this.prefs = { grid: true, snap: false, wheelZoom: false, ...store.get('architect.board.prefs', {}) };
    this.undoStack = [];
    this.redoStack = [];
    this.editingId = null;
    this.activeId = null;
    this.g = null;
    this.pointers = new Map();
    this.space = false;
    this.bindHover = null;
    this.lastPointer = null;
    this.presenting = false;
    this.handlers = {};
    this.nodes = new Map();
    this.cam = { x: 0, y: 0, z: 1 };
    this._anim = null;
    this.build();
    this.sync();
    this.initCamera(camera);
  }

  /* ================= events ================= */
  on(name, fn) { (this.handlers[name] ||= new Set()).add(fn); return () => this.handlers[name].delete(fn); }
  emit(name, data) { this.handlers[name]?.forEach((fn) => fn(data)); }

  /* ================= DOM ================= */
  build() {
    this.vp = h('div', { class: 'bp-viewport', tabindex: '0', 'aria-label': 'Board canvas', 'data-tool': 'select' });
    this.world = h('div', { class: 'bp-world' });
    this.frameLayer = h('div', { class: 'bp-layer' });
    this.elLayer = h('div', { class: 'bp-layer' });
    this.liveLayer = h('div', { class: 'bp-layer' });
    this.overlay = h('div', { class: 'bp-overlay' });
    this.world.append(this.frameLayer, this.elLayer, this.liveLayer, this.overlay);
    this.vp.append(this.world);
    this.host.append(this.vp);

    const L = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      (this._unbind ||= []).push(() => target.removeEventListener(type, fn, opts));
    };
    L(this.vp, 'pointerdown', (e) => this.onDown(e));
    L(this.vp, 'pointermove', (e) => this.onMove(e));
    L(this.vp, 'pointerup', (e) => this.onUp(e));
    L(this.vp, 'pointercancel', (e) => this.onUp(e, true));
    L(this.vp, 'lostpointercapture', (e) => { if (this.g && this.g.pointerId === e.pointerId) this.onUp(e, true); });
    L(this.vp, 'dblclick', (e) => this.onDblClick(e));
    L(this.vp, 'contextmenu', (e) => this.onContextMenu(e));
    L(this.vp, 'wheel', (e) => this.onWheel(e), { passive: false });
    L(this.vp, 'dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    L(this.vp, 'drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) {
        const url = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
        if (url && /^https?:\/\//.test(url.trim())) { e.preventDefault(); this.emit('url', { url: url.trim(), at: this.toWorld(e.clientX, e.clientY) }); }
        return;
      }
      e.preventDefault();
      this.emit('files', { files, at: this.toWorld(e.clientX, e.clientY) });
    });
    L(window, 'keydown', (e) => this.onKeyDown(e));
    L(window, 'keyup', (e) => this.onKeyUp(e));
    L(window, 'blur', () => { this.space = false; this.vp.classList.remove('is-space'); });
    L(document, 'paste', (e) => this.onPaste(e));
    L(document, 'copy', (e) => this.onCopy(e, false));
    L(document, 'cut', (e) => this.onCopy(e, true));

    this._ro = new ResizeObserver(() => { this.emit('camera', this.cam); });
    this._ro.observe(this.vp);
    document.fonts?.ready?.then(() => { if (this.vp.isConnected) this.refreshAll(); });
  }

  destroy() {
    this.finishEditing();
    this._unbind?.forEach((f) => f());
    this._ro?.disconnect();
    cancelAnimationFrame(this._anim);
    this.vp.remove();
    this.handlers = {};
  }

  /* ================= camera ================= */
  rect() { return this.vp.getBoundingClientRect(); }
  toWorld(cx, cy) {
    const r = this.rect();
    return { x: (cx - r.left - this.cam.x) / this.cam.z, y: (cy - r.top - this.cam.y) / this.cam.z };
  }
  toScreen(p) {
    const r = this.rect();
    return { x: r.left + this.cam.x + p.x * this.cam.z, y: r.top + this.cam.y + p.y * this.cam.z };
  }
  viewCenter() { const r = this.rect(); return this.toWorld(r.left + r.width / 2, r.top + r.height / 2); }

  applyCamera() {
    const { x, y, z } = this.cam;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    this.vp.style.setProperty('--iz', String(1 / z));
    let step = 24 * z;
    while (step < 14) step *= 4;
    while (step > 96) step /= 4;
    this.vp.style.backgroundSize = `${step}px ${step}px`;
    this.vp.style.backgroundPosition = `${x}px ${y}px`;
    this.vp.classList.toggle('no-grid', !this.prefs.grid);
    if (this._lastZ !== z) { this._lastZ = z; this.renderOverlay(); }
    this.emit('camera', this.cam);
  }

  setCamera(c, { animate = false } = {}) {
    const target = { x: c.x, y: c.y, z: clamp(c.z, MIN_Z, MAX_Z) };
    cancelAnimationFrame(this._anim);
    if (!animate || prefersReducedMotion()) { this.cam = target; this.applyCamera(); return; }
    const from = { ...this.cam };
    const t0 = performance.now();
    const dur = 420;
    // Interpolate in screen space around fixed world point so motion feels straight.
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const k = easeInOut(t);
      const z = Math.exp(Math.log(from.z) + (Math.log(target.z) - Math.log(from.z)) * k);
      this.cam = { x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k, z };
      this.applyCamera();
      if (t < 1) this._anim = requestAnimationFrame(step);
    };
    this._anim = requestAnimationFrame(step);
  }

  zoomAt(cx, cy, factor) {
    const r = this.rect();
    const z = clamp(this.cam.z * factor, MIN_Z, MAX_Z);
    const wx = (cx - r.left - this.cam.x) / this.cam.z;
    const wy = (cy - r.top - this.cam.y) / this.cam.z;
    this.cam = { x: cx - r.left - wx * z, y: cy - r.top - wy * z, z };
    this.applyCamera();
  }

  zoomBy(factor, animate = true) {
    const r = this.rect();
    const z = clamp(this.cam.z * factor, MIN_Z, MAX_Z);
    const c = this.viewCenter();
    this.setCamera({ x: r.width / 2 - c.x * z, y: r.height / 2 - c.y * z, z }, { animate });
  }

  zoomTo(z, animate = true) { this.zoomBy(z / this.cam.z, animate); }

  fitRect(rc, { pad = 80, maxZ = 1, animate = true } = {}) {
    if (!rc) return;
    const r = this.rect();
    const w = Math.max(rc.w, 1), hh = Math.max(rc.h, 1);
    const z = clamp(Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / hh, maxZ), MIN_Z, MAX_Z);
    const c = center(rc);
    this.setCamera({ x: r.width / 2 - c.x * z, y: r.height / 2 - c.y * z, z }, { animate });
  }

  contentRect() { return unionRects(this.els.map((e) => rectOf(e, this.byId))); }

  zoomToFit(animate = true) {
    const rc = this.contentRect();
    if (rc) this.fitRect(rc, { animate });
    else { const r = this.rect(); this.setCamera({ x: r.width / 2, y: r.height / 2, z: 1 }, { animate }); }
  }

  zoomToSelection() {
    const rc = unionRects(this.selected().map((e) => rectOf(e, this.byId)));
    if (rc) this.fitRect(rc, { maxZ: 2 });
  }

  initCamera(saved) {
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.z) && saved.z > 0) {
      this.cam = { x: saved.x, y: saved.y, z: clamp(saved.z, MIN_Z, MAX_Z) };
      this.applyCamera();
    } else this.zoomToFit(false);
  }

  /* ================= rendering ================= */
  ctx() { return { byId: this.byId, editingId: this.editingId, activeId: this.activeId, mediaUrl: this.mediaUrl }; }

  sync() {
    const ctx = this.ctx();
    const seen = new Set();
    const updatedText = [];
    let fi = 0, ei = 0;
    for (const el of this.els) {
      seen.add(el.id);
      let node = this.nodes.get(el.id);
      if (!node) { node = createNode(el); this.nodes.set(el.id, node); }
      const layer = el.type === 'frame' ? this.frameLayer : this.elLayer;
      const idx = el.type === 'frame' ? fi++ : ei++;
      if (layer.children[idx] !== node) layer.insertBefore(node, layer.children[idx] || null);
      if (node._el !== el || node._force || el.type === 'line') {
        updateNode(node, el, ctx);
        node._el = el;
        node._force = false;
        if (el.type === 'text') updatedText.push(el.id);
      }
      node.classList.toggle('is-selected', this.sel.has(el.id));
    }
    for (const [id, node] of this.nodes) if (!seen.has(id)) { node.remove(); this.nodes.delete(id); }
    if (updatedText.length) this.measureTexts(updatedText);
    this.renderOverlay();
  }

  measureTexts(ids) {
    const fixes = new Map();
    for (const id of ids) {
      const node = this.nodes.get(id);
      const el = this.byId.get(id);
      if (!node || !el) continue;
      const hgt = node.offsetHeight;
      const wid = el.autoW ? node.offsetWidth : el.w;
      if ((hgt && Math.abs(hgt - el.h) > 0.5) || Math.abs(wid - el.w) > 0.5) fixes.set(id, { h: hgt || el.h, w: wid });
    }
    if (!fixes.size) return;
    this.els = this.els.map((e) => (fixes.has(e.id) ? { ...e, ...fixes.get(e.id) } : e));
    this.byId = new Map(this.els.map((e) => [e.id, e]));
    for (const id of fixes.keys()) { const n = this.nodes.get(id); if (n) n._el = this.byId.get(id); }
    this.emit('change', { silent: true });
  }

  refreshAll() { for (const n of this.nodes.values()) n._force = true; this.sync(); }
  refreshMedia() {
    for (const el of this.els) if (el.type === 'image' || el.type === 'video') { const n = this.nodes.get(el.id); if (n) n._force = true; }
    this.sync();
  }

  renderOverlay() {
    const o = this.overlay;
    o.replaceChildren();
    const z = this.cam.z;
    const box = (r, cls) => h('div', { class: cls, style: { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` } });
    const g = this.g;
    if (g?.marquee) o.append(box(g.marquee, 'ov-marquee'));
    if (this.bindHover) {
      const t = this.byId.get(this.bindHover);
      if (t) o.append(box(rectOf(t, this.byId), 'ov-bind'));
    }
    if (this.presenting) return;
    const sel = this.selected();
    if (!sel.length) return;
    const busy = g && (g.moved || g.type === 'resize' || g.type === 'endpoint' || g.type === 'anchor');
    const handle = (d, r) => {
      const x = r.x + (d.includes('w') ? 0 : d.includes('e') ? r.w : r.w / 2);
      const y = r.y + (d.includes('n') ? 0 : d.includes('s') ? r.h : r.h / 2);
      return h('div', { class: `ov-h h-${d}`, 'data-handle': d, style: { left: `${x}px`, top: `${y}px` } });
    };
    if (sel.length === 1) {
      const el = sel[0];
      if (el.type === 'line') {
        const lg = lineGeom(el, this.byId);
        if (el.locked) { o.append(lockBadge(lg.bbox)); return; }
        const pt = (which, p) => h('div', { class: ['ov-pt', (which === 'a' ? el.a : el.b)?.id && 'is-bound'], 'data-handle': which, style: { left: `${p.x}px`, top: `${p.y}px` } });
        o.append(pt('a', lg.a), pt('b', lg.b));
        return;
      }
      const r = rectOf(el, this.byId);
      o.append(box(r, `ov-sel${el.locked ? ' is-locked' : ''}`));
      if (el.locked) { o.append(lockBadge(r)); return; }
      if (busy && g.type !== 'resize') return;
      if (this.editingId === el.id) return;
      const dirs = el.type === 'text' ? ['nw', 'ne', 'se', 'sw', 'e', 'w']
        : el.type === 'image' || el.type === 'video' ? ['nw', 'ne', 'se', 'sw']
          : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      dirs.forEach((d) => o.append(handle(d, r)));
      // Connection dots: drag one to draw a connector, click one to add a connected item.
      if (CONNECTABLE.has(el.type) && !busy) {
        const off = 20 / z;
        const spots = { e: [r.x + r.w + off, r.y + r.h / 2], w: [r.x - off, r.y + r.h / 2], s: [r.x + r.w / 2, r.y + r.h + off], n: [r.x + r.w / 2, r.y - off] };
        for (const [d, [x, y]] of Object.entries(spots)) {
          o.append(h('div', { class: 'ov-qc', 'data-handle': `qc-${d}`, title: 'Drag to connect · click to add a connected item', style: { left: `${x}px`, top: `${y}px` } }));
        }
      }
    } else {
      for (const el of sel) if (el.type !== 'line') o.append(box(rectOf(el, this.byId), 'ov-sub'));
      const r = unionRects(sel.map((e) => rectOf(e, this.byId)));
      o.append(box(r, 'ov-sel'));
      if (!busy && sel.some((e) => !e.locked)) ['nw', 'ne', 'se', 'sw'].forEach((d) => o.append(handle(d, r)));
    }
    function lockBadge(r) {
      return h('div', { class: 'ov-lock', style: { left: `${r.x + r.w}px`, top: `${r.y}px` } }, icon('lock', 12));
    }
  }

  /* ================= state ================= */
  selected() { return [...this.sel].map((id) => this.byId.get(id)).filter(Boolean); }

  setEls(next, { commit = true, before } = {}) {
    const prev = this.els;
    if (next === prev) return;
    if (commit) this.pushUndo(before || prev);
    this.els = next;
    this.byId = new Map(next.map((e) => [e.id, e]));
    for (const id of [...this.sel]) if (!this.byId.has(id)) this.sel.delete(id);
    this.sync();
    this.emit('change', { commit });
  }

  commitFrom(before) { if (this.els !== before) { this.pushUndo(before); this.emit('change', { commit: true }); } }

  pushUndo(snapshot) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.emit('history');
  }

  restore(list) {
    this.els = list;
    this.byId = new Map(list.map((e) => [e.id, e]));
    for (const id of [...this.sel]) if (!this.byId.has(id)) this.sel.delete(id);
    if (this.activeId && !this.byId.has(this.activeId)) this.activeId = null;
    this.sync();
    this.emit('change', { commit: true });
    this.emit('selection');
    this.emit('history');
  }

  undo() {
    this.finishEditing();
    if (!this.undoStack.length) return;
    this.redoStack.push(this.els);
    this.restore(this.undoStack.pop());
  }

  redo() {
    this.finishEditing();
    if (!this.redoStack.length) return;
    this.undoStack.push(this.els);
    this.restore(this.redoStack.pop());
  }

  updateEls(ids, patch, opts) {
    const set = new Set(ids);
    if (!set.size) return;
    this.setEls(this.els.map((e) => (set.has(e.id) ? { ...e, ...(typeof patch === 'function' ? patch(e) : patch) } : e)), opts);
  }

  // Style change from the context bar; remembered for the next element of that type.
  applyStyle(ids, patch) {
    const els = ids.map((id) => this.byId.get(id)).filter(Boolean);
    for (const el of els) {
      const keys = STYLE_KEYS[el.type];
      if (!keys) continue;
      const rec = (this.lastStyle[el.type] ||= {});
      for (const k of Object.keys(patch)) if (keys.includes(k)) rec[k] = patch[k];
    }
    store.set('architect.board.style', this.lastStyle);
    this.updateEls(ids, patch);
    this.emit('selection');
  }

  addEls(list, { select = true, edit = false } = {}) {
    if (!list.length) return;
    this.setEls([...this.els, ...list]);
    if (select) this.select(list.map((e) => e.id));
    if (edit && list.length === 1) this.startEditing(list[0].id, { selectAll: true, fresh: true });
  }

  removeEls(ids, opts = {}) {
    const set = new Set(ids);
    if (!set.size) return;
    if (this.editingId && set.has(this.editingId)) this.finishEditing();
    if (this.activeId && set.has(this.activeId)) this.activeId = null;
    const next = [];
    for (const e of this.els) {
      if (set.has(e.id)) continue;
      if (e.type === 'line' && ((e.a?.id && set.has(e.a.id)) || (e.b?.id && set.has(e.b.id)))) {
        const g = lineGeom(e, this.byId);
        next.push({ ...e, a: e.a?.id && set.has(e.a.id) ? { x: g.a.x, y: g.a.y } : e.a, b: e.b?.id && set.has(e.b.id) ? { x: g.b.x, y: g.b.y } : e.b });
      } else next.push(e);
    }
    ids.forEach((id) => this.sel.delete(id));
    this.setEls(next, opts);
    this.emit('selection');
  }

  select(ids, { add = false } = {}) {
    const expanded = this.expandGroups(ids);
    this.sel = add ? new Set([...this.sel, ...expanded]) : new Set(expanded);
    this.syncSelection();
  }

  clearSel() {
    if (!this.sel.size) return;
    this.sel = new Set();
    this.syncSelection();
  }

  selectAll() { this.select(this.els.map((e) => e.id)); }

  syncSelection() {
    for (const [id, node] of this.nodes) node.classList.toggle('is-selected', this.sel.has(id));
    this.renderOverlay();
    this.emit('selection');
  }

  expandGroups(ids) {
    const groups = new Set(ids.map((id) => this.byId.get(id)?.group).filter(Boolean));
    if (!groups.size) return ids;
    return [...new Set([...ids, ...this.els.filter((e) => e.group && groups.has(e.group)).map((e) => e.id)])];
  }

  setTool(tool) {
    this.finishEditing();
    if (this.tool === tool) { this.emit('tool', tool); return; }
    this.tool = tool;
    this.vp.dataset.tool = tool;
    this.bindHover = null;
    this.renderOverlay();
    this.emit('tool', tool);
  }

  setOpt(key, value) {
    this.opts[key] = value;
    store.set('architect.board.opts', this.opts);
    this.emit('tool', this.tool);
  }

  setPref(key, value) {
    this.prefs[key] = value;
    store.set('architect.board.prefs', this.prefs);
    this.applyCamera();
    this.emit('prefs');
  }

  /* ================= element factory ================= */
  makeEl(type, rect, at) {
    const base = { ...(DEFAULTS[type] || {}), ...(this.lastStyle[type] || {}) };
    const el = { id: uid(), type, ...base };
    if (type === 'shape') el.kind = this.opts.shape || 'rect';
    if (type === 'sticky') el.fill = this.opts.sticky || base.fill;
    if (type === 'frame') {
      const n = this.els.filter((e) => e.type === 'frame').length + 1;
      el.title = `Frame ${n}`;
    }
    if (rect) Object.assign(el, { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    else {
      const p = at || this.viewCenter();
      Object.assign(el, { x: p.x - el.w / 2, y: p.y - el.h / 2 });
    }
    if (this.prefs.snap && type !== 'line') { el.x = snap(el.x); el.y = snap(el.y); }
    return el;
  }

  // Free-standing helper for media/link elements made outside gestures.
  place(el, at) {
    const p = at || this.viewCenter();
    return { id: uid(), x: p.x - (el.w || 200) / 2, y: p.y - (el.h || 120) / 2, ...el };
  }

  frames() { return this.els.filter((e) => e.type === 'frame'); }

  elementAt(p, excludeId) {
    const pad = 6 / this.cam.z;
    for (let i = this.els.length - 1; i >= 0; i--) {
      const e = this.els[i];
      if (e.id === excludeId || !CONNECTABLE.has(e.type)) continue;
      if (pointIn(e, p, pad)) return e;
    }
    return null;
  }

  /* ================= pointer gestures ================= */
  onDown(e) {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('[data-noptr]')) return;
    if (e.target.closest('[contenteditable="true"]')) return;
    if (e.target.closest('.is-live .el-media')) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2 && e.pointerType === 'touch') { this.startPinch(); return; }
    if (this.pointers.size > 1) return;

    if (this.editingId) this.finishEditing();
    if (this.activeId && !e.target.closest(`[data-eid="${this.activeId}"]`)) this.deactivate();
    if (document.activeElement !== this.vp && !isTypingTarget(document.activeElement)) this.vp.focus({ preventScroll: true });
    else if (isTypingTarget(document.activeElement)) { document.activeElement.blur(); this.vp.focus({ preventScroll: true }); }

    const p = this.toWorld(e.clientX, e.clientY);
    const start = { cx: e.clientX, cy: e.clientY, p, shift: e.shiftKey, alt: e.altKey, pointerId: e.pointerId, touch: e.pointerType === 'touch' };
    if (e.button !== 0 && e.button !== 1) { this.pointers.delete(e.pointerId); return; }
    try { this.vp.setPointerCapture(e.pointerId); } catch {}

    if (e.button === 1 || this.space || this.tool === 'hand' || this.presenting) { e.preventDefault(); this.beginPan(start); return; }

    const handle = e.target.closest('[data-handle]');
    const node = e.target.closest('[data-eid]');
    const el = node ? this.byId.get(node.dataset.eid) : null;

    switch (this.tool) {
      case 'select': this.downSelect(start, handle, el); break;
      case 'sticky': case 'text': case 'shape': case 'frame': this.beginCreate(start, this.tool); break;
      case 'line': this.beginLine(start); break;
      case 'pen': this.beginPen(start); break;
      case 'eraser': this.beginErase(start); break;
      default: this.beginPan(start);
    }
  }

  downSelect(start, handle, el) {
    if (handle) {
      const d = handle.dataset.handle;
      if (d.startsWith('qc-')) { this.beginAnchor(start, d.slice(3)); return; }
      if (d === 'a' || d === 'b') { this.beginEndpoint(start, d); return; }
      this.beginResize(start, d);
      return;
    }
    if (el) {
      if (start.shift) {
        const ids = this.expandGroups([el.id]);
        if (this.sel.has(el.id)) { ids.forEach((id) => this.sel.delete(id)); this.syncSelection(); return; }
        this.select(ids, { add: true });
      } else if (!this.sel.has(el.id)) this.select([el.id]);
      if (this.selected().every((x) => x.locked)) return;
      this.beginMove(start);
      return;
    }
    if (start.touch) { this.beginPan(start); return; }
    if (!start.shift) this.clearSel();
    this.beginMarquee(start);
  }

  onMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = this.toWorld(e.clientX, e.clientY);
    this.lastPointer = p;
    if (this.g?.type === 'pinch') { this.movePinch(); return; }
    if (this.g && this.g.pointerId === e.pointerId) { this.g.onMove?.(p, e); return; }
    if (!this.g && this.tool === 'line') {
      const t = this.elementAt(p);
      const id = t?.id || null;
      if (id !== this.bindHover) { this.bindHover = id; this.renderOverlay(); }
    }
  }

  onUp(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    const g = this.g;
    if (!g) return;
    if (g.type === 'pinch') { if (this.pointers.size < 2) { this.g = null; this.emit('gesture', false); } return; }
    if (g.pointerId !== e.pointerId) return;
    this.g = null;
    try { this.vp.releasePointerCapture(e.pointerId); } catch {}
    this.vp.classList.remove('is-panning');
    document.body.classList.remove('bp-busy');
    g.onUp?.(this.toWorld(e.clientX, e.clientY), e, cancelled);
    this.renderOverlay();
    this.emit('gesture', false);
  }

  startGesture(g) {
    this.g = g;
    this.emit('gesture', true);
  }

  beginPan(start) {
    const cam0 = { ...this.cam };
    this.vp.classList.add('is-panning');
    cancelAnimationFrame(this._anim);
    this.startGesture({
      type: 'pan', pointerId: start.pointerId,
      onMove: (p, e) => {
        this.cam = { ...cam0, x: cam0.x + (e.clientX - start.cx), y: cam0.y + (e.clientY - start.cy) };
        this.applyCamera();
      },
    });
  }

  beginMarquee(start) {
    const base = new Set(this.sel);
    const g = {
      type: 'marquee', pointerId: start.pointerId, marquee: null,
      onMove: (p, e) => {
        if (!g.marquee && Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < 4) return;
        g.marquee = rectFromPoints(start.p, p);
        const hits = [];
        for (const el of this.els) {
          const r = rectOf(el, this.byId);
          if (el.type === 'frame' ? contains(g.marquee, r) : intersects(g.marquee, r)) hits.push(el.id);
        }
        this.sel = new Set([...base, ...this.expandGroups(hits)]);
        for (const [id, node] of this.nodes) node.classList.toggle('is-selected', this.sel.has(id));
        this.renderOverlay();
      },
      onUp: () => { this.emit('selection'); },
    };
    this.startGesture(g);
  }

  beginMove(start) {
    let ids = this.selected().filter((x) => !x.locked).map((x) => x.id);
    const before = this.els;
    const addFrameChildren = (list) => {
      const frames = list.map((id) => this.byId.get(id)).filter((x) => x?.type === 'frame');
      if (!frames.length) return list;
      const set = new Set(list);
      for (const el of this.els) {
        if (set.has(el.id) || el.type === 'frame' || el.locked) continue;
        const r = rectOf(el, this.byId);
        if (frames.some((f) => contains(f, r))) set.add(el.id);
      }
      return [...set];
    };
    ids = addFrameChildren(ids);
    let startPos = new Map(ids.map((id) => [id, this.byId.get(id)]));
    const g = {
      type: 'move', pointerId: start.pointerId, moved: false,
      onMove: (p, e) => {
        if (!g.moved) {
          if (Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < 4) return;
          g.moved = true;
          document.body.classList.add('bp-busy');
          if (start.alt) {
            const clones = this.cloneEls(this.selected().map((x) => x.id), 0, 0);
            this.setEls([...this.els, ...clones], { commit: false });
            this.sel = new Set(clones.map((c) => c.id));
            ids = addFrameChildren(clones.map((c) => c.id));
            startPos = new Map(ids.map((id) => [id, this.byId.get(id)]));
            for (const [id, node] of this.nodes) node.classList.toggle('is-selected', this.sel.has(id));
          }
        }
        let dx = p.x - start.p.x, dy = p.y - start.p.y;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (this.prefs.snap) {
          const first = startPos.values().next().value;
          if (first && first.type !== 'line') { dx = snap(first.x + dx) - first.x; dy = snap(first.y + dy) - first.y; }
        }
        this.setEls(this.els.map((el) => (startPos.has(el.id) ? moved(startPos.get(el.id), dx, dy) : el)), { commit: false });
      },
      onUp: () => { if (g.moved) this.commitFrom(before); this.emit('selection'); },
    };
    this.startGesture(g);
  }

  beginResize(start, dir) {
    const sel = this.selected().filter((x) => !x.locked);
    if (!sel.length) return;
    const before = this.els;
    const origin = new Map(sel.map((e) => [e.id, e]));
    const rects = new Map(sel.map((e) => [e.id, rectOf(e, this.byId)]));
    const ob = unionRects([...rects.values()]);
    const single = sel.length === 1 ? sel[0] : null;
    const corner = dir.length === 2;
    const aspectDefault = !single || single.type === 'image' || single.type === 'video';
    const g = {
      type: 'resize', pointerId: start.pointerId,
      onMove: (p, e) => {
        document.body.classList.add('bp-busy');
        const dx = p.x - start.p.x, dy = p.y - start.p.y;
        let { x, y, w, h: hh } = ob;
        if (dir.includes('e')) w = ob.w + dx;
        if (dir.includes('w')) { w = ob.w - dx; x = ob.x + dx; }
        if (dir.includes('s')) hh = ob.h + dy;
        if (dir.includes('n')) { hh = ob.h - dy; y = ob.y + dy; }
        const min = 12;
        if (w < min) { if (dir.includes('w')) x = ob.x + ob.w - min; w = min; }
        if (hh < min) { if (dir.includes('n')) y = ob.y + ob.h - min; hh = min; }
        const keep = corner && (aspectDefault !== e.shiftKey) || (single?.type === 'text' && corner);
        if (keep) {
          const k = Math.max(w / (ob.w || 1), hh / (ob.h || 1));
          w = (ob.w || 1) * k; hh = (ob.h || 1) * k;
          if (dir.includes('w')) x = ob.x + ob.w - w;
          if (dir.includes('n')) y = ob.y + ob.h - hh;
        }
        if (this.prefs.snap && !keep) {
          if (dir.includes('e')) w = snap(x + w) - x;
          if (dir.includes('s')) hh = snap(y + hh) - y;
          if (dir.includes('w')) { const nx = snap(x); w += x - nx; x = nx; }
          if (dir.includes('n')) { const ny = snap(y); hh += y - ny; y = ny; }
        }
        const sx = w / (ob.w || 1), sy = hh / (ob.h || 1);
        const mapPt = (pt) => ({ x: x + (pt.x - ob.x) * sx, y: y + (pt.y - ob.y) * sy });
        this.setEls(before.map((el) => {
          if (!origin.has(el.id)) return el;
          const r = rects.get(el.id);
          const nr = { x: x + (r.x - ob.x) * sx, y: y + (r.y - ob.y) * sy, w: r.w * sx, h: r.h * sy };
          return resized(el, nr, sx, sy, mapPt, single, corner);
        }), { commit: false });
      },
      onUp: () => { this.commitFrom(before); this.emit('selection'); },
    };
    this.startGesture(g);
  }

  beginEndpoint(start, which) {
    const line = this.selected()[0];
    if (!line || line.type !== 'line') return;
    const before = this.els;
    const other = which === 'a' ? line.b : line.a;
    const g = {
      type: 'endpoint', pointerId: start.pointerId,
      onMove: (p) => {
        const t = this.elementAt(p, line.id);
        const bindId = t && t.id !== other?.id ? t.id : null;
        this.bindHover = bindId;
        const end = bindId ? { id: bindId, x: p.x, y: p.y } : { x: p.x, y: p.y };
        this.setEls(this.els.map((el) => (el.id === line.id ? { ...el, [which]: end } : el)), { commit: false });
      },
      onUp: () => { this.bindHover = null; this.commitFrom(before); this.emit('selection'); },
    };
    this.startGesture(g);
  }

  beginCreate(start, type) {
    const before = this.els;
    let made = null;
    const g = {
      type: 'create', pointerId: start.pointerId,
      onMove: (p, e) => {
        if (!made && Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < 6) return;
        let r = rectFromPoints(start.p, p);
        if (type === 'sticky' || e.shiftKey) {
          const s2 = Math.max(r.w, r.h);
          r = { x: p.x < start.p.x ? start.p.x - s2 : start.p.x, y: p.y < start.p.y ? start.p.y - s2 : start.p.y, w: s2, h: s2 };
        }
        if (type === 'text') r.h = made?.h || DEFAULTS.text.h;
        r.w = Math.max(r.w, 20);
        r.h = Math.max(r.h, 20);
        if (!made) {
          made = this.makeEl(type, r);
          this.sel = new Set([made.id]);
          this.setEls([...this.els, made], { commit: false });
        } else {
          this.setEls(this.els.map((el) => (el.id === made.id ? { ...el, x: r.x, y: r.y, w: r.w, h: type === 'text' ? el.h : r.h } : el)), { commit: false });
        }
      },
      onUp: () => {
        if (!made) {
          made = this.makeEl(type, null, start.p);
          if (type === 'text') { made.x = start.p.x - 4; made.autoW = true; } // text starts where you click and hugs its words
          this.setEls([...this.els, made], { commit: false });
        }
        this.pushUndo(before);
        this.emit('change', { commit: true });
        this.sel = new Set([made.id]);
        this.setTool('select');
        this.syncSelection();
        if (type === 'sticky' || type === 'text' || type === 'frame') this.startEditing(made.id, { selectAll: true, fresh: true });
      },
    };
    this.startGesture(g);
  }

  beginLine(start) {
    const before = this.els;
    const t0 = this.elementAt(start.p);
    const line = this.makeEl('line');
    delete line.x; delete line.y; delete line.w; delete line.h;
    line.endCap = this.opts.line === 'line' ? 'none' : (line.endCap && line.endCap !== 'none' ? line.endCap : 'arrow');
    line.a = t0 ? { id: t0.id, x: start.p.x, y: start.p.y } : { x: start.p.x, y: start.p.y };
    line.b = { x: start.p.x, y: start.p.y };
    let added = false;
    const g = {
      type: 'line', pointerId: start.pointerId,
      onMove: (p, e) => {
        if (!added) {
          if (Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < 4) return;
          added = true;
          this.setEls([...this.els, line], { commit: false });
        }
        const t = this.elementAt(p, line.id);
        const bindId = t && t.id !== line.a.id ? t.id : null;
        this.bindHover = bindId;
        const b = bindId ? { id: bindId, x: p.x, y: p.y } : { x: p.x, y: p.y };
        this.setEls(this.els.map((el) => (el.id === line.id ? { ...el, b } : el)), { commit: false });
      },
      onUp: () => {
        this.bindHover = null;
        if (!added) {
          this.setEls([...this.els, { ...line, a: { x: start.p.x, y: start.p.y }, b: { x: start.p.x + 160, y: start.p.y } }], { commit: false });
        }
        this.pushUndo(before);
        this.emit('change', { commit: true });
        this.sel = new Set([line.id]);
        this.setTool('select');
        this.syncSelection();
      },
    };
    this.startGesture(g);
  }

  beginPen(start) {
    const kind = this.opts.pen === 'highlighter' ? 'highlighter' : 'pen';
    const color = kind === 'highlighter' ? this.opts.hlColor : this.opts.penColor;
    const width = kind === 'highlighter' ? 18 : this.opts.penWidth;
    const opacity = kind === 'highlighter' ? 0.38 : 1;
    const pts = [[start.p.x, start.p.y]];
    const path = s('path', { d: penPath(pts), fill: 'none', stroke: css(color), 'stroke-width': width, opacity, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    const svg = s('svg', { class: 'bp-live-svg' }, path);
    this.liveLayer.append(svg);
    const g = {
      type: 'pen', pointerId: start.pointerId,
      onMove: (p) => {
        const last = pts[pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) < 1.2 / this.cam.z) return;
        pts.push([p.x, p.y]);
        path.setAttribute('d', penPath(pts));
      },
      onUp: () => {
        svg.remove();
        if (pts.length === 1) pts.push([pts[0][0] + 0.5, pts[0][1] + 0.5]);
        const simp = simplify(pts, 0.6 / this.cam.z);
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const [x, y] of simp) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
        const r2 = (v) => Math.round(v * 100) / 100;
        const el = {
          id: uid(), type: 'pen', x: r2(x1), y: r2(y1), w: r2(Math.max(x2 - x1, 1)), h: r2(Math.max(y2 - y1, 1)),
          points: simp.map(([x, y]) => [r2(x - x1), r2(y - y1)]), stroke: color, strokeWidth: width, opacity, kind,
        };
        this.setEls([...this.els, el]);
      },
    };
    this.startGesture(g);
  }

  beginErase(start) {
    const before = this.els;
    const test = (p) => {
      const rad = 8 / this.cam.z;
      const hit = [];
      for (const el of this.els) {
        if (el.type !== 'pen' || el.locked) continue;
        const sw = (el.strokeWidth || 3) / 2;
        if (!pointIn(el, p, rad + sw)) continue;
        const pts = el.points || [];
        for (let i = 0; i < pts.length; i++) {
          const a = { x: el.x + pts[i][0], y: el.y + pts[i][1] };
          const b = i + 1 < pts.length ? { x: el.x + pts[i + 1][0], y: el.y + pts[i + 1][1] } : a;
          if (distToSeg(p, a, b) <= rad + sw) { hit.push(el.id); break; }
        }
      }
      if (hit.length) { const set = new Set(hit); this.setEls(this.els.filter((e) => !set.has(e.id)), { commit: false }); }
    };
    test(start.p);
    this.startGesture({ type: 'erase', pointerId: start.pointerId, onMove: (p) => test(p), onUp: () => this.commitFrom(before) });
  }

  startPinch() {
    if (this.g && this.g.type !== 'pinch') {
      const g = this.g;
      this.g = null;
      g.onUp?.(this.lastPointer || { x: 0, y: 0 }, {}, true);
    }
    const [a, b] = [...this.pointers.values()];
    const r = this.rect();
    this.g = {
      type: 'pinch',
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      m0: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top },
      cam0: { ...this.cam },
    };
    this.emit('gesture', true);
  }

  movePinch() {
    const g = this.g;
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const r = this.rect();
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const m = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    const z = clamp(g.cam0.z * (d / g.d0), MIN_Z, MAX_Z);
    const wx = (g.m0.x - g.cam0.x) / g.cam0.z, wy = (g.m0.y - g.cam0.y) / g.cam0.z;
    this.cam = { x: m.x - wx * z, y: m.y - wy * z, z };
    this.applyCamera();
  }

  onWheel(e) {
    if (e.target instanceof Element && e.target.closest('.is-live .el-media')) return;
    e.preventDefault();
    cancelAnimationFrame(this._anim);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      const dy = clamp(e.deltaY * unit, -60, 60);
      this.zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.01));
    } else if (this.prefs.wheelZoom && !e.shiftKey && Math.abs(e.deltaX) < 1) {
      this.zoomAt(e.clientX, e.clientY, Math.exp(-clamp(e.deltaY * unit, -200, 200) * 0.0016));
    } else {
      let dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      this.cam = { ...this.cam, x: this.cam.x - dx, y: this.cam.y - dy };
      this.applyCamera();
    }
  }

  // Pointer capture retargets click events to the viewport, so look up what is really under the pointer.
  targetAt(e) {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    return t instanceof Element && this.vp.contains(t) ? t : (e.target instanceof Element ? e.target : null);
  }

  onDblClick(e) {
    const target = this.targetAt(e);
    if (!target) return;
    if (target.closest('[contenteditable="true"], [data-noptr]')) return;
    const node = target.closest('[data-eid]');
    const el = node ? this.byId.get(node.dataset.eid) : null;
    if (!el) {
      if (this.tool === 'select' && !this.presenting && !target.closest('[data-handle]')) {
        const made = this.makeEl('text', null, this.toWorld(e.clientX, e.clientY));
        made.x = this.toWorld(e.clientX, e.clientY).x - 4;
        made.autoW = true;
        this.addEls([made], { edit: true });
      }
      return;
    }
    if (el.type === 'video' || el.type === 'embed') { this.activate(el.id); return; }
    if (this.presenting || el.locked) return;
    if (TEXTUAL.has(el.type) || el.type === 'frame') this.startEditing(el.id);
    else if (el.type === 'link' && el.url) window.open(el.url, '_blank', 'noopener');
  }

  onContextMenu(e) {
    const target = this.targetAt(e);
    if (!target || target.closest('[contenteditable="true"]')) return;
    e.preventDefault();
    if (this.presenting) return;
    const node = target.closest('[data-eid]');
    const el = node ? this.byId.get(node.dataset.eid) : null;
    if (el && !this.sel.has(el.id)) this.select([el.id]);
    if (!el) this.clearSel();
    this.emit('contextmenu', { x: e.clientX, y: e.clientY, onElement: !!el, at: this.toWorld(e.clientX, e.clientY) });
  }

  /* ================= editing ================= */
  // fresh: the element was just created, so typing into it shouldn't add a second undo step.
  startEditing(id, { selectAll = false, fresh = false } = {}) {
    const el = this.byId.get(id);
    if (!el || el.locked) return;
    this.finishEditing();
    const node = this.nodes.get(id);
    const target = el.type === 'frame' ? node?._title : node?._text;
    if (!target) return;
    this.editingId = id;
    this.sel = new Set([id]);
    for (const [nid, n] of this.nodes) n.classList.toggle('is-selected', this.sel.has(nid));
    node.classList.add('is-editing');
    target.contentEditable = 'true';
    target.spellcheck = true;
    target.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(target);
    if (!selectAll) range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || (el.type === 'frame' && e.key === 'Enter')) {
        e.preventDefault();
        this.finishEditing();
        this.vp.focus({ preventScroll: true });
      }
    };
    const onInput = () => {
      if (el.type === 'sticky') fitText(node, el);
      if (el.type === 'text') {
        const hgt = node.offsetHeight;
        const cur = this.byId.get(id);
        const wid = cur?.autoW ? node.offsetWidth : cur?.w;
        if (cur && (Math.abs(hgt - cur.h) > 0.5 || Math.abs(wid - cur.w) > 0.5)) {
          this.els = this.els.map((x) => (x.id === id ? { ...x, h: hgt, w: wid } : x));
          this.byId = new Map(this.els.map((x) => [x.id, x]));
          node._el = this.byId.get(id);
        }
      }
      this.renderOverlay();
    };
    const onPaste = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData('text/plain') || '';
      document.execCommand('insertText', false, text);
    };
    const onBlur = () => { if (this.editingId === id) this.finishEditing(); };
    target.addEventListener('keydown', onKey);
    target.addEventListener('input', onInput);
    target.addEventListener('paste', onPaste);
    target.addEventListener('blur', onBlur);
    this._edit = { id, target, node, fresh, off: () => {
      target.removeEventListener('keydown', onKey);
      target.removeEventListener('input', onInput);
      target.removeEventListener('paste', onPaste);
      target.removeEventListener('blur', onBlur);
    } };
    this.renderOverlay();
    this.emit('selection');
  }

  finishEditing() {
    const ed = this._edit;
    if (!ed) return;
    this._edit = null;
    this.editingId = null;
    ed.off();
    const { id, target, node, fresh } = ed;
    // innerText keeps line breaks typed into contentEditable; frame titles use textContent
    // because innerText would bake in the CSS uppercase transform.
    const raw = (node.classList.contains('el-frame') ? target.textContent : target.innerText).replace(/ /g, ' ');
    const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    target.contentEditable = 'false';
    node.classList.remove('is-editing');
    window.getSelection()?.removeAllRanges();
    const el = this.byId.get(id);
    if (!el) return;
    if (el.type === 'text' && !text.trim()) {
      // An empty text box disappears. A brand-new one leaves no history entry.
      this.setEls(this.els.filter((e) => e.id !== id), { commit: !!(el.text || '').trim() });
      this.emit('selection');
      return;
    }
    const key = el.type === 'frame' ? 'title' : 'text';
    const value = el.type === 'frame' ? (text.trim() || 'Frame') : text;
    if (value !== (el[key] || '')) this.updateEls([id], { [key]: value }, { commit: !fresh });
    else { node._force = true; this.sync(); }
    this.emit('selection');
  }

  activate(id) {
    this.activeId = id;
    const n = this.nodes.get(id);
    if (n) n._force = true;
    this.sync();
    this.emit('selection');
  }

  deactivate() {
    const id = this.activeId;
    if (!id) return;
    this.activeId = null;
    const n = this.nodes.get(id);
    if (n) n._force = true;
    this.sync();
    this.emit('selection');
  }

  /* ================= commands ================= */
  cloneEls(ids, dx = 24, dy = 24) {
    const set = new Set(ids);
    const map = new Map(ids.map((id) => [id, uid()]));
    const groupMap = new Map();
    const out = [];
    for (const el of this.els) {
      if (!set.has(el.id)) continue;
      const c = structuredClone(el);
      c.id = map.get(el.id);
      if (c.group) { if (!groupMap.has(c.group)) groupMap.set(c.group, uid()); c.group = groupMap.get(c.group); }
      if (c.type === 'line') {
        c.a = c.a?.id && map.has(c.a.id) ? { ...c.a, id: map.get(c.a.id) } : (() => { const g = lineGeom(el, this.byId); return { x: g.a.x + dx, y: g.a.y + dy }; })();
        c.b = c.b?.id && map.has(c.b.id) ? { ...c.b, id: map.get(c.b.id) } : (() => { const g = lineGeom(el, this.byId); return { x: g.b.x + dx, y: g.b.y + dy }; })();
      } else { c.x += dx; c.y += dy; }
      delete c.locked;
      out.push(c);
    }
    return out;
  }

  duplicate() {
    const ids = this.selected().map((e) => e.id);
    if (!ids.length) return;
    const clones = this.cloneEls(ids);
    this.setEls([...this.els, ...clones]);
    this.select(clones.map((c) => c.id));
  }

  deleteSelection() {
    const ids = this.selected().filter((e) => !e.locked).map((e) => e.id);
    if (ids.length) this.removeEls(ids);
  }

  serializeSelection() {
    const sel = this.selected();
    if (!sel.length) return null;
    // Resolve connector endpoints so a pasted copy keeps its shape.
    const els = sel.map((el) => {
      if (el.type !== 'line') return el;
      const g = lineGeom(el, this.byId);
      return { ...el, a: { ...el.a, x: g.a.x, y: g.a.y }, b: { ...el.b, x: g.b.x, y: g.b.y } };
    });
    return CLIP_MARK + JSON.stringify({ els });
  }

  copy() {
    const text = this.serializeSelection();
    if (!text) return false;
    this.clipboard = text;
    navigator.clipboard?.writeText(text).catch(() => {});
    return true;
  }

  onCopy(e, cut) {
    if (!this.vp.isConnected || isTypingTarget(e.target) || isTypingTarget(document.activeElement) || this.editingId) return;
    if (window.getSelection()?.toString()) return; // let normal text selection copy work
    const text = this.serializeSelection();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
    this.clipboard = text;
    if (cut) this.deleteSelection();
  }

  onPaste(e) {
    if (!this.vp.isConnected || isTypingTarget(e.target) || this.editingId || this.presenting) return;
    if (document.querySelector('.dlg-overlay')) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const at = this.pasteAnchor();
    const files = [...dt.files].filter((f) => /^(image|video)\//.test(f.type));
    if (files.length) { e.preventDefault(); this.emit('files', { files, at }); return; }
    const text = dt.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (text.startsWith(CLIP_MARK)) { this.pasteSerialized(text, at); return; }
    const t = text.trim();
    if (/^https?:\/\/\S+$/i.test(t)) { this.emit('url', { url: t, at }); return; }
    const el = this.makeEl('text', null, at);
    el.text = t.slice(0, 5000);
    el.w = Math.min(520, Math.max(160, Math.min(t.length, 60) * 11));
    this.addEls([el]);
  }

  pasteAnchor() {
    const lp = this.lastPointer;
    if (lp) {
      const sp = this.toScreen(lp);
      const r = this.rect();
      if (sp.x >= r.left && sp.x <= r.right && sp.y >= r.top && sp.y <= r.bottom) return lp;
    }
    return this.viewCenter();
  }

  pasteSerialized(text, at) {
    let data;
    try { data = JSON.parse(text.slice(CLIP_MARK.length)); } catch { return; }
    const list = (data?.els || []).filter((x) => x && x.id && x.type);
    if (!list.length) return;
    const map = new Map(list.map((x) => [x.id, uid()]));
    const groupMap = new Map();
    const rect = unionRects(list.map((x) => (x.type === 'line' ? { x: Math.min(x.a.x, x.b.x), y: Math.min(x.a.y, x.b.y), w: Math.abs(x.a.x - x.b.x), h: Math.abs(x.a.y - x.b.y) } : { x: x.x, y: x.y, w: x.w, h: x.h })));
    const c = center(rect);
    const dx = at.x - c.x, dy = at.y - c.y;
    const out = list.map((src) => {
      const el = structuredClone(src);
      el.id = map.get(src.id);
      delete el.locked;
      if (el.group) { if (!groupMap.has(el.group)) groupMap.set(el.group, uid()); el.group = groupMap.get(el.group); }
      if (el.type === 'line') {
        for (const k of ['a', 'b']) {
          const end = el[k];
          if (end.id && map.has(end.id)) el[k] = { ...end, id: map.get(end.id), x: end.x + dx, y: end.y + dy };
          else el[k] = { x: end.x + dx, y: end.y + dy };
        }
      } else { el.x += dx; el.y += dy; }
      return el;
    });
    this.addEls(out);
  }

  group() {
    const sel = this.selected();
    if (sel.length < 2) return;
    const gid = uid();
    this.updateEls(sel.map((e) => e.id), { group: gid });
    this.emit('selection');
  }

  ungroup() {
    const ids = new Set(this.selected().filter((e) => e.group).map((e) => e.id));
    if (!ids.size) return;
    this.setEls(this.els.map((e) => { if (!ids.has(e.id)) return e; const c = { ...e }; delete c.group; return c; }));
    this.emit('selection');
  }

  toggleLock() {
    const sel = this.selected();
    if (!sel.length) return;
    const lock = !sel.every((e) => e.locked);
    this.updateEls(sel.map((e) => e.id), { locked: lock });
    this.emit('selection');
  }

  bringToFront() {
    const set = this.sel;
    if (!set.size) return;
    this.setEls([...this.els.filter((e) => !set.has(e.id)), ...this.els.filter((e) => set.has(e.id))]);
  }

  sendToBack() {
    const set = this.sel;
    if (!set.size) return;
    this.setEls([...this.els.filter((e) => set.has(e.id)), ...this.els.filter((e) => !set.has(e.id))]);
  }

  align(kind) {
    const sel = this.selected().filter((e) => e.type !== 'line' && !e.locked);
    if (sel.length < 2) return;
    const r = unionRects(sel.map((e) => rectOf(e)));
    const patch = (e) => {
      switch (kind) {
        case 'left': return { x: r.x };
        case 'right': return { x: r.x + r.w - e.w };
        case 'center': return { x: r.x + r.w / 2 - e.w / 2 };
        case 'top': return { y: r.y };
        case 'bottom': return { y: r.y + r.h - e.h };
        case 'middle': return { y: r.y + r.h / 2 - e.h / 2 };
        default: return {};
      }
    };
    this.updateEls(sel.map((e) => e.id), (e) => movedTo(e, patch(e)));
  }

  distribute(axis) {
    const sel = this.selected().filter((e) => e.type !== 'line' && !e.locked);
    if (sel.length < 3) return;
    const key = axis === 'h' ? 'x' : 'y', size = axis === 'h' ? 'w' : 'h';
    const sorted = [...sel].sort((a, b) => a[key] - b[key]);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const total = sorted.reduce((s2, e) => s2 + e[size], 0);
    const gap = (last[key] + last[size] - first[key] - total) / (sorted.length - 1);
    let cur = first[key];
    const pos = new Map();
    for (const e of sorted) { pos.set(e.id, cur); cur += e[size] + gap; }
    this.updateEls(sorted.map((e) => e.id), (e) => movedTo(e, { [key]: pos.get(e.id) }));
  }

  nudge(dx, dy) {
    const sel = this.selected().filter((e) => !e.locked);
    if (!sel.length) return;
    const before = this.els;
    const ids = new Set(sel.map((e) => e.id));
    this.setEls(this.els.map((e) => (ids.has(e.id) ? moved(e, dx, dy) : e)), { commit: false });
    clearTimeout(this._nudgeT);
    if (!this._nudgeBefore) this._nudgeBefore = before;
    this._nudgeT = setTimeout(() => { this.commitFrom(this._nudgeBefore); this._nudgeBefore = null; }, 400);
    this.emit('selection');
  }

  connectorFrom(src, b) {
    return {
      id: uid(), type: 'line', ...DEFAULTS.line, ...(this.lastStyle.line || {}),
      route: this.lastStyle.line?.route || 'curve',
      a: { id: src.id, x: src.x + src.w / 2, y: src.y + src.h / 2 }, b,
    };
  }

  // Drag from a connection dot: the connector follows the pointer and snaps to whatever you drop it on.
  // A click without dragging adds a connected item on that side instead.
  beginAnchor(start, dir) {
    const src = this.selected()[0];
    if (!src || src.locked) return;
    const before = this.els;
    let line = null;
    this.startGesture({
      type: 'anchor', pointerId: start.pointerId,
      onMove: (p, e) => {
        if (!line) {
          if (Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < 5) return;
          line = this.connectorFrom(src, { x: p.x, y: p.y });
          this.setEls([...this.els, line], { commit: false });
        }
        const t = this.elementAt(p, line.id);
        const bindId = t && t.id !== src.id ? t.id : null;
        if (bindId !== this.bindHover) this.bindHover = bindId;
        const b = bindId ? { id: bindId, x: p.x, y: p.y } : { x: p.x, y: p.y };
        this.setEls(this.els.map((el) => (el.id === line.id ? { ...el, b } : el)), { commit: false });
      },
      onUp: () => {
        this.bindHover = null;
        if (!line) { this.quickCreate(dir); return; }
        this.pushUndo(before);
        this.emit('change', { commit: true });
        this.sel = new Set([line.id]);
        this.syncSelection();
      },
    });
  }

  // Add a connected item on one side: a blank copy for notes, shapes and text; a sticky next to media.
  quickCreate(dir) {
    const src = this.selected()[0];
    if (!src) return;
    const gap = 90;
    let next;
    if (src.type === 'sticky' || src.type === 'shape' || src.type === 'text') {
      next = { ...structuredClone(src), id: uid(), text: '' };
      delete next.group; delete next.locked;
    } else {
      next = this.makeEl('sticky', { x: 0, y: 0, w: 200, h: 200 });
    }
    const cx = src.x + src.w / 2, cy = src.y + src.h / 2;
    if (dir === 'e') { next.x = src.x + src.w + gap; next.y = cy - next.h / 2; }
    else if (dir === 'w') { next.x = src.x - gap - next.w; next.y = cy - next.h / 2; }
    else if (dir === 's') { next.x = cx - next.w / 2; next.y = src.y + src.h + gap; }
    else { next.x = cx - next.w / 2; next.y = src.y - gap - next.h; }
    const line = this.connectorFrom(src, { id: next.id, x: next.x, y: next.y });
    this.setEls([...this.els, line, next]);
    this.sel = new Set([next.id]);
    this.syncSelection();
    this.startEditing(next.id, { fresh: true });
  }

  /* ================= keyboard ================= */
  onKeyDown(e) {
    if (!this.vp.isConnected) return;
    if (isTypingTarget(e.target) || document.querySelector('.dlg-overlay')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();

    if (this.presenting) {
      if (e.key === 'Escape') { e.preventDefault(); this.emit('present', 'exit'); }
      else if (['arrowright', 'arrowdown', ' ', 'pagedown', 'enter'].includes(k)) { e.preventDefault(); this.emit('present', 'next'); }
      else if (['arrowleft', 'arrowup', 'pageup', 'backspace'].includes(k)) { e.preventDefault(); this.emit('present', 'prev'); }
      return;
    }

    if (e.key === ' ' && !mod) {
      e.preventDefault();
      if (!this.space) { this.space = true; this.vp.classList.add('is-space'); }
      return;
    }
    if (mod) {
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
      else if (k === 'y') { e.preventDefault(); this.redo(); }
      else if (k === 'a') { e.preventDefault(); this.selectAll(); }
      else if (k === 'd') { e.preventDefault(); this.duplicate(); }
      else if (k === 'g') { e.preventDefault(); if (e.shiftKey) this.ungroup(); else this.group(); }
      else if (k === 'l' && e.shiftKey) { e.preventDefault(); this.toggleLock(); }
      else if (k === 'f') { e.preventDefault(); this.emit('command', 'search'); }
      else if (k === '=' || k === '+') { e.preventDefault(); this.zoomBy(1.25); }
      else if (k === '-' || k === '_') { e.preventDefault(); this.zoomBy(0.8); }
      else if (k === '0') { e.preventDefault(); this.zoomTo(1); }
      else if (k === 'e') { e.preventDefault(); this.emit('command', 'export'); }
      return;
    }
    if (e.altKey) return;

    if (e.key === 'Escape') {
      if (this.g) return;
      if (this.activeId) this.deactivate();
      else if (this.tool !== 'select') this.setTool('select');
      else this.clearSel();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); return; }
    if (e.key === 'Enter') {
      const sel = this.selected();
      if (sel.length === 1 && (TEXTUAL.has(sel[0].type) || sel[0].type === 'frame')) { e.preventDefault(); this.startEditing(sel[0].id); }
      return;
    }
    if (e.key.startsWith('Arrow')) {
      if (!this.sel.size) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      this.nudge(d[0], d[1]);
      return;
    }
    if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); this.zoomToFit(); return; }
    if (e.shiftKey && e.code === 'Digit2') { e.preventDefault(); this.zoomToSelection(); return; }
    if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) { e.preventDefault(); this.emit('command', 'shortcuts'); return; }
    if (e.key === ']') { this.bringToFront(); return; }
    if (e.key === '[') { this.sendToBack(); return; }
    const tools = { v: 'select', h: 'hand', n: 'sticky', t: 'text', s: 'shape', l: 'line', p: 'pen', e: 'eraser', f: 'frame' };
    if (tools[k] && !e.shiftKey) {
      if (k === 'p') this.setOpt('pen', 'pen');
      this.setTool(tools[k]);
      return;
    }
    if (k === 'r') { this.setOpt('shape', 'rect'); this.setTool('shape'); return; }
    if (k === 'o') { this.setOpt('shape', 'ellipse'); this.setTool('shape'); return; }
    if (k === 'a') { this.setOpt('line', 'arrow'); this.setTool('line'); return; }
    if (k === 'u') { this.emit('command', 'upload'); return; }
    if (k === 'k') { this.emit('command', 'embed'); return; }
    if (k === 'g') { this.setPref('grid', !this.prefs.grid); return; }
  }

  onKeyUp(e) {
    if (e.key === ' ') { this.space = false; this.vp.classList.remove('is-space'); }
  }
}

/* ---------------- helpers ---------------- */
const snap = (v) => Math.round(v / 8) * 8;

function moved(el, dx, dy) {
  if (el.type === 'line') {
    return { ...el, a: el.a.id ? el.a : { x: el.a.x + dx, y: el.a.y + dy }, b: el.b.id ? el.b : { x: el.b.x + dx, y: el.b.y + dy } };
  }
  return { ...el, x: el.x + dx, y: el.y + dy };
}

function movedTo(el, patch) {
  return el.type === 'line' ? el : { ...el, ...patch };
}

function resized(el, nr, sx, sy, mapPt, single, corner) {
  if (el.type === 'line') {
    return { ...el, a: el.a.id ? el.a : mapPt(el.a), b: el.b.id ? el.b : mapPt(el.b) };
  }
  if (el.type === 'pen') {
    const kx = nr.w / (el.w || 1), ky = nr.h / (el.h || 1);
    return { ...el, ...nr, points: (el.points || []).map(([x, y]) => [Math.round(x * kx * 100) / 100, Math.round(y * ky * 100) / 100]) };
  }
  if (el.type === 'text') {
    const out = { ...el, x: nr.x, y: nr.y, w: Math.max(24, nr.w), autoW: false };
    if (single && corner) out.fontSize = Math.max(6, Math.round((el.fontSize || 22) * sx * 2) / 2);
    else if (!single) out.fontSize = Math.max(6, Math.round((el.fontSize || 22) * Math.min(sx, sy) * 2) / 2);
    return out;
  }
  const out = { ...el, ...nr };
  if (!single && el.fontSize && (el.type === 'shape' || el.type === 'sticky')) out.fontSize = Math.max(6, Math.round(el.fontSize * Math.min(sx, sy) * 2) / 2);
  return out;
}
