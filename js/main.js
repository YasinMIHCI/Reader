// Re:Lecteur — orchestration de l'application.

import * as db from './db.js';
import { fetchChapterSource, fetchPageHtml, fetchImageBlob, fetchWpComAdjacent } from './fetcher.js';
import { extractFromHtml, extractFromApi, extractFromPastedText } from './extractor.js';
import { getSettings, setSettings, resetSettings, onSettingsChange, applyAppearance, THEMES, FONTS, ensureFontLoaded } from './settings.js';
import { Speaker, loadVoices, sortedVoices, pickVoice, voiceLabel, ttsSupported } from './tts.js';
import { ReaderView, fmtDuration } from './reader.js';
import { playIntro } from './intro.js';
import { AudioSpeaker, OPENAI_VOICES, OPENAI_MODELS, ELEVEN_MODELS, ELEVEN_DEFAULT_VOICES, listElevenVoices, getElevenQuota, isFreeElevenVoice, isRetiredVoice } from './neural.js';
import { SyncManager, recordDeletion } from './sync.js';
import { HybridSpeaker } from './hybrid.js';
import { groupLibrary, checkNewChapters, notifyNew } from './series.js';
import { extractiveRecap, aiRecap } from './recap.js';
import { prepareSpeech, toDisplay, detectSpeaker, getDict, setDict } from './speech.js';
import { ensureRoles, getCast, setRole, NARRATOR, UNKNOWN, PITCHES } from './cast.js';
import { analyzeChapter, MOODS, moodById, MOOD_PROSODY } from './mood.js';
import { MusicManager } from './music.js';

const EXAMPLE_URL = 'https://rezerowebnovelfr.wordpress.com/2024/12/21/arc-vii-chapitre-1-bapteme/';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const state = {
  chapter: null,
  segments: [],
  objectUrls: [],
  abort: null,
  prefetching: new Set(),
  sleepTimer: null,
  sleepUntil: 0,
  sleepAtChapterEnd: false,
  wakeLock: null,
  saveTimer: null,
  knownIds: new Set(),
  items: [],         // énoncés envoyés à la voix (une ou plusieurs phrases chacun)
  segChunk: [],      // phrase -> { chunk, start }
  currentSeg: -1,    // phrase en cours
  currentLocal: 0,   // position du mot dans la phrase
  blockMoods: [],    // ambiance de chaque bloc
};

// Deux moteurs : voix de l'appareil (Web Speech) ou voix IA (OpenAI / ElevenLabs)
const engines = { browser: new Speaker(), neural: new AudioSpeaker() };
engines.hybrid = new HybridSpeaker(engines.browser, engines.neural);
// engineFallback : crédits de voix IA épuisés -> voix de l'appareil jusqu'au prochain changement de réglage
const engineFor = (s = getSettings()) => (s.engine === 'browser' || state.engineFallback ? engines.browser
  : s.hybrid ? engines.hybrid : engines.neural);
const sync = new SyncManager();
let speaker = engineFor();
/** Écoute un événement du moteur actif uniquement. */
function on(type, fn) {
  Object.values(engines).forEach(eng => eng.addEventListener(type, e => { if (eng === speaker) fn(e); }));
}
const reader = new ReaderView($('#reader'));
// eslint-disable-next-line prefer-const
let music;

// =====================================================================
// Utilitaires d'interface
// =====================================================================

function toast(msg, { type = 'info', duration = 4200, action } = {}) {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const m = document.createElement('span');
  m.className = 'toast-msg';
  m.textContent = msg;
  t.append(m);
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = () => { action.fn(); close(); };
    t.append(b);
  }
  box.append(t);
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 300); };
  if (duration) setTimeout(close, duration);
  t.addEventListener('click', e => { if (e.target === t || e.target === m) close(); });
  while (box.children.length > 3) box.firstChild.remove();
  return close;
}

function showLoading(title) {
  $('#loading-title').textContent = title || 'Récupération du chapitre…';
  $('#loading-step').textContent = '';
  $('#loading').hidden = false;
}
function setLoadingStep(s) { $('#loading-step').textContent = s; }
function hideLoading() { $('#loading').hidden = true; }

let openDrawer = null;
function showDrawer(id) {
  closeDrawers();
  const d = $('#' + id);
  d.hidden = false;
  $('#scrim').hidden = false;
  openDrawer = d;
  if (id === 'library') renderLibrary();
  if (id === 'music') renderMusic();
  if (id === 'settings') { renderCast(); renderDict(); }
  setTimeout(() => d.querySelector('input[type=search]')?.focus({ preventScroll: true }), 50);
}
function closeDrawers() {
  $$('.drawer').forEach(d => { d.hidden = true; });
  $('#scrim').hidden = true;
  openDrawer = null;
}
function selectTab(name) {
  $$('#settings .tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  if (name === 'voice') { renderCast(); renderDict(); }
  $$('#settings .tab-panel').forEach(p => { p.hidden = p.dataset.panel !== name; });
}

function setRangeFill(input) {
  const min = +input.min || 0; const max = +input.max || 100;
  const pct = max > min ? ((+input.value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', pct + '%');
}

function relativeDate(ts) {
  if (!ts) return '';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return "à l'instant";
  if (d < 3600) return `il y a ${Math.round(d / 60)} min`;
  if (d < 86400) return `il y a ${Math.round(d / 3600)} h`;
  if (d < 86400 * 7) return `il y a ${Math.round(d / 86400)} j`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

// iOS/Safari n'autorisent la synthèse vocale qu'à la suite d'un geste de l'utilisateur :
// on prononce un « silence » pendant le clic pour débloquer la lecture qui suivra le chargement.
let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked || !ttsSupported) return;
  speechUnlocked = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch { /* ignore */ }
}
document.addEventListener('pointerdown', unlockSpeech, { once: true, capture: true });
document.addEventListener('keydown', unlockSpeech, { once: true, capture: true });

function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) return null;
  const m = u.match(/https?:\/\/[^\s<>"']+/i);
  if (m) u = m[0];
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).href; } catch { return null; }
}

// =====================================================================
// Navigation (hash) : #/ = accueil, #/lire/<id> = chapitre
// =====================================================================

function routeFromHash() {
  const h = location.hash || '';
  const m = h.match(/^#\/lire\/(.+)$/);
  if (m) return { view: 'reader', id: decodeURIComponent(m[1]) };
  return { view: 'home' };
}

function goHome(push = true) {
  if (push && location.hash !== '#/') history.pushState(null, '', '#/');
  speaker.stop();
  state.chapter = null;
  showView('home');
  renderHome();
}

function showView(name) {
  $('#view-home').hidden = name !== 'home';
  $('#view-reader').hidden = name !== 'reader';
  $('#player').hidden = name !== 'reader';
  document.body.classList.toggle('has-player', name === 'reader');
  $('#topbar-title').classList.toggle('show', name === 'reader');
  $('#follow-btn').hidden = true;
  if (name === 'home') {
    delete document.documentElement.dataset.mood;
    $('#topbar').classList.remove('tucked');
    document.title = 'Re:Lecteur';
  }
}

async function handleRoute() {
  const r = routeFromHash();
  if (r.view === 'reader') {
    if (state.chapter?.id === r.id) return;
    await openChapter(r.id, { autoplay: false });
  } else {
    if (state.chapter) { speaker.stop(); state.chapter = null; }
    showView('home');
    renderHome();
  }
}

// =====================================================================
// Chargement d'un chapitre
// =====================================================================

async function fetchAndStore(url, { signal, onStep, keep } = {}) {
  const id = db.chapterIdFromUrl(url);
  const src = await fetchChapterSource(url, { signal, onStep });
  onStep?.('Extraction du texte…');
  const data = src.kind === 'api' ? extractFromApi(src) : extractFromHtml(src.html, src.url || url);
  const now = Date.now();
  const chapter = {
    id,
    url,
    canonicalUrl: src.url || url,
    title: data.title,
    siteName: data.siteName,
    lang: data.lang,
    blocks: data.blocks,
    nav: data.nav || {},
    isIndex: data.isIndex,
    index: (data.index || []).map(l => ({ ...l, id: db.chapterIdFromUrl(l.href) })),
    wordCount: data.wordCount,
    date: src.date || null,
    source: src.kind === 'api' ? src.source : src.via,
    navChecked: src.kind === 'html',
    addedAt: keep?.addedAt || now,
    lastReadAt: keep?.lastReadAt || now,
    progress: keep?.progress || { seg: 0, pct: 0 },
  };
  await db.saveChapter(chapter);
  state.knownIds.add(id);
  sync.schedulePush();
  return chapter;
}

async function loadUrl(rawUrl, { autoplay = true, force = false } = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) { toast('Adresse invalide.', { type: 'error' }); return; }
  const id = db.chapterIdFromUrl(url);
  const existing = await db.getChapter(id);
  if (existing && !force) {
    navigateToChapter(id, { autoplay });
    return;
  }
  speaker.stop();
  state.abort?.abort();
  const ctrl = new AbortController();
  state.abort = ctrl;
  showLoading(force ? 'Mise à jour du chapitre…' : 'Récupération du chapitre…');
  try {
    const chapter = await fetchAndStore(url, { signal: ctrl.signal, onStep: setLoadingStep, keep: existing });
    hideLoading();
    db.requestPersistence();
    if (force && state.chapter?.id === id) state.chapter = null;
    navigateToChapter(chapter.id, { autoplay });
  } catch (e) {
    hideLoading();
    if (ctrl.signal.aborted) return;
    console.error(e);
    toast(e.message?.split('\n')[0] || 'Échec du chargement', {
      type: 'error', duration: 9000,
      action: { label: 'Coller le texte', fn: () => { goHome(); const d = $('.paste-card'); d.open = true; d.scrollIntoView({ behavior: 'smooth' }); $('#paste-text').focus(); } },
    });
  } finally {
    if (state.abort === ctrl) state.abort = null;
  }
}

let pendingAutoplay = null;
function navigateToChapter(id, { autoplay = false } = {}) {
  pendingAutoplay = { id, autoplay };
  const hash = '#/lire/' + encodeURIComponent(id);
  if (location.hash === hash) {
    state.chapter = null;
    openChapter(id, { autoplay });
  } else {
    location.hash = hash; // déclenche hashchange -> openChapter
  }
}

function revokeObjectUrls() {
  state.objectUrls.forEach(u => URL.revokeObjectURL(u));
  state.objectUrls = [];
}

