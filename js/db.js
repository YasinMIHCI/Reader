// Stockage local (IndexedDB) : chapitres lus + images téléchargées.
// Aucune requête réseau n'est nécessaire pour rouvrir un chapitre déjà chargé.

const DB_NAME = 'relecteur';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chapters')) {
        const s = db.createObjectStore('chapters', { keyPath: 'id' });
        s.createIndex('lastReadAt', 'lastReadAt');
      }
      if (!db.objectStoreNames.contains('images')) {
        const s = db.createObjectStore('images', { keyPath: 'key' });
        s.createIndex('chapterId', 'chapterId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    Promise.resolve(fn(t)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction annulée'));
  }));
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Identifiant stable d'un chapitre à partir de son URL. */
export function chapterIdFromUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'ref'].forEach(p => u.searchParams.delete(p));
    let s = u.host.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + (u.search || '');
    return s.toLowerCase();
  } catch {
    return 'local:' + url;
  }
}

export async function saveChapter(chapter) {
  return tx(['chapters'], 'readwrite', t => { t.objectStore('chapters').put(chapter); });
}

export async function getChapter(id) {
  return tx(['chapters'], 'readonly', t => reqP(t.objectStore('chapters').get(id)));
}

export async function listChapters() {
  const all = await tx(['chapters'], 'readonly', t => reqP(t.objectStore('chapters').getAll()));
  return (all || []).sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));
}

export async function updateChapter(id, patch) {
  return tx(['chapters'], 'readwrite', async t => {
    const store = t.objectStore('chapters');
    const cur = await reqP(store.get(id));
    if (cur) store.put(Object.assign(cur, patch));
  });
}

export async function deleteChapter(id) {
  return tx(['chapters', 'images'], 'readwrite', async t => {
    t.objectStore('chapters').delete(id);
    const idx = t.objectStore('images').index('chapterId');
    const keys = await reqP(idx.getAllKeys(IDBKeyRange.only(id)));
    keys.forEach(k => t.objectStore('images').delete(k));
  });
}

export async function saveImage(chapterId, key, blob, srcUrl) {
  return tx(['images'], 'readwrite', t => {
    t.objectStore('images').put({ key, chapterId, blob, srcUrl, savedAt: Date.now() });
  });
}

export async function getImage(key) {
  return tx(['images'], 'readonly', t => reqP(t.objectStore('images').get(key)));
}

export async function getImagesForChapter(chapterId) {
  return tx(['images'], 'readonly', t => reqP(t.objectStore('images').index('chapterId').getAll(IDBKeyRange.only(chapterId))));
}

export async function clearAll() {
  return tx(['chapters', 'images'], 'readwrite', t => {
    t.objectStore('chapters').clear();
    t.objectStore('images').clear();
  });
}

export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) return await navigator.storage.estimate();
  } catch { /* ignore */ }
  return null;
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
  } catch { /* ignore */ }
  return false;
}

// ---- Export / import (pour transférer sa bibliothèque d'un appareil à l'autre)

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

export async function exportLibrary() {
  const chapters = await listChapters();
  const images = await tx(['images'], 'readonly', t => reqP(t.objectStore('images').getAll()));
  const outImages = [];
  for (const img of images || []) {
    outImages.push({ key: img.key, chapterId: img.chapterId, srcUrl: img.srcUrl, data: await blobToDataURL(img.blob) });
  }
  return { app: 'relecteur', version: 1, exportedAt: new Date().toISOString(), chapters, images: outImages };
}

export async function importLibrary(json) {
  if (!json || json.app !== 'relecteur' || !Array.isArray(json.chapters)) {
    throw new Error('Fichier de bibliothèque invalide');
  }
  const imgs = [];
  for (const img of json.images || []) {
    try { imgs.push({ key: img.key, chapterId: img.chapterId, srcUrl: img.srcUrl, blob: await dataURLToBlob(img.data), savedAt: Date.now() }); } catch { /* ignore */ }
  }
  await tx(['chapters', 'images'], 'readwrite', t => {
    json.chapters.forEach(c => t.objectStore('chapters').put(c));
    imgs.forEach(i => t.objectStore('images').put(i));
  });
  return json.chapters.length;
}
