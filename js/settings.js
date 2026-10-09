// Réglages de l'utilisateur (apparence, voix, comportement), stockés dans localStorage.

const KEY = 'relecteur.settings.v1';

export const THEMES = [
  { id: 'nuit-sorciere', name: 'Sorcière', desc: 'Violet profond' },
  { id: 'givre', name: 'Givre', desc: 'Bleu glacé' },
  { id: 'manoir', name: 'Manoir', desc: 'Bleu nuit & rose' },
  { id: 'clair', name: 'Clair', desc: 'Papier blanc' },
  { id: 'sepia', name: 'Sépia', desc: 'Vieux livre' },
  { id: 'nuit', name: 'Nuit', desc: 'Noir OLED' },
];

export const FONTS = [
  { id: 'literata', name: 'Literata', css: "'Literata', Georgia, serif", google: 'Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400' },
  { id: 'lora', name: 'Lora', css: "'Lora', Georgia, serif", google: 'Lora:ital,wght@0,400;0,600;1,400' },
  { id: 'merriweather', name: 'Merriweather', css: "'Merriweather', Georgia, serif", google: 'Merriweather:ital,wght@0,400;0,700;1,400' },
  { id: 'crimson', name: 'Crimson Pro', css: "'Crimson Pro', Georgia, serif", google: 'Crimson+Pro:ital,wght@0,400;0,600;1,400' },
  { id: 'cormorant', name: 'Cormorant', css: "'Cormorant Garamond', Garamond, serif", google: 'Cormorant+Garamond:ital,wght@0,500;0,700;1,500' },
  { id: 'atkinson', name: 'Atkinson (lisibilité)', css: "'Atkinson Hyperlegible', system-ui, sans-serif", google: 'Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400' },
  { id: 'nunito', name: 'Nunito', css: "'Nunito', system-ui, sans-serif", google: 'Nunito:ital,wght@0,400;0,700;1,400' },
  { id: 'inter', name: 'Inter', css: "'Inter', system-ui, sans-serif", google: 'Inter:wght@400;600' },
  { id: 'serif', name: 'Serif du système', css: "Georgia, 'Times New Roman', serif", google: null },
  { id: 'sans', name: 'Sans du système', css: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", google: null },
];

export const DEFAULTS = {
  theme: 'nuit-sorciere',
  font: 'literata',
  fontSize: 20,          // px
  lineHeight: 1.75,
  width: 42,             // em
  align: 'left',         // left | justify
  paraSpacing: 1,        // em
  indent: false,

  engine: 'browser',     // browser | openai | elevenlabs
  voiceURI: '',
  expressiveness: 0.6,   // variations de ton (voix de l'appareil)
  fluid: true,           // enchaîne plusieurs phrases par énoncé (moins de blancs)
  openaiKey: '',
  openaiModel: 'gpt-4o-mini-tts',
  openaiVoice: 'coral',
  elevenKey: '',
  elevenModel: 'eleven_multilingual_v2',
  elevenVoice: '21m00Tcm4TlvDq8ikWAM',
  rate: 1,
  pitch: 1,
  volume: 1,

  highlightWord: true,
  highlightSentence: true,
  focusMode: false,      // assombrit les paragraphes non lus
  autoScroll: true,
  scrollAnchor: 0.38,    // position de la ligne lue dans l'écran (0 = haut)
  autoNext: true,        // enchaîne sur le chapitre suivant
  prefetchNext: true,    // précharge le chapitre suivant pendant la lecture
  readTitle: true,       // lit le titre du chapitre avant le texte
  keepAwake: true,       // garde l'écran allumé pendant la lecture
  downloadImages: true,

  musicAuto: true,       // musique automatique selon l'ambiance
  musicVolume: 0.3,
  musicFollowVoice: true, // pause de la musique quand la voix s'arrête
  miniPlayerSmall: false,

  showIntro: true,
  customProxy: '',
};

let cache = null;
const listeners = new Set();

export function getSettings() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* ignore */ }
  cache = { ...DEFAULTS, ...saved };
  return cache;
}

export function setSettings(patch) {
  cache = { ...getSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* ignore */ }
  listeners.forEach(fn => fn(cache, patch));
  return cache;
}

export function resetSettings() {
  cache = { ...DEFAULTS };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* ignore */ }
  listeners.forEach(fn => fn(cache, cache));
  return cache;
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const loadedFonts = new Set();
export function ensureFontLoaded(fontId) {
  const f = FONTS.find(x => x.id === fontId);
  if (!f || !f.google || loadedFonts.has(f.id)) return;
  loadedFonts.add(f.id);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
  document.head.appendChild(link);
}

/** Applique les réglages d'apparence au document (variables CSS). */
export function applyAppearance(s = getSettings()) {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    requestAnimationFrame(() => {
      meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim() || '#120c1f');
    });
  }
  const font = FONTS.find(f => f.id === s.font) || FONTS[0];
  ensureFontLoaded(font.id);
  root.style.setProperty('--reader-font', font.css);
  root.style.setProperty('--reader-size', s.fontSize + 'px');
  root.style.setProperty('--reader-lh', s.lineHeight);
  root.style.setProperty('--reader-width', s.width + 'em');
  root.style.setProperty('--reader-para', s.paraSpacing + 'em');
  root.style.setProperty('--reader-align', s.align);
  root.style.setProperty('--reader-indent', s.indent ? '1.6em' : '0');
  root.classList.toggle('focus-mode', !!s.focusMode);
  root.classList.toggle('no-hl-sentence', !s.highlightSentence);
  root.classList.toggle('no-hl-word', !s.highlightWord);
}