async function openChapter(id, { autoplay = false, startSeg = null } = {}) {
  if (pendingAutoplay?.id === id) { autoplay = autoplay || pendingAutoplay.autoplay; pendingAutoplay = null; }
  const chapter = await db.getChapter(id);
  if (!chapter) {
    toast('Ce chapitre n\'est plus en mémoire.', { type: 'error' });
    goHome();
    return;
  }
  speaker.stop();
  revokeObjectUrls();
  state.chapter = chapter;

  // Images stockées localement
  const stored = await db.getImagesForChapter(id).catch(() => []);
  const urlByKey = {};
  stored.forEach(img => {
    const u = URL.createObjectURL(img.blob);
    state.objectUrls.push(u);
    urlByKey[img.key] = u;
  });

  const s = getSettings();
  showView('reader');
  state.segments = reader.render(chapter, {
    imageUrl: (b, i) => urlByKey[`${id}#${i}`] || b.src,
    onNav: (kind, url) => goNav(kind, url),
    onIndexLink: href => loadUrl(href, { autoplay: true }),
    onDownload: kind => (kind === 'index' ? downloadIndex(chapter) : downloadFollowing(chapter)),
    knownIds: state.knownIds,
    readTitle: s.readTitle,
    estimateSeconds: () => speaker.totalSeconds(),
  });
  reader.anchor = s.scrollAnchor;
  reader.autoScroll = s.autoScroll;

  state.blockMoods = analyzeChapter(chapter.blocks);
  markDialogue(state.segments);
  speaker = engineFor();
  buildItems();
  configureVoice();
  // met à jour la durée estimée maintenant que la voix est configurée
  const meta = $('.chapter-meta');
  if (meta) meta.textContent = `${(chapter.wordCount || 0).toLocaleString('fr-FR')} mots · ≈ ${fmtDuration(speaker.totalSeconds())} d'écoute`;

  document.title = `${chapter.title} · Re:Lecteur`;
  $('#topbar-title').textContent = chapter.title;
  setupMediaSession();
  updateChapterButtons();

  // Position de reprise
  const total = state.segments.length;
  $('#progress').max = Math.max(0, total - 1);
  let seg = startSeg ?? chapter.progress?.seg ?? 0;
  if (seg >= total) seg = 0;
  if (chapter.progress?.pct >= 0.995) seg = 0; // chapitre terminé : on recommence au début
  positionAt(seg);
  updateMood(seg);
  if (seg > 0) {
    reader.setCurrent(seg, { scroll: false });
    requestAnimationFrame(() => reader.scrollToSegment(seg, true));
    if (!autoplay) toast(`Reprise à ${Math.round((seg / Math.max(1, total)) * 100)} %`, { action: { label: 'Depuis le début', fn: () => { seekSeg(0); window.scrollTo({ top: 0, behavior: 'smooth' }); } } });
  } else {
    window.scrollTo(0, 0);
  }
  updateProgressUI(seg);
  db.updateChapter(id, { lastReadAt: Date.now() });

  if (autoplay && total) playSeg(seg);

  showRecap(chapter);

  // Tâches de fond : navigation entre chapitres + images
  discoverNav(chapter);
  if (s.downloadImages) downloadImages(chapter, urlByKey);
}

function goNav(kind, url) {
  if (!url) return;
  const wasPlaying = speaker.playing;
  loadUrl(url, { autoplay: wasPlaying || kind === 'next' });
}

function updateChapterButtons() {
  const nav = state.chapter?.nav || {};
  $('#btn-prev-chap').disabled = !nav.prev;
  $('#btn-next-chap').disabled = !nav.next;
}

async function discoverNav(chapter) {
  if (chapter.navChecked || (chapter.nav?.next && chapter.nav?.prev) || !chapter.url) return;
  let found = {};
  try {
    const host = new URL(chapter.url).host;
    if (/\.wordpress\.com$/i.test(host) && chapter.date) {
      found = await fetchWpComAdjacent(host, chapter.date);
    } else {
      const html = await fetchPageHtml(chapter.url);
      found = extractFromHtml(html, chapter.url).nav || {};
    }
  } catch (e) {
    console.info('Navigation non trouvée', e.message);
  }
  const nav = { ...found, ...(chapter.nav || {}) };
  await db.updateChapter(chapter.id, { nav, navChecked: true });
  chapter.nav = nav;
  chapter.navChecked = true;
  if (state.chapter?.id === chapter.id) {
    state.chapter.nav = nav;
    reader.updateNav(state.chapter, (k, u) => goNav(k, u));
    updateChapterButtons();
  }
}

