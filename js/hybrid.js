// Mode hybride : la narration est lue par la voix de l'appareil (gratuite) et les dialogues
// par la voix IA (ElevenLabs / OpenAI). Chaque énoncé porte `engine: 'browser' | 'neural'`.
// Le moteur composite enchaîne des « séries » d'énoncés consécutifs du même moteur
// et présente la même interface que Speaker / AudioSpeaker.

export class HybridSpeaker extends EventTarget {
  constructor(browser, neural) {
    super();
    this.engines = { browser, neural };
    this.items = [];
    this.index = 0;
    this.charIndex = 0;
    this.state = 'stopped';
    this.active = null;
    this.runEnd = -1;
    this.gen = 0;
    this.rate = 1;
    // Relais des événements du moteur actif
    for (const eng of [browser, neural]) {
      for (const type of ['segment', 'word', 'loading', 'notice']) {
        eng.addEventListener(type, e => { if (eng === this.active && this.state !== 'stopped') this.forward(type, e.detail); });
      }
      eng.addEventListener('error', e => { if (eng === this.active) this.forward('error', e.detail); });
      eng.addEventListener('end', () => { if (eng === this.active) this.onRunEnd(); });
      eng.addEventListener('state', () => {
        if (eng !== this.active) return;
        // une pause / une erreur du moteur actif se répercute ; les fins de série sont gérées par onRunEnd
        if (eng.state === 'paused' && this.state === 'playing') this.setState('paused');
      });
    }
  }

  get playing() { return this.state === 'playing'; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  forward(type, detail) {
    if (type === 'segment' || type === 'word') {
      this.index = detail.index;
      this.charIndex = type === 'word' ? detail.charIndex : detail.offset;
    }
    this.emit(type, detail);
  }
  setState(s) { if (this.state !== s) { this.state = s; this.emit('state', s); } }

  engineOf(i) { return this.items[i]?.engine === 'browser' ? this.engines.browser : this.engines.neural; }

  setItems(items, lang) {
    this.stop();
    this.items = items;
    this.engines.browser.setItems(items, lang);
    this.engines.neural.setItems(items, lang);
    this.index = 0;
    this.charIndex = 0;
  }

  configure(opts) {
    if (opts.rate !== undefined) this.rate = opts.rate;
    this.engines.browser.configure(opts);
    this.engines.neural.configure({ rate: opts.rate, volume: opts.volume });
  }

  playFrom(index, offset = 0) {
    const gen = ++this.gen;
    const eng = this.engineOf(index);
    const other = eng === this.engines.browser ? this.engines.neural : this.engines.browser;
    other.stopAfter = Infinity;
    if (other.state !== 'stopped') other.stop();
    let end = index;
    while (end + 1 < this.items.length && this.engineOf(end + 1) === eng) end++;
    this.runEnd = end;
    this.active = eng;
    this.index = index;
    this.charIndex = offset;
    this.setState('playing');
    eng.stopAfter = end;
    eng.playFrom(index, offset);
    // la voix IA prépare déjà ses prochains passages pendant que l'appareil lit
    if (eng === this.engines.browser) this.engines.neural.prefetch(end + 1);
    return gen;
  }

  onRunEnd() {
    if (this.state !== 'playing') return;
    if (this.runEnd >= this.items.length - 1) {
      this.charIndex = 0;
      this.setState('stopped');
      this.emit('end');
      return;
    }
    this.playFrom(this.runEnd + 1, 0);
  }

  play() {
    if (!this.items.length) return;
    if (this.state === 'paused' && this.active) {
      this.setState('playing');
      this.active.play();
    } else this.playFrom(this.index, this.charIndex || 0);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.setState('paused');
    this.active?.pause();
  }

  toggle() { this.state === 'playing' ? this.pause() : this.play(); }

  stop() {
    this.gen++;
    for (const e of Object.values(this.engines)) { e.stopAfter = Infinity; if (e.state !== 'stopped') e.stop(); }
    this.active = null;
    this.setState('stopped');
  }

  seek(index, { play, offset = 0 } = {}) {
    index = Math.max(0, Math.min(this.items.length - 1, index));
    const shouldPlay = play ?? this.state === 'playing';
    if (shouldPlay) { this.playFrom(index, offset); return; }
    for (const e of Object.values(this.engines)) if (e.state === 'playing') e.pause();
    this.active = null;
    this.index = index;
    this.charIndex = offset;
    if (this.state !== 'paused') this.setState('paused');
    this.emit('segment', { index, offset });
  }

  remainingSeconds() {
    let chars = 0;
    for (let i = this.index; i < this.items.length; i++) chars += this.items[i].text.length;
    return Math.max(0, (chars - this.charIndex) / (14.5 * this.rate));
  }

  totalSeconds() { return this.items.reduce((n, it) => n + it.text.length, 0) / (14.5 * this.rate); }
}
