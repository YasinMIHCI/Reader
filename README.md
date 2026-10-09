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
| 🗣️ **Voix naturelle** | Utilise les meilleures voix de l'appareil, triées automatiquement (les voix neuronales « Natural », « Online », « Premium »… sont marquées ★ et choisies par défaut). |
| 🎯 **Suivi visuel** | Phrase en cours surlignée, mot en cours surligné, petit marqueur lumineux animé dans la marge qui suit la ligne lue, et défilement automatique fluide. Si tu fais défiler toi-même, un bouton « Suivre la voix » apparaît. Clique sur n'importe quelle phrase pour lire à partir de là. |
| 📚 **Bibliothèque** | Chaque chapitre ouvert est gardé en mémoire (IndexedDB) avec sa position de lecture : il se rouvre instantanément, **sans aucune nouvelle requête**. Recherche, suppression, export/import (pour passer d'un appareil à l'autre). |
| ⏭️ **Enchaînement** | Détection des liens « précédent / sommaire / suivant ». Le chapitre suivant est préchargé pendant l'écoute et lancé automatiquement à la fin. Les pages de sommaire sont détectées et affichées sous forme de liste. |
| 🎨 **Apparence** | 6 thèmes (Sorcière, Givre, Manoir, Clair, Sépia, Nuit OLED), 10 polices, taille, interligne, largeur, espacement, justification, alinéa, mode concentration. |
| 🌙 **Confort** | Minuterie de sommeil (10 min → fin du chapitre), vitesse de 0,5× à 2,5×, écran maintenu allumé pendant la lecture, contrôles depuis l'écran verrouillé / le casque. |
| 🎬 **Intro animée** | Une animation de 5 secondes au lancement (horloge qui remonte le temps, ombres, éclats, givre, cercle magique) — désactivable dans Réglages → Avancé. Dessinée entièrement en code, sans aucune image officielle. |
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
| `B` / `A` / `R` | Bibliothèque / Apparence / Réglages voix |

## Vie privée

Tout reste sur ton appareil : la bibliothèque, les images et les réglages sont stockés dans le navigateur (IndexedDB / localStorage). Aucun compte, aucun serveur à moi. Seules les requêtes nécessaires pour récupérer les chapitres sont envoyées (au site du roman, à l'API WordPress.com ou au proxy).

## Structure du projet

```
index.html              page unique de l'application
css/style.css           thèmes et mise en page responsive
js/main.js              orchestration (navigation, bibliothèque, lecteur, réglages)
js/fetcher.js           récupération : API WordPress, requête directe, proxys CORS
js/extractor.js         extraction du texte du roman + nettoyage + découpage en phrases
js/tts.js               moteur de lecture (Web Speech API, suivi mot à mot)
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