async function downloadImages(chapter, already = {}) {
  const todo = chapter.blocks.map((b, i) => ({ b, i })).filter(({ b, i }) => b.type === 'img' && b.src && !already[`${chapter.id}#${i}`]);
  if (!todo.length) return;
  let ok = 0;
  const worker = async () => {
    while (todo.length) {
      const { b, i } = todo.shift();
      try {
        const blob = await fetchImageBlob(b.src);
        const key = `${chapter.id}#${i}`;
        await db.saveImage(chapter.id, key, blob, b.src);
        ok++;
        if (state.chapter?.id === chapter.id) {
          const u = URL.createObjectURL(blob);
          state.objectUrls.push(u);
          reader.setImage(i, u);
        }
      } catch (e) {
        console.info('Image non téléchargée (affichée depuis le site)', b.src, e.message);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (ok) console.info(`${ok} image(s) enregistrée(s) hors ligne`);
}

async function prefetchNext() {
  const ch = state.chapter;
  const s = getSettings();
  if (!ch?.nav?.next || !s.prefetchNext) return;
  const nextId = db.chapterIdFromUrl(ch.nav.next);
  if (state.prefetching.has(nextId) || state.knownIds.has(nextId)) return;
  state.prefetching.add(nextId);
  try {
    if (await db.getChapter(nextId)) { state.knownIds.add(nextId); return; }
    const next = await fetchAndStore(ch.nav.next, {});
    console.info('Chapitre suivant préchargé :', next.title);
    if (s.downloadImages) downloadImages(next);
  } catch (e) {
    console.info('Préchargement impossible', e.message);
    state.prefetching.delete(nextId);
  }
}

// =====================================================================
// Voix & lecteur audio
// =====================================================================

function configureVoice() {
  const s = getSettings();
  const lang = state.chapter?.lang || 'fr-FR';
  if (speaker === engines.browser) {
    const voice = pickVoice(s.voiceURI, lang);
    speaker.configure({ voice, rate: s.rate, pitch: s.pitch, volume: s.volume });
  } else speaker.configure({ rate: s.rate, volume: s.volume });
}

function fillVoiceSelects() {
  const s = getSettings();
  const lang = state.chapter?.lang || 'fr';
  const { same, others } = sortedVoices(lang);
  const current = pickVoice(s.voiceURI, lang);
  const build = sel => {
    sel.innerHTML = '';
    if (!same.length && !others.length) {
      sel.append(new Option('Aucune voix disponible', ''));
      return;
    }
    const g1 = document.createElement('optgroup');
    g1.label = same.length ? 'Langue du texte (meilleures en premier)' : 'Aucune voix dans la langue du texte';
    same.forEach(v => g1.append(new Option(voiceLabel(v), v.voiceURI, false, current?.voiceURI === v.voiceURI)));
    sel.append(g1);
    if (others.length) {
      const g2 = document.createElement('optgroup');
      g2.label = 'Autres langues';
      others.forEach(v => g2.append(new Option(`${v.name} (${v.lang})`, v.voiceURI, false, current?.voiceURI === v.voiceURI)));
      sel.append(g2);
    }
  };
  build($('#set-voice'));
  build($('#voice-quick'));
  const natural = same.filter(v => /natural|neural|premium|enhanced|online|google/i.test(v.name)).length;
  $('#voice-count').textContent = `${same.length} voix pour cette langue${natural ? `, dont ${natural} naturelle(s) ★` : ''}`;
  const status = $('#voice-status');
  if (!ttsSupported) status.textContent = '⚠️ Ce navigateur ne propose pas la synthèse vocale.';
  else if (!same.length) status.textContent = '⚠️ Aucune voix française trouvée sur cet appareil : installe-en une (voir ci-dessus).';
  else status.textContent = `Voix sélectionnée : ${current ? voiceLabel(current) : '—'}`;
}

function updatePlayButton() {
  const btn = $('#btn-play');
  const playing = speaker.state === 'playing';
  btn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
  reader.setPlaying(playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function updateProgressUI(i) {
  const total = state.segments.length || 1;
  const p = $('#progress');
  p.value = i;
  setRangeFill(p);
  const pct = Math.round((i / Math.max(1, total - 1)) * 100);
  $('#time-pct').textContent = `${isFinite(pct) ? pct : 0} %`;
  const left = speaker.remainingSeconds();
  $('#time-left').textContent = left <= 0 ? '–' : left < 60 ? '< 1 min' : `−${fmtDuration(left)}`;
}

function saveProgress(seg) {
  const ch = state.chapter;
  if (!ch) return;
  const total = state.segments.length || 1;
  const pct = seg / Math.max(1, total - 1);
  ch.progress = { seg, pct };
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    db.updateChapter(ch.id, { progress: ch.progress, lastReadAt: Date.now() });
    sync.schedulePush(20000);
  }, 800);
}

// ---------------------------------------------------------------------
// Énoncés : plusieurs phrases sont regroupées pour limiter les blancs entre phrases,
// tout en gardant le suivi visuel phrase par phrase.

function markDialogue(segs) {
  let block = null; let depth = 0; let dash = false;
  segs.forEach(sg => {
    if (sg.block !== block) { block = sg.block; depth = 0; dash = /^[—–-]\s?/.test(sg.text); }
    const opens = (sg.text.match(/[«“]/g) || []).length;
    const closes = (sg.text.match(/[»”]/g) || []).length;
    sg.dialogue = dash || depth > 0 || opens > 0 || /^["']/.test(sg.text);
    depth = Math.max(0, depth + opens - closes);
  });
}

function moodOfSeg(i) {
  const sg = state.segments[i];
  if (!sg) return 'calme';
  const b = sg.block >= 0 ? sg.block : state.chapter?.blocks.findIndex(x => x.text) ?? 0;
  return state.blockMoods[b] || 'calme';
}

function prosodyFor(it, e, k) {
  const t = it.text.trim();
  let r = 0; let p = 0;
  if (it.dialogue) { p += 0.07; r += 0.02; }
  if (/\?\s*[»”"]?$/.test(t)) p += 0.05;
  if (/!/.test(t)) { r += 0.05; p += 0.04; }
  if (/…|\.\.\./.test(t)) r -= 0.05;
  const mp = MOOD_PROSODY[it.mood] || {};
  r += mp.rate || 0; p += mp.pitch || 0;
  p += (((k * 37) % 7) - 3) * 0.008; // petite variation naturelle d'un énoncé à l'autre
  return { rate: 1 + r * e, pitch: 1 + p * e * 1.4 };
}

const seriesKey = ch => ch?.siteName || (ch?.url ? new URL(ch.url).host : 'Texte collé');

function voicePools() {
  const lang = state.chapter?.lang || 'fr';
  return {
    browser: sortedVoices(lang).same.slice(0, 6).map(v => v.voiceURI),
    eleven: elevenVoiceOptions().filter(([, n]) => !n.startsWith('💎')).map(([id]) => id),
    openai: OPENAI_VOICES.map(([id]) => id),
  };
}
function baseVoices() {
  const s = getSettings();
  return { browser: pickVoice(s.voiceURI, state.chapter?.lang || 'fr-FR')?.voiceURI || '', eleven: s.elevenVoice, openai: s.openaiVoice };
}

function buildItems() {
  const s = getSettings();
  const segs = state.segments;
  const mode = speaker === engines.browser ? 'browser' : speaker === engines.hybrid ? 'hybrid' : 'neural';
  const maxLen = mode === 'browser' ? (s.fluid ? 240 : 0) : 520;
  const dict = getDict();
  const multi = !!s.multiVoice;
  // Qui parle ? (« Nom : “…” »)
  const blockSpeaker = {};
  const counts = new Map();
  (state.chapter?.blocks || []).forEach((bl, i) => {
    if (bl.type !== 'p' && bl.type !== 'quote') return;
    const n = detectSpeaker(bl.text);
    if (n) { blockSpeaker[i] = n; counts.set(n, (counts.get(n) || 0) + 1); }
  });
  state.characters = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const series = seriesKey(state.chapter);
  const cast = multi ? ensureRoles(series, state.characters.map(c => c[0]), voicePools(), baseVoices()) : {};
  const lang = state.chapter?.lang || 'fr-FR';
  const allVoices = sortedVoices(lang);
  const voiceByUri = uri => [...allVoices.same, ...allVoices.others].find(v => v.voiceURI === uri);

  const items = [];
  state.segChunk = new Array(segs.length);
  let cur = null;
  segs.forEach((sg, i) => {
    const mood = moodOfSeg(i);
    const role = blockSpeaker[sg.block] || (sg.dialogue ? UNKNOWN : NARRATOR);
    const engine = mode === 'hybrid' ? (role === NARRATOR ? 'browser' : 'neural') : mode === 'browser' ? 'browser' : 'neural';
    const roleKey = multi ? role : (sg.dialogue ? 'd' : 'n');
    const { spoken, map } = prepareSpeech(sg.text, { dict, stripSpeaker: multi && role !== NARRATOR && role !== UNKNOWN });
    const canMerge = cur && maxLen && cur.text.length + 1 + spoken.length <= maxLen && cur.mood === mood
      && (sg.block === -1) === (cur.block === -1) && cur.engine === engine
      && (engine === 'neural' && !multi ? true : cur.roleKey === roleKey);
    if (canMerge) {
      const start = cur.text.length + 1;
      cur.text += ' ' + spoken;
      cur.parts.push({ seg: i, start, map });
      cur.dialogue = cur.dialogue || sg.dialogue;
      state.segChunk[i] = { chunk: items.length - 1, start };
    } else {
      cur = { text: spoken, parts: [{ seg: i, start: 0, map }], mood, dialogue: sg.dialogue, block: sg.block, role, roleKey, engine };
      // voix du personnage (le narrateur garde la voix choisie dans les réglages)
      if (multi && role !== NARRATOR && cast[role]) {
        const r = cast[role];
        if (engine === 'browser') { cur.voice = voiceByUri(r.browser?.uri) || undefined; cur.castPitch = r.browser?.pitch || 1; }
        else { cur.elevenVoice = r.eleven; cur.openaiVoice = r.openai; }
      }
      items.push(cur);
      state.segChunk[i] = { chunk: items.length - 1, start: 0 };
    }
  });
  const e = s.expressiveness ?? 0.6;
  items.forEach((it, k) => {
    if (it.engine !== 'browser') return;
    const pr = prosodyFor(it, e, k);
    it.rateMul = pr.rate;
    it.pitchMul = pr.pitch * (it.castPitch || 1);
  });
  state.items = items;
  speaker.setItems(items, lang);
  if (openDrawer?.id === 'settings') renderCast();
}

/** Énoncé + position -> phrase + position dans la phrase. */
function locate(chunk, ci, len = 1) {
  const it = state.items[chunk];
  if (!it) return { seg: Math.max(0, state.currentSeg), local: 0, length: 1 };
  let part = it.parts[0];
  for (const p of it.parts) { if (p.start <= ci) part = p; else break; }
  // position dans le texte parlé -> position dans le texte affiché
  const d = toDisplay(part.map, Math.max(0, ci - part.start), len);
  return { seg: part.seg, local: d.index, length: d.length };
}

function setSegFromEngine(seg) {
  if (seg === state.currentSeg) return;
  state.currentSeg = seg;
  reader.setCurrent(seg);
  updateProgressUI(seg);
  saveProgress(seg);
  const total = state.segments.length;
  if (total && seg / total > 0.5) prefetchNext();
  updateMood(seg);
}

/** Place la lecture sur une phrase sans lancer la voix. */
function positionAt(seg) {
  const m = state.segChunk[seg] || { chunk: 0, start: 0 };
  speaker.index = m.chunk;
  speaker.charIndex = m.start;
  state.currentSeg = seg;
  state.currentLocal = 0;
}

function seekSeg(i, { play } = {}) {
  if (!state.segments.length) return;
  i = Math.max(0, Math.min(state.segments.length - 1, i));
  const m = state.segChunk[i];
  state.currentLocal = 0;
  speaker.seek(m.chunk, { play, offset: m.start });
  state.currentSeg = -1;
  setSegFromEngine(i);
}
const playSeg = i => seekSeg(i, { play: true });
const nextSeg = () => seekSeg(state.currentSeg + 1);
function prevSeg() {
  if (state.currentLocal > 12 && speaker.playing) seekSeg(state.currentSeg);
  else seekSeg(state.currentSeg - 1);
}

/** Change de moteur / regroupement en gardant la position. */
function rebuildItems() {
  const was = speaker.playing;
  speaker.stop();
  speaker = engineFor();
  if (!state.chapter) return;
  const seg = Math.max(0, state.currentSeg);
  buildItems();
  configureVoice();
  positionAt(seg);
  updatePlayButton();
  updateProgressUI(seg);
  if (was) playSeg(seg);
}

// ---------------------------------------------------------------------
// Ambiance

function updateMood(seg) {
  if (!state.chapter) return;
  const mood = moodOfSeg(seg);
  state.sceneMood = mood;
  music?.setSceneMood(mood);
  renderMoodChip();
}

function applyMoodTint() {
  const on = getSettings().moodTheme && state.chapter && !$('#view-reader').hidden;
  const mood = music?.mood || state.sceneMood;
  if (on && mood) document.documentElement.dataset.mood = mood;
  else delete document.documentElement.dataset.mood;
}

function renderMoodChip() {
  applyMoodTint();
  const m = moodById(music?.mood || state.sceneMood || 'calme');
  $('#mood-emoji').textContent = m.emoji;
  $('#mood-label').textContent = m.label;
  const btn = $('#btn-mood');
  btn.classList.toggle('manual', !!music?.manualMood);
  btn.title = `Ambiance : ${m.label}${music?.manualMood ? ' (forcée)' : ' (détectée)'} — musique`;
  if (btn.dataset.mood !== m.id) {
    btn.dataset.mood = m.id;
    btn.classList.add('pulse');
    setTimeout(() => btn.classList.remove('pulse'), 600);
  }
  $('#mini-mood').textContent = m.emoji;
}

function startPlayback() {
  if (!state.segments.length) return;
  checkElevenBeforePlay();
  if (speaker.state === 'paused') {
    if (!reader.isCurrentVisible()) reader.refocus();
    speaker.play();
    return;
  }
  // Première lecture : depuis la position sauvegardée, sinon depuis ce qui est visible à l'écran
  let from = Math.max(0, state.currentSeg);
  if (from === 0 && window.scrollY > 200) from = reader.firstVisibleSegment();
  playSeg(from);
}

function togglePlay() {
  if (speaker.state === 'playing') speaker.pause();
  else startPlayback();
}

on('segment', e => {
  const loc = locate(e.detail.index, e.detail.offset);
  state.currentLocal = loc.local;
  setSegFromEngine(loc.seg);
});
on('word', e => {
  const loc = locate(e.detail.index, e.detail.charIndex, e.detail.charLength);
  setSegFromEngine(loc.seg);
  state.currentLocal = loc.local;
  // pas de surlignage sur un signe de ponctuation isolé (« … »)
  const txt = state.segments[loc.seg]?.text.substr(loc.local, loc.length) || '';
  if (/[\p{L}\p{N}]/u.test(txt)) reader.setWord(loc.seg, loc.local, loc.length);
});
on('loading', e => $('#btn-play').classList.toggle('loading', !!e.detail));
on('notice', e => toast(e.detail.message, { duration: 7000 }));
on('state', () => {
  updatePlayButton();
  music?.onVoiceState(speaker.state === 'playing');
  if (speaker.state !== 'playing') $('#btn-play').classList.remove('loading');
  handleWakeLock();
  if (speaker.state !== 'playing') updateFollowButton();
});
on('error', e => {
  if (e.detail.code === 'quota' && speaker !== engines.browser) {
    state.engineFallback = true;
    toast(`${e.detail.message} Je continue avec la voix de l'appareil (rien n'est facturé).`, {
      type: 'error', duration: 9000,
      action: { label: 'Mes crédits', fn: () => { showDrawer('settings'); selectTab('voice'); showElevenQuota(); } },
    });
    rebuildItems();
    if (state.chapter) playSeg(Math.max(0, state.currentSeg));
    return;
  }
  if (e.detail.code === 'voice_switched') return;
  toast(e.detail.message, { type: 'error', duration: 7000 });
});
on('end', () => {
  const ch = state.chapter;
  if (!ch) return;
  ch.progress = { seg: state.segments.length - 1, pct: 1 };
  db.updateChapter(ch.id, { progress: ch.progress, lastReadAt: Date.now() });
  if (state.sleepAtChapterEnd) {
    setSleep(0);
    toast('Bonne nuit 🌙 — lecture arrêtée à la fin du chapitre.');
    return;
  }
  if (getSettings().autoNext && ch.nav?.next) {
    toast('Chapitre suivant…', { duration: 2500 });
    setTimeout(() => {
      if (state.chapter?.id === ch.id) loadUrl(ch.nav.next, { autoplay: true });
    }, 1200);
  } else if (!ch.nav?.next) {
    toast('Fin du chapitre ✦');
  }
});

// Défilement manuel / bouton « Suivre la voix »
let followCheck = null;
function updateFollowButton() {
  const btn = $('#follow-btn');
  if (!state.chapter || !state.segments.length || reader.current < 0) { btn.hidden = true; return; }
  const visible = reader.isCurrentVisible();
  reader.detached = !visible;
  const show = !visible && (speaker.state === 'playing' || speaker.state === 'paused');
  btn.hidden = !show;
  if (show) {
    const r = reader.segments[reader.current].el.getBoundingClientRect();
    btn.classList.toggle('up', r.top < 0);
  }
}
reader.addEventListener('userscroll', () => {
  clearTimeout(followCheck);
  followCheck = setTimeout(updateFollowButton, 250);
});
reader.addEventListener('seek', e => {
  const i = e.detail.index;
  reader.detached = false;
  playSeg(i);
});
reader.addEventListener('imageclick', e => {
  const lb = $('#lightbox');
  lb.querySelector('img').src = e.detail.src;
  lb.querySelector('img').alt = e.detail.alt || '';
  lb.showModal?.();
});
$('#follow-btn').addEventListener('click', () => {
  reader.detached = false;
  reader.refocus();
  $('#follow-btn').hidden = true;
});

// Barre du haut qui se cache en lecture quand on descend
let lastY = window.scrollY;
let scrollTick = false;
window.addEventListener('scroll', () => {
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => {
    scrollTick = false;
    const y = window.scrollY;
    const tb = $('#topbar');
    if (!$('#view-reader').hidden) {
      if (y > lastY + 6 && y > 120) tb.classList.add('tucked');
      else if (y < lastY - 6 || y < 60) tb.classList.remove('tucked');
    }
    lastY = y;
    if (!$('#follow-btn').hidden || reader.detached) updateFollowButton();
  });
}, { passive: true });

// Garder l'écran allumé
async function handleWakeLock() {
  const want = speaker.state === 'playing' && getSettings().keepAwake && document.visibilityState === 'visible';
  try {
    if (want && !state.wakeLock && 'wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener?.('release', () => { state.wakeLock = null; });
    } else if (!want && state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch { state.wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  handleWakeLock();
  if (document.visibilityState === 'hidden') sync.flush();
  else if (sync.enabled && Date.now() - (getSettings().lastSyncAt || 0) > 120000) sync.syncNow();
  if (document.visibilityState === 'hidden' && state.chapter) {
    db.updateChapter(state.chapter.id, { progress: state.chapter.progress, lastReadAt: Date.now() });
  }
});

// Contrôles « système » (écran verrouillé, casque Bluetooth…)
function setupMediaSession() {
  if (!('mediaSession' in navigator) || !state.chapter) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.chapter.title,
      artist: state.chapter.siteName || 'Re:Lecteur',
      album: 'Re:Lecteur',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* non supporté */ } };
    set('play', () => startPlayback());
    set('pause', () => speaker.pause());
    set('stop', () => speaker.pause());
    set('seekbackward', () => prevSeg());
    set('seekforward', () => nextSeg());
    set('previoustrack', () => goNav('prev', state.chapter?.nav?.prev));
    set('nexttrack', () => goNav('next', state.chapter?.nav?.next));
  } catch { /* ignore */ }
}

// Minuterie de sommeil
function setSleep(value) {
  clearInterval(state.sleepTimer);
  state.sleepTimer = null;
  state.sleepUntil = 0;
  state.sleepAtChapterEnd = false;
  const label = $('#sleep-label');
  label.textContent = '';
  if (value === 'chapter') {
    state.sleepAtChapterEnd = true;
    label.textContent = 'fin';
    toast('Arrêt à la fin du chapitre.');
  } else if (+value > 0) {
    state.sleepUntil = Date.now() + (+value) * 60000;
    const tick = () => {
      const left = state.sleepUntil - Date.now();
      if (left <= 0) {
        speaker.pause();
        setSleep(0);
        toast('Bonne nuit 🌙 — lecture mise en pause.');
        return;
      }
      label.textContent = `${Math.ceil(left / 60000)}′`;
    };
    tick();
    state.sleepTimer = setInterval(tick, 15000);
    toast(`Arrêt dans ${value} min.`);
  }
  $$('#sleep-pop [data-sleep]').forEach(b => b.classList.toggle('on', String(b.dataset.sleep) === String(value) && value !== 0 && value !== '0'));
}

function paragraphJump(dir) {
  const segs = state.segments;
  if (!segs.length) return;
  let i = Math.max(0, state.currentSeg);
  const block = segs[i]?.block;
  if (dir > 0) {
    while (i < segs.length - 1 && segs[i].block === block) i++;
  } else {
    // début du paragraphe courant, ou du précédent si on y est déjà
    let start = i;
    while (start > 0 && segs[start - 1].block === block) start--;
    if (start === i || state.currentLocal < 5) {
      if (start > 0) {
        const pb = segs[start - 1].block;
        start--;
        while (start > 0 && segs[start - 1].block === pb) start--;
      }
    }
    i = start;
  }
  seekSeg(i);
}

function changeRate(delta) {
  const r = Math.round(Math.min(2.5, Math.max(0.5, getSettings().rate + delta)) * 100) / 100;
  setSettings({ rate: r });
  toast(`Vitesse ${r.toString().replace('.', ',')}×`, { duration: 1200 });
}

// =====================================================================
// Accueil & bibliothèque
// =====================================================================

function chapterItem(ch, { onClick, current } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chap-item' + (current ? ' current' : '');
  const pct = Math.round((ch.progress?.pct || 0) * 100);
  b.innerHTML = `<div class="ci-main"><div class="ci-title"></div><div class="ci-sub"></div><div class="ci-bar"><i style="width:${pct}%"></i></div></div><span class="ci-pct">${pct >= 99 ? '✓' : pct + ' %'}</span>`;
  b.querySelector('.ci-title').textContent = ch.title;
  b.querySelector('.ci-sub').textContent = `${ch.siteName || ''} · ${relativeDate(ch.lastReadAt || ch.addedAt)}`;
  b.addEventListener('click', onClick);
  return b;
}

function renderNews() {
  const items = state.news || [];
  $('#news-card').hidden = !items.length;
  const list = $('#news-list');
  list.innerHTML = '';
  items.forEach(n => {
    const li = document.createElement('li');
    li.className = 'news-item';
    li.innerHTML = '<div class="ni-main"><div class="ni-title"></div><div class="ni-sub"></div></div>';
    li.querySelector('.ni-title').textContent = n.title || 'Chapitre suivant';
    li.querySelector('.ni-sub').textContent = `${n.series} · après « ${n.after} »`;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small primary';
    b.textContent = '▶ Écouter';
    b.onclick = () => loadUrl(n.url, { autoplay: true });
    li.append(b);
    list.append(li);
  });
  $('#btn-notify').hidden = typeof Notification === 'undefined' || Notification.permission !== 'default';
  // pastille sur le bouton Bibliothèque
  let badge = $('#btn-library .lib-badge');
  if (items.length && !badge) { badge = document.createElement('span'); badge.className = 'lib-badge'; $('#btn-library').append(badge); }
  if (badge) { if (items.length) badge.textContent = items.length; else badge.remove(); }
}

async function refreshNews(force = false) {
  try {
    state.news = await checkNewChapters({ force });
    renderNews();
    notifyNew(state.news);
    if (openDrawer?.id === 'library') renderLibrary();
  } catch (e) { console.info('Vérification des nouveautés impossible', e.message); }
}

async function renderHome() {
  const all = await db.listChapters().catch(() => []);
  state.knownIds = new Set(all.map(c => c.id));
  renderNews();
  const resume = all.find(c => (c.progress?.pct || 0) > 0.01 && (c.progress?.pct || 0) < 0.99) || null;
  const rc = $('#resume-card');
  rc.hidden = !resume;
  if (resume) {
    const body = $('#resume-body');
    body.innerHTML = '';
    body.append(chapterItem(resume, { onClick: () => navigateToChapter(resume.id, { autoplay: true }) }));
    if (resume.nav?.next) {
      const nb = document.createElement('button');
      nb.className = 'link-btn';
      nb.type = 'button';
      nb.textContent = 'Passer au chapitre suivant ›';
      nb.onclick = () => loadUrl(resume.nav.next, { autoplay: true });
      body.append(nb);
    }
  }
  const list = $('#recent-list');
  list.innerHTML = '';
  const recent = all.filter(c => c !== resume).slice(0, 6);
  $('#recent-card').hidden = !recent.length;
  recent.forEach(c => {
    const li = document.createElement('li');
    li.append(chapterItem(c, { onClick: () => navigateToChapter(c.id, { autoplay: false }) }));
    list.append(li);
  });
}

async function renderLibrary() {
  const all = await db.listChapters().catch(() => []);
  state.knownIds = new Set(all.map(c => c.id));
  const q = ($('#lib-search').value || '').trim().toLowerCase();
  const list = $('#lib-list');
  list.innerHTML = '';
  const filtered = all.filter(c => !q || (c.title + ' ' + (c.siteName || '')).toLowerCase().includes(q));
  if (!filtered.length) {
    list.innerHTML = `<div class="lib-empty">${all.length ? 'Aucun résultat.' : 'Ta bibliothèque est vide.<br>Les chapitres que tu ouvres seront gardés ici.'}</div>`;
  }
  // Groupé par série, puis par arc
  const makeRow = c => {
    const row = document.createElement('div');
    row.className = 'lib-row';
    row.append(chapterItem(c, {
      current: state.chapter?.id === c.id,
      onClick: () => { closeDrawers(); navigateToChapter(c.id, { autoplay: false }); },
    }));
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.type = 'button';
    del.title = 'Supprimer';
    del.setAttribute('aria-label', 'Supprimer ' + c.title);
    del.innerHTML = '<svg><use href="#i-trash"/></svg>';
    del.onclick = async () => {
      if (!confirm(`Supprimer « ${c.title} » de la bibliothèque ?`)) return;
      await db.deleteChapter(c.id);
      recordDeletion('chapters', c.id);
      sync.schedulePush(2000);
      state.knownIds.delete(c.id);
      renderLibrary();
      if (state.chapter?.id === c.id) goHome();
      else if (!$('#view-home').hidden) renderHome();
    };
    row.append(del);
    return row;
  };
  groupLibrary(filtered).forEach((ser, si) => {
    const box = document.createElement('section');
    box.className = 'lib-series';
    const head = document.createElement('div');
    head.className = 'lib-series-head';
    head.innerHTML = `<span></span><small>${ser.done}/${ser.count} terminés</small>`;
    head.firstChild.textContent = ser.name;
    box.append(head);
    const news = (state.news || []).filter(n => n.series === ser.name);
    news.forEach(n => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small primary';
      b.style.margin = '.3rem 0';
      b.textContent = `✨ Nouveau : ${n.title || 'chapitre suivant'}`;
      b.onclick = () => { closeDrawers(); loadUrl(n.url, { autoplay: true }); };
      box.append(b);
    });
    ser.arcs.forEach((arc, ai) => {
      const rows = arc.chapters.map(makeRow);
      if (!arc.arc && ser.arcs.length === 1) { const inner = document.createElement('div'); inner.className = 'lib-list-inner'; rows.forEach(r => inner.append(r)); box.append(inner); return; }
      const det = document.createElement('details');
      det.className = 'lib-arc';
      det.open = q ? true : (si === 0 && ai === 0);
      const pct = Math.round((arc.done / Math.max(1, arc.chapters.length)) * 100);
      det.innerHTML = `<summary><span></span><span>${arc.chapters.length} lu${arc.chapters.length > 1 ? 's' : ''} · ${arc.done} terminé${arc.done > 1 ? 's' : ''}</span></summary><div class="arc-bar"><i style="width:${pct}%"></i></div>`;
      det.querySelector('summary span').textContent = arc.arc || 'Autres chapitres';
      const inner = document.createElement('div');
      inner.className = 'lib-list-inner';
      rows.forEach(r => inner.append(r));
      det.append(inner);
      box.append(det);
    });
    list.append(box);
  });
  const est = await db.storageEstimate();
  $('#lib-usage').textContent = `${all.length} chapitre(s)` + (est?.usage ? ` · ${(est.usage / 1048576).toFixed(1)} Mo utilisés` : '');
}

// =====================================================================
// Réglages
// =====================================================================

const RANGE_FORMAT = {
  fontSize: v => `${v} px`,
  lineHeight: v => (+v).toFixed(2).replace('.', ','),
  width: v => `${v} em`,
  paraSpacing: v => `${(+v).toFixed(1).replace('.', ',')} em`,
  rate: v => `${(+v).toFixed(2).replace('.', ',')}×`,
  pitch: v => (+v).toFixed(2).replace('.', ','),
  volume: v => `${Math.round(v * 100)} %`,
  scrollAnchor: v => `${Math.round(v * 100)} %`,
  expressiveness: v => `${Math.round(v * 100)} %`,
  musicVolume: v => `${Math.round(v * 100)} %`,
};
const BOOL_KEYS = ['showRecap', 'moodTheme', 'multiVoice', 'hybrid', 'indent', 'highlightWord', 'highlightSentence', 'focusMode', 'autoScroll', 'readTitle', 'autoNext', 'prefetchNext', 'keepAwake', 'showIntro', 'downloadImages', 'fluid', 'musicAuto', 'musicFollowVoice'];
const TEXT_KEYS = ['openaiKey', 'openaiModel', 'openaiVoice', 'elevenKey', 'elevenModel', 'elevenVoice'];

function elevenVoiceOptions() {
  let custom = [];
  try { custom = JSON.parse(localStorage.getItem('relecteur.elevenVoices') || '[]'); } catch { /* ignore */ }
  custom = custom.filter(v => !isRetiredVoice(v.id));
  return custom.length ? custom.map(v => [v.id, v.name]) : ELEVEN_DEFAULT_VOICES;
}
function fillSelect(sel, options, value) {
  sel.innerHTML = '';
  options.forEach(([v, label]) => sel.append(new Option(label, v, false, v === value)));
  if (value && ![...sel.options].some(o => o.value === value)) sel.append(new Option(value, value, true, true));
}

function buildSettingsUI() {
  // Thèmes
  const grid = $('#theme-grid');
  THEMES.forEach(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-swatch';
    b.dataset.theme = t.id;
    b.innerHTML = `<b>${t.name}</b><span>${t.desc}</span><div class="dots"><i></i><i></i><i></i></div>`;
    // aperçu des couleurs du thème
    const probe = document.createElement('div');
    probe.dataset.theme = t.id;
    probe.style.display = 'none';
    document.body.append(probe);
    const cs = getComputedStyle(probe);
    b.style.background = cs.getPropertyValue('--bg');
    b.style.color = cs.getPropertyValue('--text');
    const dots = b.querySelectorAll('.dots i');
    dots[0].style.background = cs.getPropertyValue('--accent');
    dots[1].style.background = cs.getPropertyValue('--accent-2');
    dots[2].style.background = cs.getPropertyValue('--surface-2');
    probe.remove();
    b.onclick = () => setSettings({ theme: t.id });
    grid.append(b);
  });
  // Polices
  const fs = $('#set-font');
  FONTS.forEach(f => fs.append(new Option(f.name, f.id)));
  fs.onchange = () => setSettings({ font: fs.value });

  Object.keys(RANGE_FORMAT).forEach(k => {
    const input = $('#set-' + k);
    if (!input) return;
    input.addEventListener('input', () => {
      setSettings({ [k]: parseFloat(input.value) });
    });
  });
  BOOL_KEYS.forEach(k => {
    const input = $('#set-' + k);
    if (input) input.addEventListener('change', () => setSettings({ [k]: input.checked }));
  });
  $$('[data-align]').forEach(b => { b.onclick = () => setSettings({ align: b.dataset.align }); });
  $('#set-customProxy').addEventListener('change', e => setSettings({ customProxy: e.target.value.trim() }));
  const onVoice = e => setSettings({ voiceURI: e.target.value });
  $('#set-voice').addEventListener('change', onVoice);
  $('#voice-quick').addEventListener('change', onVoice);
  // Moteur de voix & voix IA
  $('#set-engine').addEventListener('change', e => setSettings({ engine: e.target.value }));
  // Nettoie une clé collée (espaces, retours à la ligne, guillemets, préfixe « xi-api-key: »…)
  const cleanKey = v => v.replace(/^\s*(xi-api-key|authorization|bearer)\s*[:=]?\s*/i, '').replace(/[\s"'`]/g, '');
  TEXT_KEYS.forEach(k => {
    const el = $('#set-' + k);
    if (!el) return;
    const isKey = /Key$/.test(k);
    let timer;
    const save = () => {
      const v = isKey ? cleanKey(el.value) : el.value.trim();
      if (isKey) el.value = v;
      if (v === (getSettings()[k] || '')) return;
      setSettings({ [k]: v });
      if (isKey && v) toast('Clé enregistrée ✓', { duration: 1800 });
    };
    el.addEventListener('change', save);
    if (isKey) el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 700); });
  });
  fillSelect($('#set-openaiModel'), OPENAI_MODELS, getSettings().openaiModel);
  fillSelect($('#set-openaiVoice'), OPENAI_VOICES, getSettings().openaiVoice);
  fillSelect($('#set-elevenModel'), ELEVEN_MODELS, getSettings().elevenModel);
  fillSelect($('#set-elevenVoice'), elevenVoiceOptions(), getSettings().elevenVoice);
  $('#eleven-load-voices').addEventListener('click', async () => {
    const key = $('#set-elevenKey').value.trim();
    if (!key) { toast("Colle d'abord ta clé API ElevenLabs.", { type: 'error' }); return; }
    setSettings({ elevenKey: key });
    try {
      const voices = await listElevenVoices(key);
      // voix gratuites d'abord ; celles de la bibliothèque (payantes via l'API) marquées
      voices.sort((a, b) => isFreeElevenVoice(b) - isFreeElevenVoice(a) || a.name.localeCompare(b.name));
      localStorage.setItem('relecteur.elevenVoices', JSON.stringify(voices.map(v => ({
        id: v.id,
        name: `${isFreeElevenVoice(v) ? '' : '💎 '}${v.name}${v.labels.accent ? ' · ' + v.labels.accent : ''}${v.labels.gender ? ' · ' + v.labels.gender : ''}${isFreeElevenVoice(v) ? '' : ' (compte payant)'}`,
      }))));
      fillSelect($('#set-elevenVoice'), elevenVoiceOptions(), getSettings().elevenVoice);
      const free = voices.filter(isFreeElevenVoice).length;
      toast(`${voices.length} voix chargées, dont ${free} utilisables gratuitement (les 💎 demandent un compte payant).`, { duration: 6000 });
    } catch (err) { toast(err.message, { type: 'error' }); }
  });
  $('#eleven-quota-btn').addEventListener('click', () => showElevenQuota());
  $('#album-prepare').addEventListener('click', () => prepareChapterAudio());
  $('#album-download').addEventListener('click', () => downloadAlbum());
  $('#dict-add').addEventListener('submit', e => {
    e.preventDefault();
    const from = $('#dict-from').value.trim(); const to = $('#dict-to').value.trim();
    if (!from || !to) return;
    const all = getDict().filter(d => d.from.toLowerCase() !== from.toLowerCase());
    all.push({ from, to });
    setDict(all);
    $('#dict-from').value = ''; $('#dict-to').value = '';
    renderDict();
    sync.schedulePush();
    rebuildItems();
    toast(`« ${from} » sera prononcé « ${to} ».`);
  });
  $('#audio-cache-clear').addEventListener('click', async () => {
    await db.clearAudio();
    toast('Cache audio vidé.');
  });
  $('#voice-test').addEventListener('click', () => {
    const s = getSettings();
    if (s.engine !== 'browser') {
      if (speaker.playing) speaker.pause();
      const t = new AudioSpeaker();
      t.addEventListener('error', e => toast(e.detail.message, { type: 'error', duration: 7000 }));
      t.setItems([{ text: "Bonjour ! Je suis la voix qui va te lire tes chapitres. Prêt ? Alors, on commence…", mood: 'joyeux', dialogue: true }], 'fr-FR');
      t.configure({ rate: s.rate, volume: s.volume });
      t.playFrom(0, 0);
      return;
    }
    if (!ttsSupported) return;
    const v = pickVoice(s.voiceURI, state.chapter?.lang || 'fr-FR');
    const wasPlaying = speaker.playing;
    if (wasPlaying) speaker.pause();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance('Bonjour ! Je suis la voix qui va te lire tes chapitres. On commence quand tu veux.');
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = s.rate; u.pitch = s.pitch; u.volume = s.volume;
    speechSynthesis.speak(u);
  });
  $('#btn-replay-intro').addEventListener('click', () => { closeDrawers(); playIntro({ reducedMotion: false }); });
  $('#btn-reset-settings').addEventListener('click', () => {
    if (confirm('Réinitialiser tous les réglages ?')) { resetSettings(); syncSettingsUI(); toast('Réglages réinitialisés.'); }
  });
  // Marque-page
  const base = location.origin + location.pathname;
  $('#bookmarklet').href = `javascript:(()=>{location.href='${base}?url='+encodeURIComponent(location.href)})()`;
  $('#bookmarklet').addEventListener('click', e => { e.preventDefault(); toast('Glisse ce bouton dans ta barre de favoris 😉'); });
}

function syncSettingsUI() {
  const s = getSettings();
  $$('.theme-swatch').forEach(b => b.classList.toggle('on', b.dataset.theme === s.theme));
  $('#set-font').value = s.font;
  Object.entries(RANGE_FORMAT).forEach(([k, fmt]) => {
    const input = $('#set-' + k);
    if (!input) return;
    input.value = s[k];
    setRangeFill(input);
    const out = $('#out-' + k);
    if (out) out.textContent = fmt(s[k]);
  });
  BOOL_KEYS.forEach(k => { const i = $('#set-' + k); if (i) i.checked = !!s[k]; });
  $$('[data-align]').forEach(b => b.classList.toggle('on', b.dataset.align === s.align));
  $('#set-customProxy').value = s.customProxy || '';
  $('#set-engine').value = s.engine;
  $$('.engine-panel').forEach(pn => { pn.hidden = pn.dataset.engine !== s.engine; });
  if ($('#hybrid-box')) $('#hybrid-box').hidden = s.engine === 'browser';
  $('#audio-cache-clear').hidden = s.engine === 'browser';
  TEXT_KEYS.forEach(k => { const el = $('#set-' + k); if (el && document.activeElement !== el) el.value = s[k] || ''; });
  $('#btn-speed').textContent = `${String(s.rate).replace('.', ',')}×`;
  const sr = $('#speed-range');
  sr.value = s.rate;
  setRangeFill(sr);
  $$('[data-speed]').forEach(b => b.classList.toggle('on', +b.dataset.speed === s.rate));
}

onSettingsChange((s, patch) => {
  applyAppearance(s);
  syncSettingsUI();
  if ('voiceURI' in patch || 'rate' in patch || 'pitch' in patch || 'volume' in patch) {
    configureVoice();
    if ('voiceURI' in patch) fillVoiceSelects();
    if (state.chapter) updateProgressUI(Math.max(0, state.currentSeg));
  }
  if (['engine', 'openaiKey', 'elevenKey', 'elevenModel', 'openaiModel'].some(k => k in patch)) state.engineFallback = false;
  if ('engine' in patch || 'fluid' in patch || 'expressiveness' in patch || 'multiVoice' in patch || 'hybrid' in patch
    || (s.engine !== 'browser' && ['openaiKey', 'openaiModel', 'openaiVoice', 'elevenKey', 'elevenModel', 'elevenVoice'].some(k => k in patch))) {
    rebuildItems();
  }
  if ('elevenVoice' in patch) fillSelect($('#set-elevenVoice'), elevenVoiceOptions(), s.elevenVoice);
  if ('musicVolume' in patch) music?.applyVolume();
  if ('moodTheme' in patch) applyMoodTint();
  if ('musicAuto' in patch && !s.musicAuto) music?.stop();
  if ('scrollAnchor' in patch) reader.anchor = s.scrollAnchor;
  if ('autoScroll' in patch) reader.autoScroll = s.autoScroll;
  if ('keepAwake' in patch) handleWakeLock();
  if ('readTitle' in patch && state.chapter) {
    const id = state.chapter.id;
    state.chapter = null;
    openChapter(id, { autoplay: false });
  }
  // Après un changement de mise en page, on garde la phrase lue en vue
  if (('fontSize' in patch || 'lineHeight' in patch || 'width' in patch || 'font' in patch || 'paraSpacing' in patch) && reader.current >= 0) {
    clearTimeout(state.relayout);
    state.relayout = setTimeout(() => { reader.lastLineTop = null; reader.updateMarker(false); }, 120);
  }
});

// =====================================================================
// Téléchargement d'un arc dans le navigateur (lecture hors ligne)
// =====================================================================

const dl = { queue: [], running: false, ctrl: null, done: 0, total: 0, failed: 0, label: '' };

function renderDlBar(text) {
  const bar = $('#dl-bar');
  bar.hidden = !dl.running;
  if (!dl.running) return;
  $('#dl-text').textContent = text || `${dl.label} : ${dl.done}/${dl.total}`;
  $('#dl-fill').style.width = `${Math.round((dl.done / Math.max(1, dl.total)) * 100)}%`;
}

/** Adresse du chapitre suivant d'un chapitre (lien de la page, sinon API WordPress.com). */
async function nextUrlOf(ch) {
  if (ch.nav?.next) return ch.nav.next;
  try {
    const host = new URL(ch.url).host;
    if (/\.wordpress\.com$/i.test(host) && ch.date) {
      const nav = await fetchWpComAdjacent(host, ch.date);
      if (nav.next) { await db.updateChapter(ch.id, { nav: { ...(ch.nav || {}), ...nav } }); return nav.next; }
    }
  } catch { /* ignore */ }
  return null;
}

async function runDownloads(nextFn) {
  dl.running = true;
  dl.ctrl = new AbortController();
  renderDlBar();
  const withImages = getSettings().downloadImages;
  try {
    while (!dl.ctrl.signal.aborted) {
      const job = dl.queue.shift() || (nextFn ? await nextFn() : null);
      if (!job) break;
      renderDlBar(`${dl.label} : ${dl.done + 1}/${dl.total} — ${job.title || 'chapitre'}…`);
      try {
        const id = db.chapterIdFromUrl(job.url);
        let ch = await db.getChapter(id);
        if (!ch) {
          ch = await fetchAndStore(job.url, { signal: dl.ctrl.signal });
          if (withImages) await downloadImages(ch);
        }
        job.after?.(ch);
      } catch (e) {
        if (dl.ctrl.signal.aborted) break;
        dl.failed++;
        console.info('Téléchargement impossible', job.url, e.message);
        job.after?.(null);
      }
      dl.done++;
      renderDlBar();
      await new Promise(r => setTimeout(r, 350)); // reste poli avec le site
    }
  } finally {
    const aborted = dl.ctrl.signal.aborted;
    dl.running = false;
    renderDlBar();
    const ok = dl.done - dl.failed;
    toast(aborted ? `Téléchargement arrêté : ${ok} chapitre(s) enregistré(s).`
      : `📥 ${ok} chapitre(s) enregistré(s) dans le navigateur${dl.failed ? ` (${dl.failed} échec(s))` : ''} : lisibles hors ligne.`, { duration: 6000 });
    dl.queue = [];
    if (!$('#view-home').hidden) renderHome();
    if (openDrawer?.id === 'library') renderLibrary();
    if (state.chapter?.isIndex) { const id = state.chapter.id; state.chapter = null; openChapter(id); }
  }
}

function downloadIndex(chapter) {
  if (dl.running) { toast('Un téléchargement est déjà en cours.'); return; }
  const links = (chapter.index || []).filter(l => !state.knownIds.has(l.id));
  if (!links.length) { toast('Tous les chapitres de ce sommaire sont déjà enregistrés.'); return; }
  if (links.length > 15 && !confirm(`Télécharger ${links.length} chapitres dans le navigateur ? Ça peut prendre quelques minutes.`)) return;
  dl.queue = links.map(l => ({ url: l.href, title: l.text }));
  dl.total = links.length; dl.done = 0; dl.failed = 0;
  dl.label = 'Sommaire';
  runDownloads();
}

function downloadFollowing(chapter, count = 10) {
  if (dl.running) { toast('Un téléchargement est déjà en cours.'); return; }
  const answer = prompt('Combien de chapitres suivants télécharger dans le navigateur ?', String(count));
  if (answer === null) return;
  const n = Math.max(1, Math.min(100, parseInt(answer, 10) || count));
  dl.total = n; dl.done = 0; dl.failed = 0;
  dl.label = 'Suite';
  let cur = chapter;
  let left = n;
  const visited = new Set([chapter.id]);
  // on suit les liens « chapitre suivant » de proche en proche
  runDownloads(async () => {
    if (left <= 0 || !cur) return null;
    const url = await nextUrlOf(cur);
    const id = url && db.chapterIdFromUrl(url);
    if (!url || visited.has(id)) { dl.total = dl.done; return null; } // fin de la série (ou boucle)
    visited.add(id);
    left--;
    return { url, title: '', after: ch => { cur = ch; } };
  });
}

// =====================================================================
// Récap « Précédemment… »
// =====================================================================

async function findPrevious(ch) {
  if (ch.nav?.prev) {
    const p = await db.getChapter(db.chapterIdFromUrl(ch.nav.prev));
    if (p) return p;
  }
  // sinon : le chapitre qui précède dans la même série (ordre des arcs et des numéros)
  const all = await db.listChapters();
  const ser = groupLibrary(all).find(x => x.name === seriesKey(ch));
  if (!ser) return null;
  const flat = [...ser.arcs].reverse().flatMap(a => a.chapters);
  const i = flat.findIndex(c => c.id === ch.id);
  return i > 0 ? flat[i - 1] : null;
}

function speakRecap(lines) {
  if (!ttsSupported || !lines.length) return;
  if (speaker.playing) speaker.pause();
  speechSynthesis.cancel();
  const s = getSettings();
  const u = new SpeechSynthesisUtterance(`Précédemment. ${lines.join(' ')}`);
  const v = pickVoice(s.voiceURI, state.chapter?.lang || 'fr-FR');
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = s.rate; u.pitch = s.pitch; u.volume = s.volume;
  speechSynthesis.speak(u);
}

async function showRecap(chapter) {
  $('#reader .recap-card')?.remove();
  if (!getSettings().showRecap) return;
  const prev = await findPrevious(chapter);
  if (!prev || (prev.progress?.pct || 0) < 0.3 || state.chapter?.id !== chapter.id) return;
  let lines = prev.recapAI || extractiveRecap(prev);
  if (!lines.length) return;
  const card = document.createElement('section');
  card.className = 'recap-card';
  card.innerHTML = '<div class="recap-head"><b>📜 Précédemment…</b><span></span></div><ul></ul><div class="row wrap"></div>';
  card.querySelector('.recap-head span').textContent = `dans « ${prev.title} »`;
  const fill = (ls, ai) => {
    const ul = card.querySelector('ul');
    ul.innerHTML = '';
    ls.forEach(l => { const li = document.createElement('li'); li.textContent = l; ul.append(li); });
    if (ai) { const tag = document.createElement('span'); tag.className = 'recap-ai'; tag.textContent = '✨ résumé IA'; card.querySelector('.recap-head').append(tag); }
  };
  fill(lines, !!prev.recapAI);
  const actions = card.querySelector('.row');
  const mk = (label, fn, cls = 'btn small') => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label; b.onclick = fn; actions.append(b); return b; };
  mk('▶ Écouter le récap', () => speakRecap(lines));
  if (!prev.recapAI && getSettings().openaiKey) {
    const btn = mk('✨ Résumé IA', async () => {
      btn.disabled = true; btn.textContent = 'Rédaction…';
      try {
        lines = await aiRecap(prev, getSettings().openaiKey);
        await db.updateChapter(prev.id, { recapAI: lines });
        fill(lines, true);
        btn.remove();
      } catch (e) { toast(e.message, { type: 'error' }); btn.disabled = false; btn.textContent = '✨ Résumé IA'; }
    });
  }
  mk('Masquer', () => card.remove(), 'btn small ghost');
  $('#reader .chapter-head')?.after(card);
}

