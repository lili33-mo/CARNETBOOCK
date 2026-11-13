# SyncPad — architecture

## Vue d'ensemble

```
 Tablette        Téléphone        Ordinateur            (navigateurs)
 ┌────────┐      ┌────────┐       ┌────────┐
 │ Canvas │      │ Canvas │       │ Canvas │   moteur d'écriture   client/src/board.js
 │ Y.Doc  │      │ Y.Doc  │       │ Y.Doc  │   copie complète du carnet (CRDT)
 │IndexedDB│     │IndexedDB│      │IndexedDB│  stockage local, hors ligne
 └───┬────┘      └───┬────┘       └───┬────┘
     │   WebSocket : deltas binaires + messages éphémères   client/src/sync.js
     └───────────────┼────────────────┘
               ┌─────┴──────┐
               │  Serveur   │  server/index.js
               │  Node.js   │  vérifie les droits, applique, rediffuse
               │  Y.Doc     │
               │  SQLite    │  server/store.js
               └────────────┘
```

## Choix techniques et raisons

| Besoin | Choix | Raison |
|---|---|---|
| Multiplateforme | Application web (React) | Un seul code pour Windows, Mac, Android, iPad |
| Modifications simultanées | CRDT **Yjs** | Fusion automatique, déterministe, sans perte |
| Transport | **WebSocket** | Bidirectionnel, faible latence, fonctionne partout |
| Persistance serveur | **SQLite intégré à Node** (`node:sqlite`) | Aucune installation ; schéma portable vers PostgreSQL |
| Hors ligne | **IndexedDB** (y-indexeddb) | Le carnet reste utilisable et rien n'est perdu |
| Rendu | Canvas 2D sur deux calques | Écriture fluide même sur un carnet très chargé |

WebRTC n'est pas utilisé : il n'apporterait qu'un gain de latence marginal sur réseau local et priverait le serveur de son rôle de contrôle des droits.

## Modèle de données du carnet (Y.Doc)

- `items` (Y.Map) : `id → élément`
  - trait : `{ type:'stroke', tool, color, size, pts:[x,y,pression,…], vp, z, by }`
  - texte : `{ type:'text', x, y, text, color, fs, z, by }`
- `meta` (Y.Map) : `paper` = `blank | grid | lined`

`by` est l'identifiant de l'appareil auteur ; il servira à distinguer « écrire » de « modifier le contenu des autres ».
Un trait est immuable : on l'ajoute ou on le supprime. Deux appareils ne peuvent donc pas se corrompre mutuellement un trait.

## Protocole

Connexion : `ws://hôte/ws?nb=<id du carnet>`

| Sens | Message | Rôle |
|---|---|---|
| C→S | `{t:'hello', deviceId, name, kind, ownerToken?}` | Identification |
| S→C | `{t:'welcome', role, mode, sharing, title, code, color}` | Droits accordés |
| ↔ | binaire `[0, vecteur d'état]` | « Voici ce que j'ai » |
| ↔ | binaire `[1, delta]` | Modification |
| S→C | `{t:'ack'}` / `{t:'ack', denied:true}` | Enregistré / refusé |
| C→S→C | `live`, `live-end`, `cursor`, `view` | Éphémère : trait en cours, curseurs, écran du propriétaire |
| S→C | `peers`, `state`, `gone` | Appareils présents, changement de droits |
| C→S | `mode`, `title`, `sharing`, `disconnect`, `block`, `unblock` | Réservé au propriétaire |

**Reconnexion.** À chaque connexion les deux côtés échangent leur vecteur d'état et ne s'envoient que ce qui manque à l'autre. C'est ce mécanisme qui récupère ce qui a été écrit pendant une coupure.

**Trait en direct.** Pendant l'écriture, les points partent toutes les 33 ms en message éphémère (non stocké). Au lever du stylo, le trait complet est validé dans le CRDT. Le document reste ainsi compact : un trait = une entrée.

## Sécurité (état actuel)

- Le rôle est calculé par le serveur (`owner`, `editor`, `viewer`) et relu **à chaque modification reçue**. Un client modifié qui envoie une écriture sans en avoir le droit reçoit un refus et rien n'est diffusé (test « Sécurité » dans `tests/sync.test.mjs`).
- Le jeton du propriétaire fait 256 bits ; seul son hachage SHA-256 est stocké.
- Les codes de session sont limités à 30 essais par minute et par adresse.
- Un appareil retiré est bloqué durablement ; l'arrêt du partage coupe toutes les connexions des invités.

À faire : comptes utilisateurs, HTTPS, approbation explicite des nouveaux appareils.

## Feuille de route

| Étape | Contenu | État |
|---|---|---|
| 1 | Moteur d'écriture et interface | Fait |
| 2 | Synchronisation, hors ligne, reconnexion | Fait |
| 3 | Sessions, QR code, gestion des appareils, modes | Fait |
| 4 | **Section 13** : rôles Lecture / Écriture / Modification / Administrateur par participant, invitations à accepter ou refuser, historique et restauration de versions | À faire |
| 5 | Images, export PDF, installation hors ligne (PWA), hébergement Internet en HTTPS | À faire |

### Conception prévue pour l'étape 4

- Table `members(notebook_id, device_id, role, invited_by, status)` ; le rôle par participant remplace le mode global.
- « Écriture » contre « Modification » : avant d'appliquer un delta, le serveur l'applique sur une copie et rejette toute suppression ou remplacement d'un élément dont `by` n'est pas l'expéditeur.
- Invitations : lien signé portant le rôle proposé ; l'invité accepte ou refuse ; l'administrateur peut exiger une approbation.
- Historique : instantané du document à intervalles et avant chaque « tout effacer » ; restaurer = réécrire l'état de l'instantané comme une nouvelle modification, ce qui reste compatible avec le CRDT.

## Résultats des tests (exécutés le 13 novembre 2026)

Synchronisation, vrais clients WebSocket sur un vrai serveur, même machine :

- Latence d'un trait entre deux appareils : environ 5 ms (plancher de mesure du test).
- Six appareils : 30 traits reçus par les cinq autres en 20 ms.
- 200 éléments écrits en même temps par deux appareils : aucun perdu, copies identiques.
- Coupure réseau : 40 éléments récupérés des deux côtés dès la reconnexion.
- 2 000 traits (200 000 points) : document de 2,2 Mo, nouvel appareil chargé en 0,1 s.

Navigateurs Chrome réels, traits dessinés par événements pointeur :

- Le trait est visible chez l'autre avant la fin du geste.
- Carnet de 2 000 traits : ouverture en 0,5 s, redessin complet en 32 ms, image pendant l'écriture en 0,3 ms.

Ces chiffres viennent d'une seule machine : sur un vrai Wi-Fi, il faut ajouter le temps de trajet réseau (quelques millisecondes à quelques dizaines).
