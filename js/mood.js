// Analyse de l'ambiance du texte : détermine, paragraphe par paragraphe, si la scène est
// calme, joyeuse, romantique, triste, tendue, d'action, épique, mystérieuse ou effrayante.
// Sert à choisir la musique (OST) et à colorer l'expressivité de la voix.
//
// Méthode : lexique pondéré (français + anglais) + ponctuation, lissé sur une fenêtre de
// paragraphes (avec un peu d'anticipation), remis à zéro à chaque changement de scène,
// puis stabilisé pour éviter de changer de musique toutes les deux phrases.

export const MOODS = [
  { id: 'calme', label: 'Calme', emoji: '🍃' },
  { id: 'joyeux', label: 'Joyeux', emoji: '☀️' },
  { id: 'romantique', label: 'Romantique', emoji: '💞' },
  { id: 'triste', label: 'Triste', emoji: '💧' },
  { id: 'tension', label: 'Tension', emoji: '⏳' },
  { id: 'action', label: 'Action', emoji: '⚔️' },
  { id: 'epique', label: 'Épique', emoji: '🔥' },
  { id: 'mystere', label: 'Mystère', emoji: '🌫️' },
  { id: 'effrayant', label: 'Effrayant', emoji: '🌑' },
];

export const moodById = id => MOODS.find(m => m.id === id) || MOODS[0];

/** Ambiances proches, utilisées quand aucune musique n'a le tag exact. */
export const MOOD_FALLBACK = {
  calme: ['romantique', 'mystere', 'joyeux'],
  joyeux: ['calme', 'romantique'],
  romantique: ['calme', 'triste', 'joyeux'],
  triste: ['calme', 'romantique', 'mystere'],
  tension: ['mystere', 'action', 'effrayant'],
  action: ['epique', 'tension'],
  epique: ['action', 'tension'],
  mystere: ['tension', 'calme', 'effrayant'],
  effrayant: ['tension', 'mystere'],
};