// =====================================================================
// Voix des personnages & prononciation
// =====================================================================

function voiceOptionsFor(kind) {
  if (kind === 'eleven') return elevenVoiceOptions();
  if (kind === 'openai') return OPENAI_VOICES;
  const { same } = sortedVoices(state.chapter?.lang || 'fr');
  return same.map(v => [v.voiceURI, voiceLabel(v)]);
}

function testRole(role, sample) {
  const s = getSettings();
  const r = getCast(seriesKey(state.chapter))[role] || {};
  const text = prepareSpeech(sample || 'Bonjour, voici ma voix.', { dict: getDict(), stripSpeaker: true }).spoken.slice(0, 160);
  if (speaker.playing) speaker.pause();
  const useBrowser = s.engine === 'browser' || state.engineFallback;
  if (useBrowser) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = [...sortedVoices(state.chapter?.lang || 'fr').same].find(x => x.voiceURI === r.browser?.uri);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = s.rate; u.pitch = s.pitch * (r.browser?.pitch || 1);
    speechSynthesis.speak(u);
    return;
  }
  const t = new AudioSpeaker();
  t.addEventListener('error', e => toast(e.detail.message, { type: 'error', duration: 7000 }));
  t.setItems([{ text, mood: 'calme', dialogue: true, elevenVoice: r.eleven, openaiVoice: r.openai }], 'fr-FR');
  t.configure({ rate: s.rate, volume: s.volume });
  t.playFrom(0, 0);
}

