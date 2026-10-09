// Moteur de lecture à voix haute basé sur la Web Speech API.
// - lit phrase par phrase (évite les coupures des navigateurs sur les longs textes)
// - précharge la phrase suivante dans la file pour éviter les blancs
// - émet la position du mot lu (événements "boundary"), ou l'estime si la voix ne les fournit pas
// - pause = annulation + reprise au mot près (plus fiable que pause()/resume() selon les navigateurs)

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
const CPS_KEY = 'relecteur.cps';

export const ttsSupported = !!(synth && typeof SpeechSynthesisUtterance !== 'undefined');

/** Score de "naturel" d'une voix : les voix neuronales/en ligne passent en premier. */
export function voiceScore(v, lang = 'fr') {
  let s = 0;
  const n = v.name || '';
  if (/natural/i.test(n)) s += 60;
  if (/neural|neuronal/i.test(n)) s += 50;
  if (/premium/i.test(n)) s += 45;
  if (/enhanced|améliorée/i.test(n)) s += 35;
  if (/online|en ligne/i.test(n)) s += 30;
  if (/google/i.test(n)) s += 25;
  if (/siri/i.test(n)) s += 20;
  if (/multilingual/i.test(n)) s += 5;
  if (/espeak|compact|eloquence|novelty|bad news|bells|boing|bubbles|cellos|whisper|zarvox|trinoids|albert|jester|organ|superstar|wobble/i.test(n)) s -= 60;
  const vl = (v.lang || '').toLowerCase().replace('_', '-');
  const l = (lang || 'fr').toLowerCase();
  if (vl === l || vl === `${l}-${l}`) s += 12;
  else if (vl.startsWith(l.slice(0, 2))) s += 8;
  else s -= 100;
  if (vl === 'fr-fr') s += 3;
  if (v.localService === false) s += 4;
  return s;
}

export function voiceLabel(v) {
  const q = voiceScore(v, (v.lang || 'fr').slice(0, 2));
  const star = q >= 50 ? '★ ' : q >= 25 ? '☆ ' : '';
  return `${star}${v.name.replace(/^Microsoft\s+/, '').replace(/\s*-\s*[^-]+\([^)]*\)$/, '')} (${v.lang})`;
}

let voicesCache = [];
export function loadVoices() {
  return new Promise(resolve => {
    if (!ttsSupported) return resolve([]);
    let tries = 0;
    const done = () => {
      voicesCache = synth.getVoices() || [];
      resolve(voicesCache);
    };
    const check = () => {
      const v = synth.getVoices();
      if (v && v.length) return done();
      if (++tries > 20) return done();
      setTimeout(check, 150);
    };
    synth.addEventListener?.('voiceschanged', () => { voicesCache = synth.getVoices() || []; }, { once: false });
    check();
  });
}

export function getVoices() {
  return voicesCache.length ? voicesCache : (synth?.getVoices() || []);
}

export function sortedVoices(lang = 'fr') {
  const all = getVoices();
  const l = (lang || 'fr').slice(0, 2).toLowerCase();
  const same = all.filter(v => (v.lang || '').toLowerCase().startsWith(l));
  const others = all.filter(v => !(v.lang || '').toLowerCase().startsWith(l));
  same.sort((a, b) => voiceScore(b, lang) - voiceScore(a, lang) || a.name.localeCompare(b.name));
  others.sort((a, b) => (a.lang || '').localeCompare(b.lang || '') || a.name.localeCompare(b.name));
  return { same, others };
}

export function pickVoice(voiceURI, lang = 'fr') {
  const all = getVoices();
  if (voiceURI) {
    const v = all.find(x => x.voiceURI === voiceURI);
    if (v) {
      // Si la voix choisie n'est pas de la langue du texte, on choisit la meilleure voix de la bonne langue
      if ((v.lang || '').toLowerCase().startsWith((lang || 'fr').slice(0, 2).toLowerCase())) return v;
    }
  }
  const { same } = sortedVoices(lang);
  return same[0] || all.find(x => x.default) || all[0] || null;
}

