// Tests réels de synchronisation (section 11 du cahier des charges).
// Un vrai serveur est démarré, de vrais clients WebSocket s'y connectent :
// rien n'est simulé côté synchronisation.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { startServer } from '../server/index.js';
import { SyncClient, LOCAL } from '../client/src/sync.js';

const dir = mkdtempSync(join(tmpdir(), 'syncpad-'));
const dbFile = join(dir, 'test.db');
// Faux services pour le « dessin magique » : aucun appel extérieur pendant les tests
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const providers = {
  recognize: async (png) => (png.length > 200 ? 'poêle à frire' : null),
  findImage: async (label) => (label === 'introuvable' ? null : { data: PNG_1PX, mime: 'image/png', width: 640, height: 480, title: label, pageUrl: 'https://exemple.test/' + label }),
};
let srv = await startServer({ port: 0, dbFile, quiet: true, providers });
let base = `http://127.0.0.1:${srv.port}`;
const clients = [];
const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error(`Délai dépassé : ${label}`);
    await sleep(5);
  }
  return Date.now() - t0;
}
async function createNotebook() {
  const r = await fetch(`${base}/api/notebooks`, { method: 'POST', body: JSON.stringify({ title: 'Test' }) });
  return r.json();
}
let n = 0;
function device(nb, { owner = false, name } = {}) {
  n++;
  const c = new SyncClient({
    url: `ws://127.0.0.1:${srv.port}/ws`, notebookId: nb.id,
    deviceId: `device-test-${n}-${Math.random().toString(36).slice(2, 10)}`,
    name: name || `Appareil ${n}`, kind: 'desktop', ownerToken: owner ? nb.ownerToken : undefined,
  });
  c.items = c.doc.getMap('items');
  clients.push(c);
  return c;
}
const ready = (c) => until(() => c.status === 'online' && c.synced, 'connexion');
function stroke(c, id, points = 20) {
  const pts = [];
  for (let i = 0; i < points; i++) pts.push(Math.round(Math.random() * 1000), Math.round(Math.random() * 1000), 0.5);
  c.doc.transact(() => c.items.set(id, { type: 'stroke', tool: 'pen', color: '#111', size: 3, pts }), LOCAL);
}
const canon = (c) => { const o = c.items.toJSON(); return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])); };
const same = (...cs) => cs.every((c) => canon(c) === canon(cs[0]));

