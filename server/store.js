// Stockage persistant : SQLite intégré à Node (aucune dépendance native).
// Le schéma reste volontairement simple et portable vers PostgreSQL.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans caractères ambigus

export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

function randomString(len, alphabet) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS notebooks (
        id          TEXT PRIMARY KEY,
        code        TEXT UNIQUE NOT NULL,
        owner_hash  TEXT NOT NULL,
        title       TEXT NOT NULL DEFAULT 'Carnet sans titre',
        mode        TEXT NOT NULL DEFAULT 'collab',   -- 'collab' | 'broadcast'
        sharing     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS updates (
        notebook_id TEXT NOT NULL,
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        data        BLOB NOT NULL,
        device_id   TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS updates_nb ON updates(notebook_id, seq);
      CREATE TABLE IF NOT EXISTS devices (
        notebook_id TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        name        TEXT,
        kind        TEXT,
        blocked     INTEGER NOT NULL DEFAULT 0,
        last_seen   INTEGER,
        last_sync   INTEGER,
        PRIMARY KEY (notebook_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS images (
        id          TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL,
        mime        TEXT NOT NULL,
        data        BLOB NOT NULL,
        label       TEXT,
        source_url  TEXT,
        created_at  INTEGER NOT NULL
      );
    `);
    this.q = {
      insertNb: this.db.prepare('INSERT INTO notebooks (id, code, owner_hash, title, created_at) VALUES (?,?,?,?,?)'),
      getNb: this.db.prepare('SELECT * FROM notebooks WHERE id = ?'),
      getNbByCode: this.db.prepare('SELECT * FROM notebooks WHERE code = ?'),
      setMode: this.db.prepare('UPDATE notebooks SET mode = ? WHERE id = ?'),
      setSharing: this.db.prepare('UPDATE notebooks SET sharing = ? WHERE id = ?'),
      setTitle: this.db.prepare('UPDATE notebooks SET title = ? WHERE id = ?'),
      addUpdate: this.db.prepare('INSERT INTO updates (notebook_id, data, device_id, created_at) VALUES (?,?,?,?)'),
      getUpdates: this.db.prepare('SELECT seq, data FROM updates WHERE notebook_id = ? ORDER BY seq'),
      countUpdates: this.db.prepare('SELECT COUNT(*) AS n FROM updates WHERE notebook_id = ?'),
      delUpdatesUpTo: this.db.prepare('DELETE FROM updates WHERE notebook_id = ? AND seq <= ?'),
      upsertDevice: this.db.prepare(`INSERT INTO devices (notebook_id, device_id, name, kind, last_seen)
        VALUES (?,?,?,?,?) ON CONFLICT(notebook_id, device_id)
        DO UPDATE SET name = excluded.name, kind = excluded.kind, last_seen = excluded.last_seen`),
      touchSync: this.db.prepare('UPDATE devices SET last_sync = ? WHERE notebook_id = ? AND device_id = ?'),
      touchSeen: this.db.prepare('UPDATE devices SET last_seen = ? WHERE notebook_id = ? AND device_id = ?'),
      setBlocked: this.db.prepare('UPDATE devices SET blocked = ? WHERE notebook_id = ? AND device_id = ?'),
      getDevice: this.db.prepare('SELECT * FROM devices WHERE notebook_id = ? AND device_id = ?'),
      listDevices: this.db.prepare('SELECT * FROM devices WHERE notebook_id = ? ORDER BY last_seen DESC'),
      addImage: this.db.prepare('INSERT INTO images (id, notebook_id, mime, data, label, source_url, created_at) VALUES (?,?,?,?,?,?,?)'),
      getImage: this.db.prepare('SELECT mime, data FROM images WHERE id = ?'),
    };
  }

  createNotebook(title) {
    const id = randomString(14, 'abcdefghijkmnpqrstuvwxyz23456789');
    const ownerToken = randomBytes(32).toString('base64url');
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = randomString(6, CODE_ALPHABET);
      try {
        this.q.insertNb.run(id, code, hashToken(ownerToken), (title || '').slice(0, 120) || 'Carnet sans titre', Date.now());
        return { id, code, ownerToken };
      } catch (e) {
        if (!String(e.message).includes('UNIQUE')) throw e;
      }
    }
    throw new Error('Impossible de générer un code de session unique');
  }

  getNotebook(id) { return this.q.getNb.get(id); }
  getNotebookByCode(code) { return this.q.getNbByCode.get(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')); }
  setMode(id, mode) { this.q.setMode.run(mode, id); }
  setSharing(id, on) { this.q.setSharing.run(on ? 1 : 0, id); }
  setTitle(id, title) { this.q.setTitle.run(title, id); }

  addUpdate(id, data, deviceId) { this.q.addUpdate.run(id, data, deviceId || null, Date.now()); }
  getUpdates(id) { return this.q.getUpdates.all(id); }
  countUpdates(id) { return this.q.countUpdates.get(id).n; }

  // Remplace le journal des mises à jour par un seul instantané fusionné.
  compact(id, snapshot, upToSeq) {
    this.db.exec('BEGIN');
    try {
      this.q.delUpdatesUpTo.run(id, upToSeq);
      this.q.addUpdate.run(id, snapshot, null, Date.now());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  addImage(nb, { data, mime, label, sourceUrl }) {
    const id = randomString(20, 'abcdefghijkmnpqrstuvwxyz23456789');
    this.q.addImage.run(id, nb, mime, data, label || null, sourceUrl || null, Date.now());
    return id;
  }
  getImage(id) { return this.q.getImage.get(id); }

  upsertDevice(nb, deviceId, name, kind) { this.q.upsertDevice.run(nb, deviceId, name, kind, Date.now()); }
  touchSync(nb, deviceId) { this.q.touchSync.run(Date.now(), nb, deviceId); }
  touchSeen(nb, deviceId) { this.q.touchSeen.run(Date.now(), nb, deviceId); }
  setBlocked(nb, deviceId, blocked) { this.q.setBlocked.run(blocked ? 1 : 0, nb, deviceId); }
  getDevice(nb, deviceId) { return this.q.getDevice.get(nb, deviceId); }
  listDevices(nb) { return this.q.listDevices.all(nb); }
}
