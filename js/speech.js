// Préparation du texte à prononcer.
// Le texte affiché ne change pas ; on fabrique une version « parlée » plus naturelle
// (lettres étirées, tirets, répliques muettes, dictionnaire de prononciation…)
// en gardant pour chaque caractère parlé sa position dans le texte affiché,
// afin que le surlignage du mot lu reste exact.

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Applique une règle (regex + remplacement) en mettant à jour la correspondance des positions. */
function applyRule(str, map, re, repl) {
  let out = '';
  const outMap = [];
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(str))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    for (let i = last; i < m.index; i++) { out += str[i]; outMap.push(map[i]); }
    const r = typeof repl === 'function' ? repl(...m) : repl.replace(/\$(\d)/g, (_, k) => m[+k] ?? '');
    for (let k = 0; k < r.length; k++) { out += r[k]; outMap.push(map[m.index + Math.min(k, m[0].length - 1)]); }
    last = m.index + m[0].length;
    if (!re.global) break;
  }
  for (let i = last; i < str.length; i++) { out += str[i]; outMap.push(map[i]); }
  outMap.push(map[str.length]);
  return [out, outMap];
}

// « Subaru : “… » / « Emilia: « … » / « Meili : — … »
const SPEAKER_RE = /^\s*([\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){0,2})\s*:\s*(?=[“«"—–-])/u;
const NOT_NAMES = /^(il|elle|je|tu|nous|vous|ils|elles|on|lui|eux|moi|toi|note|n\/t|nt|tl|t\/n|traduction|traducteur|ps|edit|attention|chapitre|arc|tome|volume|prologue|épilogue)$/i;

/** Nom du personnage qui parle, si la réplique est écrite « Nom : “…” ». */
export function detectSpeaker(text) {
  const m = (text || '').match(SPEAKER_RE);
  if (!m) return null;
  const name = m[1].trim().replace(/\s+/g, ' ');
  if (NOT_NAMES.test(name) || name.length > 32) return null;
  return name;
}

/** Préfixe « Nom : » à retirer de la version parlée (sa longueur en caractères). */
export function speakerPrefixLength(text) {
  const m = (text || '').match(SPEAKER_RE);
  return m && !NOT_NAMES.test(m[1].trim()) ? m[0].length : 0;
}

/**
 * @param text texte affiché (une phrase)
 * @param opts.dict  [{ from, to }] dictionnaire de prononciation
 * @param opts.stripSpeaker  retire « Nom : » au début (quand chaque personnage a sa voix)
 * @returns {{ spoken: string, map: number[] }}  map[i] = position dans le texte affiché ; map[spoken.length] = fin
 */
export function prepareSpeech(text, { dict = [], stripSpeaker = false } = {}) {
  let s = text;
  let map = Array.from({ length: text.length + 1 }, (_, i) => i);
  const rule = (re, repl) => { [s, map] = applyRule(s, map, re, repl); };

  if (stripSpeaker) {
    const n = speakerPrefixLength(s);
    if (n) { s = s.slice(n); map = map.slice(n); }
  }
  // Dictionnaire de prononciation (mots entiers, sans tenir compte des majuscules)
  for (const d of dict) {
    if (!d?.from || d.to === undefined) continue;
    rule(new RegExp(`(?<![\\p{L}\\p{N}])${esc(d.from.trim())}(?![\\p{L}\\p{N}])`, 'giu'), d.to);
  }
  // Lettres étirées : « visaaaage » → « visage », « arrivéééé » → « arrivé »
  rule(/(\p{L})\1{2,}/gu, '$1');
  // Suites de tirets « —— » / « –– » : une simple pause
  rule(/\s*[—–―-]{2,}\s*/g, (m0) => (/^\s*[—–―-]+\s*$/.test(s) ? ' ' : ', '));
  rule(/\.{4,}/g, '…');
  // Symboles qui ne se prononcent pas
  rule(/[※◇◆♦☆★•·#*_~|^`[\]{}<>]/g, ' ');
  rule(/\s{2,}/g, ' ');
  // Réplique sans aucun mot (« “————” ») : un silence
  if (!/[\p{L}\p{N}]/u.test(s)) return { spoken: '…', map: [0, text.length] };
  return { spoken: s, map };
}

/** Position affichée correspondant à une position parlée (et longueur du mot). */
export function toDisplay(map, spokenIndex, spokenLength = 1) {
  const a = map[Math.max(0, Math.min(spokenIndex, map.length - 1))];
  const b = map[Math.max(0, Math.min(spokenIndex + spokenLength, map.length - 1))];
  return { index: a, length: Math.max(1, b - a) };
}

// ---------- Dictionnaire de prononciation

const DICT_KEY = 'relecteur.dict';
export const DEFAULT_DICT = [
  { from: 'onii-san', to: 'onii san' },
  { from: 'onee-san', to: 'onee san' },
  { from: 'nee-sama', to: 'nee sama' },
];
export function getDict() {
  try {
    const d = JSON.parse(localStorage.getItem(DICT_KEY) || 'null');
    return Array.isArray(d) ? d : DEFAULT_DICT.slice();
  } catch { return DEFAULT_DICT.slice(); }
}
export function setDict(d) {
  try { localStorage.setItem(DICT_KEY, JSON.stringify(d)); } catch { /* ignore */ }
}