async function test(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ name, ok: true, info, ms: Date.now() - t0 });
    console.log(`  ✓ ${name}${info ? ` — ${info}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, info: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

console.log('\nSyncPad — tests de synchronisation\n');

await test('1. Connecter deux appareils', async () => {
  const nb = await createNotebook();
  const a = device(nb, { owner: true }), b = device(nb);
  await ready(a); await ready(b);
  await until(() => a.peers.length === 2 && b.peers.length === 2, 'liste des appareils');
  assert.equal(a.me.role, 'owner');
  assert.equal(b.me.role, 'editor');
  return 'les deux se voient dans la liste des appareils';
});

await test('2. Écrire sur le premier, afficher sur le deuxième', async () => {
  const nb = await createNotebook();
  const a = device(nb, { owner: true }), b = device(nb);
  await ready(a); await ready(b);
  const lat = [];
  for (let i = 0; i < 50; i++) {
    stroke(a, `s${i}`);
    lat.push(await until(() => b.items.has(`s${i}`), `trait ${i}`));
  }
  assert.ok(same(a, b));
  lat.sort((x, y) => x - y);
  return `50 traits, latence médiane ${lat[25]} ms, max ${lat[49]} ms`;
});

await test('3-4. Six appareils : un écrit, les cinq autres affichent', async () => {
  const nb = await createNotebook();
  const all = [device(nb, { owner: true }), ...Array.from({ length: 5 }, () => device(nb))];
  await Promise.all(all.map(ready));
  await until(() => all.every((c) => c.peers.length === 6), '6 appareils visibles');
  for (let i = 0; i < 30; i++) stroke(all[0], `w${i}`);
  const ms = await until(() => all.every((c) => c.items.size === 30), 'diffusion aux 5 autres');
  assert.ok(same(...all));
  return `30 traits reçus par les 5 autres en ${ms} ms`;
});

await test('5. Deux appareils modifient en même temps', async () => {
  const nb = await createNotebook();
  const a = device(nb, { owner: true }), b = device(nb), c = device(nb);
  await Promise.all([a, b, c].map(ready));
  for (let i = 0; i < 100; i++) { stroke(a, `a${i}`); stroke(b, `b${i}`); if (i % 10 === 0) await sleep(1); }
  // Conflit direct : les deux modifient le même élément et l'un efface ce que l'autre vient d'écrire
  a.doc.transact(() => a.items.set('partage', { type: 'text', text: 'version A' }), LOCAL);
  b.doc.transact(() => b.items.set('partage', { type: 'text', text: 'version B' }), LOCAL);
  a.doc.transact(() => a.items.delete('b0'), LOCAL);
  await until(() => a.isSaved() && b.isSaved() && same(a, b, c) && a.items.size === 200, 'convergence');
  assert.equal(a.items.get('partage').text, b.items.get('partage').text);
  return `200 éléments, aucun perdu, les 3 copies sont identiques (conflit résolu : « ${a.items.get('partage').text} »)`;
});

await test('6-7. Coupure réseau puis récupération', async () => {
  const nb = await createNotebook();
  const a = device(nb, { owner: true }), b = device(nb);
  await ready(a); await ready(b);
  stroke(a, 'avant');
  await until(() => b.items.has('avant'), 'synchro initiale');
  b.goOffline();                                   // « Wi-Fi coupé » sur B
  await until(() => a.peers.length === 1, 'A voit B hors ligne');
  for (let i = 0; i < 20; i++) stroke(b, `horsligne${i}`); // B continue d'écrire
  for (let i = 0; i < 20; i++) stroke(a, `enligne${i}`);   // A aussi
  b.doc.transact(() => b.items.delete('avant'), LOCAL);     // B efface hors ligne
  await sleep(150);
  assert.equal(a.items.size, 21, 'A ne doit rien avoir reçu de B pendant la coupure');
  assert.equal(b.isSaved(), false);
  b.reconnectNow();                                // « Wi-Fi rétabli »
  const ms = await until(() => b.isSaved() && same(a, b) && a.items.size === 40, 'récupération');
  assert.equal(a.items.has('avant'), false);
  return `40 éléments des deux côtés ${ms} ms après le retour du réseau`;
});

await test('6 bis. Connexion coupée brutalement (sans fermeture propre)', async () => {
  const nb = await createNotebook();
  const a = device(nb, { owner: true }), b = device(nb);
  await ready(a); await ready(b);
  // Le serveur coupe le socket de B : B doit se reconnecter tout seul
  for (const room of srv.rooms.values()) for (const c of room.conns) if (c.deviceId === b.hello.deviceId) c.ws.terminate();
  await until(() => b.status === 'offline', 'B détecte la coupure');
  stroke(b, 'pendant');
  stroke(a, 'ailleurs');
  const ms = await until(() => b.isSaved() && a.items.has('pendant') && b.items.has('ailleurs'), 'reconnexion automatique');
  return `reconnexion automatique et rattrapage en ${ms} ms`;
});

await test('8. Performance : dessin complexe (2 000 traits, 200 000 points)', async () => {
  const nb = await createNotebook();
  const a = device(nb, { owner: true }), b = device(nb);
  await ready(a); await ready(b);
  const t0 = Date.now();
  for (let i = 0; i < 2000; i++) { stroke(a, `p${i}`, 100); if (i % 50 === 0) await sleep(0); }
  await until(() => b.items.size === 2000 && a.isSaved(), 'réception', 30000);
  const live = Date.now() - t0;
  // Un nouvel appareil arrive sur ce carnet déjà chargé
  const c = device(nb);
  const t1 = Date.now();
  await until(() => c.items.size === 2000, 'chargement initial', 30000);
  const load = Date.now() - t1;
  const lat = [];
  for (let i = 0; i < 20; i++) { stroke(a, `q${i}`); lat.push(await until(() => c.items.has(`q${i}`), 'latence')); }
  lat.sort((x, y) => x - y);
  const size = Y.encodeStateAsUpdate(a.doc).length;
  return `écrit et diffusé en ${live} ms ; nouvel appareil chargé en ${load} ms ; latence médiane ensuite ${lat[10]} ms ; document ${(size / 1024).toFixed(0)} Ko`;
});

await test('Sécurité : en mode diffusion, le serveur refuse les écritures des spectateurs', async () => {
  const nb = await createNotebook();
  const a = device(nb, { owner: true }), b = device(nb);
  await ready(a); await ready(b);
  a.send({ t: 'mode', mode: 'broadcast' });
  await until(() => b.me.role === 'viewer', 'B devient spectateur');
  // B contourne l'interface et envoie quand même une modification
  let denied = false;
  b.on('denied', () => { denied = true; });
  b.ws.send(new Uint8Array([1, ...Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getMap('items').set('pirate', { x: 1 }); return d; })())]));
  await until(() => denied, 'refus du serveur');
  stroke(a, 'officiel');
  await until(() => b.items.has('officiel'), 'B reçoit toujours le propriétaire');
  assert.equal(a.items.has('pirate'), false);
  // Un non-propriétaire ne peut pas non plus changer le mode
  b.send({ t: 'mode', mode: 'collab' });
  await sleep(100);
  assert.equal(b.me.role, 'viewer');
  return 'écriture forcée rejetée, changement de mode rejeté';
});

