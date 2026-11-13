// Moteur d'écriture : rendu Canvas, saisie stylet/doigt/souris, zoom, gomme.
// Deux calques : « base » (contenu validé, redessiné seulement quand il change)
// et « overlay » (trait en cours, traits distants en direct, curseurs), ce qui
// garde l'écriture fluide même sur un carnet très chargé.
import * as Y from 'yjs';
import { LOCAL } from './sync.js';

export const TOOLS = {
  pen: { label: 'Stylo', alpha: 1, width: 1 },
  pencil: { label: 'Crayon', alpha: 0.72, width: 0.6 },
  highlighter: { label: 'Surligneur', alpha: 0.32, width: 5 },
};

let idCounter = 0;
export function newId(prefix = 'i') {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return `${prefix}${a[0].toString(36)}${a[1].toString(36)}${(idCounter++).toString(36)}`;
}

const r1 = (v) => Math.round(v * 10) / 10;

function strokeWidth(s) { return s.size * (TOOLS[s.tool]?.width ?? 1); }

function bboxOf(item) {
  if (item.type === 'text') {
    const lines = String(item.text || '').split('\n');
    const w = Math.max(...lines.map((l) => l.length), 1) * item.fs * 0.62;
    return [item.x - 4, item.y - 4, item.x + w + 4, item.y + lines.length * item.fs * 1.3 + 4];
  }
  if (item.type === 'image') return [item.x - 4, item.y - 4, item.x + item.w + 4, item.y + item.h + 30];
  const p = item.pts; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
  }
  const m = strokeWidth(item) * 1.2 + 2;
  return [x0 - m, y0 - m, x1 + m, y1 + m];
}

// Courbe lissée passant par les milieux des segments
function buildPath(p) {
  const path = new Path2D();
  const n = p.length / 3;
  path.moveTo(p[0], p[1]);
  if (n === 1) { path.lineTo(p[0] + 0.01, p[1] + 0.01); return path; }
  if (n === 2) { path.lineTo(p[3], p[4]); return path; }
  for (let i = 1; i < n - 1; i++) {
    const x = p[i * 3], y = p[i * 3 + 1];
    path.quadraticCurveTo(x, y, (x + p[i * 3 + 3]) / 2, (y + p[i * 3 + 4]) / 2);
  }
  path.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
  return path;
}

