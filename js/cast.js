// Distribution des voix : une voix par personnage, mémorisée par série.
// Clés spéciales : « __narrator » (narration) et « __dialogue » (répliques sans nom).
// Chaque entrée garde un choix par moteur :
//   { browser: { uri, pitch }, eleven: 'voiceId', openai: 'voice' }

const KEY = 'relecteur.cast';

export const NARRATOR = '__narrator';
export const UNKNOWN = '__dialogue';
export const PITCHES = [
  [0.85, 'Grave'], [1, 'Normale'], [1.18, 'Aiguë'], [1.32, 'Très aiguë'],
];

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}
function save(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

export function getAllCasts() { return load(); }
export function setAllCasts(all) { save(all || {}); }

export function getCast(series) { return load()[series] || {}; }

export function setRole(series, name, patch) {
  const all = load();
  const cast = all[series] || (all[series] = {});
  cast[name] = { ...(cast[name] || {}), ...patch, updatedAt: Date.now() };
  save(all);
}

/**
 * Complète la distribution pour les personnages d'un chapitre : chaque nouveau personnage
 * reçoit une voix différente des autres (rotation dans les voix disponibles).
 * @param pools { browser: [{uri}], eleven: [id], openai: [voice] }
 * @param base  voix générale choisie dans les réglages (pour le narrateur)
 */
export function ensureRoles(series, names, pools, base) {
  const all = load();
  const cast = all[series] || (all[series] = {});
  let changed = false;
  const used = { browser: new Set(), eleven: new Set(), openai: new Set() };
  Object.values(cast).forEach(r => {
    if (r.browser) used.browser.add(`${r.browser.uri}|${r.browser.pitch}`);
    if (r.eleven) used.eleven.add(r.eleven);
    if (r.openai) used.openai.add(r.openai);
  });
  const pick = (kind, list, fallback) => {
    const free = list.filter(v => !used[kind].has(v));
    const v = free[0] ?? list[(Object.keys(cast).length) % Math.max(1, list.length)] ?? fallback;
    used[kind].add(v);
    return v;
  };
  // combinaisons voix × hauteur pour la voix de l'appareil (souvent peu de voix installées)
  const browserCombos = [];
  [1, 1.18, 0.85, 1.32].forEach(p => pools.browser.forEach(v => browserCombos.push(`${v}|${p}`)));

  const ensure = (name, defaults) => {
    if (cast[name]) return;
    cast[name] = defaults;
    changed = true;
  };
  ensure(NARRATOR, {
    browser: { uri: base.browser, pitch: 1 },
    eleven: base.eleven,
    openai: base.openai,
  });
  used.browser.add(`${base.browser}|1`); used.eleven.add(base.eleven); used.openai.add(base.openai);
  ensure(UNKNOWN, {
    browser: { uri: base.browser, pitch: 1.1 },
    eleven: pick('eleven', pools.eleven, base.eleven),
    openai: pick('openai', pools.openai, base.openai),
  });
  names.forEach(name => {
    if (cast[name]) return;
    const combo = pick('browser', browserCombos, `${base.browser}|1`).split('|');
    cast[name] = {
      browser: { uri: combo[0], pitch: parseFloat(combo[1]) || 1 },
      eleven: pick('eleven', pools.eleven, base.eleven),
      openai: pick('openai', pools.openai, base.openai),
    };
    changed = true;
  });
  if (changed) save(all);
  return cast;
}

/** Fusion pour la synchronisation : l'entrée la plus récente de chaque rôle l'emporte. */
export function mergeCasts(a = {}, b = {}) {
  const out = JSON.parse(JSON.stringify(a));
  Object.entries(b).forEach(([series, roles]) => {
    const dst = out[series] || (out[series] = {});
    Object.entries(roles || {}).forEach(([name, r]) => {
      if (!dst[name] || (r.updatedAt || 0) > (dst[name].updatedAt || 0)) dst[name] = r;
    });
  });
  return out;
}
