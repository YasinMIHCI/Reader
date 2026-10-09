# Re:Lecteur

**Écoute tes romans en ligne au lieu de les lire.**
Tu colles l'URL d'un chapitre, Re:Lecteur récupère uniquement le texte du roman (sans menus, pubs, boutons de partage ni commentaires), le met en page comme tu veux, puis te le lit à voix haute. Le texte défile tout seul et le mot prononcé est surligné en direct.

Site 100 % statique (HTML/CSS/JS, aucune compilation) : il s'héberge gratuitement sur GitHub Pages et marche sur PC comme sur téléphone.

---

## Fonctionnalités

| | |
|---|---|
| 🔗 **Import par URL** | Colle le lien d'un chapitre. Pour les sites **WordPress.com** (comme la traduction FR de Re:Zero), l'API officielle est utilisée : pas besoin de proxy. Les autres sites passent par des proxys CORS (automatique). |
| 🧹 **Texte propre** | Seul le texte du roman est gardé : titres, paragraphes, dialogues, séparateurs de scènes. Les menus, pubs, « J'aime », « Partager », « Articles similaires », commentaires, liens de navigation et mots du traducteur sont retirés. |
| 🖼️ **Images** | Les illustrations du chapitre sont téléchargées et stockées sur l'appareil (elles restent disponibles hors ligne). Clic dessus pour les agrandir. |
| 🗣️ **Voix naturelle** | Voix de l'appareil (gratuit) triées automatiquement — les voix neuronales « Natural », « Online », « Premium »… sont marquées ★. **Expressivité** : le ton et le rythme varient selon les dialogues, les questions, les exclamations et l'ambiance de la scène. **Enchaînement fluide** : plusieurs phrases par énoncé pour supprimer les blancs. |
| 🎭 **Voix IA (option)** | Avec ta propre clé API : **OpenAI** (reçoit des consignes de jeu selon la scène : triste, action, romantique…) ou **ElevenLabs** (ultra-réaliste, synchronisation mot à mot exacte). Le passage suivant est préparé à l'avance (pas de blanc) et les audios sont mis en cache : une réécoute ne coûte rien. |
| 🎵 **Musiques d'ambiance** | Bibliothèque d'OST à partir de liens YouTube, avec des tags (calme, joyeux, romantique, triste, tension, action, épique, mystère, effrayant). Re:Lecteur **analyse le texte en direct** pour comprendre l'ambiance de la scène et lance la musique qui va avec, en fondu enchaîné. Pause avec la voix, volume réglable, ambiance forçable à la main. |
| 🎯 **Suivi visuel** | Phrase en cours surlignée, mot en cours surligné, petit marqueur lumineux animé dans la marge qui suit la ligne lue, et défilement automatique fluide. Si tu fais défiler toi-même, un bouton « Suivre la voix » apparaît. Clique sur n'importe quelle phrase pour lire à partir de là. |
| 📚 **Bibliothèque** | Chaque chapitre ouvert est gardé en mémoire (IndexedDB) avec sa position de lecture : il se rouvre instantanément, **sans aucune nouvelle requête**. Recherche, suppression, export/import (pour passer d'un appareil à l'autre). |
| ⏭️ **Enchaînement** | Détection des liens « précédent / sommaire / suivant ». Le chapitre suivant est préchargé pendant l'écoute et lancé automatiquement à la fin. Les pages de sommaire sont détectées et affichées sous forme de liste. |
| 🎨 **Apparence** | 6 thèmes (Sorcière, Givre, Manoir, Clair, Sépia, Nuit OLED), 10 polices, taille, interligne, largeur, espacement, justification, alinéa, mode concentration. |
| 🌙 **Confort** | Minuterie de sommeil (10 min → fin du chapitre), vitesse de 0,5× à 2,5×, écran maintenu allumé pendant la lecture, contrôles depuis l'écran verrouillé / le casque. |
| 🎬 **Intro animée** | Une animation de 5 secondes au lancement : horloge qui remonte le temps, ombres, éclats, puis une silhouette anonyme qui gravit un long escalier à contre-jour de la lune (vue de côté) — désactivable dans Réglages → Avancé. Dessinée entièrement en code, sans aucune image officielle. |
| 📱 **PC & mobile** | Interface responsive, panneaux en « bottom sheet » sur téléphone, installable comme une application (PWA), fonctionne hors ligne, partage de lien depuis Android directement vers l'appli. |

## Mettre le site en ligne (GitHub Pages)

1. Fusionne cette branche dans `main` (ou garde-la telle quelle).
2. Sur GitHub : **Settings → Pages → Build and deployment**
   - *Source* : **Deploy from a branch**
   - *Branch* : `main` (ou la branche de ton choix) — dossier **`/ (root)`** → **Save**
3. Après une minute, le site est disponible sur `https://yasinmihci.github.io/Reader/`.

Sur téléphone, ouvre l'adresse puis « Ajouter à l'écran d'accueil » pour l'avoir comme une vraie application.

## Avoir la voix la plus naturelle possible

La qualité de la voix dépend des voix installées sur l'appareil :

- **PC** : utilise **Microsoft Edge** → voix neuronales « Denise », « Henri », « Vivienne », « Rémy »… (excellentes, gratuites).
  Chrome propose « Google français » (correct).
- **Android** : Chrome + *Services Google de synthèse vocale* ; dans les réglages du téléphone (Accessibilité → Synthèse vocale) télécharge la voix française haute qualité.
- **iPhone / iPad** : Réglages → Accessibilité → Contenu énoncé → Voix → Français → télécharge une voix **Premium** ou **Améliorée**.

