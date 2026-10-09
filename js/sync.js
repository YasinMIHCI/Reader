// Synchronisation « compte » : ta bibliothèque (chapitres + progression + musiques) est enregistrée
// dans un fichier privé sur ton compte GitHub (un Gist secret). Tu peux tout fermer, changer
// d'appareil, revenir : tout est récupéré.
//
// - connexion avec un jeton GitHub (permission « gist » uniquement)
// - fusion intelligente : la progression la plus récente gagne, les suppressions se propagent
// - fichier compressé (gzip) quand le navigateur le permet
// - les images ne sont pas envoyées (elles sont retéléchargées depuis le site si besoin)

import * as db from './db.js';
import { getSettings, setSettings } from './settings.js';

const API = 'https://api.github.com';
const GIST_DESC = 'Re:Lecteur — bibliothèque (ne pas modifier à la main)';
const FILE_GZ = 'relecteur.json.gz.b64';
const FILE_JSON = 'relecteur.json';
const TOMB_KEY = 'relecteur.tombstones';

// ---------- Suppressions (pour qu'elles se propagent aux autres appareils)

function readTombs() {
  try { return JSON.parse(localStorage.getItem(TOMB_KEY) || '{"chapters":{},"osts":{}}'); } catch { return { chapters: {}, osts: {} }; }
}
function writeTombs(t) { try { localStorage.setItem(TOMB_KEY, JSON.stringify(t)); } catch { /* ignore */ } }
export function recordDeletion(kind, id) {
  const t = readTombs();
  (t[kind] ||= {})[id] = Date.now();
  writeTombs(t);
}

// ---------- Compression

async function gzipB64(text) {
  const cs = new CompressionStream('gzip');
  const buf = await new Response(new Blob([text]).stream().pipeThrough(cs)).arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function gunzipB64(b64) {
  const bin = atob(b64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream('gzip');
  return new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
}
const canGzip = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

// ---------- API GitHub

async function gh(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token || getSettings().syncToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('Jeton GitHub invalide ou expiré.');
  if (res.status === 403 || res.status === 404) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`GitHub : accès refusé (${j.message || res.status}). Vérifie que le jeton a la permission « gist ».`);
  }
  if (!res.ok) throw new Error(`GitHub : erreur ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function findOrCreateGist(token) {
  for (let page = 1; page <= 5; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`, { token });
    const hit = list.find(g => g.description === GIST_DESC);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  const created = await gh('/gists', {
    method: 'POST',
    token,
    body: { description: GIST_DESC, public: false, files: { [FILE_JSON]: { content: '{"app":"relecteur","sync":1,"chapters":[],"osts":[]}' } } },
  });
  return created.id;
}

async function readRemote(gistId) {
  const g = await gh(`/gists/${gistId}`);
  const f = g.files[FILE_GZ] || g.files[FILE_JSON];
  if (!f) return { chapters: [], osts: [], tombstones: { chapters: {}, osts: {} } };
  let content = f.content;
  if (f.truncated || !content) content = await (await fetch(f.raw_url)).text();
  const text = f.filename === FILE_GZ ? await gunzipB64(content) : content;
  const data = JSON.parse(text || '{}');
  return { chapters: data.chapters || [], osts: data.osts || [], tombstones: data.tombstones || { chapters: {}, osts: {} }, updatedAt: data.updatedAt || 0, hasGz: !!g.files[FILE_GZ], hasJson: !!g.files[FILE_JSON] };
}

async function writeRemote(gistId, data, remoteFiles) {
  const text = JSON.stringify(data);
  const files = {};
  if (canGzip) {
    files[FILE_GZ] = { content: await gzipB64(text) };
    if (remoteFiles?.hasJson) files[FILE_JSON] = null; // remplace l'ancien format
  } else {
    files[FILE_JSON] = { content: text };
    if (remoteFiles?.hasGz) files[FILE_GZ] = null;
  }
  await gh(`/gists/${gistId}`, { method: 'PATCH', body: { files } });
}

// ---------- Fusion