// ---------------------------------------------------------------------
// Audio du chapitre entier (une piste : écoute écran éteint + MP3)

function renderAlbumBox() {
  const s = getSettings();
  const box = $('#album-box');
  if (!box) return;
  box.hidden = s.engine === 'browser';
  const album = engines.neural.album;
  $('#album-download').hidden = !album || speaker !== engines.neural;
  if (s.hybrid && s.engine !== 'browser') $('#album-status').textContent = 'Indisponible en mode économie (la narration est lue par l\'appareil, qui ne peut pas être enregistrée).';
  else if (album && speaker === engines.neural) $('#album-status').textContent = `✓ Piste prête : ${fmtDuration(album.total)} — elle continue écran verrouillé.`;
  else if (!state.albumBusy) $('#album-status').textContent = '';
}

async function prepareChapterAudio() {
  const s = getSettings();
  if (!state.chapter) { toast('Ouvre d\'abord un chapitre.'); return; }
  if (speaker !== engines.neural) { toast(s.hybrid ? 'Désactive le mode économie pour préparer l\'audio complet.' : 'Choisis une voix IA (OpenAI ou ElevenLabs).', { type: 'error' }); return; }
  if (state.albumBusy) { state.albumBusy.abort(); return; }
  const pending = await speaker.pendingChars();
  if (pending > 0) {
    let msg = `Préparer tout le chapitre va générer ≈ ${pending.toLocaleString('fr-FR')} caractères de voix IA.`;
    if (s.engine === 'elevenlabs') {
      try {
        const q = await getElevenQuota(s.elevenKey);
        const left = Math.max(0, q.limit - q.used);
        msg += `\nIl te reste ${left.toLocaleString('fr-FR')} crédits ElevenLabs${pending > left ? ' : ce ne sera PAS suffisant, la préparation s\'arrêtera quand ils seront épuisés.' : '.'}`;
      } catch { /* ignore */ }
    } else msg += `\nCoût OpenAI estimé : ≈ ${(pending / 14.5 / 60 * 0.015).toFixed(2).replace('.', ',')} $.`;
    if (!confirm(msg + '\n\nContinuer ?')) return;
  }
  const ctrl = new AbortController();
  state.albumBusy = ctrl;
  const btn = $('#album-prepare');
  btn.textContent = '✕ Arrêter';
  const status = $('#album-status');
  const wasPlaying = speaker.playing;
  try {
    await speaker.prepareAlbum({ signal: ctrl.signal, onProgress: (d, n) => { status.textContent = `Préparation… ${d}/${n} passages (${Math.round((d / n) * 100)} %)`; } });
    toast('🎧 Audio du chapitre prêt : il continuera même écran verrouillé.');
    if (wasPlaying || speaker.playing) speaker.playFrom(speaker.index, speaker.charIndex || 0);
  } catch (e) {
    if (e.name === 'AbortError') status.textContent = 'Préparation arrêtée (les passages déjà générés sont gardés).';
    else status.textContent = `Arrêté : ${e.message} Les passages déjà générés sont gardés.`;
  } finally {
    state.albumBusy = null;
    btn.textContent = '🎧 Préparer l\'audio du chapitre';
    renderAlbumBox();
  }
}