Choisis ensuite ta voix dans Réglages → Voix (bouton « Tester »).

### Voix IA (encore plus naturelles, avec émotions)

Réglages → Voix → **Moteur de voix** :

- **OpenAI** : crée une clé sur platform.openai.com (API keys). Modèle `gpt-4o-mini-tts` : la voix joue l'émotion de la scène. ≈ 1,5 centime par minute d'écoute.
- **ElevenLabs** : crée une clé sur elevenlabs.io (Profile → API keys). Offre gratuite ≈ 10 000 caractères/mois. Bouton « Charger mes voix » pour choisir parmi tes voix.

La clé n'est stockée que dans ton navigateur et n'est envoyée qu'au service choisi.

## Musiques d'ambiance (OST)

1. Bouton 🎵 en haut → colle un lien YouTube (vidéo d'OST), coche une ou plusieurs ambiances, « Ajouter ».
2. Pendant la lecture, l'ambiance détectée s'affiche dans le lecteur (ex. 💧 Triste). La musique correspondante démarre automatiquement, change en fondu quand la scène change, et se met en pause avec la voix.
3. Clique sur la puce d'ambiance pour forcer une ambiance, passer à une autre musique ou couper la musique.

Si aucune musique n'a exactement le bon tag, une ambiance proche est utilisée (ex. tension → mystère). Certaines vidéos interdisent la lecture hors de YouTube : elles sont signalées et ignorées.

## Sites qui bloquent les requêtes

Un site web ne peut normalement pas lire le contenu d'un autre site (règle CORS du navigateur). Re:Lecteur essaie dans l'ordre :

1. l'API WordPress.com (sites `*.wordpress.com`) ;
2. une requête directe ;
3. ton **proxy personnel** s'il est configuré ;
4. plusieurs proxys publics gratuits (le plus fiable est mémorisé) ;
5. l'API REST de WordPress pour les WordPress auto-hébergés.

Les proxys publics peuvent être lents ou indisponibles. Pour une fiabilité maximale, crée ton propre proxy gratuit en 2 minutes avec **Cloudflare Workers** : le code et les instructions sont dans [`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js). Colle ensuite son adresse dans Réglages → Avancé → Proxy personnel (ex. `https://relecteur-proxy.toi.workers.dev/?url={url}`).

En dernier recours : la carte **« Le site bloque ? Colle le texte »** de l'accueil accepte du texte ou du HTML copié depuis la page.

## Astuces

- **Marque-page magique** (Réglages → Avancé) : glisse-le dans ta barre de favoris, puis clique dessus depuis n'importe quel chapitre pour l'ouvrir dans Re:Lecteur.
- Lien direct : `https://yasinmihci.github.io/Reader/?url=<adresse du chapitre>`
- Ajoute `?nointro` à l'adresse pour sauter l'intro une fois.

### Raccourcis clavier

| Touche | Action |
|---|---|
| `Espace` | Lecture / pause |
| `←` `→` | Phrase précédente / suivante |
| `Maj` + `←` `→` | Paragraphe précédent / suivant |
| `+` `−` | Vitesse |
| `N` / `P` | Chapitre suivant / précédent |
| `F` | Revenir à la voix |
| `B` / `A` / `R` / `M` | Bibliothèque / Apparence / Réglages voix / Musiques |

## Vie privée

Tout reste sur ton appareil : la bibliothèque, les images, les musiques, le cache audio, les réglages et les clés API sont stockés dans le navigateur (IndexedDB / localStorage). Aucun compte, aucun serveur à moi. Seules les requêtes nécessaires sont envoyées : au site du roman (ou à l'API WordPress.com / au proxy), à YouTube pour les musiques, et au service de voix IA si tu en as choisi un.

## Structure du projet

```
index.html              page unique de l'application
css/style.css           thèmes et mise en page responsive
js/main.js              orchestration (navigation, bibliothèque, lecteur, réglages)
js/fetcher.js           récupération : API WordPress, requête directe, proxys CORS
js/extractor.js         extraction du texte du roman + nettoyage + découpage en phrases
js/tts.js               moteur de lecture (Web Speech API, suivi mot à mot, prosodie expressive)
js/neural.js            voix IA OpenAI / ElevenLabs (cache, préchargement, synchronisation)
js/mood.js              analyse de l'ambiance du texte (lexique + ponctuation, lissage par scène)
js/music.js             bibliothèque d'OST YouTube + lecteur + choix selon l'ambiance
js/reader.js            rendu, surlignage, marqueur de voix, défilement automatique
js/intro.js             intro animée de 5 s (canvas)
js/db.js                stockage local (IndexedDB) + export/import
js/settings.js          réglages
sw.js                   service worker (fonctionnement hors ligne)
vendor/Readability.js   Mozilla Readability (Apache 2.0), extraction de secours
proxy/                  proxy CORS optionnel pour Cloudflare Workers
tests/                  tests de bout en bout (Playwright) avec un faux site WordPress
```

## Développement

```bash
npx serve .            # ou : python3 -m http.server 8080
npm install && npm test   # tests de bout en bout (nécessite Chromium)
```

Les tests simulent un site WordPress (avec menus, pubs, partage, commentaires…), un proxy, l'API WordPress.com et une synthèse vocale factice ; ils vérifient l'extraction, le surlignage, le défilement, le stockage hors ligne, la bibliothèque, le mobile et l'intro.
