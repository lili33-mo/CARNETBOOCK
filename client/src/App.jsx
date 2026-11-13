import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { SyncClient } from './sync.js';
import { Board, TOOLS, newId, sketchToPng } from './board.js';

// ---------- Identité de l'appareil et carnets récents (stockage local) ----------
function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

function detectDevice() {
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPhone/.test(ua)) return { kind: 'phone', name: 'iPhone' };
  if (/iPad/.test(ua) || touchMac) return { kind: 'tablet', name: 'iPad' };
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? { kind: 'phone', name: 'Téléphone Android' } : { kind: 'tablet', name: 'Tablette Android' };
  if (/Windows/.test(ua)) return { kind: 'desktop', name: 'Ordinateur Windows' };
  if (/Mac/.test(ua)) return { kind: 'desktop', name: 'Mac' };
  return { kind: 'desktop', name: 'Ordinateur' };
}
function getDevice() {
  let d = load('syncpad.device', null);
  if (!d?.id) { d = { id: newId('d') + newId(''), ...detectDevice() }; save('syncpad.device', d); }
  return d;
}
function rememberNotebook(entry) {
  const list = load('syncpad.notebooks', []);
  const prev = list.find((n) => n.id === entry.id) || {};
  save('syncpad.notebooks', [{ ...prev, ...entry, opened: Date.now() }, ...list.filter((n) => n.id !== entry.id)].slice(0, 30));
}

const KIND_LABEL = { desktop: 'Ordinateur', tablet: 'Tablette', phone: 'Téléphone', screen: 'Écran' };
const LINK_LABEL = { local: 'Cet ordinateur', lan: 'Wi-Fi / réseau local', internet: 'Internet' };
const ROLE_LABEL = { owner: 'Propriétaire', editor: 'Écriture', viewer: 'Lecture' };
const COLORS = ['#1c1b19', '#6b7280', '#dc2626', '#ea580c', '#f5c518', '#16a34a', '#2563eb', '#7c3aed', '#db2777'];