const stamp = c => Math.max(c.lastReadAt || 0, c.updatedAt || 0, c.addedAt || 0);

function mergeLists(local, remote, tombs, key = 'id', time = stamp) {
  const map = new Map();
  [...remote, ...local].forEach(item => {
    const cur = map.get(item[key]);
    if (!cur || time(item) >= time(cur)) map.set(item[key], item);
  });
  const out = [];
  map.forEach((item, id) => {
    const del = tombs[id];
    if (del && del >= time(item)) return;
    out.push(item);
  });
  return out;
}

function mergeTombs(a, b) {
  const out = { chapters: { ...(a.chapters || {}) }, osts: { ...(a.osts || {}) } };
  for (const kind of ['chapters', 'osts']) {
    Object.entries(b[kind] || {}).forEach(([id, t]) => { out[kind][id] = Math.max(out[kind][id] || 0, t); });
  }
  // on oublie les suppressions de plus de 90 jours
  const limit = Date.now() - 90 * 86400000;
  for (const kind of ['chapters', 'osts']) Object.keys(out[kind]).forEach(id => { if (out[kind][id] < limit) delete out[kind][id]; });
  return out;
}

// ---------- Gestionnaire

export class SyncManager extends EventTarget {
  constructor() {
    super();
    this.busy = null;
    this.pushTimer = null;
    this.status = 'off';
    this.lastError = null;
  }

  get enabled() { const s = getSettings(); return !!(s.syncToken && s.syncGistId); }

  setStatus(status, detail) {
    this.status = status;
    if (status === 'error') this.lastError = detail;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, detail } }));
  }

  /** Connexion : vérifie le jeton, trouve (ou crée) le fichier, puis synchronise. */
  async connect(token) {
    token = token.trim();
    const user = await gh('/user', { token });
    const gistId = await findOrCreateGist(token);
    setSettings({ syncToken: token, syncGistId: gistId, syncUser: user.login });
    await this.syncNow();
    return user.login;
  }

  disconnect() {
    clearTimeout(this.pushTimer);
    setSettings({ syncToken: '', syncGistId: '', syncUser: '', lastSyncAt: 0 });
    this.setStatus('off');
  }

  /** Récupère le fichier distant, fusionne avec l'appareil, puis renvoie le résultat fusionné. */
  syncNow() {
    if (!this.enabled) return Promise.resolve(false);
    if (this.busy) return this.busy.then(() => this.syncNow());
    this.busy = (async () => {
      this.setStatus('syncing');
      try {
        const gistId = getSettings().syncGistId;
        const remote = await readRemote(gistId);
        const localChapters = await db.listChapters();
        const localOsts = await db.listOsts();
        const tombs = mergeTombs(readTombs(), remote.tombstones);
        writeTombs(tombs);
        const chapters = mergeLists(localChapters, remote.chapters, tombs.chapters);
        const osts = mergeLists(localOsts, remote.osts, tombs.osts, 'id', o => Math.max(o.updatedAt || 0, o.addedAt || 0));
        // applique localement
        const changed = await db.replaceAll({ chapters, osts, deleteChapters: Object.keys(tombs.chapters), deleteOsts: Object.keys(tombs.osts) });
        // renvoie au serveur
        await writeRemote(gistId, { app: 'relecteur', sync: 1, updatedAt: Date.now(), chapters, osts, tombstones: tombs }, remote);
        setSettings({ lastSyncAt: Date.now() });
        this.setStatus('ok');
        if (changed) this.dispatchEvent(new CustomEvent('pulled'));
        return true;
      } catch (e) {
        console.warn('Synchronisation impossible', e);
        this.setStatus('error', e.message);
        return false;
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  }

  /** À appeler après chaque modification locale : envoi groupé quelques secondes plus tard. */
  schedulePush(delay = 8000) {
    if (!this.enabled) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.syncNow(), delay);
  }

  /** Envoi immédiat si une modification est en attente (ex. quand on quitte la page). */
  flush() {
    if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = null; this.syncNow(); }
  }
}
