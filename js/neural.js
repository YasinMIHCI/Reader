// Voix IA « neuronales » (optionnelles, avec ta propre clé API) : beaucoup plus naturelles et
// expressives que les voix du système. Même interface que Speaker (tts.js).
//  - OpenAI (gpt-4o-mini-tts) : on lui donne des consignes de jeu selon l'ambiance de la scène
//  - ElevenLabs : voix ultra-réalistes, avec horodatage exact de chaque caractère
// Les audios générés sont mis en cache (IndexedDB) : réécouter un chapitre ne coûte rien.

import { getAudio, saveAudio } from './db.js';
import { getSettings } from './settings.js';
import { MOOD_DIRECTION } from './mood.js';

export const OPENAI_VOICES = [
  ['coral', 'Coral (féminine, chaleureuse)'], ['nova', 'Nova (féminine, vive)'], ['shimmer', 'Shimmer (féminine, douce)'],
  ['sage', 'Sage (féminine, posée)'], ['ballad', 'Ballad (masculine, expressive)'], ['ash', 'Ash (masculine, claire)'],
  ['onyx', 'Onyx (masculine, grave)'], ['echo', 'Echo (masculine)'], ['fable', 'Fable (narrateur)'], ['alloy', 'Alloy (neutre)'],
  ['verse', 'Verse (expressive)'], ['marin', 'Marin (récente)'], ['cedar', 'Cedar (récente)'],
];
export const OPENAI_MODELS = [['gpt-4o-mini-tts', 'gpt-4o-mini-tts (émotions guidées)'], ['tts-1-hd', 'tts-1-hd'], ['tts-1', 'tts-1 (économique)']];
export const ELEVEN_MODELS = [['eleven_multilingual_v2', 'Multilingual v2 (stable)'], ['eleven_v3', 'v3 (le plus expressif)'], ['eleven_flash_v2_5', 'Flash v2.5 (rapide, économique)']];
export const ELEVEN_DEFAULT_VOICES = [
  ['21m00Tcm4TlvDq8ikWAM', 'Rachel'], ['EXAVITQu4vr4xnSDxMaL', 'Sarah'], ['XB0fDUnXU5powFXDhCwa', 'Charlotte'],
  ['pNInz6obpgDQGcFmaJgB', 'Adam'], ['onwK4e9ZLuTAKqWW03F9', 'Daniel'], ['JBFqnCBsd6RMkjVDRZzb', 'George'],
];

// Indications d'émotion pour ElevenLabs v3 (balises audio)
const V3_TAGS = {
  triste: '[sad]', joyeux: '[happy]', romantique: '[tender]', tension: '[nervous]', action: '[excited]',
  epique: '[determined]', mystere: '[whispers]', effrayant: '[fearful]', calme: '[calm]',
};
// Réglages de stabilité selon l'ambiance (plus bas = plus expressif)
const ELEVEN_STABILITY = { action: 0.3, triste: 0.38, effrayant: 0.35, tension: 0.35, epique: 0.35, joyeux: 0.4, romantique: 0.42, mystere: 0.45, calme: 0.5 };

async function sha(text) {
  if (crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return 'h' + h + ':' + text.length;
}

async function apiError(res, provider) {
  let msg = '';
  try { const j = await res.json(); msg = j.error?.message || j.detail?.message || j.detail?.status || (typeof j.detail === 'string' ? j.detail : '') || ''; } catch { /* ignore */ }
  if (res.status === 401) return new Error(`${provider} : clé API invalide ou manquante.`);
  if (res.status === 429) return new Error(`${provider} : quota atteint ou trop de requêtes. ${msg}`.trim());
  if (res.status === 402) return new Error(`${provider} : crédit insuffisant. ${msg}`.trim());
  return new Error(`${provider} : erreur ${res.status}. ${msg}`.trim());
}

function openAiInstructions(item) {
  return [
    'Tu es un narrateur de livre audio francophone expérimenté. Lis ce passage de roman de façon vivante et naturelle,',
    'avec de vraies émotions, des variations de ton et de rythme, des respirations et des pauses expressives (jamais monotone).',
    item.dialogue ? 'Le passage contient des répliques : incarne les personnages, change légèrement de voix et d\'intention pour les dialogues.' : '',
    `Ambiance — ${MOOD_DIRECTION[item.mood] || MOOD_DIRECTION.calme}.`,
    'Prononce correctement les noms propres et ne lis pas la ponctuation.',
  ].filter(Boolean).join(' ');
}

async function synthOpenAI(item, s, signal) {
  if (!s.openaiKey) throw new Error('OpenAI : ajoute ta clé API dans Réglages → Voix.');
  const body = { model: s.openaiModel, voice: s.openaiVoice, input: item.text, response_format: 'mp3' };
  if (/gpt-4o/.test(s.openaiModel)) body.instructions = openAiInstructions(item);
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${s.openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res, 'OpenAI');
  return { blob: await res.blob(), alignment: null };
}

async function synthEleven(item, s, signal) {
  if (!s.elevenKey) throw new Error('ElevenLabs : ajoute ta clé API dans Réglages → Voix.');
  const v3 = s.elevenModel === 'eleven_v3';
  let text = item.text;
  let skip = 0;
  if (v3 && V3_TAGS[item.mood]) { const tag = V3_TAGS[item.mood] + ' '; text = tag + text; skip = tag.length; }
  const voice_settings = v3
    ? { stability: 0.5, similarity_boost: 0.75 }
    : { stability: ELEVEN_STABILITY[item.mood] ?? 0.45, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true };
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(s.elevenVoice)}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    signal,
    headers: { 'xi-api-key': s.elevenKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: s.elevenModel, voice_settings, language_code: (item.lang || 'fr').slice(0, 2) }),
  });
  if (!res.ok) throw await apiError(res, 'ElevenLabs');
  const data = await res.json();
  const bin = atob(data.audio_base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const al = data.normalized_alignment || data.alignment;
  let alignment = null;
  if (al?.character_start_times_seconds?.length) {
    alignment = al.character_start_times_seconds.slice(skip);
  }
  return { blob: new Blob([bytes], { type: 'audio/mpeg' }), alignment };
}