/** Remplace (sans changer la longueur) les caractères que certaines voix prononcent bizarrement. */
function speakable(text) {
  return text
    .replace(/[*_~#|^`]/g, ' ')
    .replace(/[\[\]{}<>]/g, ' ');
}

function wordAt(text, index) {
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
  re.lastIndex = 0;
  let m;
  let last = null;
  while ((m = re.exec(text))) {
    if (m.index + m[0].length > index) return { start: m.index, length: m[0].length };
    last = m;
  }
  return last ? { start: last.index, length: last[0].length } : { start: index, length: 0 };
}

export class Speaker extends EventTarget {
  constructor() {
    super();
    this.items = [];          // [{text}]
    this.index = 0;           // phrase en cours
    this.charIndex = 0;       // position du dernier mot lu dans la phrase en cours
    this.state = 'stopped';   // stopped | playing | paused
    this.gen = 0;
    this.live = new Set();    // références (Safari libère sinon les utterances et perd les événements)
    this.voice = null;
    this.lang = 'fr-FR';
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.queuedNext = -1;
    this.estimateTimer = null;
    this.cps = 14.5;
    try { this.cps = parseFloat(localStorage.getItem(CPS_KEY)) || 14.5; } catch { /* ignore */ }
    this.watchdog = null;
  }

  setItems(items, lang) {
    this.stop();
    this.items = items;
    if (lang) this.lang = lang;
    this.index = 0;
    this.charIndex = 0;
  }

  configure({ voice, rate, pitch, volume }) {
    const changed = (voice !== undefined && voice !== this.voice) || (rate !== undefined && rate !== this.rate) || (pitch !== undefined && pitch !== this.pitch);
    if (voice !== undefined) this.voice = voice;
    if (rate !== undefined) this.rate = rate;
    if (pitch !== undefined) this.pitch = pitch;
    if (volume !== undefined) this.volume = volume;
    if (changed && this.state === 'playing') this.playFrom(this.index, this.resumeOffset());
  }

  get playing() { return this.state === 'playing'; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  resumeOffset() {
    const text = this.items[this.index]?.text || '';
    if (!this.charIndex) return 0;
    // reprend au début du mot en cours
    return wordAt(text, this.charIndex).start;
  }

  play() {
    if (!this.items.length) return;
    if (this.state === 'paused') this.playFrom(this.index, this.resumeOffset());
    else if (this.state === 'stopped') this.playFrom(this.index, 0);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.gen++;
    this.clearTimers();
    synth.cancel();
    this.live.clear();
    this.setState('paused');
  }

  toggle() { this.state === 'playing' ? this.pause() : this.play(); }

  stop() {
    this.gen++;
    this.clearTimers();
    if (synth) synth.cancel();
    this.live.clear();
    this.setState('stopped');
  }

  seek(index, { play } = {}) {
    index = Math.max(0, Math.min(this.items.length - 1, index));
    const shouldPlay = play ?? this.state === 'playing';
    this.index = index;
    this.charIndex = 0;
    if (shouldPlay) this.playFrom(index, 0);
    else {
      if (this.state === 'playing') this.pause();
      if (this.state === 'stopped') this.setState('paused');
      this.emit('segment', { index, offset: 0 });
    }
  }

  next() { if (this.index < this.items.length - 1) this.seek(this.index + 1); }
  prev() {
    // Si on est au milieu de la phrase, revient à son début ; sinon phrase précédente
    if (this.charIndex > 12 && this.state === 'playing') this.seek(this.index);
    else this.seek(this.index - 1);
  }

  clearTimers() {
    clearInterval(this.estimateTimer); this.estimateTimer = null;
    clearTimeout(this.watchdog); this.watchdog = null;
    clearTimeout(this.startTimer); this.startTimer = null;
  }

  playFrom(index, offset = 0) {
    if (!ttsSupported) { this.emit('error', { message: 'La synthèse vocale n\'est pas disponible dans ce navigateur.' }); return; }
    this.gen++;
    const gen = this.gen;
    this.clearTimers();
    synth.cancel();
    this.live.clear();
    this.index = index;
    this.charIndex = offset;
    this.queuedNext = -1;
    this.setState('playing');
    // Certains navigateurs (Chrome) gardent un état "paused" fantôme
    try { synth.resume(); } catch { /* ignore */ }
    // Petit délai : Safari/Chrome ignorent parfois un speak() immédiatement après cancel()
    setTimeout(() => {
      if (gen !== this.gen) return;
      this.speakItem(index, offset, gen);
    }, 60);
  }

  speakItem(index, offset, gen) {
    const item = this.items[index];
    if (!item) return;
    const full = item.text;
    const text = speakable(full.slice(offset));
    if (!text.trim()) {
      // Rien à dire : on passe à la suite
      this.onItemEnd(index, gen, 0, 0);
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = this.lang;
    u.rate = this.rate;
    u.pitch = this.pitch;
    u.volume = this.volume;
    let startedAt = 0;
    let gotBoundary = false;

    u.onstart = () => {
      if (gen !== this.gen) return;
      startedAt = performance.now();
      clearTimeout(this.watchdog);
      this.index = index;
      this.charIndex = offset;
      this.emit('segment', { index, offset });
      // On met la phrase suivante dans la file pour un enchaînement sans blanc
      if (index + 1 < this.items.length && this.queuedNext !== index + 1) {
        this.queuedNext = index + 1;
        this.speakItem(index + 1, 0, gen);
      }
      // Si aucune frontière de mot n'arrive, on estime la position du mot lu
      clearInterval(this.estimateTimer);
      clearTimeout(this.startTimer);
      this.startTimer = setTimeout(() => {
        if (gen !== this.gen || gotBoundary || this.index !== index) return;
        this.estimateTimer = setInterval(() => {
          if (gen !== this.gen || gotBoundary || this.index !== index) { clearInterval(this.estimateTimer); return; }
          const elapsed = (performance.now() - startedAt) / 1000;
          const pos = Math.min(text.length - 1, Math.floor(elapsed * this.cps * this.rate));
          const w = wordAt(text, pos);
          this.charIndex = offset + w.start;
          this.emit('word', { index, charIndex: offset + w.start, charLength: w.length, estimated: true });
        }, 120);
      }, 450);
    };

    u.onboundary = e => {
      if (gen !== this.gen || this.index !== index) return;
      if (e.name && e.name !== 'word') return;
      gotBoundary = true;
      clearInterval(this.estimateTimer);
      const len = e.charLength || wordAt(text, e.charIndex).length;
      this.charIndex = offset + e.charIndex;
      this.emit('word', { index, charIndex: offset + e.charIndex, charLength: len, estimated: false });
    };

    u.onend = () => {
      this.live.delete(u);
      if (gen !== this.gen) return;
      const dur = startedAt ? (performance.now() - startedAt) / 1000 : 0;
      this.onItemEnd(index, gen, text.length, dur);
    };

    u.onerror = e => {
      this.live.delete(u);
      if (gen !== this.gen) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('Erreur de synthèse vocale', e.error);
      if (e.error === 'not-allowed') {
        this.setState('paused');
        this.emit('error', { message: 'Le navigateur a bloqué la lecture : appuie sur ▶ pour lancer.' });
        return;
      }
      this.onItemEnd(index, gen, 0, 0);
    };

    this.live.add(u);
    synth.speak(u);

    // Garde-fou : si la phrase ne démarre jamais (bug de voix), on relance
    if (index === this.index) {
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        if (gen !== this.gen || startedAt) return;
        if (this.state === 'playing' && this.index === index) {
          console.warn('La voix ne démarre pas, nouvelle tentative');
          synth.cancel();
          this.queuedNext = -1;
          setTimeout(() => { if (gen === this.gen) this.speakItem(index, offset, gen); }, 80);
        }
      }, 4000);
    }
  }

  onItemEnd(index, gen, len, dur) {
    clearInterval(this.estimateTimer);
    // Calibrage de la vitesse estimée (caractères / seconde à vitesse 1)
    if (len > 40 && dur > 1) {
      const measured = len / dur / this.rate;
      if (measured > 5 && measured < 40) {
        this.cps = this.cps * 0.7 + measured * 0.3;
        try { localStorage.setItem(CPS_KEY, String(this.cps.toFixed(2))); } catch { /* ignore */ }
      }
    }
    if (index !== this.index) return;
    if (index >= this.items.length - 1) {
      this.charIndex = 0;
      this.setState('stopped');
      this.emit('end');
      return;
    }
    // La phrase suivante était déjà en file ; si ce n'est pas le cas (ou si elle a été perdue), on la lance
    const nextIndex = index + 1;
    this.index = nextIndex;
    this.charIndex = 0;
    if (this.queuedNext !== nextIndex) {
      this.speakItem(nextIndex, 0, gen);
    } else {
      // Filet de sécurité : si la phrase en file ne démarre pas, on la relance
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        if (gen !== this.gen || this.index !== nextIndex || this.state !== 'playing') return;
        if (!synth.speaking) {
          this.queuedNext = -1;
          this.speakItem(nextIndex, 0, gen);
        }
      }, 1500);
    }
  }

  /** Estimation de la durée restante (secondes) à partir de la phrase en cours. */
  remainingSeconds() {
    let chars = 0;
    for (let i = this.index; i < this.items.length; i++) chars += this.items[i].text.length;
    chars -= this.charIndex;
    return Math.max(0, chars / (this.cps * this.rate));
  }

  totalSeconds() {
    const chars = this.items.reduce((n, it) => n + it.text.length, 0);
    return chars / (this.cps * this.rate);
  }
}