function downloadAlbum() {
  const al = engines.neural.album;
  if (!al || !state.chapter) return;
  const ext = /wav/.test(al.blob.type) ? 'wav' : 'mp3';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(al.blob);
  // nom de fichier sûr partout (sans accents ni caractères spéciaux)
  const safe = state.chapter.title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[–—―]/g, '-')
    .replace(/[^\w .()'-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'chapitre';
  a.download = `${safe}.${ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function renderCast() {
  const box = $('#cast-list');
  if (!box) return;
  const s = getSettings();
  $('#hybrid-box').hidden = s.engine === 'browser';
  renderAlbumBox();
  box.innerHTML = '';
  if (!s.multiVoice) return;
  if (!state.chapter) { box.innerHTML = '<p class="muted small">Ouvre un chapitre pour voir ses personnages.</p>'; return; }
  const series = seriesKey(state.chapter);
  const cast = getCast(series);
  // moteur qui lira les répliques : IA (si choisie) sinon appareil
  const kind = s.engine === 'browser' || state.engineFallback ? 'browser' : s.engine === 'elevenlabs' ? 'eleven' : 'openai';
  const rows = [[UNKNOWN, 'Répliques sans nom', null], ...state.characters.slice(0, 24).map(([n, c]) => [n, n, c])];
  if (state.characters.length === 0) {
    box.innerHTML = '<p class="muted small">Aucune réplique « Nom : “…” » dans ce chapitre : la narration et les dialogues gardent la voix principale.</p>';
  }
  rows.forEach(([role, label, count]) => {
    if (role === UNKNOWN && state.characters.length === 0) return;
    const r = cast[role] || {};
    const row = document.createElement('div');
    row.className = 'cast-row';
    const name = document.createElement('div');
    name.className = 'cast-name';
    name.innerHTML = `${label.replace(/[<>&]/g, '')}${count ? ` <small>· ${count} réplique${count > 1 ? 's' : ''}</small>` : ''}`;
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'btn small';
    test.textContent = '▶';
    test.title = 'Écouter';
    const sampleBlock = state.chapter.blocks.find(b => b.text && detectSpeaker(b.text) === role);
    test.onclick = () => testRole(role, sampleBlock?.text);
    const ctrl = document.createElement('div');
    ctrl.className = 'cast-ctrl';
    const sel = document.createElement('select');
    const current = kind === 'browser' ? r.browser?.uri : r[kind];
    fillSelect(sel, voiceOptionsFor(kind), current || '');
    sel.onchange = () => {
      if (kind === 'browser') setRole(series, role, { browser: { uri: sel.value, pitch: r.browser?.pitch || 1 } });
      else setRole(series, role, { [kind]: sel.value });
      sync.schedulePush();
      rebuildItems();
    };
    ctrl.append(sel);
    if (kind === 'browser') {
      const pitch = document.createElement('select');
      pitch.className = 'pitch';
      fillSelect(pitch, PITCHES.map(([v, l]) => [String(v), l]), String(r.browser?.pitch || 1));
      pitch.onchange = () => {
        setRole(series, role, { browser: { uri: sel.value, pitch: parseFloat(pitch.value) } });
        sync.schedulePush();
        rebuildItems();
      };
      ctrl.append(pitch);
    }
    row.append(name, test, ctrl);
    box.append(row);
  });
}

function renderDict() {
  const list = $('#dict-list');
  if (!list) return;
  list.innerHTML = '';
  getDict().forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'dict-row';
    const t = document.createElement('span');
    t.textContent = `${d.from} → ${d.to}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.innerHTML = '<svg><use href="#i-trash"/></svg>';
    del.title = 'Supprimer';
    del.onclick = () => { const all = getDict(); all.splice(i, 1); setDict(all); renderDict(); sync.schedulePush(); rebuildItems(); };
    row.append(t, del);
    list.append(row);
  });
}