function ago(ts) {
  if (!ts) return 'jamais';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 10) return 'à l\'instant';
  if (s < 60) return `il y a ${Math.floor(s)} s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return new Date(ts).toLocaleDateString('fr-FR');
}

// ---------- Icônes ----------
const paths = {
  pen: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1zM14 7l3 3',
  pencil: 'M5 19l1.2-4.2L15.5 5.5l3 3L9.2 17.8 5 19zM13.5 7.5l3 3',
  highlighter: 'M9 14l-3 3v2h4l2-2M9 14l6-9 4 4-9 6M9 14l3 3M4 21h16',
  eraser: 'M8 19l-4-4a2 2 0 010-2.8l8.4-8.4a2 2 0 012.8 0l4 4a2 2 0 010 2.8L11 19H8zM7.5 9.5l6 6M11 19h9',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  magic: 'M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9L11 3zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z',
  hand: 'M8 12V5.5a1.5 1.5 0 013 0V11M11 10V4.5a1.5 1.5 0 013 0V11M14 10.5V6a1.5 1.5 0 013 0v8c0 3.5-2.5 6-6 6s-4.5-1.5-6-4l-2-3.5a1.4 1.4 0 012.4-1.4L8 13',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
  share: 'M16 8a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 100-6 3 3 0 000 6zM18 22a3 3 0 100-6 3 3 0 000 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  back: 'M15 18l-6-6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  desktop: 'M3 5h18v11H3zM8 20h8M12 16v4',
  tablet: 'M6 3h12a1 1 0 011 1v16a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1zM11 18h2',
  phone: 'M8 3h8a1 1 0 011 1v16a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zM11 18h2',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4',
};
const Icon = ({ name, size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
);

// ---------- Navigation ----------
function useRoute() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const f = () => setPath(location.pathname); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);
  const go = useCallback((p) => { history.pushState(null, '', p); setPath(p); }, []);
  return [path, go];
}

export default function App() {
  const [path, go] = useRoute();
  const m = path.match(/^\/n\/([a-z0-9]{6,32})$/);
  return m ? <Notebook key={m[1]} id={m[1]} go={go} /> : <Home go={go} />;
}

// ---------- Accueil ----------
function Home({ go }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const recents = useMemo(() => load('syncpad.notebooks', []), []);

  async function create() {
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/notebooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Carnet sans titre' }) });
      if (!r.ok) throw new Error();
      const nb = await r.json();
      rememberNotebook({ id: nb.id, code: nb.code, ownerToken: nb.ownerToken, title: 'Carnet sans titre' });
      go(`/n/${nb.id}`);
    } catch { setError('Impossible de créer le carnet. Le serveur est-il démarré ?'); setBusy(false); }
  }
  async function join(e) {
    e.preventDefault(); setError('');
    const c = code.replace(/[^A-Za-z0-9]/g, '');
    if (c.length < 4) return setError('Saisissez le code affiché sur l\'autre appareil.');
    try {
      const r = await fetch(`/api/join/${c}`);
      const body = await r.json();
      if (!r.ok) return setError(body.error || 'Code invalide.');
      go(`/n/${body.id}`);
    } catch { setError('Serveur injoignable.'); }
  }

  return (
    <main className="home">
      <div className="home-card">
        <div className="brand"><span className="brand-mark" />SyncPad</div>
        <h1>Écrivez une fois.<br />Affichez partout.</h1>
        <p className="lead">Un carnet manuscrit qui apparaît en temps réel sur tous vos appareils.</p>
        <button className="btn primary big" onClick={create} disabled={busy}>Nouveau carnet</button>
        <form className="join" onSubmit={join}>
          <label htmlFor="code">Rejoindre avec un code</label>
          <div className="join-row">
            <input id="code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={8} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
            <button className="btn" type="submit">Rejoindre</button>
          </div>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {recents.length > 0 && (
          <section className="recents">
            <h2>Carnets récents</h2>
            <ul>
              {recents.map((n) => (
                <li key={n.id}>
                  <a href={`/n/${n.id}`} onClick={(e) => { e.preventDefault(); go(`/n/${n.id}`); }}>
                    <span className="recent-title">{n.title || 'Carnet sans titre'}</span>
                    <span className="recent-meta">{n.ownerToken ? 'À vous' : 'Partagé'} · {ago(n.opened)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

// ---------- Carnet ----------
function Notebook({ id, go }) {
  const holder = useRef(null);
  const boardRef = useRef(null);
  const syncRef = useRef(null);
  const [, bump] = useState(0);
  const refresh = useCallback(() => bump((n) => n + 1), []);
  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(3);
  const [panel, setPanel] = useState(false);
  const [follow, setFollow] = useState(false);
  const [textEdit, setTextEdit] = useState(null);
  const [toast, setToast] = useState('');
  const [magic, setMagic] = useState({ busy: false, ask: false });
  const device = useMemo(getDevice, []);
  const saved = useMemo(() => load('syncpad.notebooks', []).find((n) => n.id === id), [id]);

  useEffect(() => {
    let dead = false, board, sync, idb;
    const doc = new Y.Doc();
    (async () => {
      // Copie locale du carnet : permet d'écrire hors ligne et de rouvrir instantanément
      try {
        idb = new IndexeddbPersistence(`syncpad-${id}`, doc);
        await Promise.race([idb.whenSynced, new Promise((r) => setTimeout(r, 1500))]);
      } catch { idb = null; }
      if (dead) return;
      sync = new SyncClient({
        url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
        notebookId: id, deviceId: device.id, name: device.name, kind: device.kind,
        ownerToken: saved?.ownerToken, doc,
      });
      if (idb) sync.skipOrigins.add(idb);
      board = new Board(holder.current, doc, sync, {
        onHistory: refresh, onView: refresh, onMeta: refresh, onMagic: refresh,
        onFollow: setFollow,
        onTextEdit: (t) => { board.setEditing(t.id); setTextEdit(t); },
      });
      syncRef.current = sync; boardRef.current = board;
      window.__syncpad = { board, sync }; // point d'accès pour les tests automatisés et le débogage
      sync.on('status', refresh);
      sync.on('peers', refresh);
      sync.on('denied', () => setToast('Modification refusée : ce carnet est en lecture seule pour vous.'));
      let firstRole = true;
      sync.on('me', () => {
        rememberNotebook({ id, title: sync.me.title, code: sync.me.code });
        document.title = `${sync.me.title} — SyncPad`;
        if (sync.me.role === 'viewer' && firstRole) { board.setFollow(true); setFollow(true); }
        if (sync.me.role !== 'viewer') { board.setFollow(false); setFollow(false); }
        firstRole = false;
        refresh();
      });
      setReady(true);
    })();
    const online = () => sync?.reconnectNow();
    const offline = () => sync?.goOffline();          // le système signale la perte du réseau
    addEventListener('offline', offline);
    const visible = () => { if (document.visibilityState === 'visible' && sync?.status === 'offline') sync.reconnectNow(); };
    addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    return () => {
      dead = true;
      removeEventListener('online', online);
      removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
      board?.destroy(); sync?.destroy(); idb?.destroy?.(); doc.destroy();
      document.title = 'SyncPad';
    };
  }, [id]);

  const board = boardRef.current, sync = syncRef.current;
  useEffect(() => { if (board) { board.tool = tool; board.color = color; board.size = size; board.eraserAt = null; board.dirtyOver = true; } }, [board, tool, color, size]);
  useEffect(() => { if (board && tool !== 'magic') { board.clearMagic(); setMagic({ busy: false, ask: false }); } }, [board, tool]);

  // Dessin magique : croquis -> nom de l'objet -> vraie photo posée à côté
  async function runMagic(label) {
    const strokes = board.magicStrokes(), bounds = board.magicBounds();
    if (!strokes.length) return;
    setMagic({ busy: true, ask: false });
    const res = await sync.magic(label ? { label } : { png: sketchToPng(strokes) });
    if (res.img) { board.placePicture(res, bounds); return setMagic({ busy: false, ask: false }); }
    if (res.needLabel) return setMagic({ busy: false, ask: true, hint: res.unknown ? 'Je n\'ai pas reconnu le dessin. Quel est cet objet ?' : 'Quel est cet objet ?' });
    if (res.error === 'aucune-image') return setMagic({ busy: false, ask: true, hint: `Aucune photo trouvée pour « ${res.label} ». Essayez un autre mot.` });
    setMagic({ busy: false, ask: false });
    setToast({ 'hors-ligne': 'Cette fonction demande une connexion au serveur.', 'trop-vite': 'Patientez deux secondes avant de réessayer.', 'lecture-seule': 'Ce carnet est en lecture seule pour vous.' }[res.error] || 'La recherche de photo a échoué. Vérifiez la connexion Internet de l\'ordinateur qui héberge SyncPad.');
  }

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t); }, [toast]);

  // Raccourcis clavier
  useEffect(() => {
    const down = (e) => {
      const b = boardRef.current; if (!b) return;
      if (e.target.matches('input, textarea, select')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? b.doRedo() : b.doUndo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); b.doRedo(); }
      else if (e.code === 'Space') { b.spaceDown = true; e.preventDefault(); }
      else if (!mod) { const t = { p: 'pen', c: 'pencil', s: 'highlighter', e: 'eraser', t: 'text', h: 'hand', m: 'magic' }[e.key.toLowerCase()]; if (t) setTool(t); }
    };
    const up = (e) => { if (e.code === 'Space' && boardRef.current) boardRef.current.spaceDown = false; };
    addEventListener('keydown', down); addEventListener('keyup', up);
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up); };
  }, []);

  const me = sync?.me;
  const canWrite = !!sync?.canWrite();
  const isOwner = me?.role === 'owner';
  const status = !sync ? 'connecting' : sync.status;
  const statusLabel = status === 'online'
    ? (sync.isSaved() ? 'Synchronisé' : 'Synchronisation…')
    : status === 'offline' ? (sync.dirtyOffline ? 'Hors ligne — modifications en attente' : 'Hors ligne') : status === 'refused' ? 'Accès fermé' : 'Connexion…';
  const statusClass = status === 'online' ? (sync.isSaved() ? 'ok' : 'busy') : status === 'offline' ? 'off' : 'busy';

  let refused = null;
  if (status === 'refused') {
    const msg = {
      introuvable: ['Carnet introuvable', 'Ce lien ne correspond à aucun carnet sur ce serveur.'],
      'partage-arrete': ['Partage arrêté', 'Le propriétaire a arrêté le partage de ce carnet.'],
      'appareil-retire': ['Accès retiré', 'Le propriétaire a retiré cet appareil du carnet.'],
      deconnecte: ['Déconnecté', 'Le propriétaire a déconnecté cet appareil.'],
    }[sync.refusedReason] || ['Accès refusé', ''];
    refused = (
      <div className="refused"><div className="home-card center">
        <h1 className="small">{msg[0]}</h1><p className="lead">{msg[1]}</p>
        <div className="row">
          {sync.refusedReason !== 'introuvable' && <button className="btn" onClick={() => sync.reconnectNow()}>Réessayer</button>}
          <button className="btn primary" onClick={() => go('/')}>Retour à l'accueil</button>
        </div>
      </div></div>
    );
  }

  const tb = (name, label, key) => (
    <button key={name} className={`tool ${tool === name ? 'active' : ''}`} onClick={() => setTool(name)} title={`${label} (${key})`} aria-label={label} aria-pressed={tool === name}><Icon name={name} /></button>
  );

  return (
    <div className="notebook">
      <header className="topbar">
        <button className="icon-btn" onClick={() => go('/')} aria-label="Retour à l'accueil" title="Accueil"><Icon name="back" /></button>
        {isOwner
          ? <input className="title" key={me.title} defaultValue={me.title} aria-label="Titre du carnet" maxLength={120}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== me.title) sync.send({ t: 'title', title: v }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
          : <span className="title readonly">{me?.title || saved?.title || 'Carnet'}</span>}
        <span className={`status ${statusClass}`} role="status"><i />{statusLabel}</span>
        <button className="btn share-btn" onClick={() => setPanel(!panel)} aria-expanded={panel}>
          <Icon name="share" size={17} /><span className="share-label">Partager</span>
          {sync?.peers.length > 0 && <b className="count">{sync.peers.length}</b>}
        </button>
      </header>

      <div className="stage">
        <div className="board" ref={holder} data-tool={canWrite ? tool : 'hand'} />

        {textEdit && board && (
          <textarea
            className="text-edit" autoFocus defaultValue={textEdit.text}
            style={{ left: board.toScreen(textEdit.x, textEdit.y)[0], top: board.toScreen(textEdit.x, textEdit.y)[1], fontSize: textEdit.fs * board.view.k, color: textEdit.color, lineHeight: 1.3 }}
            onBlur={(e) => { board.commitText({ ...textEdit, text: e.target.value }); setTextEdit(null); }}
            onKeyDown={(e) => { if (e.key === 'Escape') e.target.blur(); e.stopPropagation(); }}
            placeholder="Texte…"
          />
        )}

        {ready && canWrite && !refused && (
          <div className="toolbar" role="toolbar" aria-label="Outils d'écriture">
            <div className="group">
              {tb('pen', 'Stylo', 'P')}{tb('pencil', 'Crayon', 'C')}{tb('highlighter', 'Surligneur', 'S')}{tb('eraser', 'Gomme', 'E')}{tb('text', 'Texte', 'T')}{tb('magic', 'Dessin magique : dessinez un objet, obtenez sa photo', 'M')}{tb('hand', 'Déplacer', 'H')}
            </div>
            <div className="group colors">
              {COLORS.map((c) => (
                <button key={c} className={`swatch ${color === c ? 'active' : ''}`} style={{ '--c': c }} onClick={() => { setColor(c); if (tool === 'eraser' || tool === 'hand') setTool('pen'); }} aria-label={`Couleur ${c}`} aria-pressed={color === c} />
              ))}
              <label className="swatch custom" title="Autre couleur"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Autre couleur" /></label>
            </div>
            <div className="group">
              <input className="size" type="range" min="1" max="14" step="0.5" value={size} onChange={(e) => setSize(+e.target.value)} aria-label="Épaisseur du trait" title={`Épaisseur : ${size}`} />
              <span className="size-dot" aria-hidden="true"><i style={{ width: Math.max(2, size * (TOOLS[tool]?.width > 1 ? 1.6 : 1)), height: Math.max(2, size * (TOOLS[tool]?.width > 1 ? 1.6 : 1)), background: color }} /></span>
            </div>
            <div className="group">
              <button className="tool" onClick={() => board.doUndo()} disabled={!board?.canUndo()} title="Annuler (Ctrl+Z)" aria-label="Annuler"><Icon name="undo" /></button>
              <button className="tool" onClick={() => board.doRedo()} disabled={!board?.canRedo()} title="Rétablir (Ctrl+Y)" aria-label="Rétablir"><Icon name="redo" /></button>
            </div>
            <div className="group">
              <select className="paper" value={board?.meta.get('paper') || 'blank'} onChange={(e) => board.setPaper(e.target.value)} aria-label="Type de papier">
                <option value="blank">Feuille blanche</option><option value="grid">Quadrillé</option><option value="lined">Ligné</option>
              </select>
            </div>
          </div>
        )}

        {ready && canWrite && tool === 'magic' && !refused && (() => {
          const b = board.magicBounds();
          if (!b) return <div className="magic-hint">Dessinez un objet, puis touchez « Montrer l'objet ».</div>;
          const [sx, sy] = board.toScreen(b[0], b[3]);
          const style = { left: Math.max(10, Math.min(sx, board.w - 250)), top: Math.max(10, Math.min(sy + 10, board.h - 120)) };
          return (
            <div className="magic-chip" style={style}>
              {magic.ask ? (
                <form onSubmit={(e) => { e.preventDefault(); const v = e.target.elements.label.value.trim(); if (v) runMagic(v); }}>
                  <label htmlFor="magic-label">{magic.hint}</label>
                  <div className="magic-row">
                    <input id="magic-label" name="label" autoFocus maxLength={60} placeholder="poêle, vélo, tasse…" autoComplete="off" onKeyDown={(e) => e.stopPropagation()} />
                    <button className="btn primary" type="submit">Afficher</button>
                  </div>
                </form>
              ) : (
                <button className="btn primary" disabled={magic.busy} onClick={() => runMagic()}><Icon name="magic" size={17} />{magic.busy ? 'Recherche…' : 'Montrer l\'objet'}</button>
              )}
              <button className="icon-btn" onClick={() => { board.clearMagic(); setMagic({ busy: false, ask: false }); }} aria-label="Annuler le dessin magique" title="Recommencer"><Icon name="close" size={16} /></button>
            </div>
          );
        })()}

        {ready && me && !canWrite && (
          <div className="viewer-bar">
            <span>Mode diffusion · lecture seule</span>
            <label><input type="checkbox" checked={follow} onChange={(e) => { board.setFollow(e.target.checked); setFollow(e.target.checked); }} /> Suivre l'écran du propriétaire</label>
          </div>
        )}

        {ready && (
          <div className="zoom">
            <button onClick={() => { board._userMovedView(); board.zoomBy(1 / 1.25); }} aria-label="Zoom arrière">−</button>
            <button className="pct" onClick={() => { board._userMovedView(); board.resetZoom(); }} title="Revenir à 100 %">{Math.round((board?.view.k || 1) * 100)} %</button>
            <button onClick={() => { board._userMovedView(); board.zoomBy(1.25); }} aria-label="Zoom avant">+</button>
            <button onClick={() => { board._userMovedView(); board.fitContent(); }} title="Tout afficher" aria-label="Tout afficher"><Icon name="fit" size={16} /></button>
          </div>
        )}

        {toast && <div className="toast" role="alert">{toast}</div>}
        {refused}

        {panel && sync && me && <SharePanel sync={sync} me={me} device={device} id={id} board={board} onClose={() => setPanel(false)} setToast={setToast} />}
      </div>
    </div>
  );
}

// ---------- Panneau de partage et gestion des appareils ----------
function SharePanel({ sync, me, device, id, board, onClose, setToast }) {
  const [origin, setOrigin] = useState(location.origin);
  const [localOnly, setLocalOnly] = useState(false);
  const [name, setName] = useState(device.name);
  const isOwner = me.role === 'owner';
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 5000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) return;
    fetch('/api/info').then((r) => r.json()).then((info) => {
      if (info.addresses?.length) setOrigin(`http://${info.addresses[0]}:${info.port}`);
      else setLocalOnly(true);
    }).catch(() => {});
  }, []);
  const link = `${origin}/n/${id}`;

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); setToast(`${what} copié`); }
    catch { setToast('Copie impossible : sélectionnez le texte à la main.'); }
  }
  function rename() {
    const v = name.trim(); if (!v || v === device.name) return;
    device.name = v; save('syncpad.device', device); sync.hello.name = v; sync.send({ t: 'rename', name: v });
  }

  const offline = isOwner ? sync.known.filter((d) => !d.online) : [];
  const lastSync = new Map(sync.known.map((d) => [d.deviceId, d.lastSync]));

  return (
    <aside className="panel" aria-label="Partage et appareils">
      <div className="panel-head"><h2>Partage</h2><button className="icon-btn" onClick={onClose} aria-label="Fermer"><Icon name="close" /></button></div>

      {me.sharing ? (
        <section className="invite">
          <img className="qr" src={`/api/qr?text=${encodeURIComponent(link)}`} alt="QR code pour rejoindre ce carnet" width="148" height="148" />
          <div className="invite-info">
            <span className="label">Code de session</span>
            <button className="code" onClick={() => copy(me.code, 'Code')} title="Copier le code">{me.code}</button>
            <button className="link" onClick={() => copy(link, 'Lien')} title="Copier le lien">{link.replace(/^https?:\/\//, '')}</button>
            {localOnly && <p className="hint">Aucun réseau détecté : connectez cet ordinateur au Wi-Fi pour inviter d'autres appareils.</p>}
          </div>
        </section>
      ) : <p className="hint boxed">Le partage est arrêté. Vous seul avez accès à ce carnet.</p>}

      {isOwner && (
        <section>
          <span className="label">Mode</span>
          <div className="seg" role="radiogroup" aria-label="Mode d'utilisation">
            <button role="radio" aria-checked={me.mode === 'collab'} className={me.mode === 'collab' ? 'on' : ''} onClick={() => sync.send({ t: 'mode', mode: 'collab' })}>Collaboratif<small>Tous écrivent</small></button>
            <button role="radio" aria-checked={me.mode === 'broadcast'} className={me.mode === 'broadcast' ? 'on' : ''} onClick={() => { sync.send({ t: 'mode', mode: 'broadcast' }); board?._sendView(true); }}>Diffusion<small>Vous écrivez, les autres regardent</small></button>
          </div>
        </section>
      )}

      <section>
        <span className="label">Appareils connectés · {sync.peers.length}</span>
        <ul className="devices">
          {sync.peers.map((p) => (
            <li key={p.cid}>
              <span className="avatar" style={{ background: p.color }}><Icon name={p.kind} size={16} /></span>
              <div className="dev-main">
                <b>{p.name}{p.cid === me.cid && <em> · vous</em>}</b>
                <small>{KIND_LABEL[p.kind]} · {LINK_LABEL[p.link]} · {ROLE_LABEL[p.role]}{isOwner && lastSync.get(p.deviceId) ? ` · synchro ${ago(lastSync.get(p.deviceId))}` : ''}</small>
              </div>
              {isOwner && p.role !== 'owner' && (
                <div className="dev-actions">
                  <button onClick={() => sync.send({ t: 'disconnect', deviceId: p.deviceId })}>Déconnecter</button>
                  <button className="danger" onClick={() => sync.send({ t: 'block', deviceId: p.deviceId })}>Retirer</button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {offline.length > 0 && (
          <>
            <span className="label">Hors ligne</span>
            <ul className="devices muted">
              {offline.map((d) => (
                <li key={d.deviceId}>
                  <span className="avatar off"><Icon name={d.kind || 'desktop'} size={16} /></span>
                  <div className="dev-main"><b>{d.name}</b><small>{d.blocked ? 'Accès retiré' : `Vu ${ago(d.lastSeen)}`} · synchro {ago(d.lastSync)}</small></div>
                  <div className="dev-actions">
                    {d.blocked
                      ? <button onClick={() => sync.send({ t: 'unblock', deviceId: d.deviceId })}>Autoriser</button>
                      : d.deviceId !== device.id && <button className="danger" onClick={() => sync.send({ t: 'block', deviceId: d.deviceId })}>Retirer</button>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <label className="label" htmlFor="devname">Nom de cet appareil</label>
        <input id="devname" className="field" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
      </section>

      {isOwner && (
        <section className="panel-foot">
          {me.sharing
            ? <button className="btn danger wide" onClick={() => sync.send({ t: 'sharing', on: false })}>Arrêter le partage</button>
            : <button className="btn primary wide" onClick={() => sync.send({ t: 'sharing', on: true })}>Reprendre le partage</button>}
          <button className="btn ghost wide" onClick={() => { if (confirm('Effacer tout le contenu du carnet ? Vous pourrez annuler avec Ctrl+Z.')) board.clearAll(); }}><Icon name="trash" size={16} /> Tout effacer</button>
        </section>
      )}
    </aside>
  );
}
