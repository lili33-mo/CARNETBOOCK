// Tests de bout en bout dans de vrais navigateurs (Chrome piloté par Playwright).
// Chaque « appareil » est un contexte de navigation isolé (stockage séparé),
// connecté au vrai serveur. Les traits sont dessinés avec de vrais événements pointeur.
//   Prérequis : npm i -D playwright   (et Chrome installé ; CHROME_PATH pour le chemin)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { SyncClient, LOCAL } from '../client/src/sync.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const chromePath = process.env.CHROME_PATH || ['/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);

const dir = mkdtempSync(join(tmpdir(), 'syncpad-e2e-'));
const shots = process.env.SHOTS || join(dir, 'shots');
mkdirSync(shots, { recursive: true });
// Faux service de photos (pas d'accès Internet pendant les tests) ; pas de reconnaissance IA :
// l'application doit alors demander le nom de l'objet.
const PHOTO = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#c7d7e8"/><circle cx="270" cy="250" r="150" fill="#2b2b2b"/><rect x="400" y="232" width="220" height="36" rx="18" fill="#2b2b2b"/></svg>`;
const providers = { findImage: async (label) => ({ data: Buffer.from(PHOTO), mime: 'image/svg+xml', width: 640, height: 480, title: label, pageUrl: 'https://exemple.test' }) };
let vision = false;
providers.recognize = async () => (vision ? 'poêle à frire' : null);
const srv = await startServer({ port: 0, dbFile: join(dir, 'e2e.db'), quiet: true, providers });
const base = `http://127.0.0.1:${srv.port}`;
const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(url, { viewport = { width: 1100, height: 720 }, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('   [erreur page]', e.message); errors.push(e.message); });
  await page.goto(url);
  return page;
}
const errors = [];
const synced = (page) => page.waitForFunction(() => window.__syncpad?.sync.isSaved(), null, { timeout: 10000 });
const count = (page) => page.evaluate(() => window.__syncpad.board.items.size);
const waitCount = (page, n) => page.waitForFunction((n) => window.__syncpad?.board.items.size === n, n, { timeout: 15000 });
const digest = (page) => page.evaluate(() => { const o = window.__syncpad.board.items.toJSON(); return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])); });

