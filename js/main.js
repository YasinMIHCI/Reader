// Re:Lecteur — orchestration de l'application.

import * as db from './db.js';
import { fetchChapterSource, fetchPageHtml, fetchImageBlob, fetchWpComAdjacent } from './fetcher.js';
import { extractFromHtml, extractFromApi, extractFromPastedText } from './extractor.js';
import { getSettings, setSettings, resetSettings, onSettingsChange, applyAppearance, THEMES, FONTS, ensureFontLoaded } from './settings.js';
import { Speaker, loadVoices, sortedVoices, pickVoice, voiceLabel, ttsSupported } from './tts.js';
import { ReaderView, fmtDuration } from './reader.js';
import { playIntro } from './intro.js';

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
};

const speaker = new Speaker();
const reader = new ReaderView($('#reader'));

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
  setTimeout(() => d.querySelector('input[type=search]')?.focus({ preventScroll: true }), 50);
}
function closeDrawers() {
  $$('.drawer').forEach(d => { d.hidden = true; });
  $('#scrim').hidden = true;
  openDrawer = null;
}
function selectTab(name) {
  $$('#settings .tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
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
    knownIds: state.knownIds,
    readTitle: s.readTitle,
    estimateSeconds: () => speaker.totalSeconds(),
  });
  reader.anchor = s.scrollAnchor;
  reader.autoScroll = s.autoScroll;

  const lang = chapter.lang || 'fr-FR';
  speaker.setItems(state.segments.map(x => ({ text: x.text })), lang);
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
  speaker.index = seg;
  if (seg > 0) {
    reader.setCurrent(seg, { scroll: false });
    requestAnimationFrame(() => reader.scrollToSegment(seg, true));
    if (!autoplay) toast(`Reprise à ${Math.round((seg / Math.max(1, total)) * 100)} %`, { action: { label: 'Depuis le début', fn: () => { speaker.seek(0); reader.setCurrent(0); window.scrollTo({ top: 0, behavior: 'smooth' }); } } });
  } else {
    window.scrollTo(0, 0);
  }
  updateProgressUI(seg);
  db.updateChapter(id, { lastReadAt: Date.now() });

  if (autoplay && total) speaker.playFrom(seg, 0);

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
  const voice = pickVoice(s.voiceURI, lang);
  speaker.configure({ voice, rate: s.rate, pitch: s.pitch, volume: s.volume });
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
  state.saveTimer = setTimeout(() => db.updateChapter(ch.id, { progress: ch.progress, lastReadAt: Date.now() }), 800);
}

function startPlayback() {
  if (!state.segments.length) return;
  if (speaker.state === 'paused') {
    if (!reader.isCurrentVisible()) reader.refocus();
    speaker.play();
    return;
  }
  // Première lecture : depuis la position sauvegardée, sinon depuis ce qui est visible à l'écran
  let from = speaker.index || 0;
  if (from === 0 && window.scrollY > 200) from = reader.firstVisibleSegment();
  speaker.playFrom(from, 0);
}

function togglePlay() {
  if (speaker.state === 'playing') speaker.pause();
  else startPlayback();
}