await test('Sécurité : retirer un appareil et arrêter le partage', async () => {
  const nb = await createNotebook();
  const a = device(nb, { owner: true }), b = device(nb), c = device(nb);
  await Promise.all([a, b, c].map(ready));
  a.send({ t: 'block', deviceId: b.hello.deviceId });
  await until(() => b.status === 'refused', 'B est retiré');
  b.reconnectNow();
  await until(() => b.status === 'refused' && b.refusedReason === 'appareil-retire', 'B ne peut pas revenir');
  a.send({ t: 'sharing', on: false });
  await until(() => c.status === 'refused', 'C est déconnecté à l\'arrêt du partage');
  const r = await fetch(`${base}/api/join/${nb.code}`);
  assert.equal(r.status, 404);
  assert.equal(a.status, 'online');
  return 'appareil retiré bloqué durablement ; arrêt du partage immédiat ; code de session désactivé';
});

await test('Dessin magique : croquis reconnu, photo stockée et servie ; refusé aux spectateurs', async () => {
  const nb = await createNotebook();
  const a = device(nb, { owner: true }), b = device(nb);
  await ready(a); await ready(b);
  assert.equal(a.me.vision, true);
  const r = await a.magic({ png: 'A'.repeat(400) });
  assert.equal(r.label, 'poêle à frire');
  const img = await fetch(`${base}/api/img/${r.img}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await img.arrayBuffer()).byteLength, PNG_1PX.length);
  assert.equal((await a.magic({ label: 'vélo' })).error, 'trop-vite');
  await sleep(2100);
  assert.equal((await a.magic({ label: 'introuvable' })).error, 'aucune-image');
  assert.equal((await b.magic({ png: 'court' })).error, 'image-invalide');
  a.send({ t: 'mode', mode: 'broadcast' });
  await until(() => b.me.role === 'viewer', 'B spectateur');
  assert.equal((await b.magic({ label: 'tasse' })).error, 'lecture-seule');
  return `« ${r.label} » → image ${r.img.slice(0, 6)}… servie par le serveur`;
});

await test('Rejoindre par code de session', async () => {
  const nb = await createNotebook();
  const r = await (await fetch(`${base}/api/join/${nb.code.toLowerCase()}`)).json();
  assert.equal(r.id, nb.id);
  assert.equal((await fetch(`${base}/api/join/ZZZZZZ`)).status, 404);
  return `code ${nb.code}`;
});

await test('Sauvegarde : le carnet survit à un redémarrage du serveur', async () => {
  const nb = await createNotebook();
  const a = device(nb, { owner: true });
  await ready(a);
  for (let i = 0; i < 350; i++) stroke(a, `k${i}`, 5); // dépasse le seuil de compaction
  await until(() => a.isSaved(), 'enregistrement');
  for (const c of clients.splice(0)) c.destroy();
  const port = srv.port;
  await srv.close();
  srv = await startServer({ port, dbFile, quiet: true, providers });
  base = `http://127.0.0.1:${srv.port}`;
  const fresh = device(nb);
  await until(() => fresh.items.size === 350, 'relecture après redémarrage');
  return `350 traits retrouvés (${srv.store.countUpdates(nb.id)} entrées en base après compaction)`;
});

for (const c of clients) c.destroy();
await srv.close();
rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} tests réussis\n`);
process.exit(failed ? 1 : 0);