// Racines (sans accents, en minuscules). Poids 1 par défaut, "racine:2" pour un poids plus fort.
const LEXICON = {
  triste: `larme pleur sanglot chagrin tristesse triste deuil funer tombe:0.5 mourir:0.6 mourut:0.6 meurt:0.6 adieu regret solitude seule:0.6 seul:0.4
    perdu:0.5 perte souffr:0.7 douleur:0.6 brise:0.6 pardon:0.6 desole vide:0.5 absence manque:0.5 cercueil enterr defunt orphelin abandonn melancol
    gemi:0.8 lugubre desespoir:2 desesper:2 inconsolable sanglota:2 pleura:2 sanglotait:2 pleurait:2 souvenir:0.4 jamais_plus:0.8 trop_tard:1.2
    tear cried crying sobb grief sorrow mourn funeral lonely sadness regret`,
  action: `epee lame:0.8 coup:0.7 frapp attaqu combat bataille explos bless sang:0.6 esquiv bondi saut:0.6 courut courir:0.6 poing charge:0.6 griffe crocs
    ennemi arme:0.8 fleche tir:0.5 magie:0.6 sortilege incant flamm:0.8 eclair:0.6 foudre fracas impact transperc trancha tranch riposte parer:0.8
    bouclier armure guerrier duel choc:0.8 s'elanc elanca projet:0.4 percut ecras:0.8 abatt:0.8 fonca fonce:0.6 hache massue mordit
    sword strike attack fight battle blood dodge punch explosion slash blade enemy`,
  romantique: `amour:1.5 aimait aimer:0.8 baiser:1.5 embrass:1.5 levres:1.2 rougi:1.5 rougeur rougissant tendre:0.8 tendresse:1.5 caress etreint:1.2 enlac:1.5
    main_dans_la_main:2 joue:0.5 belle:0.5 beaute:0.6 charm:0.6 desir:0.8 epous:0.8 mariage:0.8 rendez-vous_timide:0.8 doucement:0.3 coeur_battait:1.2
    love kiss blush embrace tender darling`,
  joyeux: `rire:1.2 rit:1 riait:1.2 eclat_de_rire:2 joie:1.2 joyeu:1.2 heureu:1 content:0.8 sourire:0.5 souriait:0.6 plaisant:0.8 blague amus fete festin
    celebr enthous gai:0.8 ravi:0.8 enjou rigol taquin hilar pouffa s'esclaffa
    laugh joy happy cheerful grin`,
  calme: `calme:1.2 paisib tranquil silence:0.5 repos:0.8 dormir:0.6 sommeil:0.7 matin:0.5 aube:0.8 brise:0.3 soleil:0.4 jardin:0.8 fleur:0.6 lac:0.5 nuage:0.6 ciel:0.4
    promen:0.8 sereni apais detend soupira:0.5 lentement:0.5 chaleur:0.4 tasse:0.6 the_chaud:0.8 cuisine:0.5 dejeuner:0.6 repas:0.5
    calm peaceful quiet gentle breeze`,
  tension: `soudain:1.2 soudainement:1.2 brusque danger menace peur:0.8 craign:0.8 trembl:0.8 sueur froid:0.4 retint_son_souffle:2 haleta:1.2 nerv angoiss
    inquiet:0.8 suspic piege doute:0.5 pesant hesit crisp aux_aguets:1.5 surveill:0.6 prudem mefian presentiment urgence vite:0.4 coeur_s'emballa:2 deglutit:1.2
    suddenly danger threat fear tremble sweat nervous anxious`,
  mystere: `etrange:1.2 mystere:1.5 mysteri:1.5 secret:0.8 inconnu:0.8 enigm:1.5 bizarre:1 curieu:0.6 enquet indice mystique legende:0.6 ancien:0.4 prophet
    malediction rumeur:0.8 dissimul cache:0.4 brume brouillard:1.2 murmur:0.6 chuchot:0.6 enigmatique
    strange mystery secret unknown riddle mist fog`,
  effrayant: `horreur:1.5 horrible:1.2 terreur:1.5 terrifi:1.5 effroi:1.5 effray:1.2 epouvant:1.5 monstre:1.2 cadavre:1.5 ossements decompos demon:1.2
    sorciere:1 malefi tenebr:1.2 obscurite:0.6 ombre:0.5 folie:1.2 dement:1.2 hurlement:1.2 cauchemar:1.5 sinistr:1.2 macabr:1.5 viscer:1.5 entrailles:1.5
    putride:1.5 glacial:0.5 possede:1 miasme:1.5 pestilen:1.2 rire_dement:2
    horror terror monster corpse nightmare darkness`,
  epique: `heros:1.2 heroi:1.5 destin:1 jur:0.6 serment:1.5 promesse:1 sauver:1.2 sauverai:2 victoire:1.5 triomph:1.5 courage:1.2 determin:1.2 se_releva:1.5
    releva:0.8 volonte:1 royaume:0.6 armee:0.8 gloire:1.2 puissance:0.6 ultime:0.8 decisif:1 resolution:0.8 proteger:1 protegerai:2 je_vais_te_sauver:3
    hero destiny vow victory courage`,
};

function strip(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'");
}

const COMPILED = Object.entries(LEXICON).map(([mood, src]) => {
  const single = []; const phrases = [];
  src.trim().split(/\s+/).forEach(tok => {
    const [term, wt] = tok.split(':');
    const entry = { t: term.replace(/_/g, ' '), w: wt ? parseFloat(wt) : 1 };
    (term.includes('_') ? phrases : single).push(entry);
  });
  return { mood, single, phrases };
});