// =====================================================================
// Compte (synchronisation) & crédits ElevenLabs
// =====================================================================

function renderSync() {
  const s = getSettings();
  const on = sync.enabled;
  $('#sync-off').hidden = on;
  $('#sync-on').hidden = !on;
  $('#sync-user').textContent = s.syncUser || '';
  const st = $('#sync-status');
  st.className = 'sync-status small ' + sync.status;
  st.textContent = sync.status === 'syncing' ? 'Synchronisation…'
    : sync.status === 'error' ? `Erreur : ${sync.lastError}`
      : s.lastSyncAt ? `Synchronisé ${relativeDate(s.lastSyncAt)}` : 'Pas encore synchronisé';
  let dot = $('#btn-library .sync-dot');
  if (on && !dot) { dot = document.createElement('span'); dot.className = 'sync-dot'; $('#btn-library').append(dot); }
  if (!on && dot) dot.remove();
  if (dot) dot.style.background = sync.status === 'error' ? 'var(--danger)' : '';
}

async function refreshAfterPull() {
  refreshNews();
  await music?.reload();
  if (!$('#view-home').hidden) renderHome();
  if (openDrawer?.id === 'library') renderLibrary();
  toast('Bibliothèque synchronisée ☁️', { duration: 2500 });
}

function setupSync() {
  sync.addEventListener('status', renderSync);
  sync.addEventListener('pulled', refreshAfterPull);
  $('#sync-connect').addEventListener('click', async () => {
    const token = $('#sync-token').value.trim();
    if (!token) { toast('Colle ton jeton GitHub.', { type: 'error' }); return; }
    const btn = $('#sync-connect');
    btn.disabled = true;
    try {
      const login = await sync.connect(token);
      $('#sync-token').value = '';
      toast(`Connecté en tant que ${login} ✓ Ta bibliothèque est sauvegardée en ligne.`);
    } catch (e) { toast(e.message, { type: 'error', duration: 8000 }); }
    btn.disabled = false;
    renderSync();
  });
  $('#sync-now').addEventListener('click', () => sync.syncNow());
  $('#sync-logout').addEventListener('click', () => {
    if (!confirm('Se déconnecter ? Ta bibliothèque reste sur cet appareil et dans ton fichier GitHub.')) return;
    sync.disconnect();
    renderSync();
  });
  renderSync();
  setInterval(renderSync, 60000);
  if (sync.enabled) sync.syncNow();
}

function chapterCharsLeft() {
  if (!state.items.length) return 0;
  let n = 0;
  for (let i = Math.max(0, speaker.index); i < state.items.length; i++) n += state.items[i].text.length;
  return n;
}

async function showElevenQuota() {
  const box = $('#eleven-quota');
  const key = getSettings().elevenKey || $('#set-elevenKey').value.trim();
  if (!key) { box.textContent = "Ajoute d'abord ta clé API."; return null; }
  box.textContent = 'Vérification…';
  try {
    const q = await getElevenQuota(key);
    const left = Math.max(0, q.limit - q.used);
    const pct = q.limit ? Math.min(100, (q.used / q.limit) * 100) : 0;
    const need = state.chapter ? chapterCharsLeft() : 0;
    box.innerHTML = `<b>${left.toLocaleString('fr-FR')}</b> caractères restants sur ${q.limit.toLocaleString('fr-FR')}`
      + (q.reset ? ` · remise à zéro le ${new Date(q.reset).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}` : '')
      + (need ? `<br>Reste de ce chapitre : ≈ ${need.toLocaleString('fr-FR')} caractères${need > left ? ' — ⚠️ pas assez : la fin sera lue avec la voix de l\'appareil' : ''}` : '')
      + `<div class="quota-bar"><i style="width:${pct}%"></i></div>`;
    return { ...q, left };
  } catch (e) {
    box.textContent = /permission|missing/i.test(e.message) ? 'Ta clé n\'a pas la permission « User → Read » : active-la pour voir les crédits.' : e.message;
    return null;
  }
}

// Avertit une fois par chapitre si les crédits ElevenLabs ne suffiront pas
let quotaWarnedFor = null;
async function checkElevenBeforePlay() {
  const s = getSettings();
  if (s.engine !== 'elevenlabs' || state.engineFallback || !state.chapter || quotaWarnedFor === state.chapter.id) return;
  quotaWarnedFor = state.chapter.id;
  try {
    const q = await getElevenQuota(s.elevenKey);
    const left = Math.max(0, q.limit - q.used);
    const need = chapterCharsLeft();
    if (need > left) toast(`ElevenLabs : il te reste ${left.toLocaleString('fr-FR')} caractères, ce chapitre en demande ≈ ${need.toLocaleString('fr-FR')}. Quand ce sera épuisé, je continuerai avec la voix de l'appareil (rien n'est facturé).`, { duration: 9000 });
  } catch { /* clé sans permission de lecture : on ignore */ }
}

// =====================================================================
// Musiques d'ambiance
// =====================================================================

const ostTagSel = new Set();

function moodButton(m, { on, onClick, count } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = on ? 'on' : '';
  b.innerHTML = `<span>${m.emoji}</span><span>${m.label}</span>${count !== undefined ? `<span class="count">${count}</span>` : ''}`;
  b.onclick = onClick;
  return b;
}

function renderOstTagPicker() {
  const box = $('#ost-tags');
  box.innerHTML = '';
  MOODS.forEach(m => box.append(moodButton(m, {
    on: ostTagSel.has(m.id),
    onClick: () => { ostTagSel.has(m.id) ? ostTagSel.delete(m.id) : ostTagSel.add(m.id); renderOstTagPicker(); },
  })));
}

function renderMusic() {
  if (!music) return;
  renderOstTagPicker();
  const counts = music.countByMood();
  const cov = $('#mood-coverage');
  cov.innerHTML = '';
  MOODS.forEach(m => {
    const sp = document.createElement('span');
    sp.className = counts[m.id] ? '' : 'empty';
    sp.textContent = `${m.emoji} ${m.label} · ${counts[m.id]}`;
    sp.title = counts[m.id] ? '' : 'Aucune musique pour cette ambiance : une ambiance proche sera utilisée';
    cov.append(sp);
  });
  $('#ost-count').textContent = music.tracks.length ? `(${music.tracks.length})` : '';
  const list = $('#ost-list');
  list.innerHTML = '';
  if (!music.tracks.length) {
    list.innerHTML = '<div class="lib-empty">Aucune musique pour l\'instant.<br>Ajoute des liens YouTube d\'OST et choisis leurs ambiances : elles se lanceront toutes seules selon ce qui se passe dans l\'histoire.</div>';
    return;
  }
  [...music.tracks].reverse().forEach(t => {
    const row = document.createElement('div');
    row.className = 'ost-item' + (music.current?.id === t.id ? ' playing' : '') + (t.broken ? ' broken' : '');
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'ost-thumb';
    thumb.title = 'Écouter';
    if (t.type === 'file') { thumb.classList.add('file'); thumb.innerHTML = '♪<span>▶</span>'; }
    else thumb.innerHTML = `<img alt="" loading="lazy" src="https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg"><span>▶</span>`;
    thumb.onclick = () => { music.previewTrack(t); };
    const main = document.createElement('div');
    main.className = 'ost-main';
    const title = document.createElement('div');
    title.className = 'ost-title';
    const tt = document.createElement('span');
    tt.textContent = (t.broken ? '⚠️ ' : '') + (t.title || `Vidéo ${t.videoId}`);
    if (t.type === 'file') { const bf = document.createElement('span'); bf.className = 'badge-file'; bf.textContent = 'fichier · sans pub'; tt.append(bf); }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.title = 'Supprimer';
    del.innerHTML = '<svg><use href="#i-trash"/></svg>';
    del.onclick = () => { if (confirm(`Supprimer « ${t.title || t.videoId} » ?`)) music.remove(t); };
    title.append(tt, del);
    const tags = document.createElement('div');
    tags.className = 'ost-tags';
    MOODS.forEach(m => tags.append(moodButton(m, {
      on: t.tags.includes(m.id),
      onClick: () => music.update(t, { tags: t.tags.includes(m.id) ? t.tags.filter(x => x !== m.id) : [...t.tags, m.id], broken: false }),
    })));
    main.append(title, tags);
    row.append(thumb, main);
    list.append(row);
  });
}

function renderMoodPop() {
  const grid = $('#mood-grid');
  grid.innerHTML = '';
  const counts = music.countByMood();
  const detected = moodById(state.sceneMood || 'calme');
  $('#mood-detected').textContent = state.chapter ? `Détectée dans le texte : ${detected.emoji} ${detected.label}` : '';
  const auto = moodButton({ emoji: '✨', label: 'Automatique (selon le texte)' }, { on: !music.manualMood, onClick: () => { music.setManualMood(null); renderMoodPop(); renderMoodChip(); } });
  auto.classList.add('auto');
  grid.append(auto);
  MOODS.forEach(m => grid.append(moodButton(m, {
    on: music.manualMood === m.id,
    count: counts[m.id],
    onClick: () => { music.setManualMood(m.id); renderMoodPop(); renderMoodChip(); },
  })));
  $('#mood-music-toggle').textContent = music.isPlaying() ? '⏸ Pause musique' : '♪ Lancer la musique';
}