export async function listElevenVoices(key) {
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
  if (!res.ok) throw await apiError(res, 'ElevenLabs');
  const data = await res.json();
  return (data.voices || []).map(v => ({ id: v.voice_id, name: v.name, labels: v.labels || {} }));
}

/** Poids de chaque caractère (les pauses de ponctuation "prennent du temps"). */
function charWeights(text) {
  const w = new Float64Array(text.length + 1);
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    w[i] = acc;
    const c = text[i];
    acc += /[\s]/.test(c) ? 0.6 : 1;
    if (/[,;:]/.test(c)) acc += 3;
    else if (/[.!?…]/.test(c)) acc += 6;
    else if (c === '\n') acc += 5;
  }
  w[text.length] = acc;
  return w;
}

function wordAround(text, i) {
  const isW = c => /[\p{L}\p{N}'’-]/u.test(c);
  let a = i; let b = i;
  while (a > 0 && isW(text[a - 1])) a--;
  if (!isW(text[a] || '')) { while (a < text.length && !isW(text[a])) a++; b = a; }
  while (b < text.length && isW(text[b])) b++;
  return { start: a, length: Math.max(1, b - a) };
}

export class AudioSpeaker extends EventTarget {
  constructor() {
    super();
    this.items = [];
    this.index = 0;
    this.charIndex = 0;
    this.state = 'stopped';
    this.rate = 1;
    this.volume = 1;
    this.gen = 0;
    this.cache = new Map();
    this.urls = [];
    this.current = null;
    this.raf = 0;
    this.lastWord = -1;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true;
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('error', () => {
      if (this.state === 'playing' && this.audio.src) this.emit('error', { message: 'Lecture audio impossible.' });
    });
  }

  get playing() { return this.state === 'playing'; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(s) { if (this.state !== s) { this.state = s; this.emit('state', s); } }

  setItems(items, lang) {
    this.stop();
    this.urls.forEach(u => URL.revokeObjectURL(u));
    this.urls = [];
    this.cache.clear();
    this.items = items;
    this.lang = lang;
    this.index = 0;
    this.charIndex = 0;
  }

  configure({ rate, volume }) {
    if (rate !== undefined) { this.rate = rate; this.audio.playbackRate = rate; }
    if (volume !== undefined) { this.volume = volume; this.audio.volume = volume; }
  }

  async cacheKey(item) {
    const s = getSettings();
    const id = s.engine === 'openai'
      ? `openai|${s.openaiModel}|${s.openaiVoice}|${/gpt-4o/.test(s.openaiModel) ? item.mood + '|' + (item.dialogue ? 'd' : 'n') : ''}`
      : `eleven|${s.elevenModel}|${s.elevenVoice}|${item.mood}`;
    return sha(id + '|' + item.text);
  }

  ensure(index) {
    if (index < 0 || index >= this.items.length) return null;
    if (!this.cache.has(index)) {
      const p = this.fetchItem(index).catch(e => { this.cache.delete(index); throw e; });
      this.cache.set(index, p);
    }
    return this.cache.get(index);
  }

  async fetchItem(index) {
    const item = { ...this.items[index], lang: this.lang };
    const key = await this.cacheKey(item);
    let rec = await getAudio(key).catch(() => null);
    if (!rec) {
      const s = getSettings();
      const r = s.engine === 'elevenlabs' ? await synthEleven(item, s) : await synthOpenAI(item, s);
      rec = { blob: r.blob, alignment: r.alignment };
      saveAudio(key, r.blob, r.alignment).catch(() => {});
    }
    const url = URL.createObjectURL(rec.blob);
    this.urls.push(url);
    return { url, alignment: rec.alignment, weights: charWeights(item.text), text: item.text };
  }

  prefetch(from) {
    for (let k = from; k < Math.min(this.items.length, from + 2); k++) {
      this.ensure(k)?.catch(() => {});
    }
  }

  async playFrom(index, offset = 0) {
    const gen = ++this.gen;
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    this.index = index;
    this.charIndex = offset;
    this.setState('playing');
    this.emit('segment', { index, offset });
    this.emit('loading', true);
    let r;
    try {
      r = await this.ensure(index);
    } catch (e) {
      if (gen !== this.gen) return;
      this.emit('loading', false);
      this.setState('paused');
      this.emit('error', { message: e.message || String(e) });
      return;
    }
    if (gen !== this.gen) return;
    this.current = r;
    this.lastWord = -1;
    this.audio.src = r.url;
    this.audio.playbackRate = this.rate;
    this.audio.volume = this.volume;
    await new Promise(res => {
      if (this.audio.readyState >= 1) return res();
      this.audio.addEventListener('loadedmetadata', res, { once: true });
      this.audio.addEventListener('error', res, { once: true });
    });
    if (gen !== this.gen) return;
    if (offset > 0) this.audio.currentTime = this.timeForChar(offset);
    try {
      await this.audio.play();
    } catch (e) {
      if (gen !== this.gen) return;
      this.emit('loading', false);
      this.setState('paused');
      this.emit('error', { message: e.name === 'NotAllowedError' ? 'Appuie sur ▶ pour lancer la lecture.' : (e.message || 'Lecture impossible') });
      return;
    }
    this.emit('loading', false);
    this.prefetch(index + 1);
    this.tick(gen);
  }

  duration() {
    const d = this.audio.duration;
    return isFinite(d) && d > 0 ? d : null;
  }

  timeForChar(ci) {
    const r = this.current;
    if (!r) return 0;
    if (r.alignment) return r.alignment[Math.min(ci, r.alignment.length - 1)] || 0;
    const d = this.duration();
    if (!d) return 0;
    return (r.weights[ci] / r.weights[r.weights.length - 1]) * d;
  }

  charForTime(t) {
    const r = this.current;
    if (!r) return 0;
    let arr; let target;
    if (r.alignment) { arr = r.alignment; target = t; }
    else {
      const d = this.duration();
      if (!d) return 0;
      arr = r.weights;
      target = (t / d) * r.weights[r.weights.length - 1];
    }
    let lo = 0; let hi = Math.min(arr.length, r.text.length) - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= target) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  tick(gen) {
    if (gen !== this.gen || this.state !== 'playing') return;
    const r = this.current;
    if (r && !this.audio.paused) {
      const ci = this.charForTime(this.audio.currentTime);
      const w = wordAround(r.text, ci);
      if (w.start !== this.lastWord) {
        this.lastWord = w.start;
        this.charIndex = w.start;
        this.emit('word', { index: this.index, charIndex: w.start, charLength: w.length, estimated: !r.alignment });
      }
    }
    this.raf = requestAnimationFrame(() => this.tick(gen));
  }

  onEnded() {
    if (this.state !== 'playing') return;
    cancelAnimationFrame(this.raf);
    if (this.index >= this.items.length - 1) {
      this.charIndex = 0;
      this.setState('stopped');
      this.emit('end');
      return;
    }
    this.playFrom(this.index + 1, 0);
  }

  play() {
    if (!this.items.length) return;
    if (this.state === 'paused' && this.current && this.audio.src && this.audio.currentTime > 0 && !this.audio.ended) {
      this.setState('playing');
      this.audio.play().then(() => this.tick(this.gen)).catch(e => {
        this.setState('paused');
        this.emit('error', { message: e.message });
      });
    } else this.playFrom(this.index, this.charIndex || 0);
  }

  pause() {
    if (this.state !== 'playing') return;
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    this.setState('paused');
  }

  toggle() { this.state === 'playing' ? this.pause() : this.play(); }

  stop() {
    this.gen++;
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    this.current = null;
    this.setState('stopped');
  }

  seek(index, { play, offset = 0 } = {}) {
    index = Math.max(0, Math.min(this.items.length - 1, index));
    const shouldPlay = play ?? this.state === 'playing';
    if (shouldPlay) { this.playFrom(index, offset); return; }
    this.gen++;
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    this.current = null;
    this.index = index;
    this.charIndex = offset;
    if (this.state === 'stopped' || this.state === 'playing') this.setState('paused');
    this.emit('segment', { index, offset });
  }

  remainingSeconds() {
    let chars = 0;
    for (let i = this.index; i < this.items.length; i++) chars += this.items[i].text.length;
    chars -= this.charIndex;
    return Math.max(0, chars / (14.5 * this.rate));
  }

  totalSeconds() {
    return this.items.reduce((n, it) => n + it.text.length, 0) / (14.5 * this.rate);
  }
}
