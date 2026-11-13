// Client de synchronisation. Fonctionne dans le navigateur et dans Node (tests).
//
// Principe :
//  - Le carnet est un document CRDT (Yjs). Chaque appareil en garde une copie
//    complète, donc on peut écrire hors ligne.
//  - Seuls les deltas circulent sur le WebSocket, jamais le document entier.
//  - À chaque (re)connexion, client et serveur échangent leur « vecteur d'état »
//    et s'envoient uniquement ce qui manque à l'autre : rien n'est perdu.
import * as Y from 'yjs';

const MSG_STATE_VECTOR = 0;
const MSG_UPDATE = 1;

export const LOCAL = 'local';   // origine des modifications faites sur cet appareil
const REMOTE = 'remote';        // origine des modifications reçues du serveur

export class SyncClient {
  constructor({ url, notebookId, deviceId, name, kind, ownerToken, doc, WebSocketImpl }) {
    this.url = url;
    this.notebookId = notebookId;
    this.hello = { t: 'hello', deviceId, name, kind, ownerToken };
    this.doc = doc || new Y.Doc();
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this.ws = null;
    this.status = 'connecting'; // connecting | online | offline | refused
    this.refusedReason = null;
    this.pending = 0;           // modifications envoyées, pas encore confirmées
    this.dirtyOffline = false;  // modifications faites sans connexion
    this.synced = false;
    this.me = null;             // { cid, role, mode, sharing, title, code, color }
    this.peers = [];
    this.known = [];
    this.listeners = new Map();
    this.skipOrigins = new Set([REMOTE]);
    this.retry = 0;
    this.closed = false;
    this.enabled = true;

    this.doc.on('update', (update, origin) => {
      if (this.skipOrigins.has(origin)) return;
      if (this.isOpen() && this.me) this._sendBin(MSG_UPDATE, update);
      else this.dirtyOffline = true;
      this._emit('status');
    });
    this._connect();
  }

  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt).delete(fn);
  }
  _emit(evt, data) { for (const fn of this.listeners.get(evt) || []) fn(data); }

  isOpen() { return this.ws && this.ws.readyState === 1; }
  canWrite() { return !!this.me && (this.me.role === 'owner' || this.me.role === 'editor'); }

  _setStatus(s) { if (this.status !== s) { this.status = s; } this._emit('status'); }

  _connect() {
    if (this.closed || !this.enabled) return;
    this._setStatus(this.status === 'offline' ? 'offline' : 'connecting');
    const ws = new this.WS(`${this.url}?nb=${encodeURIComponent(this.notebookId)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify(this.hello)); };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      if (typeof ev.data === 'string') this._onJSON(JSON.parse(ev.data));
      else this._onBin(new Uint8Array(ev.data));
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.synced = false;
      this.peers = [];
      this._emit('peers');
      if (this.pending > 0) { this.dirtyOffline = true; this.pending = 0; }
      if (ev.code === 4403 || ev.code === 4404 || ev.code === 4001) {
        this.refusedReason = ev.code === 4404 ? 'introuvable' : (ev.reason || 'refuse');
        this.me = null;
        return this._setStatus('refused');
      }
      this._setStatus('offline');
      this._scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  _scheduleReconnect() {
    if (this.closed || !this.enabled) return;
    const delay = Math.min(5000, 300 * 2 ** this.retry++) * (0.7 + Math.random() * 0.6);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._connect(), delay);
  }

  // Reconnexion immédiate (retour du réseau, bouton « Réessayer »)
  reconnectNow() {
    if (this.isOpen() || this.closed) return;
    this.enabled = true;
    this.retry = 0;
    this.refusedReason = null;
    clearTimeout(this._timer);
    if (this.ws) { const old = this.ws; this.ws = null; try { old.close(); } catch {} }
    this.status = 'offline';
    this._connect();
  }

  // Coupe volontairement la connexion (sert aussi aux tests de coupure réseau)
  goOffline() {
    this.enabled = false;
    clearTimeout(this._timer);
    if (this.ws) { const old = this.ws; this.ws = null; try { old.close(); } catch {} }
    this.synced = false;
    if (this.pending > 0) { this.dirtyOffline = true; this.pending = 0; }
    this.peers = [];
    this._emit('peers');
    this._setStatus('offline');
  }

  _sendBin(type, payload) {
    const buf = new Uint8Array(payload.length + 1);
    buf[0] = type;
    buf.set(payload, 1);
    this.ws.send(buf);
    if (type === MSG_UPDATE) this.pending++;
  }

  send(obj) { if (this.isOpen() && this.me) this.ws.send(JSON.stringify(obj)); }

  _onJSON(msg) {
    switch (msg.t) {
      case 'welcome':
        this.retry = 0;
        this.me = { cid: msg.cid, role: msg.role, mode: msg.mode, sharing: msg.sharing, title: msg.title, code: msg.code, color: msg.color, vision: msg.vision };
        // Demande au serveur tout ce qui manque à cet appareil
        this._sendBin(MSG_STATE_VECTOR, Y.encodeStateVector(this.doc));
        this._setStatus('online');
        this._emit('me');
        break;
      case 'state':
        if (this.me) Object.assign(this.me, { role: msg.role, mode: msg.mode, sharing: msg.sharing, title: msg.title });
        this._emit('me');
        break;
      case 'synced':
        this.synced = true;
        this._emit('synced');
        this._emit('status');
        break;
      case 'ack':
        this.pending = Math.max(0, this.pending - 1);
        if (msg.denied) this._emit('denied');
        this._emit('status');
        break;
      case 'peers':
        this.peers = msg.peers;
        if (msg.known) this.known = msg.known;
        this._emit('peers');
        break;
      case 'live': case 'live-end': case 'cursor': case 'view': case 'gone': case 'magic-result':
        this._emit(msg.t, msg);
        break;
    }
  }

  _onBin(buf) {
    const type = buf[0];
    const payload = buf.subarray(1);
    if (type === MSG_STATE_VECTOR) {
      // Le serveur annonce ce qu'il possède : on lui envoie ce qui lui manque
      // (typiquement, ce qui a été écrit pendant une coupure réseau).
      const diff = Y.encodeStateAsUpdate(this.doc, payload);
      if (diff.length > 2 && this.canWrite()) this._sendBin(MSG_UPDATE, diff);
      this.dirtyOffline = false;
      this._emit('status');
    } else if (type === MSG_UPDATE) {
      Y.applyUpdate(this.doc, payload, REMOTE);
    }
  }

  // Dessin magique : envoie un croquis (png en base64) ou un nom d'objet, reçoit une photo
  magic(payload) {
    return new Promise((resolve) => {
      if (!this.isOpen() || !this.me) return resolve({ error: 'hors-ligne' });
      const rid = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => { off(); resolve({ error: 'service-indisponible' }); }, 40_000);
      const off = this.on('magic-result', (m) => { if (m.rid !== rid) return; clearTimeout(timer); off(); resolve(m); });
      this.send({ t: 'magic', rid, ...payload });
    });
  }

  // Tout est-il enregistré sur le serveur ?
  isSaved() { return this.status === 'online' && this.synced && this.pending === 0 && !this.dirtyOffline; }

  destroy() {
    this.closed = true;
    clearTimeout(this._timer);
    if (this.ws) { const old = this.ws; this.ws = null; try { old.close(); } catch {} }
  }
}