function drawStroke(ctx, s, cache) {
  const p = s.pts;
  if (!p || p.length < 3) return;
  const tool = TOOLS[s.tool] || TOOLS.pen;
  const w = strokeWidth(s);
  ctx.strokeStyle = s.color;
  ctx.globalAlpha = tool.alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = s.tool === 'highlighter' ? 'butt' : 'round';
  if (s.tool === 'highlighter') ctx.globalCompositeOperation = 'multiply';
  if (s.vp && s.tool === 'pen' && p.length >= 6) {
    // Stylet : épaisseur variable selon la pression
    let px = p[0], py = p[1], pw = w * (0.35 + p[2] * 1.3);
    for (let i = 3; i < p.length; i += 3) {
      const cw = w * (0.35 + p[i + 2] * 1.3);
      ctx.lineWidth = (pw + cw) / 2;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(p[i], p[i + 1]); ctx.stroke();
      px = p[i]; py = p[i + 1]; pw = cw;
    }
  } else {
    ctx.lineWidth = w;
    let path = cache?.path;
    if (!path) { path = buildPath(p); if (cache) cache.path = path; }
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawText(ctx, t) {
  ctx.fillStyle = t.color;
  ctx.font = `${t.fs}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'top';
  String(t.text || '').split('\n').forEach((line, i) => ctx.fillText(line, t.x, t.y + i * t.fs * 1.3));
}

// Photos : chargées une fois, puis redessinées dès qu'elles sont prêtes
const imageCache = new Map();
function drawImage(ctx, it, onReady) {
  let im = imageCache.get(it.img);
  if (!im) {
    im = new Image();
    im.onload = onReady;
    im.src = `/api/img/${it.img}`;
    imageCache.set(it.img, im);
  }
  ctx.save();
  ctx.beginPath(); ctx.roundRect(it.x, it.y, it.w, it.h, 10); ctx.clip();
  if (im.complete && im.naturalWidth) ctx.drawImage(im, it.x, it.y, it.w, it.h);
  else { ctx.fillStyle = '#efece4'; ctx.fillRect(it.x, it.y, it.w, it.h); }
  ctx.restore();
  ctx.strokeStyle = '#d8d3c7'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(it.x, it.y, it.w, it.h, 10); ctx.stroke();
  if (it.label) {
    ctx.fillStyle = '#1c1b19';
    ctx.font = '600 15px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(it.label.charAt(0).toUpperCase() + it.label.slice(1), it.x + 2, it.y + it.h + 8, it.w - 4);
  }
}

// Croquis -> PNG noir sur blanc, cadré, pour la reconnaissance
export function sketchToPng(strokes, size = 448) {
  let b = null;
  for (const s of strokes) { const sb = bboxOf(s); b = b ? [Math.min(b[0], sb[0]), Math.min(b[1], sb[1]), Math.max(b[2], sb[2]), Math.max(b[3], sb[3])] : sb; }
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
  const pad = 28, k = Math.min((size - pad * 2) / Math.max(1, b[2] - b[0]), (size - pad * 2) / Math.max(1, b[3] - b[1]));
  ctx.translate(size / 2 - ((b[0] + b[2]) / 2) * k, size / 2 - ((b[1] + b[3]) / 2) * k);
  ctx.scale(k, k);
  for (const s of strokes) drawStroke(ctx, { ...s, tool: 'pen', color: '#000', vp: 0, size: Math.max(s.size, 3 / k) });
  return c.toDataURL('image/png').split(',')[1];
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class Board {
  constructor(container, doc, sync, callbacks = {}) {
    this.el = container;
    this.doc = doc;
    this.sync = sync;
    this.cb = callbacks;
    this.items = doc.getMap('items');
    this.meta = doc.getMap('meta');
    this.undo = new Y.UndoManager(this.items, { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
    this.undo.on('stack-item-added', () => this.cb.onHistory?.());
    this.undo.on('stack-item-popped', () => this.cb.onHistory?.());
    this.undo.on('stack-cleared', () => this.cb.onHistory?.());
    sync.skipOrigins.delete(this.undo); // les annulations sont bien des modifications locales à envoyer

    this.view = { x: 0, y: 0, k: 1 };
    this.tool = 'pen'; this.color = '#1c1b19'; this.size = 3;
    this.cache = new Map();      // id -> { item, bbox, path }
    this.order = [];
    this.live = new Map();       // "cid:id" -> trait distant en cours
    this.cursors = new Map();    // cid -> { x, y, t }
    this.magicIds = new Set();   // traits du croquis « dessin magique » en cours
    this.hidden = new Set();     // éléments gommés pendant le geste en cours
    this.pointers = new Map();
    this.current = null;
    this.penSeen = false;
    this.follow = false;
    this.spaceDown = false;

    this.base = document.createElement('canvas');
    this.over = document.createElement('canvas');
    for (const c of [this.base, this.over]) { c.className = 'board-canvas'; container.appendChild(c); }
    this.bctx = this.base.getContext('2d');
    this.octx = this.over.getContext('2d');

    this._onItems = (ev) => {
      for (const id of ev.keysChanged) {
        const item = this.items.get(id);
        if (item) this.cache.set(id, { item, bbox: bboxOf(item) }); else this.cache.delete(id);
        for (const key of this.live.keys()) if (key.endsWith(':' + id)) this.live.delete(key);
      }
      this._reorder();
      this.dirtyBase = this.dirtyOver = true;
      this.cb.onContent?.();
    };
    this.items.observe(this._onItems);
    this._onMeta = () => { this.dirtyBase = true; this.cb.onMeta?.(); };
    this.meta.observe(this._onMeta);
    this.items.forEach((item, id) => this.cache.set(id, { item, bbox: bboxOf(item) }));
    this._reorder();

    this.offs = [
      sync.on('live', (m) => this._onLive(m)),
      sync.on('live-end', (m) => { const l = this.live.get(`${m.cid}:${m.id}`); if (l) l.expire = performance.now() + 1500; }),
      sync.on('cursor', (m) => { this.cursors.set(m.cid, { x: m.x, y: m.y, t: performance.now() }); this.dirtyOver = true; }),
      sync.on('view', (m) => { this.remoteView = m.r; if (this.follow) this._applyRemoteView(); }),
      sync.on('gone', (m) => { this.cursors.delete(m.cid); for (const k of this.live.keys()) if (k.startsWith(m.cid + ':')) this.live.delete(k); this.dirtyOver = true; }),
      sync.on('peers', () => { this.dirtyOver = true; this._sendView(true); }),
    ];

    this._bind();
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(container);
    this._resize();
    this.view.x = Math.max(16, this.w / 2 - 400); this.view.y = 70;
    // À la première synchronisation, cadre le contenu s'il n'est pas entièrement visible
    const offSynced = sync.on('synced', () => {
      offSynced();
      const b = this.contentBounds();
      if (!b || this.userMoved || this.follow) return;
      const [x0, y0] = this.toWorld(0, 0), [x1, y1] = this.toWorld(this.w, this.h);
      if (b[0] < x0 || b[1] < y0 || b[2] > x1 || b[3] > y1) this.fitRect(...b, 40, 1);
    });
    this.offs.push(offSynced);
    const loop = () => { this.raf = requestAnimationFrame(loop); this._frame(); };
    loop();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.items.unobserve(this._onItems);
    this.meta.unobserve(this._onMeta);
    this.offs.forEach((f) => f());
    this.undo.destroy();
    this.abort.abort();
    this.base.remove(); this.over.remove();
  }

  // ---------- Coordonnées et vue ----------
  toWorld(sx, sy) { return [(sx - this.view.x) / this.view.k, (sy - this.view.y) / this.view.k]; }
  toScreen(wx, wy) { return [wx * this.view.k + this.view.x, wy * this.view.k + this.view.y]; }

  zoomAt(sx, sy, factor) {
    const k = Math.max(0.1, Math.min(8, this.view.k * factor));
    const [wx, wy] = this.toWorld(sx, sy);
    this.view.k = k; this.view.x = sx - wx * k; this.view.y = sy - wy * k;
    this._viewChanged();
  }
  zoomBy(factor) { this.zoomAt(this.w / 2, this.h / 2, factor); }
  resetZoom() { this.zoomAt(this.w / 2, this.h / 2, 1 / this.view.k); }
  fitRect(x0, y0, x1, y1, pad = 40, maxK = 4) {
    const k = Math.max(0.1, Math.min(maxK, Math.min((this.w - pad * 2) / Math.max(1, x1 - x0), (this.h - pad * 2) / Math.max(1, y1 - y0))));
    this.view.k = k;
    this.view.x = this.w / 2 - ((x0 + x1) / 2) * k;
    this.view.y = this.h / 2 - ((y0 + y1) / 2) * k;
    this._viewChanged(true);
  }
  contentBounds() {
    let b = null;
    for (const { bbox } of this.cache.values()) b = b ? [Math.min(b[0], bbox[0]), Math.min(b[1], bbox[1]), Math.max(b[2], bbox[2]), Math.max(b[3], bbox[3])] : [...bbox];
    return b;
  }
  fitContent() { const b = this.contentBounds(); if (b) this.fitRect(...b); }
  _viewChanged(fromRemote) {
    this.dirtyBase = this.dirtyOver = true;
    this.cb.onView?.();
    if (!fromRemote) this._sendView();
  }
  _sendView(force) {
    if (this.sync.me?.role !== 'owner') return;
    const now = performance.now();
    if (!force && now - (this._lastView || 0) < 80) { clearTimeout(this._viewTimer); this._viewTimer = setTimeout(() => this._sendView(true), 90); return; }
    this._lastView = now;
    const [x0, y0] = this.toWorld(0, 0), [x1, y1] = this.toWorld(this.w, this.h);
    this.sync.send({ t: 'view', r: [r1(x0), r1(y0), r1(x1), r1(y1)] });
  }
  setFollow(on) { this.follow = on; if (on) this._applyRemoteView(); }
  _applyRemoteView() { if (this.remoteView) this.fitRect(...this.remoteView, 0); }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = this.el.clientWidth; this.h = this.el.clientHeight; this.dpr = dpr;
    for (const c of [this.base, this.over]) { c.width = Math.round(this.w * dpr); c.height = Math.round(this.h * dpr); }
    this.dirtyBase = this.dirtyOver = true;
    if (this.follow) this._applyRemoteView();
  }

  _reorder() {
    this.order = [...this.cache.entries()].sort((a, b) => (a[1].item.z || 0) - (b[1].item.z || 0) || (a[0] < b[0] ? -1 : 1));
  }

  // ---------- Rendu ----------
  _frame() {
    const now = performance.now();
    for (const [k, l] of this.live) if (l.expire && now > l.expire) { this.live.delete(k); this.dirtyOver = true; }
    for (const [cid, c] of this.cursors) if (now - c.t > 6000) { this.cursors.delete(cid); this.dirtyOver = true; }
    if (this.dirtyBase) { this.dirtyBase = false; this._drawBase(); }
    if (this.dirtyOver) { this.dirtyOver = false; this._drawOver(); }
  }

  _setTransform(ctx) {
    const { x, y, k } = this.view, d = this.dpr;
    ctx.setTransform(k * d, 0, 0, k * d, x * d, y * d);
  }

  _drawPaper(ctx) {
    const paper = this.meta.get('paper') || 'blank';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#fffefb';
    ctx.fillRect(0, 0, this.w, this.h);
    if (paper === 'blank') return;
    const step = (paper === 'grid' ? 32 : 40) * this.view.k;
    if (step < 7) return;
    ctx.strokeStyle = paper === 'grid' ? '#e4e9f0' : '#d5deeb';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = ((this.view.y % step) + step) % step; y < this.h; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(this.w, Math.round(y) + 0.5); }
    if (paper === 'grid') for (let x = ((this.view.x % step) + step) % step; x < this.w; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, this.h); }
    ctx.stroke();
  }

  _drawBase() {
    const ctx = this.bctx;
    this._drawPaper(ctx);
    this._setTransform(ctx);
    const [vx0, vy0] = this.toWorld(0, 0), [vx1, vy1] = this.toWorld(this.w, this.h);
    for (const [id, entry] of this.order) {
      const b = entry.bbox;
      if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
      if (this.hidden.has(id) || id === this.editingId) continue;
      const type = entry.item.type;
      if (type === 'text') drawText(ctx, entry.item);
      else if (type === 'image') drawImage(ctx, entry.item, () => { this.dirtyBase = true; });
      else drawStroke(ctx, entry.item, entry);
    }
  }

  _drawOver() {
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.over.width, this.over.height);
    this._setTransform(ctx);
    for (const l of this.live.values()) drawStroke(ctx, l);
    if (this.current) drawStroke(ctx, this.current);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.eraserAt) {
      ctx.strokeStyle = '#8a8780'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(this.eraserAt[0], this.eraserAt[1], this._eraserRadius(), 0, Math.PI * 2); ctx.stroke();
    }
    const peers = new Map((this.sync.peers || []).map((p) => [p.cid, p]));
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const [cid, c] of this.cursors) {
      const p = peers.get(cid); if (!p) continue;
      const [sx, sy] = this.toScreen(c.x, c.y);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(sx, sy, 4.5, 0, Math.PI * 2); ctx.fill();
      const label = p.name; const tw = ctx.measureText(label).width;
      ctx.beginPath(); ctx.roundRect(sx + 9, sy - 9, tw + 12, 18, 9); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(label, sx + 15, sy + 0.5);
    }
  }

  // ---------- Synchronisation en direct (éphémère) ----------
  _onLive(m) {
    const key = `${m.cid}:${m.id}`;
    if (this.items.has(m.id)) return;
    let l = this.live.get(key);
    if (!l) { l = { ...m.s, pts: [] }; this.live.set(key, l); }
    for (const v of m.pts) l.pts.push(v);
    l.path = null;
    const n = l.pts.length;
    if (n >= 3) this.cursors.set(m.cid, { x: l.pts[n - 3], y: l.pts[n - 2], t: performance.now() });
    this.dirtyOver = true;
  }
  _flushLive(end) {
    const s = this.current; if (!s) return;
    if (s.pts.length > s.sent) {
      this.sync.send({ t: 'live', id: s.id, s: { tool: s.tool, color: s.color, size: s.size, vp: s.vp }, pts: s.pts.slice(s.sent) });
      s.sent = s.pts.length;
    }
    if (end) this.sync.send({ t: 'live-end', id: s.id });
  }

  // ---------- Saisie ----------
  _bind() {
    this.abort = new AbortController();
    const o = { signal: this.abort.signal, passive: false };
    const c = this.over;
    c.addEventListener('pointerdown', (e) => this._down(e), o);
    c.addEventListener('pointermove', (e) => this._move(e), o);
    c.addEventListener('pointerup', (e) => this._up(e), o);
    c.addEventListener('pointercancel', (e) => this._up(e, true), o);
    c.addEventListener('pointerleave', () => { if (this.eraserAt && !this.erasing) { this.eraserAt = null; this.dirtyOver = true; } }, o);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._userMovedView();
      if (e.ctrlKey || e.metaKey) this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.01));
      else { this.view.x -= e.deltaX; this.view.y -= e.deltaY; this._viewChanged(); }
    }, o);
    c.addEventListener('contextmenu', (e) => e.preventDefault(), o);
    c.addEventListener('touchstart', (e) => e.preventDefault(), o);
  }

  _pos(e) { const r = this.over.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  _userMovedView() { this.userMoved = true; if (this.follow) { this.follow = false; this.cb.onFollow?.(false); } }
  _eraserRadius() { return Math.max(8, this.size * 3); }

  _down(e) {
    if (e.pointerType === 'pen') this.penSeen = true;
    const [sx, sy] = this._pos(e);
    this.pointers.set(e.pointerId, { sx, sy, type: e.pointerType });
    try { this.over.setPointerCapture(e.pointerId); } catch {}
    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');

    if (touches.length === 2) {            // pincement : zoom + déplacement
      this._cancelStroke();
      this.erasing = false; this.hidden.clear();
      this.gesture = { type: 'pinch', ...this._pinchState(touches) };
      return;
    }
    if (this.gesture) return;
    const pan = this.tool === 'hand' || !this.sync.canWrite() || e.button === 1 || this.spaceDown
      || (e.pointerType === 'touch' && this.penSeen);   // stylet détecté : le doigt déplace la feuille
    if (pan) { this.gesture = { type: 'pan', id: e.pointerId, sx, sy }; this.over.style.cursor = 'grabbing'; return; }
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    const [wx, wy] = this.toWorld(sx, sy);
    if (this.tool === 'text') { this.gesture = { type: 'text', id: e.pointerId }; return; }
    if (this.tool === 'eraser' || e.buttons === 32) {
      this.gesture = { type: 'erase', id: e.pointerId };
      this.erasing = true; this.eraserAt = [sx, sy];
      this._eraseAt(wx, wy);
      return;
    }
    const vp = e.pointerType === 'pen' && e.pressure > 0 && e.pressure !== 0.5;
    this.current = {
      id: newId('s'), type: 'stroke', tool: this.tool === 'magic' ? 'pen' : this.tool, magic: this.tool === 'magic', color: this.color, size: this.size, vp,
      pts: [r1(wx), r1(wy), vp ? Math.round(e.pressure * 100) / 100 : 0.5], sent: 0, lastFlush: 0,
    };
    this.gesture = { type: 'draw', id: e.pointerId };
    this.dirtyOver = true;
  }

  _pinchState(t) {
    return { d: Math.hypot(t[0].sx - t[1].sx, t[0].sy - t[1].sy) || 1, cx: (t[0].sx + t[1].sx) / 2, cy: (t[0].sy + t[1].sy) / 2 };
  }

  _move(e) {
    const [sx, sy] = this._pos(e);
    const ptr = this.pointers.get(e.pointerId);
    const g = this.gesture;

    // Curseur partagé avec les autres participants
    const now = performance.now();
    if (this.sync.canWrite() && now - (this._lastCursor || 0) > 60 && g?.type !== 'draw') {
      this._lastCursor = now;
      const [wx, wy] = this.toWorld(sx, sy);
      this.sync.send({ t: 'cursor', x: r1(wx), y: r1(wy) });
    }
    if (this.tool === 'eraser' && this.sync.canWrite() && (!g || g.type === 'erase')) { this.eraserAt = [sx, sy]; this.dirtyOver = true; }
    if (!ptr) return;

    if (g?.type === 'pinch') {
      ptr.sx = sx; ptr.sy = sy;
      const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
      if (touches.length < 2) return;
      const s = this._pinchState(touches);
      this._userMovedView();
      this.view.x += s.cx - g.cx; this.view.y += s.cy - g.cy;
      this.zoomAt(s.cx, s.cy, s.d / g.d);
      Object.assign(g, s);
      return;
    }
    if (!g || g.id !== e.pointerId) return;
    if (g.type === 'pan') {
      this._userMovedView();
      this.view.x += sx - g.sx; this.view.y += sy - g.sy; g.sx = sx; g.sy = sy;
      this._viewChanged();
    } else if (g.type === 'erase') {
      const [wx, wy] = this.toWorld(sx, sy);
      this._eraseAt(wx, wy);
    } else if (g.type === 'draw') {
      const s = this.current;
      const events = e.getCoalescedEvents?.() || [e];
      const minDist = 0.9 / this.view.k;
      for (const ce of (events.length ? events : [e])) {
        const [cx, cy] = this._pos(ce);
        const [wx, wy] = this.toWorld(cx, cy);
        const n = s.pts.length;
        if (Math.hypot(wx - s.pts[n - 3], wy - s.pts[n - 2]) < minDist) continue;
        s.pts.push(r1(wx), r1(wy), s.vp ? Math.round((ce.pressure || 0.5) * 100) / 100 : 0.5);
      }
      this.dirtyOver = true;
      if (now - s.lastFlush > 33) { s.lastFlush = now; this._flushLive(false); }
    }
  }

  _up(e, cancelled) {
    const ptr = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pinch') { if ([...this.pointers.values()].filter((p) => p.type === 'touch').length < 2) this.gesture = this.pointers.size ? { type: 'none-until-release' } : null; return; }
    if (g.type === 'none-until-release') { if (!this.pointers.size) this.gesture = null; return; }
    if (g.id !== e.pointerId) return;
    this.gesture = null;
    this.over.style.cursor = '';
    if (g.type === 'draw') {
      if (cancelled) return this._cancelStroke();
      const s = this.current;
      this._flushLive(true);
      const item = { type: 'stroke', tool: s.tool, color: s.color, size: s.size, pts: s.pts, z: Date.now(), by: this.sync.hello.deviceId };
      if (s.vp) item.vp = 1;
      this.doc.transact(() => this.items.set(s.id, item), LOCAL);
      if (s.magic) { this.magicIds.add(s.id); this.cb.onMagic?.(); }
      this.current = null;
      this.dirtyOver = true;
    } else if (g.type === 'erase') {
      this.erasing = false;
      if (e.pointerType !== 'mouse') this.eraserAt = null;
      if (this.hidden.size && !cancelled) {
        const ids = [...this.hidden];
        this.doc.transact(() => ids.forEach((id) => this.items.delete(id)), LOCAL);
      }
      this.hidden.clear();
      this.dirtyBase = this.dirtyOver = true;
    } else if (g.type === 'text' && !cancelled && ptr) {
      const [wx, wy] = this.toWorld(ptr.sx, ptr.sy);
      const hit = this._hitText(wx, wy);
      this.cb.onTextEdit?.(hit ? { id: hit[0], ...hit[1].item } : { id: null, x: wx, y: wy - 10, text: '', color: this.color, fs: Math.max(14, this.size * 5) });
    }
  }

  _cancelStroke() {
    if (!this.current) return;
    this.sync.send({ t: 'live-end', id: this.current.id });
    this.current = null; this.dirtyOver = true;
    if (this.gesture?.type === 'draw') this.gesture = null;
  }

  _hitText(wx, wy) {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const [, e] = this.order[i];
      if (e.item.type === 'text' && wx >= e.bbox[0] && wx <= e.bbox[2] && wy >= e.bbox[1] && wy <= e.bbox[3]) return this.order[i];
    }
    return null;
  }

  _eraseAt(wx, wy) {
    const r = this._eraserRadius() / this.view.k;
    for (const [id, e] of this.order) {
      if (this.hidden.has(id)) continue;
      const b = e.bbox;
      if (wx < b[0] - r || wx > b[2] + r || wy < b[1] - r || wy > b[3] + r) continue;
      let hit = e.item.type !== 'stroke';
      if (!hit) {
        const p = e.item.pts, lim = r + strokeWidth(e.item) / 2;
        if (p.length === 3) hit = Math.hypot(wx - p[0], wy - p[1]) <= lim;
        for (let i = 3; i < p.length && !hit; i += 3) hit = distToSegment(wx, wy, p[i - 3], p[i - 2], p[i], p[i + 1]) <= lim;
      }
      if (hit) { this.hidden.add(id); this.dirtyBase = true; }
    }
  }

  // ---------- Dessin magique ----------
  magicStrokes() {
    const out = [];
    for (const id of [...this.magicIds]) { const it = this.items.get(id); if (it) out.push(it); else this.magicIds.delete(id); }
    return out;
  }
  magicBounds() {
    let b = null;
    for (const s of this.magicStrokes()) { const sb = bboxOf(s); b = b ? [Math.min(b[0], sb[0]), Math.min(b[1], sb[1]), Math.max(b[2], sb[2]), Math.max(b[3], sb[3])] : sb; }
    return b;
  }
  clearMagic() { this.magicIds.clear(); this.cb.onMagic?.(); }
  // Pose la photo à droite du croquis ; elle est synchronisée comme n'importe quel élément
  placePicture(res, bounds) {
    const h = Math.max(140, Math.min(260, bounds[3] - bounds[1]));
    const w = Math.round(h * (res.width && res.height ? res.width / res.height : 1));
    this.doc.transact(() => this.items.set(newId('g'), {
      type: 'image', img: res.img, x: r1(bounds[2] + 28), y: r1((bounds[1] + bounds[3]) / 2 - h / 2), w, h,
      label: res.label, src: res.pageUrl || '', z: Date.now(), by: this.sync.hello.deviceId,
    }), LOCAL);
    this.clearMagic();
  }

  // ---------- Actions ----------
  commitText(t) {
    const text = String(t.text || '').replace(/\s+$/, '');
    this.editingId = null;
    this.doc.transact(() => {
      if (!text) { if (t.id) this.items.delete(t.id); return; }
      const prev = t.id ? this.items.get(t.id) : null;
      this.items.set(t.id || newId('t'), { type: 'text', x: r1(t.x), y: r1(t.y), text: text.slice(0, 5000), color: t.color, fs: t.fs, z: prev?.z || Date.now(), by: prev?.by || this.sync.hello.deviceId });
    }, LOCAL);
    this.dirtyBase = true;
  }
  setEditing(id) { this.editingId = id; this.dirtyBase = true; }
  setPaper(paper) { this.doc.transact(() => this.meta.set('paper', paper), LOCAL); }
  clearAll() { this.doc.transact(() => [...this.items.keys()].forEach((k) => this.items.delete(k)), LOCAL); }
  doUndo() { this.undo.undo(); }
  doRedo() { this.undo.redo(); }
  canUndo() { return this.undo.undoStack.length > 0; }
  canRedo() { return this.undo.redoStack.length > 0; }
}
