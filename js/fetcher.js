// Récupération des pages distantes depuis un site statique (GitHub Pages).
// Le navigateur bloque les requêtes inter-sites (CORS) : on essaie donc, dans l'ordre :
//   1. l'API publique WordPress.com (autorise CORS, idéal pour les traductions hébergées sur WordPress)
//   2. l'API REST d'un WordPress auto-hébergé (/wp-json/)
//   3. une requête directe (si le site autorise CORS)
//   4. le proxy personnel configuré dans les réglages (Cloudflare Worker, voir /proxy)
//   5. des proxys CORS publics, en mémorisant celui qui fonctionne le mieux.

import { getSettings } from './settings.js';

const PUBLIC_PROXIES = [
  { name: 'allorigins', build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'codetabs', build: u => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` },
  { name: 'corsproxy.io', build: u => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
  { name: 'cors.eu.org', build: u => `https://cors.eu.org/${u}` },
];

const LS_BEST = 'relecteur.bestProxy';

function withTimeout(ms, externalSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('Délai dépassé', 'TimeoutError')), ms);
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', () => ctrl.abort(externalSignal.reason), { once: true });
  }
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const t = withTimeout(ms, opts.signal);
  try {
    return await fetch(url, { ...opts, signal: t.signal });
  } finally {
    t.done();
  }
}

function customProxyBuilder() {
  const p = (getSettings().customProxy || '').trim();
  if (!p) return null;
  if (p.includes('{url}')) return u => p.replace('{url}', encodeURIComponent(u));
  if (/[?&=]$/.test(p)) return u => p + encodeURIComponent(u);
  return u => p.replace(/\/?$/, '/') + '?url=' + encodeURIComponent(u);
}

function orderedProxies() {
  const list = [];
  const custom = customProxyBuilder();
  if (custom) list.push({ name: 'proxy personnel', build: custom });
  let best = null;
  try { best = localStorage.getItem(LS_BEST); } catch { /* ignore */ }
  const pub = [...PUBLIC_PROXIES];
  if (best) pub.sort((a, b) => (b.name === best) - (a.name === best));
  return list.concat(pub);
}

function rememberProxy(name) {
  try { localStorage.setItem(LS_BEST, name); } catch { /* ignore */ }
}

function looksLikeHtml(text) {
  return /<(html|body|article|div|p)[\s>]/i.test(text) && text.length > 500;
}

/**
 * Télécharge une ressource (texte ou binaire) en passant par les proxys si nécessaire.
 * @returns {Promise<{response: Response, via: string}>}
 */
export async function fetchThroughProxies(url, { signal, onStep, binary = false, timeout = 15000 } = {}) {
  const errors = [];
  // Requête directe
  try {
    onStep?.('Connexion directe…');
    const res = await fetchWithTimeout(url, { signal, mode: 'cors', credentials: 'omit' }, binary ? timeout : Math.min(timeout, 8000));
    if (res.ok) return { response: res, via: 'direct' };
    errors.push(`direct: HTTP ${res.status}`);
  } catch (e) {
    if (signal?.aborted) throw e;
    errors.push(`direct: ${e.message || e}`);
  }
  for (const proxy of orderedProxies()) {
    if (signal?.aborted) throw signal.reason;
    try {
      onStep?.(`Via ${proxy.name}…`);
      const res = await fetchWithTimeout(proxy.build(url), { signal, credentials: 'omit' }, timeout);
      if (!res.ok) { errors.push(`${proxy.name}: HTTP ${res.status}`); continue; }
      if (!binary) {
        // On vérifie que le proxy a bien renvoyé la page (et pas une page d'erreur à lui).
        const clone = res.clone();
        const text = await clone.text();
        if (!looksLikeHtml(text)) { errors.push(`${proxy.name}: réponse invalide`); continue; }
      }
      if (proxy.name !== 'proxy personnel') rememberProxy(proxy.name);
      return { response: res, via: proxy.name };
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push(`${proxy.name}: ${e.message || e}`);
    }
  }
  const err = new Error('Impossible de récupérer la page.\n' + errors.join('\n'));
  err.details = errors;
  throw err;
}

// ---------- WordPress

function slugFromPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  let slug = parts[parts.length - 1];
  if (/^(amp|embed|feed)$/i.test(slug) && parts.length > 1) slug = parts[parts.length - 2];
  if (/\.(html?|php)$/i.test(slug)) return null;
  return decodeURIComponent(slug);
}

function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s || '';
  return t.value;
}