speaker.addEventListener('segment', e => {
  const { index } = e.detail;
  reader.setCurrent(index);
  updateProgressUI(index);
  saveProgress(index);
  const total = state.segments.length;
  if (total && index / total > 0.5) prefetchNext();
});
speaker.addEventListener('word', e => {
  const { index, charIndex, charLength } = e.detail;
  reader.setWord(index, charIndex, charLength);
});
speaker.addEventListener('state', () => {
  updatePlayButton();
  handleWakeLock();
  if (speaker.state !== 'playing') updateFollowButton();
});
speaker.addEventListener('error', e => toast(e.detail.message, { type: 'error' }));
speaker.addEventListener('end', () => {
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
  if (speaker.state === 'playing') speaker.seek(i, { play: true });
  else { speaker.playFrom(i, 0); }
  reader.setCurrent(i, { scroll: false });
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
    set('seekbackward', () => speaker.prev());
    set('seekforward', () => speaker.next());
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
  let i = Math.max(0, speaker.index);
  const block = segs[i]?.block;
  if (dir > 0) {
    while (i < segs.length - 1 && segs[i].block === block) i++;
  } else {
    // début du paragraphe courant, ou du précédent si on y est déjà
    let start = i;
    while (start > 0 && segs[start - 1].block === block) start--;
    if (start === i || speaker.charIndex < 5) {
      if (start > 0) {
        const pb = segs[start - 1].block;
        start--;
        while (start > 0 && segs[start - 1].block === pb) start--;
      }
    }
    i = start;
  }
  speaker.seek(i);
  reader.setCurrent(i);
  updateProgressUI(i);
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

async function renderHome() {
  const all = await db.listChapters().catch(() => []);
  state.knownIds = new Set(all.map(c => c.id));
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
  // Groupé par site
  const groups = new Map();
  filtered.forEach(c => {
    const k = c.siteName || 'Autres';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  });
  groups.forEach((items, name) => {
    const h = document.createElement('div');
    h.className = 'lib-group-title';
    h.textContent = `${name} · ${items.length}`;
    list.append(h);
    items.forEach(c => {
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
        state.knownIds.delete(c.id);
        renderLibrary();
        if (state.chapter?.id === c.id) goHome();
        else if (!$('#view-home').hidden) renderHome();
      };
      row.append(del);
      list.append(row);
    });
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
};
const BOOL_KEYS = ['indent', 'highlightWord', 'highlightSentence', 'focusMode', 'autoScroll', 'readTitle', 'autoNext', 'prefetchNext', 'keepAwake', 'showIntro', 'downloadImages'];

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
  $('#voice-test').addEventListener('click', () => {
    if (!ttsSupported) return;
    const s = getSettings();
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
    if (state.chapter) updateProgressUI(Math.max(0, speaker.index));
  }
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
      renderLibrary();
      renderHome();
    } catch (err) { toast(err.message, { type: 'error' }); }
    e.target.value = '';
  });
  $('#lib-clear').addEventListener('click', async () => {
    if (!confirm('Effacer toute la bibliothèque (chapitres et images) ?')) return;
    await db.clearAll();
    state.knownIds.clear();
    renderLibrary();
    goHome();
  });

  $('#loading-cancel').addEventListener('click', () => { state.abort?.abort(); hideLoading(); });

  // Lecteur audio
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-prev').addEventListener('click', () => speaker.prev());
  $('#btn-next').addEventListener('click', () => speaker.next());
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
    speaker.seek(i);
    reader.setCurrent(i, { scroll: false });
    reader.refocus();
    updateProgressUI(i);
    saveProgress(i);
  });
  const togglePop = (id, other) => {
    $('#' + other).hidden = true;
    $('#' + id).hidden = !$('#' + id).hidden;
  };
  $('#btn-speed').addEventListener('click', e => { e.stopPropagation(); togglePop('speed-pop', 'sleep-pop'); });
  $('#btn-sleep').addEventListener('click', e => { e.stopPropagation(); togglePop('sleep-pop', 'speed-pop'); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.speed-pop, .sleep-pop, #btn-speed, #btn-sleep')) { $('#speed-pop').hidden = true; $('#sleep-pop').hidden = true; }
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
    if (e.key === 'Escape') { closeDrawers(); $('#speed-pop').hidden = true; $('#sleep-pop').hidden = true; return; }
    const inReader = !$('#view-reader').hidden;
    const k = e.key.toLowerCase();
    if (k === 'b') { openDrawer?.id === 'library' ? closeDrawers() : showDrawer('library'); return; }
    if (k === 'a') { if (openDrawer?.id === 'settings') closeDrawers(); else { showDrawer('settings'); selectTab('appearance'); } return; }
    if (k === 'r') { if (openDrawer?.id === 'settings') closeDrawers(); else { showDrawer('settings'); selectTab('voice'); } return; }
    if (!inReader) return;
    if (e.key === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? paragraphJump(1) : speaker.next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? paragraphJump(-1) : speaker.prev(); }
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
