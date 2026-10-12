// Suivi de séries : regroupement par série / arc et détection des nouveaux chapitres.

import * as db from './db.js';
import { fetchWpComAdjacent, fetchWpComTitle } from './fetcher.js';

const NOTIFIED_KEY = 'relecteur.notified';
const CHECK_KEY = 'relecteur.seriesCheck';

export const seriesOf = ch => ch?.siteName || (ch?.url ? new URL(ch.url).host : 'Texte collé');

/** « Arc VII – Chapitre 3 » -> « Arc VII » (sinon null). */
export function arcOf(title) {
  const m = (title || '').match(/\b(arc|tome|volume|vol\.?|livre|partie|saison)\s*([IVXLCDM]+|\d+)\b/i);
  if (!m) return null;
  const word = m[1].toLowerCase().startsWith('vol') ? 'Volume' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `${word} ${m[2].toUpperCase()}`;
}

/** Numéro de chapitre (pour trier). */
export function chapterNumber(title) {
  const m = (title || '').match(/chap(?:itre|ter|\.)?\s*(\d+(?:[.,]\d+)?)/i);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

const romanVal = r => {
  const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  for (let i = 0; i < r.length; i++) { const a = v[r[i]] || 0; const b = v[r[i + 1]] || 0; n += a < b ? -a : a; }
  return n;
};
export const arcRank = arc => {
  if (!arc) return -1;
  const k = arc.split(' ')[1];
  return /^\d+$/.test(k) ? +k : romanVal(k);
};

/** Titre lisible déduit d'une adresse : …/arc-vii-chapitre-2-le-retour/ -> « Arc VII chapitre 2 le retour ». */
export function titleFromUrl(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const words = decodeURIComponent(seg).replace(/\.[a-z]+$/i, '').split(/[-_]+/).filter(Boolean)
      .map(w => (/^[ivxlcdm]+$/i.test(w) && w.length <= 5 ? w.toUpperCase() : w));
    const t = words.join(' ');
    return t ? t[0].toUpperCase() + t.slice(1) : '';
  } catch { return ''; }
}

/** Regroupe les chapitres : série -> arcs -> chapitres (triés). */
export function groupLibrary(chapters) {
  const series = new Map();
  chapters.forEach(c => {
    const s = seriesOf(c);
    if (!series.has(s)) series.set(s, new Map());
    const arcs = series.get(s);
    const a = arcOf(c.title) || '';
    if (!arcs.has(a)) arcs.set(a, []);
    arcs.get(a).push(c);
  });
  const out = [];
  series.forEach((arcs, name) => {
    const arcList = [...arcs.entries()].map(([arc, list]) => {
      list.sort((x, y) => (chapterNumber(x.title) ?? 1e9) - (chapterNumber(y.title) ?? 1e9) || (x.date || '').localeCompare(y.date || '') || (x.addedAt || 0) - (y.addedAt || 0));
      return { arc, chapters: list, done: list.filter(c => (c.progress?.pct || 0) >= 0.98).length };
    }).sort((x, y) => arcRank(y.arc) - arcRank(x.arc));
    const all = arcList.flatMap(a => a.chapters);
    const last = all.reduce((m, c) => ((c.lastReadAt || 0) > (m?.lastReadAt || 0) ? c : m), null);
    out.push({ name, arcs: arcList, count: all.length, done: all.filter(c => (c.progress?.pct || 0) >= 0.98).length, lastReadAt: last?.lastReadAt || 0 });
  });
  return out.sort((a, b) => b.lastReadAt - a.lastReadAt);
}

/** Dernier chapitre connu d'une série (le plus récent publié, sinon le plus récemment ajouté). */
function latestOf(list) {
  return list.reduce((m, c) => {
    if (!m) return c;
    if (c.date && m.date) return c.date > m.date ? c : m;
    return (c.addedAt || 0) > (m.addedAt || 0) ? c : m;
  }, null);
}

/**
 * Cherche, pour chaque série, si un chapitre plus récent que le dernier en mémoire existe.
 * @returns [{ series, url, title, after }]
 */
export async function checkNewChapters({ force = false } = {}) {
  const chapters = await db.listChapters();
  const known = new Set(chapters.map(c => c.id));
  const bySeries = new Map();
  chapters.filter(c => c.url).forEach(c => {
    const s = seriesOf(c);
    if (!bySeries.has(s)) bySeries.set(s, []);
    bySeries.get(s).push(c);
  });
  let checks = {};
  try { checks = JSON.parse(localStorage.getItem(CHECK_KEY) || '{}'); } catch { /* ignore */ }
  const found = [];
  for (const [series, list] of bySeries) {
    const latest = latestOf(list);
    if (!latest) continue;
    let next = latest.nav?.next || null;
    let nextTitle = latest.nav?.nextTitle || '';
    const host = new URL(latest.url).host;
    // WordPress.com : on demande directement à l'API s'il existe un article plus récent
    const stale = force || Date.now() - (checks[series] || 0) > 20 * 60000;
    if (!next && /\.wordpress\.com$/i.test(host) && latest.date && stale) {
      checks[series] = Date.now();
      try {
        const nav = await fetchWpComAdjacent(host, latest.date);
        if (nav.next) {
          next = nav.next; nextTitle = nav.nextTitle || '';
          await db.updateChapter(latest.id, { nav: { ...(latest.nav || {}), next, nextTitle } });
        }
      } catch { /* hors ligne */ }
    }
    // titre du chapitre suivant inconnu (lien trouvé dans la page) : on le demande à WordPress.com
    if (next && !nextTitle && /\.wordpress\.com$/i.test(new URL(next).host)) {
      try {
        nextTitle = await fetchWpComTitle(next);
        if (nextTitle) await db.updateChapter(latest.id, { nav: { ...(latest.nav || {}), next, nextTitle } });
      } catch { /* ignore */ }
    }
    if (next && !nextTitle) nextTitle = titleFromUrl(next);
    if (next && !known.has(db.chapterIdFromUrl(next))) {
      found.push({ series, url: next, title: nextTitle, after: latest.title, afterId: latest.id });
    }
  }
  try { localStorage.setItem(CHECK_KEY, JSON.stringify(checks)); } catch { /* ignore */ }
  return found;
}

/** Notifications du navigateur pour les nouveautés pas encore signalées. */
export function notifyNew(items) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]'); } catch { /* ignore */ }
  const fresh = items.filter(i => !seen.includes(i.url));
  fresh.forEach(i => {
    try {
      const n = new Notification(`Nouveau chapitre — ${i.series}`, { body: i.title || `La suite de « ${i.after} » est disponible`, icon: 'icons/icon-192.png', tag: i.url });
      n.onclick = () => { window.focus(); location.href = `./?url=${encodeURIComponent(i.url)}`; };
    } catch { /* ignore */ }
  });
  try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...seen, ...fresh.map(i => i.url)].slice(-200))); } catch { /* ignore */ }
}