function setupMusic() {
  music = new MusicManager({ toast });
  music.init().then(() => renderMoodChip());
  music.addEventListener('needplayer', () => { $('#mini-player').hidden = false; });
  music.addEventListener('track', e => {
    const t = e.detail;
    $('#mini-player').hidden = !t;
    $('#mini-player').classList.toggle('file', t?.type === 'file');
    $('#mini-title').textContent = t ? (t.title || 'Musique') : '';
    if (openDrawer?.id === 'music') renderMusic();
  });
  music.addEventListener('change', () => {
    if (openDrawer?.id === 'music') renderMusic();
    if (music.current) $('#mini-title').textContent = music.current.title || 'Musique';
  });
  music.addEventListener('mood', () => renderMoodChip());
  const warnedNoMatch = new Set();
  music.addEventListener('nomatch', e => {
    const m = moodById(e.detail);
    if (warnedNoMatch.has(m.id) || !music.tracks.length) return;
    warnedNoMatch.add(m.id);
    toast(`${m.emoji} Scène « ${m.label} » : aucune musique avec ce tag. Ajoute-en une pour ce type de scène.`, {
      duration: 6000, action: { label: 'Musiques', fn: () => showDrawer('music') },
    });
  });
  music.addEventListener('change', () => sync.schedulePush());
  music.addEventListener('deleted', e => { recordDeletion('osts', e.detail); sync.schedulePush(2000); });
  $('#mini-player').classList.toggle('small', !!getSettings().miniPlayerSmall);

  $('#ost-form').addEventListener('submit', async e => {
    e.preventDefault();
    const url = $('#ost-url').value.trim();
    if (!url) { toast('Colle un lien YouTube, ou importe un fichier audio.', { type: 'error' }); return; }
    if (!ostTagSel.size) { toast('Choisis au moins une ambiance pour cette musique.', { type: 'error' }); return; }
    const tags = [...ostTagSel];
    // on vide le formulaire tout de suite (permet d'enchaîner plusieurs ajouts)
    $('#ost-url').value = '';
    ostTagSel.clear();
    renderOstTagPicker();
    try {
      await music.add(url, tags);
      renderMusic();
      toast('Musique ajoutée 🎵');
    } catch (err) {
      if (!$('#ost-url').value) $('#ost-url').value = url;
      if (!ostTagSel.size) { tags.forEach(t => ostTagSel.add(t)); renderOstTagPicker(); }
      toast(err.message, { type: 'error' });
    }
  });
  $('#btn-music').addEventListener('click', () => showDrawer('music'));
  $('#ost-files').addEventListener('change', async e => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    if (!ostTagSel.size) { toast('Choisis d\'abord au moins une ambiance (étape 1), puis importe tes fichiers.', { type: 'error' }); return; }
    const tags = [...ostTagSel];
    let ok = 0;
    for (const f of files) {
      try { await music.addFile(f, tags); ok++; } catch (err) { toast(err.message, { type: 'error' }); }
    }
    ostTagSel.clear();
    renderMusic();
    if (ok) toast(`${ok} fichier${ok > 1 ? 's' : ''} audio ajouté${ok > 1 ? 's' : ''} 🎵 (sans publicité)`);
  });
  $('#btn-mood').addEventListener('click', e => {
    e.stopPropagation();
    $('#speed-pop').hidden = true; $('#sleep-pop').hidden = true;
    const pop = $('#mood-pop');
    pop.hidden = !pop.hidden;
    if (!pop.hidden) renderMoodPop();
  });
  $('#mood-music-toggle').addEventListener('click', () => {
    if (!music.tracks.length) { $('#mood-pop').hidden = true; showDrawer('music'); toast('Ajoute d\'abord des musiques à ta bibliothèque.'); return; }
    music.togglePause();
    setTimeout(renderMoodPop, 600);
  });
  $('#mood-music-next').addEventListener('click', () => {
    if (!music.tracks.length) { $('#mood-pop').hidden = true; showDrawer('music'); return; }
    music.next();
  });
  $('#mood-open-library').addEventListener('click', () => { $('#mood-pop').hidden = true; showDrawer('music'); });
  $('#mini-toggle').addEventListener('click', () => music.togglePause());
  $('#mini-next').addEventListener('click', () => music.next());
  $('#mini-size').addEventListener('click', () => {
    const small = !getSettings().miniPlayerSmall;
    setSettings({ miniPlayerSmall: small });
    $('#mini-player').classList.toggle('small', small);
  });
  $('#mini-close').addEventListener('click', () => {
    music.stop();
    $('#mini-player').hidden = true;
    if (getSettings().musicAuto) {
      setSettings({ musicAuto: false });
      toast('Musique automatique désactivée.', { action: { label: 'Réactiver', fn: () => setSettings({ musicAuto: true }) } });
    }
  });
}

// =====================================================================
// Événements
// =====================================================================

function bindEvents() {
  $('#url-form').addEventListener('submit', e => {
    e.preventDefault();
    loadUrl($('#url-input').value, { autoplay: true });
  });
  $('#btn-paste').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) { $('#url-input').value = t.trim(); $('#url-input').focus(); }
    } catch { toast('Autorise l\'accès au presse-papiers, ou colle avec Ctrl+V / appui long.'); }
  });
  $('#btn-example').addEventListener('click', () => {
    $('#url-input').value = EXAMPLE_URL;
    loadUrl(EXAMPLE_URL, { autoplay: true });
  });
  $('#paste-form').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('#paste-text').value;
    if (!text.trim()) return;
    try {
      const data = extractFromPastedText(text, $('#paste-title').value.trim());
      const id = 'local:' + Date.now().toString(36);
      const ch = { id, url: null, ...data, nav: {}, index: [], navChecked: true, addedAt: Date.now(), lastReadAt: Date.now(), progress: { seg: 0, pct: 0 } };
      await db.saveChapter(ch);
      sync.schedulePush();
      $('#paste-text').value = '';
      $('#paste-title').value = '';
      navigateToChapter(id, { autoplay: true });
    } catch (err) { toast(err.message, { type: 'error' }); }
  });
  $('#btn-see-library').addEventListener('click', () => showDrawer('library'));

  $('#brand').addEventListener('click', () => goHome());
  $('#btn-new').addEventListener('click', () => { goHome(); setTimeout(() => $('#url-input').focus(), 50); });
  $('#btn-library').addEventListener('click', () => showDrawer('library'));
  $('#btn-appearance').addEventListener('click', () => { showDrawer('settings'); selectTab('appearance'); });
  $('#btn-settings').addEventListener('click', () => { showDrawer('settings'); selectTab('voice'); });
  $('#scrim').addEventListener('click', closeDrawers);
  $$('[data-close]').forEach(b => b.addEventListener('click', closeDrawers));
  $$('#settings .tabs [role=tab]').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  $('#lib-search').addEventListener('input', () => renderLibrary());

  $('#lib-export').addEventListener('click', async () => {
    const data = await db.exportLibrary();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `relecteur-bibliotheque-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('#lib-import-file').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const n = await db.importLibrary(JSON.parse(await f.text()));
      toast(`${n} chapitre(s) importé(s).`);
      music?.reload();
      sync.schedulePush(2000);
      renderLibrary();
      renderHome();
    } catch (err) { toast(err.message, { type: 'error' }); }
    e.target.value = '';
  });
  $('#lib-clear').addEventListener('click', async () => {
    if (!confirm('Effacer toute la bibliothèque (chapitres et images) ?')) return;
    (await db.listChapters()).forEach(c => recordDeletion('chapters', c.id));
    await db.clearAll();
    sync.schedulePush(2000);
    state.knownIds.clear();
    renderLibrary();
    goHome();
  });

  $('#loading-cancel').addEventListener('click', () => { state.abort?.abort(); hideLoading(); });
  $('#dl-cancel').addEventListener('click', () => dl.ctrl?.abort());

  // Lecteur audio
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-prev').addEventListener('click', () => prevSeg());
  $('#btn-next').addEventListener('click', () => nextSeg());
  $('#btn-prev-chap').addEventListener('click', () => goNav('prev', state.chapter?.nav?.prev));
  $('#btn-next-chap').addEventListener('click', () => goNav('next', state.chapter?.nav?.next));
  const prog = $('#progress');
  prog.addEventListener('input', () => {
    setRangeFill(prog);
    const total = state.segments.length || 1;
    $('#time-pct').textContent = `${Math.round((prog.value / Math.max(1, total - 1)) * 100)} %`;
  });
  prog.addEventListener('change', () => {
    const i = +prog.value;
    reader.detached = false;
    seekSeg(i);
    reader.refocus();
  });
  const togglePop = (id, other) => {
    $('#' + other).hidden = true;
    $('#mood-pop').hidden = true;
    $('#' + id).hidden = !$('#' + id).hidden;
  };
  $('#btn-speed').addEventListener('click', e => { e.stopPropagation(); togglePop('speed-pop', 'sleep-pop'); });
  $('#btn-sleep').addEventListener('click', e => { e.stopPropagation(); togglePop('sleep-pop', 'speed-pop'); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.speed-pop, .sleep-pop, .mood-pop, #btn-speed, #btn-sleep, #btn-mood')) { $('#speed-pop').hidden = true; $('#sleep-pop').hidden = true; $('#mood-pop').hidden = true; }
  });
  $('#speed-range').addEventListener('input', e => setSettings({ rate: parseFloat(e.target.value) }));
  $$('[data-speed]').forEach(b => b.addEventListener('click', () => setSettings({ rate: +b.dataset.speed })));
  $$('[data-speed-step]').forEach(b => b.addEventListener('click', () => changeRate(+b.dataset.speedStep)));
  $$('[data-sleep]').forEach(b => b.addEventListener('click', () => { setSleep(b.dataset.sleep === 'chapter' ? 'chapter' : +b.dataset.sleep); $('#sleep-pop').hidden = true; }));

  $('[data-close-lightbox]').addEventListener('click', () => $('#lightbox').close());
  $('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox' || e.target.tagName === 'IMG') $('#lightbox').close(); });

  window.addEventListener('hashchange', handleRoute);

  // Raccourcis clavier
  window.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.intro')) return;
    if (e.key === 'Escape') { closeDrawers(); $('#speed-pop').hidden = true; $('#sleep-pop').hidden = true; $('#mood-pop').hidden = true; return; }
    const inReader = !$('#view-reader').hidden;
    const k = e.key.toLowerCase();
    if (k === 'm') { openDrawer?.id === 'music' ? closeDrawers() : showDrawer('music'); return; }
    if (k === 'b') { openDrawer?.id === 'library' ? closeDrawers() : showDrawer('library'); return; }
    if (k === 'a') { if (openDrawer?.id === 'settings') closeDrawers(); else { showDrawer('settings'); selectTab('appearance'); } return; }
    if (k === 'r') { if (openDrawer?.id === 'settings') closeDrawers(); else { showDrawer('settings'); selectTab('voice'); } return; }
    if (!inReader) return;
    if (e.key === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? paragraphJump(1) : nextSeg(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? paragraphJump(-1) : prevSeg(); }
    else if (e.key === '+' || e.key === '=') changeRate(0.05);
    else if (e.key === '-' || e.key === '_') changeRate(-0.05);
    else if (k === 'n') goNav('next', state.chapter?.nav?.next);
    else if (k === 'p') goNav('prev', state.chapter?.nav?.prev);
    else if (k === 'f') { reader.detached = false; reader.refocus(); $('#follow-btn').hidden = true; }
  });
}

// =====================================================================
// Démarrage
// =====================================================================

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('sw.js').catch(e => console.info('Service worker non enregistré', e));
}

function incomingUrl() {
  const p = new URLSearchParams(location.search);
  const cand = p.get('url') || p.get('text') || p.get('title');
  if (!cand) return null;
  const u = normalizeUrl(cand);
  // On nettoie la barre d'adresse
  history.replaceState(null, '', location.pathname + (location.hash || '#/'));
  return u;
}

async function boot() {
  applyAppearance();
  ensureFontLoaded(getSettings().font);
  buildSettingsUI();
  syncSettingsUI();
  bindEvents();
  setupMusic();
  setupSync();
  // Nouveaux chapitres : au démarrage (après la synchro), puis toutes les 30 minutes
  setTimeout(() => refreshNews(true), sync.enabled ? 4000 : 1500);
  setInterval(() => refreshNews(), 30 * 60000);
  $('#btn-notify').addEventListener('click', async () => {
    try {
      const p = await Notification.requestPermission();
      if (p === 'granted') { toast('Alertes activées : tu seras prévenu quand un nouveau chapitre sortira (site ouvert).'); notifyNew(state.news || []); }
    } catch { /* ignore */ }
    renderNews();
  });
  registerSW();

  loadVoices().then(() => { fillVoiceSelects(); configureVoice(); });
  if (ttsSupported) speechSynthesis.addEventListener?.('voiceschanged', () => { fillVoiceSelects(); configureVoice(); });

  const shared = incomingUrl();
  const s = getSettings();
  const params = new URLSearchParams(location.search);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const start = () => {
    if (shared) loadUrl(shared, { autoplay: false });
    else handleRoute();
  };

  if (s.showIntro && !params.has('nointro')) {
    // L'application se prépare derrière l'intro
    playIntro({ reducedMotion: reduced, onDone: () => {} });
    start();
  } else {
    start();
  }
}

boot();
