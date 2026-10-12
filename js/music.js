// Musiques d'ambiance (OST) depuis YouTube.
// - bibliothèque de liens YouTube avec tags d'ambiance (calme, triste, action…)
// - lecteur YouTube officiel (IFrame API) en mini-lecteur
// - choisit automatiquement une musique qui correspond à l'ambiance de la scène lue,
//   avec fondu enchaîné, et suit la lecture (pause / reprise)

import * as db from './db.js';
import { getSettings } from './settings.js';
import { MOODS, MOOD_FALLBACK, moodById } from './mood.js';

/** Extrait l'identifiant d'une vidéo YouTube (et l'instant de départ) depuis un lien. */
export function parseYouTube(input) {
  const s = (input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return { videoId: s, start: 0 };
  let u;
  try { u = new URL(/^https?:\/\//.test(s) ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    id = u.searchParams.get('v');
    const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
    if (!id && m) id = m[2];
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const t = u.searchParams.get('t') || u.searchParams.get('start') || '';
  let start = 0;
  const hms = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?/);
  if (hms) start = (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
  return { videoId: id, start };
}

async function fetchTitle(videoId) {
  const watch = `https://www.youtube.com/watch?v=${videoId}`;
  const tries = [
    `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
    `https://noembed.com/embed?url=${encodeURIComponent(watch)}`,
  ];
  for (const url of tries) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const j = await res.json();
      if (j.title) return j.title;
    } catch { /* suivant */ }
  }
  return null;
}

let apiPromise = null;
function loadYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('Impossible de charger le lecteur YouTube (hors ligne ?)')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

export class MusicManager extends EventTarget {
  constructor({ toast } = {}) {
    super();
    this.toast = toast || (() => {});
    this.tracks = [];
    this.player = null;
    this.ready = null;
    this.current = null;        // piste en cours
    this.sceneMood = 'calme';   // ambiance détectée
    this.manualMood = null;     // ambiance forcée par l'utilisateur
    this.voicePlaying = false;
    this.fadeTimer = null;
    this.switchTimer = null;
    this.vol = 0;               // volume actuel 0..100
    this.history = [];
    this.wantPlaying = false;
    this.preview = false;
    // Lecteur pour les fichiers audio importés (aucune publicité)
    this.fileAudio = new Audio();
    this.fileAudio.preload = 'auto';
    this.fileUrl = null;
    this.fileAudio.addEventListener('ended', () => {
      if (this.current?.type === 'file') this.playForMood(this.mood, { force: true, allowSame: true });
    });
  }

  isFile(t = this.current) { return t?.type === 'file'; }

  async init() {
    this.tracks = await db.listOsts().catch(() => []);
    this.emitChange();
  }

  emitChange() { this.dispatchEvent(new CustomEvent('change')); }

  get mood() { return this.manualMood || this.sceneMood; }
  targetVolume() { return Math.round((getSettings().musicVolume ?? 0.35) * 100); }

  // ---------- Bibliothèque

  async add(url, tags) {
    const p = parseYouTube(url);
    if (!p) throw new Error('Lien YouTube invalide.');
    if (this.tracks.some(t => t.videoId === p.videoId)) throw new Error('Cette musique est déjà dans ta bibliothèque.');
    const ost = { id: `${p.videoId}-${Date.now().toString(36)}`, videoId: p.videoId, start: p.start, title: null, tags: [...new Set(tags)], addedAt: Date.now() };
    this.tracks.push(ost);
    await db.saveOst(ost);
    this.emitChange();
    fetchTitle(p.videoId).then(title => {
      if (title) { ost.title = title; db.saveOst(ost); this.emitChange(); }
    });
    return ost;
  }

  /** Importe un fichier audio (MP3, M4A, OGG…) : stocké sur l'appareil, lu sans publicité. */
  async addFile(file, tags) {
    if (!file || !/^audio\//.test(file.type || '') && !/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i.test(file.name)) {
      throw new Error(`« ${file?.name || 'fichier'} » n'est pas un fichier audio.`);
    }
    const id = `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await db.saveAudio(`ost:${id}`, file, null);
    const ost = { id, type: 'file', title: file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '), size: file.size, tags: [...new Set(tags)], addedAt: Date.now() };
    this.tracks.push(ost);
    await db.saveOst(ost);
    this.emitChange();
    return ost;
  }

  async update(ost, patch) {
    Object.assign(ost, patch, { updatedAt: Date.now() });
    await db.saveOst(ost);
    this.emitChange();
  }

  async remove(ost) {
    this.tracks = this.tracks.filter(t => t.id !== ost.id);
    await db.deleteOst(ost.id);
    if (ost.type === 'file') await db.deleteAudio(`ost:${ost.id}`).catch(() => {});
    this.dispatchEvent(new CustomEvent('deleted', { detail: ost.id }));
    if (this.current?.id === ost.id) this.stop();
    this.emitChange();
  }

  async reload() { this.tracks = await db.listOsts().catch(() => []); this.emitChange(); }

  countByMood() {
    const c = {};
    MOODS.forEach(m => { c[m.id] = 0; });
    this.tracks.forEach(t => t.tags.forEach(tag => { if (c[tag] !== undefined) c[tag]++; }));
    return c;
  }

  // ---------- Lecteur YouTube

  ensurePlayer() {
    if (this.ready) return this.ready;
    this.dispatchEvent(new CustomEvent('needplayer'));
    this.ready = loadYouTubeAPI().then(YT => new Promise(resolve => {
      this.player = new YT.Player('yt-player', {
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 0, controls: 1, playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3, fs: 0 },
        events: {
          onReady: () => resolve(this.player),
          onStateChange: e => this.onPlayerState(e),
          onError: e => this.onPlayerError(e),
        },
      });
    })).catch(e => { this.ready = null; this.toast(e.message, { type: 'error' }); throw e; });
    return this.ready;
  }

  onPlayerState(e) {
    const YT = window.YT;
    if (e.data === YT.PlayerState.ENDED) {
      // fin de la piste : une autre de la même ambiance (ou la même en boucle)
      this.playForMood(this.mood, { force: true, allowSame: true });
    }
    if (e.data === YT.PlayerState.PLAYING && this.current && !this.current.title) {
      const t = this.player.getVideoData?.().title;
      if (t) this.update(this.current, { title: t });
    }
    this.dispatchEvent(new CustomEvent('playerstate', { detail: e.data }));
  }

  onPlayerError(e) {
    const bad = this.current;
    if (bad) {
      const reason = (e.data === 101 || e.data === 150) ? "l'auteur interdit sa lecture hors de YouTube" : 'vidéo indisponible';
      this.toast(`Musique « ${bad.title || bad.videoId} » ignorée : ${reason}.`, { type: 'error', duration: 6000 });
      this.update(bad, { broken: true });
    }
    this.playForMood(this.mood, { force: true, exclude: bad?.id });
  }

  setVol(v) {
    if (this.isFile()) this.fileAudio.volume = Math.max(0, Math.min(1, v / 100));
    else try { this.player?.setVolume(v); } catch { /* ignore */ }
  }
  pauseBackend() {
    if (this.isFile()) this.fileAudio.pause();
    else try { this.player?.pauseVideo(); } catch { /* ignore */ }
  }
  resumeBackend() {
    if (this.isFile()) this.fileAudio.play().catch(() => {});
    else try { this.player?.playVideo(); } catch { /* ignore */ }
  }

  fadeTo(target, ms = 1500) {
    clearInterval(this.fadeTimer);
    return new Promise(resolve => {
      if (!this.isFile() && !this.player?.setVolume) { this.vol = target; resolve(); return; }
      const start = this.vol;
      const t0 = performance.now();
      this.fadeTimer = setInterval(() => {
        const p = Math.min(1, (performance.now() - t0) / ms);
        this.vol = Math.round(start + (target - start) * p);
        this.setVol(this.vol);
        if (p >= 1) { clearInterval(this.fadeTimer); resolve(); }
      }, 60);
    });
  }

  pickTrack(mood, { exclude, allowSame } = {}) {
    const usable = this.tracks.filter(t => !t.broken && t.id !== exclude);
    const order = [mood, ...(MOOD_FALLBACK[mood] || [])];
    for (const m of order) {
      const cands = usable.filter(t => t.tags.includes(m));
      if (!cands.length) continue;
      // évite de rejouer les dernières pistes
      const fresh = cands.filter(t => (allowSame || t.id !== this.current?.id) && !this.history.slice(-2).includes(t.id));
      const pool = fresh.length ? fresh : cands;
      return { track: pool[Math.floor(Math.random() * pool.length)], exact: m === mood };
    }
    return null;
  }

  async playTrack(track, { fadeMs = 1800 } = {}) {
    if (!this.isFile(track)) await this.ensurePlayer();
    if (this.current && this.current.id !== track.id && this.vol > 0) await this.fadeTo(0, fadeMs * 0.6);
    // arrête l'autre lecteur
    if (this.isFile(track)) { try { this.player?.pauseVideo(); } catch { /* ignore */ } }
    else this.fileAudio.pause();
    this.current = track;
    this.history.push(track.id);
    if (this.history.length > 20) this.history.shift();
    this.vol = 0;
    this.setVol(0);
    if (this.isFile(track)) {
      const rec = await db.getAudio(`ost:${track.id}`).catch(() => null);
      if (!rec?.blob) {
        this.toast(`Le fichier « ${track.title} » n'est pas sur cet appareil.`, { type: 'error' });
        this.update(track, { broken: true });
        this.current = null;
        return;
      }
      if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
      this.fileUrl = URL.createObjectURL(rec.blob);
      this.fileAudio.src = this.fileUrl;
      this.fileAudio.volume = 0;
      await this.fileAudio.play().catch(() => {});
    } else this.player.loadVideoById({ videoId: track.videoId, startSeconds: track.start || 0 });
    this.dispatchEvent(new CustomEvent('track', { detail: track }));
    this.emitChange();
    await this.fadeTo(this.targetVolume(), fadeMs);
  }

  /** Lance une musique adaptée à l'ambiance (si besoin). */
  async playForMood(mood, { force = false, exclude, allowSame } = {}) {
    if (!this.tracks.length) return;
    if (!force && this.current && this.current.tags.includes(mood) && this.isPlaying()) return;
    const pick = this.pickTrack(mood, { exclude, allowSame });
    const suits = t => !!t && [mood, ...(MOOD_FALLBACK[mood] || [])].some(m => t.tags.includes(m));
    if (!pick) {
      // Aucune musique pour cette ambiance : on ne garde pas une musique qui contredit la scène
      // (ex. une OST triste pendant un combat) -> fondu vers le silence
      this.dispatchEvent(new CustomEvent('nomatch', { detail: mood }));
      if (this.current && this.isPlaying() && !suits(this.current)) {
        this.fadeTo(0, 1500).then(() => { if (!suits(this.current)) this.pauseBackend(); });
      }
      return;
    }
    // si rien ne correspond exactement et que la musique en cours convient encore, on la garde
    if (!pick.exact && this.current && this.isPlaying() && !force && suits(this.current)) return;
    try { await this.playTrack(pick.track); } catch { /* déjà signalé */ }
  }

  isPlaying() {
    if (this.isFile()) return !this.fileAudio.paused && !this.fileAudio.ended;
    try { return this.player?.getPlayerState?.() === window.YT?.PlayerState.PLAYING; } catch { return false; }
  }

  /** Appelé à chaque changement d'ambiance détectée dans le texte. */
  setSceneMood(mood) {
    if (mood === this.sceneMood) return;
    this.sceneMood = mood;
    this.dispatchEvent(new CustomEvent('mood', { detail: this.mood }));
    if (this.manualMood || !getSettings().musicAuto || !this.wantPlaying) return;
    // petite temporisation : on ne change pas de musique pour une phrase isolée
    clearTimeout(this.switchTimer);
    this.switchTimer = setTimeout(() => this.playForMood(this.mood), 2500);
  }

  setManualMood(mood) {
    this.manualMood = mood;
    this.dispatchEvent(new CustomEvent('mood', { detail: this.mood }));
    if (this.wantPlaying || this.voicePlaying) { this.wantPlaying = true; this.playForMood(this.mood, { force: true }); }
  }

  /** Suit l'état de la voix : la musique démarre avec la lecture et se met en pause avec elle. */
  onVoiceState(playing) {
    this.voicePlaying = playing;
    const s = getSettings();
    if (!s.musicAuto || !this.tracks.length) return;
    if (playing) {
      this.wantPlaying = true;
      if (this.current && (this.player || this.isFile())) {
        if (!this.isPlaying()) {
          this.resumeBackend();
          this.fadeTo(this.targetVolume(), 1200);
        }
        if (!this.current.tags.includes(this.mood)) this.playForMood(this.mood);
      } else this.playForMood(this.mood, { force: true });
    } else if (s.musicFollowVoice && this.current) {
      this.fadeTo(0, 700).then(() => { if (!this.voicePlaying) this.pauseBackend(); });
    }
  }

  /** Applique le volume réglé (appelé quand le réglage change). */
  applyVolume() {
    if (!this.current) return;
    clearInterval(this.fadeTimer);
    this.vol = this.targetVolume();
    this.setVol(this.vol);
  }

  next() {
    this.wantPlaying = true;
    this.playForMood(this.mood, { force: true, exclude: this.current?.id });
  }

  togglePause() {
    if (!this.current || (!this.player && !this.isFile())) { this.wantPlaying = true; this.playForMood(this.mood, { force: true }); return; }
    if (this.isPlaying()) { this.wantPlaying = false; this.fadeTo(0, 500).then(() => this.pauseBackend()); }
    else { this.wantPlaying = true; this.resumeBackend(); this.fadeTo(this.targetVolume(), 800); }
  }

  stop() {
    this.wantPlaying = false;
    clearTimeout(this.switchTimer);
    if (this.current) this.fadeTo(0, 500).then(() => { try { this.player?.stopVideo(); } catch { /* ignore */ } this.fileAudio.pause(); });
    this.current = null;
    this.dispatchEvent(new CustomEvent('track', { detail: null }));
    this.emitChange();
  }

  /** Écoute une piste précise (depuis la bibliothèque). */
  async previewTrack(track) {
    this.wantPlaying = true;
    await this.playTrack(track, { fadeMs: 600 });
  }
}

export { MOODS, moodById };
