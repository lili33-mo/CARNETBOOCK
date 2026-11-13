// SyncPad — serveur : fichiers statiques, API de session, synchronisation WebSocket.
// Le serveur fait autorité : chaque modification reçue est vérifiée (rôle de
// l'appareil) AVANT d'être appliquée au document et rediffusée.
import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import QRCode from 'qrcode';
import { Store, hashToken } from './store.js';
import { recognizeWithClaude, findWikipediaImage, visionAvailable } from './picture.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.ico': 'image/x-icon', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// Types de trames binaires
const MSG_STATE_VECTOR = 0; // « voici ce que j'ai, envoie-moi ce qui me manque »
const MSG_UPDATE = 1;       // modification (delta Yjs)

const COMPACT_EVERY = 300;
const PEER_COLORS = ['#2563eb', '#db2777', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626', '#4f46e5', '#0d9488'];

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function connectionKind(ip = '') {
  const a = ip.replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return 'local';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd])/i.test(a)) return 'lan';
  return 'internet';
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

export async function startServer({ port = 3000, host = '0.0.0.0', dbFile = join(ROOT, 'data', 'syncpad.db'), quiet = false, providers = {} } = {}) {
  const store = new Store(dbFile);
  // Remplaçables dans les tests (pas d'appel extérieur)
  const recognize = providers.recognize || (visionAvailable() ? recognizeWithClaude : null);
  const findImage = providers.findImage || findWikipediaImage;
  const rooms = new Map(); // notebookId -> { doc, conns:Set, sinceCompact }

  function getRoom(id) {
    let room = rooms.get(id);
    if (room) return room;
    const doc = new Y.Doc();
    const rows = store.getUpdates(id);
    doc.transact(() => { for (const r of rows) Y.applyUpdate(doc, r.data); });
    room = { id, doc, conns: new Set(), sinceCompact: rows.length };
    rooms.set(id, room);
    return room;
  }

  function compact(room) {
    const rows = store.getUpdates(room.id);
    if (rows.length <= 1) return;
    store.compact(room.id, Y.encodeStateAsUpdate(room.doc), rows[rows.length - 1].seq);
    room.sinceCompact = 1;
  }

  function releaseRoom(room) {
    if (room.conns.size > 0) return;
    try { compact(room); } catch (e) { console.error('compaction', e); }
    room.doc.destroy();
    rooms.delete(room.id);
  }

  const roleOf = (nb, conn) => (conn.owner ? 'owner' : nb.mode === 'collab' ? 'editor' : 'viewer');
  const canWrite = (role) => role === 'owner' || role === 'editor';

  function sendJSON(conn, obj) {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(obj));
  }
  function sendBin(conn, type, payload) {
    if (conn.ws.readyState !== 1) return;
    const buf = Buffer.allocUnsafe(payload.length + 1);
    buf[0] = type;
    buf.set(payload, 1);
    conn.ws.send(buf, { binary: true });
  }

  function peersPayload(room, forOwner) {
    const peers = [...room.conns].filter((c) => c.ready).map((c) => ({
      cid: c.cid, deviceId: c.deviceId, name: c.name, kind: c.kind, color: c.color,
      role: c.role, link: c.link, since: c.since,
    }));
    const msg = { t: 'peers', peers };
    if (forOwner) {
      const online = new Set(peers.map((p) => p.deviceId));
      msg.known = store.listDevices(room.id).map((d) => ({
        deviceId: d.device_id, name: d.name, kind: d.kind, blocked: !!d.blocked,
        online: online.has(d.device_id), lastSeen: d.last_seen, lastSync: d.last_sync,
      }));
    }
    return msg;
  }
  function broadcastPeers(room) {
    for (const c of room.conns) if (c.ready) sendJSON(c, peersPayload(room, c.owner));
  }
  function refreshRoles(room) {
    const nb = store.getNotebook(room.id);
    for (const c of room.conns) {
      if (!c.ready) continue;
      c.role = roleOf(nb, c);
      sendJSON(c, { t: 'state', role: c.role, mode: nb.mode, sharing: !!nb.sharing, title: nb.title });
    }
    broadcastPeers(room);
  }

  // ---------- HTTP ----------
  const joinHits = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const hits = (joinHits.get(ip) || []).filter((t) => now - t < 60_000);
    hits.push(now);
    joinHits.set(ip, hits);
    return hits.length > 30;
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readBody(req, limit = 4096) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > limit) throw new Error('trop grand'); chunks.push(c); }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');

      if (p === '/api/notebooks' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const nb = store.createNotebook(clean(body.title, 120));
        return json(res, 201, nb);
      }
      let m;
      if ((m = p.match(/^\/api\/notebooks\/([a-z0-9]{6,32})$/)) && req.method === 'GET') {
        const nb = store.getNotebook(m[1]);
        if (!nb) return json(res, 404, { error: 'Carnet introuvable' });
        return json(res, 200, { id: nb.id, title: nb.title, code: nb.code });
      }
      if ((m = p.match(/^\/api\/join\/([A-Za-z0-9-]{4,12})$/)) && req.method === 'GET') {
        if (rateLimited(req.socket.remoteAddress)) return json(res, 429, { error: 'Trop de tentatives, réessayez dans une minute' });
        const nb = store.getNotebookByCode(m[1]);
        if (!nb || !nb.sharing) return json(res, 404, { error: 'Code invalide ou partage arrêté' });
        return json(res, 200, { id: nb.id });
      }
      if ((m = p.match(/^\/api\/img\/([a-z0-9]{20})$/)) && req.method === 'GET') {
        const img = store.getImage(m[1]);
        if (!img) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(img.data);
      }
      if (p === '/api/info') {
        return json(res, 200, { addresses: lanAddresses(), port: server.address().port });
      }
      if (p === '/api/qr') {
        const text = clean(url.searchParams.get('text'), 300);
        if (!text) return json(res, 400, { error: 'texte manquant' });
        const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return res.end(svg);
      }
      if (p.startsWith('/api/')) return json(res, 404, { error: 'Inconnu' });

      // Fichiers statiques + repli vers l'application pour /n/<id>
      let file = normalize(join(PUBLIC, decodeURIComponent(p)));
      if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
      if (p === '/' || !extname(file) || !existsSync(file)) {
        if (extname(p) && p !== '/') { res.writeHead(404); return res.end('Introuvable'); }
        file = join(PUBLIC, 'index.html');
      }
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch (e) {
      if (!quiet) console.error(e);
      if (!res.headersSent) res.writeHead(500);
      res.end('Erreur serveur');
    }
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });
  let nextCid = 1;

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const nbId = url.searchParams.get('nb') || '';
    const nb0 = store.getNotebook(nbId);
    if (!nb0) return ws.close(4404, 'introuvable');

    const conn = {
      ws, cid: nextCid++, ready: false, owner: false, role: 'viewer', alive: true,
      deviceId: null, name: 'Appareil', kind: 'desktop', color: '#2563eb',
      link: connectionKind(req.socket.remoteAddress), since: Date.now(),
    };
    let room = null;
    const helloTimer = setTimeout(() => { if (!conn.ready) ws.close(4400, 'hello attendu'); }, 10_000);

    ws.on('pong', () => { conn.alive = true; });

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) return onBinary(data);
        onJSON(JSON.parse(data.toString('utf8')));
      } catch (e) {
        if (!quiet) console.error('message invalide', e.message);
      }
    });

    function onJSON(msg) {
      if (!conn.ready) {
        if (msg.t !== 'hello') return;
        const deviceId = clean(msg.deviceId, 64);
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) return ws.close(4400, 'appareil invalide');
        const nb = store.getNotebook(nbId);
        conn.owner = !!msg.ownerToken && hashToken(msg.ownerToken) === nb.owner_hash;
        if (!conn.owner) {
          if (!nb.sharing) return ws.close(4403, 'partage-arrete');
          if (store.getDevice(nbId, deviceId)?.blocked) return ws.close(4403, 'appareil-retire');
        }
        conn.deviceId = deviceId;
        conn.name = clean(msg.name, 40) || 'Appareil';
        conn.kind = ['desktop', 'tablet', 'phone', 'screen'].includes(msg.kind) ? msg.kind : 'desktop';
        store.upsertDevice(nbId, deviceId, conn.name, conn.kind);
        room = getRoom(nbId);
        // Couleur stable par appareil, en évitant celles déjà prises dans la salle
        const used = new Set([...room.conns].map((c) => c.color));
        let h = 0; for (const ch of deviceId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        conn.color = PEER_COLORS[h % PEER_COLORS.length];
        for (let i = 0; used.has(conn.color) && i < PEER_COLORS.length; i++) conn.color = PEER_COLORS[(h + i) % PEER_COLORS.length];
        conn.role = roleOf(nb, conn);
        conn.ready = true;
        clearTimeout(helloTimer);
        room.conns.add(conn);
        sendJSON(conn, {
          t: 'welcome', cid: conn.cid, role: conn.role, mode: nb.mode, sharing: !!nb.sharing,
          title: nb.title, code: nb.code, color: conn.color, vision: !!recognize,
        });
        sendBin(conn, MSG_STATE_VECTOR, Y.encodeStateVector(room.doc));
        broadcastPeers(room);
        return;
      }

      switch (msg.t) {
        case 'live': case 'live-end': case 'cursor': case 'view': {
          // Éphémère : tracé en cours, curseurs, zone affichée par le propriétaire. Jamais stocké.
          if (!canWrite(conn.role)) return;
          if (msg.t === 'view' && !conn.owner) return;
          msg.cid = conn.cid;
          const out = JSON.stringify(msg);
          if (out.length > 64_000) return;
          for (const c of room.conns) if (c !== conn && c.ready && c.ws.readyState === 1) c.ws.send(out);
          return;
        }
        case 'magic': return void onMagic(msg);
        case 'rename': {
          conn.name = clean(msg.name, 40) || conn.name;
          store.upsertDevice(nbId, conn.deviceId, conn.name, conn.kind);
          return broadcastPeers(room);
        }
        // ----- Actions réservées au propriétaire -----
        case 'mode': {
          if (!conn.owner || !['collab', 'broadcast'].includes(msg.mode)) return;
          store.setMode(nbId, msg.mode);
          return refreshRoles(room);
        }
        case 'title': {
          if (!conn.owner) return;
          store.setTitle(nbId, clean(msg.title, 120) || 'Carnet sans titre');
          return refreshRoles(room);
        }
        case 'sharing': {
          if (!conn.owner) return;
          store.setSharing(nbId, !!msg.on);
          if (!msg.on) for (const c of [...room.conns]) if (!c.owner) c.ws.close(4403, 'partage-arrete');
          return refreshRoles(room);
        }
        case 'disconnect': case 'block': case 'unblock': {
          if (!conn.owner) return;
          const target = clean(msg.deviceId, 64);
          if (msg.t !== 'disconnect') store.setBlocked(nbId, target, msg.t === 'block');
          if (msg.t !== 'unblock') {
            for (const c of [...room.conns]) {
              if (c.deviceId === target && !c.owner) c.ws.close(msg.t === 'block' ? 4403 : 4001, msg.t === 'block' ? 'appareil-retire' : 'deconnecte');
            }
          }
          return broadcastPeers(room);
        }
      }
    }

    // Dessin magique : croquis -> nom de l'objet -> vraie photo
    async function onMagic(msg) {
      const rid = clean(msg.rid, 40);
      const reply = (extra) => sendJSON(conn, { t: 'magic-result', rid, ...extra });
      if (!canWrite(conn.role)) return reply({ error: 'lecture-seule' });
      const now = Date.now();
      if (now - (conn.lastMagic || 0) < 2000) return reply({ error: 'trop-vite' });
      conn.lastMagic = now;
      try {
        let label = clean(msg.label, 60).toLowerCase();
        if (!label) {
          if (!recognize) return reply({ needLabel: true });
          const png = String(msg.png || '');
          if (png.length < 100 || png.length > 2_000_000 || !/^[A-Za-z0-9+/=]+$/.test(png)) return reply({ error: 'image-invalide' });
          label = await recognize(png);
          if (!label) return reply({ needLabel: true, unknown: true });
        }
        const img = await findImage(label);
        if (!img) return reply({ label, error: 'aucune-image' });
        const id = store.addImage(nbId, { data: img.data, mime: img.mime, label, sourceUrl: img.pageUrl });
        reply({ label, img: id, width: img.width, height: img.height, title: img.title, pageUrl: img.pageUrl });
      } catch (e) {
        if (!quiet) console.error('dessin magique :', e.message);
        reply({ error: 'service-indisponible' });
      }
    }

    function onBinary(buf) {
      if (!conn.ready || buf.length < 1) return;
      const type = buf[0];
      const payload = new Uint8Array(buf.buffer, buf.byteOffset + 1, buf.length - 1);
      if (type === MSG_STATE_VECTOR) {
        const diff = Y.encodeStateAsUpdate(room.doc, payload);
        sendBin(conn, MSG_UPDATE, diff);
        sendJSON(conn, { t: 'synced' });
        store.touchSync(nbId, conn.deviceId);
        return;
      }
      if (type === MSG_UPDATE) {
        // Vérification côté serveur : le rôle est relu à chaque modification.
        if (!canWrite(conn.role)) return sendJSON(conn, { t: 'ack', denied: true });
        const update = Uint8Array.from(payload);
        try {
          Y.applyUpdate(room.doc, update, conn);
        } catch {
          return sendJSON(conn, { t: 'ack', denied: true });
        }
        store.addUpdate(nbId, update, conn.deviceId);
        store.touchSync(nbId, conn.deviceId);
        for (const c of room.conns) if (c !== conn && c.ready) sendBin(c, MSG_UPDATE, update);
        sendJSON(conn, { t: 'ack' });
        if (++room.sinceCompact >= COMPACT_EVERY) compact(room);
      }
    }

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!room) return;
      room.conns.delete(conn);
      store.touchSeen(nbId, conn.deviceId);
      for (const c of room.conns) if (c.ready) sendJSON(c, { t: 'gone', cid: conn.cid });
      broadcastPeers(room);
      releaseRoom(room);
    });
    ws.on('error', () => {});
  });

  // Détection des connexions mortes (Wi-Fi coupé sans fermeture propre)
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = [...rooms.values()].flatMap((r) => [...r.conns]).find((c) => c.ws === ws);
      if (conn && !conn.alive) { ws.terminate(); continue; }
      if (conn) conn.alive = false;
      try { ws.ping(); } catch {}
    }
  }, 15_000);

  await new Promise((ok, ko) => { server.once('error', ko); server.listen(port, host, ok); });
  const actualPort = server.address().port;
  if (!quiet) {
    console.log(`\n  SyncPad est démarré.\n`);
    console.log(`  Sur cet ordinateur :   http://localhost:${actualPort}`);
    for (const a of lanAddresses()) console.log(`  Sur le même Wi-Fi :    http://${a}:${actualPort}`);
    console.log(`\n  Dessin magique : ${recognize ? 'reconnaissance automatique activée' : 'sans clé IA, le nom de l\'objet sera demandé'}`);
    console.log(`\n  Ctrl+C pour arrêter.\n`);
  }

  return {
    port: actualPort, store, rooms,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => setTimeout(r, 50));
      for (const room of [...rooms.values()]) { room.conns.clear(); releaseRoom(room); }
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      store.db.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer({ port: Number(process.env.PORT) || 3000 }).catch((e) => {
    if (e.code === 'EADDRINUSE') console.error(`\n  Le port est déjà utilisé. Essayez :  set PORT=3001 && npm start\n`);
    else console.error(e);
    process.exit(1);
  });
}
