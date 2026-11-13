// « Dessin magique » : reconnaître l'objet dessiné, puis trouver une vraie photo.
//
//  1. Reconnaissance : le croquis (PNG) est envoyé à un modèle de vision (Claude).
//     Nécessite la variable d'environnement ANTHROPIC_API_KEY. Sans clé, l'application
//     demande simplement à l'utilisateur de taper le nom de l'objet.
//  2. Photo : recherche dans Wikipédia (gratuit, sans clé), image téléchargée puis
//     stockée par le serveur pour que tous les appareils du carnet puissent l'afficher.

import { existsSync, readFileSync } from 'node:fs';

// La clé peut aussi être déposée dans un fichier « cle-anthropic.txt » à la racine du projet
const keyFile = new URL('../cle-anthropic.txt', import.meta.url);
if (!process.env.ANTHROPIC_API_KEY && existsSync(keyFile)) {
  const k = readFileSync(keyFile, 'utf8').trim();
  if (k) process.env.ANTHROPIC_API_KEY = k;
}

const UA = 'SyncPad/0.2 (carnet local ; usage personnel)';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const visionAvailable = () => !!process.env.ANTHROPIC_API_KEY;

export async function recognizeWithClaude(pngBase64) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.SYNCPAD_VISION_MODEL || 'claude-haiku-5-5',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
          { type: 'text', text: 'Ceci est un croquis fait à la main. Quel objet représente-t-il ? Réponds uniquement par le nom de l\'objet en français, précis, au singulier, sans article ni ponctuation (exemples : « poêle à frire », « vélo », « tasse »). Si le dessin est illisible, réponds exactement : inconnu' },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`reconnaissance : réponse ${res.status}`);
  const body = await res.json();
  const label = String(body?.content?.find?.((c) => c.type === 'text')?.text || '')
    .replace(/[«»".\n]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
  return label && label !== 'inconnu' ? label : null;
}

async function searchWiki(lang, label) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&generator=search`
    + `&gsrsearch=${encodeURIComponent(label)}&gsrlimit=6&gsrnamespace=0`
    + `&prop=pageimages|info&piprop=thumbnail&pithumbsize=640&inprop=url`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const pages = Object.values((await res.json())?.query?.pages || {}).sort((a, b) => a.index - b.index);
  const page = pages.find((p) => p.thumbnail?.source);
  if (!page) return null;
  return { src: page.thumbnail.source, width: page.thumbnail.width, height: page.thumbnail.height, title: page.title, pageUrl: page.fullurl };
}

export async function findWikipediaImage(label) {
  const hit = (await searchWiki('fr', label)) || (await searchWiki('en', label));
  if (!hit) return null;
  const res = await fetch(hit.src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  const mime = (res.headers.get('content-type') || '').split(';')[0];
  if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null;
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_IMAGE_BYTES) return null;
  return { data, mime, width: hit.width, height: hit.height, title: hit.title, pageUrl: hit.pageUrl };
}