async function tryWordPressCom(url, signal) {
  const u = new URL(url);
  const slug = slugFromPath(u.pathname);
  if (!slug) return null;
  const site = u.host;
  const fields = 'ID,title,content,URL,date,author,featured_image,site_ID,type';
  const api = `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(site)}/posts/slug:${encodeURIComponent(slug)}?fields=${fields}`;
  const res = await fetchWithTimeout(api, { signal, credentials: 'omit' }, 12000);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.content) return null;
  return {
    source: 'wordpress.com',
    url: data.URL || url,
    title: decodeEntities(data.title),
    contentHtml: data.content,
    featuredImage: data.featured_image || null,
    date: data.date || null,
    lang: 'fr',
    siteName: site.replace(/\.wordpress\.com$/, ''),
  };
}

async function tryWordPressRest(url, signal) {
  const u = new URL(url);
  const slug = slugFromPath(u.pathname);
  if (!slug) return null;
  for (const type of ['posts', 'pages']) {
    const api = `${u.origin}/wp-json/wp/v2/${type}?slug=${encodeURIComponent(slug)}&_fields=title,content,link,date`;
    try {
      const res = await fetchWithTimeout(api, { signal, credentials: 'omit' }, 8000);
      if (!res.ok) continue;
      const arr = await res.json();
      if (Array.isArray(arr) && arr[0]?.content?.rendered) {
        return {
          source: 'wp-json',
          url: arr[0].link || url,
          title: decodeEntities(arr[0].title?.rendered || ''),
          contentHtml: arr[0].content.rendered,
          date: arr[0].date || null,
          siteName: u.host.replace(/^www\./, ''),
        };
      }
    } catch (e) {
      if (signal?.aborted) throw e;
    }
  }
  return null;
}

/**
 * Récupère une page de roman.
 * Renvoie soit { kind:'api', ... contentHtml } soit { kind:'html', html, url }.
 * Dans le cas API, on tente aussi (en arrière-plan) la page complète pour trouver
 * les liens chapitre précédent / suivant.
 */
export async function fetchChapterSource(url, { signal, onStep } = {}) {
  const u = new URL(url);
  const isWpCom = /\.wordpress\.com$/i.test(u.host);

  if (isWpCom) {
    try {
      onStep?.('API WordPress.com…');
      const r = await tryWordPressCom(url, signal);
      if (r) return { kind: 'api', ...r };
    } catch (e) { if (signal?.aborted) throw e; }
  }

  let pageError = null;
  try {
    const { response, via } = await fetchThroughProxies(url, { signal, onStep });
    const html = await response.text();
    return { kind: 'html', html, url, via };
  } catch (e) {
    if (signal?.aborted) throw e;
    pageError = e;
  }

  // Derniers recours : API WordPress (les sites WordPress autorisent souvent CORS sur l'API)
  if (!isWpCom) {
    try {
      onStep?.('API WordPress du site…');
      const r = await tryWordPressRest(url, signal);
      if (r) return { kind: 'api', ...r };
    } catch (e) { if (signal?.aborted) throw e; }
    try {
      onStep?.('API WordPress.com (domaine perso)…');
      const r = await tryWordPressCom(url, signal);
      if (r) return { kind: 'api', ...r };
    } catch (e) { if (signal?.aborted) throw e; }
  }
  throw pageError;
}

/** Récupère la page HTML complète (utilisé pour découvrir la navigation entre chapitres). */
export async function fetchPageHtml(url, { signal } = {}) {
  const { response } = await fetchThroughProxies(url, { signal, timeout: 12000 });
  return response.text();
}

/** Télécharge une image en Blob (direct puis via proxys). */
export async function fetchImageBlob(url, { signal } = {}) {
  const { response } = await fetchThroughProxies(url, { signal, binary: true, timeout: 20000 });
  const blob = await response.blob();
  if (!blob.size) throw new Error('Image vide');
  if (blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream') {
    throw new Error('Pas une image : ' + blob.type);
  }
  return blob;
}

/**
 * Article précédent / suivant (ordre chronologique) d'un blog WordPress.com, sans proxy.
 * C'est l'ordre utilisé par les liens « Article précédent / suivant » des thèmes WordPress.
 */
export async function fetchWpComAdjacent(site, date, { signal } = {}) {
  const base = `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(site)}/posts/?number=1&type=post&fields=URL,title,date`;
  const get = async qs => {
    const res = await fetchWithTimeout(base + qs, { signal, credentials: 'omit' }, 10000);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.posts?.[0]?.URL || null;
  };
  const d = encodeURIComponent(date);
  const [next, prev] = await Promise.all([
    get(`&order=ASC&order_by=date&after=${d}`).catch(() => null),
    get(`&order=DESC&order_by=date&before=${d}`).catch(() => null),
  ]);
  const nav = {};
  if (next) nav.next = next;
  if (prev) nav.prev = prev;
  return nav;
}