async function draw(page, pts, { hold = false } = {}) {
  const box = await page.locator('.board').boundingBox();
  await page.mouse.move(box.x + pts[0][0], box.y + pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
  if (!hold) await page.mouse.up();
}
const wave = (x, y, w = 200, amp = 30) => Array.from({ length: 16 }, (_, i) => [x + (i * w) / 15, y + Math.sin(i / 2) * amp]);

// Pixels non blancs sur le calque de base : prouve que le contenu est réellement dessiné à l'écran
const inkPixels = (page) => page.evaluate(() => {
  const c = document.querySelectorAll('.board-canvas')[0];
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++;
  return n;
});

async function test(name, fn) {
  try { const info = await fn(); results.push({ name, ok: true }); console.log(`  ✓ ${name}${info ? ` — ${info}` : ''}`); }
  catch (e) { results.push({ name, ok: false }); console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}

console.log('\nSyncPad — tests navigateur\n');
let A, B, url;

await test('1-2. Créer un carnet sur A, le rejoindre sur B, écrire sur A et le voir sur B', async () => {
  A = await open(base);
  await A.getByRole('button', { name: 'Nouveau carnet' }).click();
  await A.waitForURL(/\/n\//);
  url = A.url();
  await synced(A);
  B = await open(url);
  await synced(B);
  // Trait en direct : visible chez B AVANT que A ne relève le stylo
  await draw(A, wave(300, 250), { hold: true });
  await B.waitForFunction(() => window.__syncpad.board.live.size === 1, null, { timeout: 5000 });
  const livePts = await B.evaluate(() => [...window.__syncpad.board.live.values()][0].pts.length / 3);
  await A.mouse.up();
  await waitCount(B, 1);
  await sleep(100);
  const ink = await inkPixels(B);
  assert.ok(ink > 200, `le trait doit être dessiné sur B (${ink} pixels)`);
  assert.equal(await B.evaluate(() => window.__syncpad.board.live.size), 0);
  return `tracé visible en direct chez B (${livePts} points reçus avant la fin du trait), puis validé`;
});

await test('Rejoindre par code de session depuis l\'accueil', async () => {
  const code = await A.evaluate(() => window.__syncpad.sync.me.code);
  const C = await open(base);
  await C.getByLabel('Rejoindre avec un code').fill(code);
  await C.getByRole('button', { name: 'Rejoindre' }).click();
  await C.waitForURL(url);
  await waitCount(C, 1);
  await C.context().close();
  return `code ${code}`;
});

await test('Outils : texte, gomme, annuler/rétablir, papier quadrillé — synchronisés', async () => {
  await A.getByRole('button', { name: 'Texte' }).click();
  const box = await A.locator('.board').boundingBox();
  await A.mouse.click(box.x + 320, box.y + 400);
  await A.locator('.text-edit').fill('E = mc²');
  await A.getByRole('button', { name: 'Stylo' }).click();
  await waitCount(B, 2);
  assert.ok(await B.evaluate(() => Object.values(window.__syncpad.board.items.toJSON()).some((i) => i.text === 'E = mc²')));
  await A.getByLabel('Type de papier').selectOption('grid');
  await B.waitForFunction(() => window.__syncpad.board.meta.get('paper') === 'grid');
  await A.getByRole('button', { name: 'Gomme' }).click();
  await draw(A, [[400, 200], [400, 300]]);         // traverse le trait ondulé
  await waitCount(B, 1);
  await A.getByRole('button', { name: 'Annuler' }).click();
  await waitCount(B, 2);
  await A.getByRole('button', { name: 'Rétablir' }).click();
  await waitCount(B, 1);
  await A.getByRole('button', { name: 'Annuler' }).click();
  await waitCount(B, 2);
  await A.getByRole('button', { name: 'Stylo' }).click();
  return 'chaque action est répercutée sur B';
});

await test('Dessin magique : dessiner un objet sur A, la photo apparaît sur A et sur B', async () => {
  const before = await count(B);
  await A.getByRole('button', { name: /Dessin magique/ }).click();
  const circle = Array.from({ length: 25 }, (_, i) => [760 + Math.cos(i / 4) * 45, 470 + Math.sin(i / 4) * 45]);
  await draw(A, circle);
  await draw(A, [[805, 470], [880, 470]]);          // le manche
  // 1er essai : l'IA ne reconnaît pas -> l'application demande le nom
  await A.getByRole('button', { name: "Montrer l'objet" }).click();
  await A.getByLabel(/Quel est cet objet/).fill('poêle');
  await A.screenshot({ path: join(shots, 'magique-question.png') });
  await sleep(2100);
  await A.getByRole('button', { name: 'Afficher', exact: true }).click();
  await waitCount(B, before + 3);
  const item = await B.evaluate(() => Object.values(window.__syncpad.board.items.toJSON()).find((i) => i.type === 'image'));
  assert.equal(item.label, 'poêle');
  await B.waitForFunction((id) => { const im = [...document.images, ...performance.getEntriesByType('resource')]; return performance.getEntriesByType('resource').some((r) => r.name.includes(id)); }, item.img);
  // 2e essai : reconnaissance automatique
  vision = true;
  await draw(A, [[760, 560], [860, 560], [860, 620], [760, 620], [760, 560]]);
  await sleep(2100);
  await A.getByRole('button', { name: "Montrer l'objet" }).click();
  await waitCount(B, before + 5);
  const labels = await B.evaluate(() => Object.values(window.__syncpad.board.items.toJSON()).filter((i) => i.type === 'image').map((i) => i.label));
  assert.deepEqual(labels.sort(), ['poêle', 'poêle à frire']);
  await sleep(300);
  await B.screenshot({ path: join(shots, 'magique.png') });
  await A.getByRole('button', { name: 'Stylo' }).click();
  // Nettoyage pour les tests suivants : A annule ses 5 ajouts
  for (let i = 0; i < 5; i++) await A.getByRole('button', { name: 'Annuler' }).click();
  await waitCount(B, before);
  return 'nom demandé quand l\'IA ne reconnaît pas, reconnaissance automatique sinon ; photo visible chez B';
});

const others = [];
await test('3-4. Six appareils : A écrit, les cinq autres affichent', async () => {
  others.push(B);
  for (let i = 0; i < 4; i++) others.push(await open(url, i === 0 ? { viewport: { width: 390, height: 780 }, mobile: true } : {}));
  await Promise.all(others.map(synced));
  await A.waitForFunction(() => window.__syncpad.sync.peers.length === 6);
  for (let i = 0; i < 4; i++) await draw(A, wave(200 + i * 20, 120 + i * 18, 160, 12));
  await draw(A, wave(280, 192, 160, 12), { hold: true });
  const t0 = Date.now();
  await A.mouse.up();
  await Promise.all(others.map((p) => waitCount(p, 7)));
  const ms = Date.now() - t0;
  const d = await digest(A);
  for (const p of others) assert.equal(await digest(p), d);
  await A.getByRole('button', { name: 'Partager' }).click();
  await A.waitForSelector('.devices li');
  assert.equal(await A.locator('.devices').first().locator('li').count(), 6);
  await A.screenshot({ path: join(shots, 'partage.png') });
  await others[1].screenshot({ path: join(shots, 'mobile.png') });
  await A.getByRole('button', { name: 'Fermer' }).click();
  return `6 appareils dans la liste, contenu identique partout (dernier trait reçu par les 5 autres en ${ms} ms, mesure incluant le pilotage des navigateurs)`;
});

await test('5. Deux appareils écrivent en même temps', async () => {
  const before = await count(A);
  await Promise.all([
    (async () => { for (let i = 0; i < 6; i++) await draw(A, wave(120, 430 + i * 22, 220, 8)); })(),
    (async () => { for (let i = 0; i < 6; i++) await draw(B, wave(560, 430 + i * 22, 220, 8)); })(),
  ]);
  await Promise.all([A, ...others].map((p) => waitCount(p, before + 12)));
  const d = await digest(A);
  for (const p of others) assert.equal(await digest(p), d);
  return `12 traits simultanés, aucun perdu, 6 copies identiques`;
});

await test('6-7. Couper le réseau de B, écrire des deux côtés, rétablir', async () => {
  const before = await count(A);
  await B.context().setOffline(true);
  await B.waitForFunction(() => window.__syncpad.sync.status === 'offline');
  await draw(B, wave(560, 150, 200, 20));
  await draw(B, wave(560, 200, 200, 20));
  await draw(A, wave(120, 600, 200, 10));
  await sleep(400);
  assert.equal(await count(A), before + 1, 'A ne reçoit rien de B pendant la coupure');
  assert.equal(await count(B), before + 2);
  const label = await B.locator('.status').textContent();
  await B.screenshot({ path: join(shots, 'hors-ligne.png') });
  await B.context().setOffline(false);
  const t0 = Date.now();
  await Promise.all([A, B].map((p) => waitCount(p, before + 3)));
  await synced(B);
  assert.equal(await digest(A), await digest(B));
  return `B affichait « ${label} » ; tout est récupéré ${Date.now() - t0} ms après le retour du réseau`;
});

await test('7 bis. Écrire hors ligne, fermer l\'onglet, rouvrir : rien n\'est perdu', async () => {
  const before = await count(A);
  await B.context().setOffline(true);
  await B.waitForFunction(() => window.__syncpad.sync.status === 'offline');
  await draw(B, wave(700, 300, 150, 15));
  await sleep(300);                                  // laisse IndexedDB écrire
  const ctx = B.context();
  await B.close();
  await ctx.setOffline(false);
  B = await ctx.newPage();
  await B.goto(url);
  await waitCount(A, before + 1);
  others[0] = B;
  return 'le trait écrit hors ligne est arrivé sur A après réouverture';
});

await test('Mode diffusion : B passe en lecture seule et suit l\'écran de A', async () => {
  await A.getByRole('button', { name: 'Partager' }).click();
  await A.getByRole('radio', { name: /Diffusion/ }).click();
  await B.waitForSelector('.viewer-bar');
  assert.equal(await B.locator('.toolbar').count(), 0);
  const before = await count(B);
  await draw(B, wave(300, 300));                     // tentative d'écriture : doit seulement déplacer la vue
  await sleep(200);
  assert.equal(await count(A), before);
  await B.screenshot({ path: join(shots, 'diffusion.png') });
  await A.getByRole('radio', { name: /Collaboratif/ }).click();
  await B.waitForSelector('.toolbar');
  await A.getByRole('button', { name: 'Fermer' }).click();
  return 'outils masqués chez B, aucune écriture possible, retour au collaboratif immédiat';
});

await test('8. Performance : carnet de 2 000 traits (200 000 points) dans le navigateur', async () => {
  const nb = await (await fetch(`${base}/api/notebooks`, { method: 'POST' })).json();
  const bot = new SyncClient({ url: `ws://127.0.0.1:${srv.port}/ws`, notebookId: nb.id, deviceId: 'robot-de-test-0001', name: 'Robot', kind: 'desktop', ownerToken: nb.ownerToken });
  const items = bot.doc.getMap('items');
  while (!bot.synced) await sleep(10);
  for (let i = 0; i < 2000; i++) {
    const pts = []; let x = Math.random() * 3000, y = Math.random() * 2000;
    for (let j = 0; j < 100; j++) { x += Math.random() * 12 - 4; y += Math.random() * 12 - 6; pts.push(Math.round(x), Math.round(y), 0.5); }
    bot.doc.transact(() => items.set(`p${i}`, { type: 'stroke', tool: 'pen', color: '#1c1b19', size: 2, pts, z: i }), LOCAL);
  }
  while (!bot.isSaved()) await sleep(10);
  const t0 = Date.now();
  const P = await open(`${base}/n/${nb.id}`);
  await waitCount(P, 2000);
  const load = Date.now() - t0;
  await P.evaluate(() => window.__syncpad.board.fitContent());
  const frame = await P.evaluate(() => { const b = window.__syncpad.board; const t = []; for (let i = 0; i < 10; i++) { const s = performance.now(); b._drawBase(); b.bctx.getImageData(0, 0, 1, 1); t.push(performance.now() - s); } t.sort((a, b) => a - b); return t[5]; });
  // Pendant l'écriture, seul le calque léger est redessiné
  const over = await P.evaluate(() => { const b = window.__syncpad.board; b.current = { tool: 'pen', color: '#000', size: 3, pts: Array.from({ length: 900 }, (_, i) => i % 3 === 2 ? 0.5 : i) }; const s = performance.now(); for (let i = 0; i < 20; i++) { b._drawOver(); b.octx.getImageData(0, 0, 1, 1); } b.current = null; return (performance.now() - s) / 20; });
  await draw(P, wave(300, 300));
  const t1 = Date.now();
  while (items.size < 2001) { if (Date.now() - t1 > 5000) throw new Error('trait non reçu'); await sleep(2); }
  await P.screenshot({ path: join(shots, 'performance.png') });
  bot.destroy(); await P.context().close();
  assert.ok(frame < 100, `rendu complet trop lent : ${frame} ms`);
  return `ouverture ${load} ms ; redessin complet de tout le carnet ${frame.toFixed(1)} ms ; image pendant l'écriture ${over.toFixed(2)} ms`;
});

await A.screenshot({ path: join(shots, 'carnet.png') });
const H = await open(base); await H.screenshot({ path: join(shots, 'accueil.png') });
await browser.close();
await srv.close();
if (!process.env.SHOTS) rmSync(dir, { recursive: true, force: true });
if (errors.length) console.log(`\n  ${errors.length} erreur(s) JavaScript relevée(s) dans les pages`);
const failed = results.filter((r) => !r.ok).length + (errors.length ? 1 : 0);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} tests réussis\n`);
process.exit(failed ? 1 : 0);
