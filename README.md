# SyncPad

Carnet numérique connecté : on écrit sur un appareil, l'écriture apparaît en temps réel sur tous les autres.

**État : version 0.2** — moteur d'écriture, synchronisation temps réel, sessions, gestion des appareils et dessin magique.
Les permissions à quatre niveaux, l'historique des versions, les images et l'export PDF sont les prochaines étapes (voir `docs/ARCHITECTURE.md`).

## Démarrer (Windows)

1. Installer **Node.js LTS** (version 22.13 ou plus récente) depuis <https://nodejs.org>.
2. Double-cliquer sur **`start.bat`**. La première fois, il installe trois composants puis ouvre <http://localhost:3000>.
3. Au premier lancement, Windows demande d'autoriser Node.js sur le réseau : accepter pour les **réseaux privés**, sinon les autres appareils ne pourront pas se connecter.

Sur Mac ou Linux : `npm install --omit=dev` puis `npm start`.

## Connecter d'autres appareils

Les appareils doivent être sur le **même Wi-Fi** que l'ordinateur qui fait tourner SyncPad.

1. Ouvrir un carnet, cliquer sur **Partager**.
2. Sur l'autre appareil : scanner le **QR code**, ou ouvrir l'adresse affichée (`http://192.168.x.x:3000`) et saisir le **code de session**.

## Ce que fait cette version

| Domaine | Fonctions |
|---|---|
| Écriture | Stylo, crayon, surligneur, gomme, texte au clavier, couleurs, épaisseur, pression du stylet |
| Feuille | Blanche, quadrillée, lignée ; zoom, déplacement, « tout afficher » ; annuler / rétablir |
| Temps réel | Le trait apparaît chez les autres pendant qu'on l'écrit ; curseurs nommés et colorés |
| Fiabilité | Écriture hors ligne, reconnexion automatique, fusion sans perte des modifications simultanées |
| Sessions | Identifiant unique, code à 6 caractères, QR code, arrêt et reprise du partage |
| Appareils | Liste avec nom, type, statut, mode de connexion, dernière synchronisation ; déconnecter, retirer, ré-autoriser |
| Modes | Collaboratif (tous écrivent) ou Diffusion (le propriétaire écrit, les autres suivent son écran) |
| Sécurité | Droits vérifiés par le serveur à chaque modification ; sauvegarde automatique en base SQLite |

## Dessin magique : du croquis à la vraie photo

1. Choisir l'outil **étoiles** (touche `M`) et dessiner un objet, par exemple une poêle.
2. Toucher **Montrer l'objet**. Une photo de l'objet se pose à côté du croquis, avec son nom, sur tous les appareils du carnet.

Deux façons de fonctionner :

- **Sans clé IA (par défaut)** : l'application demande le nom de l'objet, puis affiche la photo.
- **Avec reconnaissance automatique** : créer un fichier `cle-anthropic.txt` à côté de `start.bat`, y coller une clé d'API Anthropic (<https://console.anthropic.com>, service payant à l'usage), puis relancer. Le croquis est alors envoyé à Anthropic pour être reconnu.

Les photos viennent de **Wikipédia** : l'ordinateur qui héberge SyncPad doit avoir Internet. Elles sont sous licences libres qui demandent de citer la source en cas de publication ; le lien de la page d'origine est conservé avec chaque image.

Raccourcis : `M` dessin magique, `P` stylo, `C` crayon, `S` surligneur, `E` gomme, `T` texte, `H` déplacer, `Espace` + glisser pour déplacer, `Ctrl` + molette pour zoomer, `Ctrl+Z` / `Ctrl+Y`.

## Limites connues

- **Pas de comptes utilisateurs.** Toute personne qui a le lien ou le code peut rejoindre le carnet tant que le partage est actif. Le propriétaire est l'appareil qui a créé le carnet (jeton secret gardé dans son navigateur) : vider les données du navigateur fait perdre ce statut.
- **Pas de chiffrement sur le réseau local** (`http://`). À réserver à un Wi-Fi de confiance. Le chiffrement arrive avec un hébergement en `https://`.
- **Réseau local uniquement** tant que le serveur tourne sur votre PC. L'accès par Internet demande de l'héberger.
- **Pas de Bluetooth** : deux navigateurs ne peuvent pas se synchroniser par Bluetooth.
- **Dessin magique** : la reconnaissance par IA et la recherche Wikipédia n'ont pas pu être essayées en conditions réelles pendant le développement (tests faits avec des services simulés). La photo trouvée est la première illustration de l'article Wikipédia correspondant : elle peut être imparfaite.
- La gomme efface des traits entiers. Images et export PDF : pas encore.
- Testé dans Chrome automatisé (ordinateur et écran mobile simulé). **Le ressenti du stylet sur une vraie tablette reste à vérifier par vous.**

## Tests

```
npm install            # installe aussi les outils de développement
npm test               # synchronisation : 12 scénarios sur un vrai serveur
npm i -D playwright    # une seule fois
npm run test:e2e       # 10 scénarios dans de vrais navigateurs Chrome
```

## Modifier l'interface

Le code source est dans `client/src`. Après modification : `npm run build` (ou `npm run dev` pour recompiler en continu).
Les données sont dans `data/syncpad.db` ; supprimer ce fichier remet tout à zéro.