/** Scores d'ambiance d'un texte. */
export function scoreText(text) {
  const t = strip(text);
  const words = t.match(/[a-z][a-z'-]*/g) || [];
  const scores = {};
  MOODS.forEach(m => { scores[m.id] = 0; });
  for (const c of COMPILED) {
    let sc = 0;
    for (const w of words) {
      for (const s of c.single) {
        if (s.t.length <= 3 ? w === s.t : w.startsWith(s.t)) { sc += s.w; break; }
      }
    }
    for (const ph of c.phrases) {
      let idx = t.indexOf(ph.t);
      while (idx !== -1) { sc += ph.w; idx = t.indexOf(ph.t, idx + ph.t.length); }
    }
    scores[c.mood] += sc;
  }
  const excl = (text.match(/!/g) || []).length;
  const ell = (text.match(/…|\.\.\./g) || []).length;
  const q = (text.match(/\?/g) || []).length;
  scores.action += Math.min(excl, 4) * 0.25;
  scores.tension += Math.min(excl, 4) * 0.2;
  scores.triste += Math.min(ell, 4) * 0.2;
  scores.mystere += Math.min(q, 4) * 0.15 + Math.min(ell, 4) * 0.1;
  return { scores, words: words.length };
}

/**
 * Ambiance de chaque bloc du chapitre.
 * @returns {string[]} id d'ambiance par bloc (même indice que blocks)
 */
export function analyzeChapter(blocks) {
  const per = blocks.map(b => (b.text ? scoreText(b.text) : null));
  const n = blocks.length;
  // scènes : séparées par les blocs "hr" et les titres
  const sceneOf = [];
  let scene = 0;
  blocks.forEach((b, i) => { if (b.type === 'hr' || b.type === 'h') scene++; sceneOf[i] = scene; });

  const raw = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!per[i]) continue;
    const acc = {};
    MOODS.forEach(m => { acc[m.id] = 0; });
    let words = 0;
    // fenêtre : 3 blocs avant, 5 après (la musique anticipe un peu), dans la même scène
    for (let k = i - 3; k <= i + 5; k++) {
      if (k < 0 || k >= n || !per[k] || sceneOf[k] !== sceneOf[i]) continue;
      const w = k === i ? 1.5 : k > i ? 1 : 0.7;
      MOODS.forEach(m => { acc[m.id] += per[k].scores[m.id] * w; });
      words += per[k].words;
    }
    // normalisation par la longueur (scores pour ~100 mots)
    const norm = 100 / Math.max(60, words);
    let best = null; let bestV = 0;
    MOODS.forEach(m => {
      const v = acc[m.id] * norm;
      if (v > bestV) { bestV = v; best = m.id; }
    });
    raw[i] = bestV >= 1.6 ? best : null;
  }
  // propagation : les blocs neutres prennent l'ambiance précédente de la scène (sinon "calme")
  const out = new Array(n).fill('calme');
  let cur = null; let curScene = -1;
  for (let i = 0; i < n; i++) {
    if (sceneOf[i] !== curScene) { curScene = sceneOf[i]; cur = null; }
    if (raw[i]) cur = raw[i];
    out[i] = cur || 'calme';
  }
  // stabilisation : une ambiance doit durer au moins 3 blocs de texte pour s'imposer
  const textIdx = [];
  for (let i = 0; i < n; i++) if (per[i]) textIdx.push(i);
  let runStart = 0;
  for (let r = 1; r <= textIdx.length; r++) {
    if (r === textIdx.length || out[textIdx[r]] !== out[textIdx[runStart]]) {
      if (r - runStart < 3 && runStart > 0) {
        const prev = out[textIdx[runStart - 1]];
        for (let k = runStart; k < r; k++) out[textIdx[k]] = prev;
      }
      runStart = r;
    }
  }
  // les blocs sans texte (images, séparateurs) héritent du bloc suivant
  for (let i = n - 2; i >= 0; i--) if (!per[i]) out[i] = out[i + 1];
  return out;
}

/** Ajustements de voix selon l'ambiance (multiplicateurs de vitesse et de hauteur). */
export const MOOD_PROSODY = {
  calme: { rate: -0.04, pitch: -0.01 },
  joyeux: { rate: 0.03, pitch: 0.06 },
  romantique: { rate: -0.05, pitch: 0.02 },
  triste: { rate: -0.09, pitch: -0.07 },
  tension: { rate: 0.03, pitch: -0.03 },
  action: { rate: 0.08, pitch: 0.02 },
  epique: { rate: 0.02, pitch: 0.03 },
  mystere: { rate: -0.05, pitch: -0.04 },
  effrayant: { rate: -0.07, pitch: -0.08 },
};

/** Consignes de jeu pour les voix IA (OpenAI). */
export const MOOD_DIRECTION = {
  calme: 'scène paisible : voix posée, douce et chaleureuse, rythme tranquille',
  joyeux: 'scène joyeuse : voix lumineuse et souriante, rythme vif, légèreté',
  romantique: 'scène romantique : voix tendre, intime, un peu émue, rythme lent',
  triste: 'scène triste : voix douce, chargée d\'émotion, retenue, rythme lent avec des pauses',
  tension: 'scène tendue : voix basse et serrée, suspense, rythme qui retient son souffle',
  action: 'scène d\'action : voix énergique et haletante, rythme rapide, intensité',
  epique: 'scène épique : voix puissante et déterminée, élan héroïque',
  mystere: 'scène mystérieuse : voix feutrée, intrigante, presque chuchotée par moments',
  effrayant: 'scène effrayante : voix sombre, inquiétante, lente, frissons',
};
