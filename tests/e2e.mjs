// Tests de bout en bout de Re:Lecteur (Playwright + Chromium).
// Lancement :  node tests/e2e.mjs   (serveur statique démarré automatiquement)
// Le réseau est simulé : aucun site réel n'est contacté.

import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests/fixtures');
const OUT = process.env.SHOTS || path.join(ROOT, 'tests/screenshots');
fs.mkdirSync(OUT, { recursive: true });
const EXE = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// Fausse Web Speech API : "parle" en émettant start / boundary (mot par mot) / end
const FAKE_TTS = () => {
  const voices = [
    { name: 'Microsoft Denise Online (Natural) - French (France)', lang: 'fr-FR', voiceURI: 'denise', localService: false, default: false },
    { name: 'Google français', lang: 'fr-FR', voiceURI: 'google-fr', localService: false, default: false },
    { name: 'eSpeak French', lang: 'fr', voiceURI: 'espeak', localService: true, default: true },
    { name: 'Google US English', lang: 'en-US', voiceURI: 'google-en', localService: false, default: false },
  ];
  const queue = [];
  let current = null; let timers = [];
  window.__spoken = [];
  const WORD_MS = 25;
  function next() {
    if (current || !queue.length) return;
    current = queue.shift();
    const u = current;
    window.__spoken.push(u.text);
    timers.push(setTimeout(() => {
      u.onstart?.({});
      const re = /\S+/g; let m; let k = 0;
      while ((m = re.exec(u.text))) {
        const ci = m.index; const cl = m[0].length; k++;
        timers.push(setTimeout(() => u.onboundary?.({ name: 'word', charIndex: ci, charLength: cl }), k * WORD_MS));
      }
      timers.push(setTimeout(() => { current = null; u.onend?.({}); next(); }, (k + 1) * WORD_MS));
    }, 5));
  }
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  const synth = {
    speak(u) { queue.push(u); next(); },
    cancel() { const c = current; const q = queue.splice(0); timers.forEach(clearTimeout); timers = []; current = null; c?.onerror?.({ error: 'interrupted' }); q.forEach(u => u.onerror?.({ error: 'canceled' })); },
    pause() {}, resume() {},
    get speaking() { return !!current; },
    get pending() { return queue.length > 0; },
    getVoices() { return voices; },
    addEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
};

function silentWav(sec, rate = 8000) {
  const n = Math.round(sec * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}

let failures = 0;
const GH = { gist: null, writes: 0 };
const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

const browser = await chromium.launch({ executablePath: EXE, args: ['--autoplay-policy=no-user-gesture-required'] });

async function newPage(viewport = { width: 1280, height: 860 }, { cors = false, log = [] } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(FAKE_TTS);
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('  [pageerror]', e.message); failures++; });
  page.on('console', m => { if (m.type() === 'error') console.log('  [console]', m.text()); });
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route('https://fonts.gstatic.com/**', r => r.abort());
  await ctx.route('https://i.ytimg.com/**', r => r.abort());
  const html = fs.readFileSync(path.join(FIX, 'wp-chapter.html'), 'utf8');
  // Site de roman : sans en-tête CORS (comme la plupart des sites) sauf si cors=true
  await ctx.route('https://exemple-roman.test/**', r => {
    const u = r.request().url();
    log.push(u);
    if (u.includes('/wp-content/uploads/')) return r.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(FIX, 'quai.png')) });
    if (u.includes('/wp-json/')) return r.fulfill({ status: 404, body: '' });
    // Playwright ne bloque pas le CORS des réponses simulées : on simule le blocage par une erreur réseau
    if (!cors) return r.abort('accessdenied');
    const body = u.includes('/sommaire') ? fs.readFileSync(path.join(FIX, 'sommaire.html'), 'utf8') : html;
    return r.fulfill({ status: 200, contentType: 'text/html', headers: { 'Access-Control-Allow-Origin': '*' }, body });
  });
  // Proxy public simulé
  await ctx.route('https://api.allorigins.win/**', async r => {
    const target = new URL(r.request().url()).searchParams.get('url');
    log.push('proxy:' + target);
    const body = target.includes('/sommaire') ? fs.readFileSync(path.join(FIX, 'sommaire.html'), 'utf8') : html;
    return r.fulfill({ status: 200, contentType: 'text/html', headers: { 'Access-Control-Allow-Origin': '*' }, body });
  });
  for (const p of ['https://api.codetabs.com/**', 'https://corsproxy.io/**', 'https://cors.eu.org/**']) await ctx.route(p, r => r.abort());
  // Faux lecteur YouTube (IFrame API) + oEmbed
  await ctx.route('https://www.youtube.com/iframe_api', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: `
    window.__ytLoads = [];
    window.YT = { PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2 }, Player: class {
      constructor(id, opts) { this.opts = opts; this.state = -1; this.vol = 100; window.__yt = this; setTimeout(() => opts.events.onReady({ target: this }), 10); }
      loadVideoById(o) { this.vid = o.videoId; this.state = 1; window.__ytLoads.push(o.videoId); this.opts.events.onStateChange({ data: 1 }); }
      playVideo() { this.state = 1; } pauseVideo() { this.state = 2; } stopVideo() { this.state = 5; }
      setVolume(v) { this.vol = v; } getPlayerState() { return this.state; } getVideoData() { return { title: 'Titre ' + this.vid }; }
    } };
    window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady();` }));
  await ctx.route('https://www.youtube.com/oembed**', r => {
    const v = new URL(new URL(r.request().url()).searchParams.get('url')).searchParams.get('v');
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ title: 'OST ' + v }) });
  });
  // Fausse API OpenAI : renvoie un vrai fichier audio (silence de 1,5 s)
  await ctx.route('https://api.openai.com/**', async r => {
    log.push('openai:' + r.request().postData());
    return r.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'Access-Control-Allow-Origin': '*' }, body: silentWav(1.5) });
  });
  // Faux GitHub (Gist) : l'état est partagé entre les « appareils » du test
  await ctx.route('https://api.github.com/**', async r => {
    const req = r.request(); const u = new URL(req.url());
    const json = (o, st = 200) => r.fulfill({ status: st, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(o) });
    if (req.headers().authorization !== 'Bearer ghp_test') return json({ message: 'Bad credentials' }, 401);
    if (u.pathname === '/user') return json({ login: 'lecteur-test' });
    if (u.pathname === '/gists' && req.method() === 'GET') return json(GH.gist ? [{ id: 'g1', description: GH.gist.description }] : []);
    if (u.pathname === '/gists' && req.method() === 'POST') { const b = req.postDataJSON(); GH.gist = { description: b.description, files: {} }; Object.entries(b.files).forEach(([n, f]) => { GH.gist.files[n] = f.content; }); return json({ id: 'g1' }, 201); }
    if (u.pathname === '/gists/g1' && req.method() === 'PATCH') { GH.writes++; const b = req.postDataJSON(); Object.entries(b.files).forEach(([n, f]) => { if (f === null) delete GH.gist.files[n]; else GH.gist.files[n] = f.content; }); return json({ id: 'g1' }); }
    if (u.pathname === '/gists/g1') return json({ id: 'g1', files: Object.fromEntries(Object.entries(GH.gist.files).map(([n, c]) => [n, { filename: n, content: c, truncated: false }])) });
    return json({ message: 'Not Found' }, 404);
  });
  await ctx.route('https://api.elevenlabs.io/**', r => {
    log.push('eleven:' + r.request().url());
    if (r.request().url().includes('/user/subscription')) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ character_count: 9990, character_limit: 10000, next_character_count_reset_unix: 1893456000 }) });
    return r.fulfill({ status: 401, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } }) });
  });
  // API WordPress.com simulée
  await ctx.route('https://public-api.wordpress.com/**', r => {
    const u = r.request().url();
    log.push(u);
    if (u.includes('/posts/slug:arc-i-chapitre-2')) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(FIX, 'wpcom-api.json'), 'utf8') });
    if (u.includes('/posts/?')) {
      const next = u.includes('order=ASC');
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ posts: [{ URL: `https://lac-traductions.wordpress.com/2024/01/0${next ? 3 : 1}/arc-i-chapitre-${next ? 3 : 1}/` }] }) });
    }
    return r.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
  });
  return { ctx, page };
}

const CH2 = 'https://exemple-roman.test/2024/01/02/arc-i-chapitre-2/';

// ---------------------------------------------------------------- 1. Extraction via proxy + lecture
{
  const log = [];
  const { ctx, page } = await newPage(undefined, { log });
  await page.goto(BASE + '?nointro');
  check(await page.isVisible('#view-home'), "l'accueil s'affiche");
  await page.screenshot({ path: `${OUT}/01-accueil.png` });

  await page.fill('#url-input', CH2);
  await page.click('#url-form button[type=submit]');
  await page.waitForSelector('#view-reader:not([hidden]) .chapter-title', { timeout: 15000 });
  const title = await page.textContent('.chapter-title');
  check(title.includes('La lanterne du quai'), `titre extrait : « ${title.trim()} »`);
  const text = await page.textContent('.chapter-body');
  check(text.includes('La pluie avait cessé depuis une heure'), 'premier paragraphe présent');
  check(text.includes('Il était tiède.'), 'dernier paragraphe présent');
  const parasites = ['Partager', 'Articles similaires', 'Publicités', 'Laisser un commentaire', 'Propulsé', 'cookies', 'Accueil', 'Super chapitre', 'Chargement', 'Twitter', 'Publié le', 'Suivre ce blog', 'Chapitre précédent', 'Table des matières', 'Annonce', 'Merci d’avoir lu'];
  const found = parasites.filter(p => text.includes(p));
  check(found.length === 0, `aucun texte parasite (${found.join(', ') || 'ok'})`);
  check(await page.locator('.chapter-body figure img').count() === 1, 'image du chapitre conservée');
  check((await page.textContent('.chapter-body figcaption'))?.includes('Illustration du quai'), "légende de l'image");
  check(await page.locator('.chapter-body .sep').count() >= 1, 'séparateur de scène détecté');
  check(await page.locator('.chapter-body p').count() === 7 + 2, `paragraphes : ${await page.locator('.chapter-body p').count()}`);
  check(!(await page.isDisabled('.chapter-nav.top .nav-next')), 'lien « chapitre suivant » détecté');
  check(!(await page.isDisabled('.chapter-nav.top .nav-prev')), 'lien « chapitre précédent » détecté');
  check(await page.locator('.chapter-nav.top .nav-index').count() === 1, 'lien « sommaire » détecté');
  check(log.some(u => u.startsWith('proxy:')), 'récupération via proxy CORS (site sans CORS)');

  // Lecture (autoplay après chargement)
  await page.waitForFunction(() => document.querySelector('.seg.current'), null, { timeout: 5000 });
  await page.waitForTimeout(700);
  const cur = await page.evaluate(() => +document.querySelector('.seg.current').dataset.i);
  check(cur >= 1, `la phrase lue avance (phrase ${cur})`);
  const hl = await page.evaluate(() => CSS.highlights.get('tts-word')?.size || 0);
  check(hl === 1, 'mot en cours surligné (CSS Highlight)');
  check(await page.evaluate(() => document.querySelector('.voice-marker').classList.contains('on')), 'marqueur de voix visible');
  const spoken = await page.evaluate(() => window.__spoken.filter(t => t.trim()).slice(0, 3));
  check(spoken[0].includes('La lanterne du quai'), `lit d'abord le titre : « ${spoken[0]} »`);
  await page.screenshot({ path: `${OUT}/02-lecture-pc.png` });
  // Image téléchargée et stockée
  await page.waitForFunction(() => document.querySelector('.chapter-body figure img')?.src.startsWith('blob:'), null, { timeout: 5000 }).catch(() => {});
  check((await page.getAttribute('.chapter-body figure img', 'src')).startsWith('blob:'), 'image téléchargée et servie depuis le stockage local');

  // Défilement automatique : on laisse lire jusqu'au bas
  const y0 = await page.evaluate(() => scrollY);
  await page.waitForTimeout(4000);
  const y1 = await page.evaluate(() => scrollY);
  check(y1 > y0, `le texte défile avec la voix (${y0} → ${y1}px)`);

  // Pause / reprise
  await page.click('#btn-play');
  check(await page.evaluate(() => document.querySelector('#btn-play use').getAttribute('href')) === '#i-play', 'pause');
  const pausedAt = await page.evaluate(() => +document.querySelector('.seg.current').dataset.i);
  await page.waitForTimeout(400);
  check(pausedAt === await page.evaluate(() => +document.querySelector('.seg.current').dataset.i), 'la lecture est bien arrêtée en pause');

  // Clic sur une phrase = lecture depuis là
  await page.evaluate(() => document.querySelector('.seg[data-i="3"]').scrollIntoView());
  await page.click('.seg[data-i="3"]');
  await page.waitForTimeout(150);
  const afterClick = await page.evaluate(() => +document.querySelector('.seg.current').dataset.i);
  check(afterClick === 3 || afterClick === 4, `clic sur une phrase → lecture depuis celle-ci (${afterClick})`);
  await page.click('#btn-play');

  // Réglages d'apparence
  await page.click('#btn-appearance');
  await page.click('.theme-swatch[data-theme="sepia"]');
  await page.fill('#set-fontSize', '26');
  await page.dispatchEvent('#set-fontSize', 'input');
  check(await page.evaluate(() => document.documentElement.dataset.theme) === 'sepia', 'changement de thème');
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.chapter')).fontSize) === '26px', 'changement de taille de police');
  await page.screenshot({ path: `${OUT}/03-reglages.png` });
  await page.click('#settings [data-close]');

  // Bibliothèque
  await page.click('#btn-library');
  await page.waitForSelector('#lib-list .chap-item');
  check((await page.textContent('#lib-list')).includes('La lanterne du quai'), 'chapitre présent dans la bibliothèque');
  await page.screenshot({ path: `${OUT}/04-bibliotheque.png` });

  // Rechargement : aucune requête réseau vers le site
  const id = await page.evaluate(() => decodeURIComponent(location.hash.replace('#/lire/', '')));
  log.length = 0;
  await page.goto(BASE + '?nointro#/lire/' + encodeURIComponent(id));
  await page.waitForSelector('.chapter-title');
  await page.waitForTimeout(500);
  const siteRequests = log.filter(u => u.includes('exemple-roman.test') && !u.includes('/wp-content/'));
  check(siteRequests.length === 0, `réouverture sans requête GET vers le site (${siteRequests.length})`);
  check((await page.getAttribute('.chapter-body figure img', 'src')).startsWith('blob:'), 'image rechargée depuis le stockage local');
  check(await page.evaluate(() => !!document.querySelector('.seg.current')), 'position de lecture restaurée');
  await ctx.close();
}

// ---------------------------------------------------------------- 2. WordPress.com (API, sans proxy)
{
  const log = [];
  const { ctx, page } = await newPage(undefined, { log });
  await page.goto(BASE + '?nointro&url=' + encodeURIComponent('https://lac-traductions.wordpress.com/2024/01/02/arc-i-chapitre-2/'));
  await page.waitForSelector('.chapter-title', { timeout: 15000 });
  check((await page.textContent('.chapter-title')).includes('Chapitre 2 : La lanterne du quai'), 'WordPress.com : titre via API');
  const t = await page.textContent('.chapter-body');
  check(t.includes('La pluie avait cessé') && !t.includes('Partager') && !t.includes('Articles similaires'), 'WordPress.com : texte propre via API');
  check(!log.some(u => u.startsWith('proxy:')), 'WordPress.com : aucun proxy utilisé');
  check(!(await page.isDisabled('.chapter-nav.top .nav-next')), 'WordPress.com : chapitre suivant détecté');
  check(new URL(page.url()).search === '', "paramètre ?url= retiré de l'adresse");
  await ctx.close();
}

// ---------------------------------------------------------------- 3. Sommaire
{
  const { ctx, page } = await newPage(undefined, { cors: true });
  await page.goto(BASE + '?nointro');
  await page.evaluate(() => { document.querySelector('#url-input').value = 'https://exemple-roman.test/sommaire/'; });
  await page.click('#url-form button[type=submit]');
  await page.waitForSelector('.toc-box', { timeout: 15000 });
  check(await page.locator('.toc-link').count() === 10, `sommaire détecté (${await page.locator('.toc-link').count()} chapitres)`);
  await ctx.close();
}

// ---------------------------------------------------------------- 4. Mobile
{
  const { ctx, page } = await newPage({ width: 390, height: 844 }, { cors: true });
  await page.goto(BASE + '?nointro');
  await page.screenshot({ path: `${OUT}/05-mobile-accueil.png` });
  await page.fill('#url-input', CH2);
  await page.click('#url-form button[type=submit]');
  await page.waitForSelector('.seg.current', { timeout: 15000 });
  await page.waitForTimeout(1500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check(!overflow, 'mobile : pas de défilement horizontal');
  await page.screenshot({ path: `${OUT}/06-mobile-lecture.png` });
  await page.click('#btn-settings');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/07-mobile-voix.png` });
  const voiceOpt = await page.$eval('#set-voice', s => s.options[s.selectedIndex]?.textContent);
  check(/Denise/.test(voiceOpt), `voix naturelle choisie par défaut : ${voiceOpt}`);
  await ctx.close();
}

// ---------------------------------------------------------------- 6. Fluidité, ambiance, musiques
{
  const { ctx, page } = await newPage(undefined, { cors: true });
  await page.goto(BASE + '?nointro');
  // Bibliothèque musicale
  await page.click('#btn-music');
  await page.fill('#ost-url', 'https://www.youtube.com/watch?v=AAAAAAAAAAA');
  await page.click('#ost-tags button:has-text("Calme")');
  await page.click('#ost-form button[type=submit]');
  await page.fill('#ost-url', 'https://youtu.be/BBBBBBBBBBB?t=1m5s');
  await page.click('#ost-tags button:has-text("Mystère")');
  await page.click('#ost-tags button:has-text("Tension")');
  await page.click('#ost-form button[type=submit]');
  await page.fill('#ost-url', 'pas un lien');
  await page.click('#ost-tags button:has-text("Triste")');
  await page.click('#ost-form button[type=submit]');
  await page.waitForTimeout(400);
  check(await page.locator('.ost-item').count() === 2, `bibliothèque musicale : 2 OST ajoutées, lien invalide refusé (${await page.locator('.ost-item').count()})`);
  check((await page.textContent('#ost-list')).includes('OST AAAAAAAAAAA'), 'titre de la vidéo récupéré');
  await page.screenshot({ path: `${OUT}/08-musiques.png` });
  await page.click('#music [data-close]');

  await page.fill('#url-input', CH2);
  await page.click('#url-form button[type=submit]');
  await page.waitForSelector('.seg.current', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const stats = await page.evaluate(() => ({ spoken: window.__spoken.filter(t => t.trim()).length, segs: document.querySelectorAll('.seg').length, first: window.__spoken.filter(t => t.trim())[1] }));
  check(stats.spoken > 0 && stats.spoken < stats.segs, `enchaînement fluide : phrases regroupées (${stats.spoken} énoncés pour ${stats.segs} phrases)`);
  const mood = await page.textContent('#mood-label');
  check(!!mood && mood.length > 2, `ambiance détectée affichée : ${mood}`);
  const loads = await page.evaluate(() => window.__ytLoads || []);
  check(loads.length >= 1, `une OST se lance automatiquement avec la lecture (${loads.join(', ')})`);
  check(await page.isVisible('#mini-player'), 'mini-lecteur de musique visible');
  // Pause de la voix -> pause de la musique
  await page.click('#btn-play');
  await page.waitForTimeout(1000);
  check(await page.evaluate(() => window.__yt.state) === 2, 'la musique se met en pause avec la voix');
  // Forcer une ambiance
  await page.click('#btn-mood');
  await page.click('#mood-grid button:has-text("Calme")');
  await page.waitForTimeout(2500);
  check(await page.evaluate(() => window.__yt.vid) === 'AAAAAAAAAAA', 'ambiance forcée « Calme » → OST calme');
  await page.screenshot({ path: `${OUT}/09-ambiance.png` });
  await ctx.close();
}

// ---------------------------------------------------------------- 7. Voix IA (OpenAI simulée)
{
  const log = [];
  const { ctx, page } = await newPage(undefined, { cors: true, log });
  await page.goto(BASE + '?nointro');
  await page.evaluate(() => localStorage.setItem('relecteur.settings.v1', JSON.stringify({ engine: 'openai', openaiKey: 'sk-test', showIntro: false })));
  await page.reload();
  await page.fill('#url-input', CH2);
  await page.click('#url-form button[type=submit]');
  await page.waitForSelector('.chapter-title', { timeout: 15000 });
  await page.waitForTimeout(2500);
  const calls = log.filter(u => u.startsWith('openai:'));
  check(calls.length >= 1, `voix IA : requêtes envoyées à OpenAI (${calls.length})`);
  const body = JSON.parse(calls[0]?.slice(7) || '{}');
  check(body.model === 'gpt-4o-mini-tts' && /Ambiance/.test(body.instructions || ''), 'voix IA : consignes d\'émotion selon l\'ambiance');
  check(await page.evaluate(() => CSS.highlights.get('tts-word')?.size || 0) === 1, 'voix IA : mot en cours surligné');
  check(await page.evaluate(() => document.querySelector('#btn-play use').getAttribute('href')) === '#i-pause', 'voix IA : lecture en cours');
  // Réécoute : servie depuis le cache, sans nouvelle requête
  const before = log.filter(u => u.startsWith('openai:')).length;
  await page.click('#btn-play');
  await page.click('.seg[data-i="0"]');
  await page.waitForTimeout(800);
  const after = log.filter(u => u.startsWith('openai:')).length;
  check(after === before, `voix IA : réécoute depuis le cache, sans nouvel appel payant (${before} → ${after})`);
  await ctx.close();
}

// ---------------------------------------------------------------- 8. Compte : sauvegarde en ligne + autre appareil
{
  const { ctx, page } = await newPage(undefined, { cors: true });
  await page.goto(BASE + '?nointro');
  await page.fill('#url-input', CH2);
  await page.click('#url-form button[type=submit]');
  await page.waitForSelector('.seg.current', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.click('#btn-play'); // pause
  await page.click('#btn-music');
  await page.fill('#ost-url', 'https://youtu.be/CCCCCCCCCCC');
  await page.click('#ost-tags button:has-text("Triste")');
  await page.click('#ost-form button[type=submit]');
  await page.waitForTimeout(300);
  await page.click('#music [data-close]');
  await page.click('#btn-settings');
  await page.click('[data-tab="account"]');
  await page.fill('#sync-token', 'ghp_mauvais');
  await page.click('#sync-connect');
  await page.waitForTimeout(500);
  check((await page.textContent('#toasts')).includes('Jeton GitHub invalide'), 'compte : mauvais jeton refusé');
  await page.fill('#sync-token', 'ghp_test');
  await page.click('#sync-connect');
  await page.waitForSelector('#sync-on:not([hidden])', { timeout: 8000 });
  await page.waitForTimeout(800);
  check((await page.textContent('#sync-user')) === 'lecteur-test', 'compte : connecté');
  check(!!GH.gist && Object.keys(GH.gist.files).some(n => n.startsWith('relecteur.json')), `compte : fichier de sauvegarde créé (${Object.keys(GH.gist?.files || {}).join(', ')})`);
  const savedPct = await page.evaluate(async () => { const { listChapters } = await import('./js/db.js'); return (await listChapters())[0].progress.seg; });
  await page.screenshot({ path: `${OUT}/10-compte.png` });
  await ctx.close();

  // Nouvel appareil (navigateur vierge) : on colle le même jeton -> tout revient
  const second = await newPage({ width: 390, height: 844 }, { cors: true });
  await second.page.goto(BASE + '?nointro');
  check(await second.page.locator('#recent-list .chap-item, #resume-body .chap-item').count() === 0, 'autre appareil : bibliothèque vide au départ');
  await second.page.click('#btn-settings');
  await second.page.click('[data-tab="account"]');
  await second.page.fill('#sync-token', 'ghp_test');
  await second.page.click('#sync-connect');
  await second.page.waitForSelector('#sync-on:not([hidden])', { timeout: 8000 });
  await second.page.waitForTimeout(1200);
  const remote = await second.page.evaluate(async () => {
    const db = await import('./js/db.js');
    const ch = await db.listChapters(); const os = await db.listOsts();
    return { n: ch.length, title: ch[0]?.title, seg: ch[0]?.progress?.seg, osts: os.map(o => o.videoId) };
  });
  check(remote.n === 1 && remote.title.includes('La lanterne'), 'autre appareil : chapitre récupéré');
  check(remote.seg === savedPct && savedPct > 0, `autre appareil : progression récupérée (phrase ${remote.seg})`);
  check(remote.osts.includes('CCCCCCCCCCC'), 'autre appareil : musiques récupérées');
  await second.page.click('#settings [data-close]');
  await second.page.click('#btn-library');
  await second.page.waitForSelector('#lib-list .chap-item');
  check(await second.page.locator('#btn-library .sync-dot').count() === 1, 'indicateur de synchronisation visible');
  // suppression sur l'appareil 2 -> propagée
  second.page.once('dialog', d => d.accept());
  await second.page.click('#lib-list .lib-row .icon-btn');
  await second.page.waitForTimeout(400);
  await second.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await second.page.evaluate(async () => { const m = await import('./js/sync.js'); });
  await second.page.waitForTimeout(3500);
  const remoteData = await second.page.evaluate(async () => {
    const db = await import('./js/db.js');
    return (await db.listChapters()).length;
  });
  check(remoteData === 0, 'suppression locale appliquée');
  await second.ctx.close();
}

// ---------------------------------------------------------------- 9. ElevenLabs : crédits épuisés -> voix de l'appareil
{
  const log = [];
  const { ctx, page } = await newPage(undefined, { cors: true, log });
  await page.goto(BASE + '?nointro');
  await page.evaluate(() => localStorage.setItem('relecteur.settings.v1', JSON.stringify({ engine: 'elevenlabs', elevenKey: 'sk_test', showIntro: false })));
  await page.reload();
  await page.fill('#url-input', CH2);
  await page.click('#url-form button[type=submit]');
  await page.waitForSelector('.chapter-title', { timeout: 15000 });
  await page.waitForTimeout(2500);
  check(log.some(u => u.startsWith('eleven:') && u.includes('text-to-speech')), 'ElevenLabs : demande envoyée');
  check((await page.textContent('#toasts')).includes('crédits du mois épuisés'), 'ElevenLabs : crédits épuisés détectés');
  check(await page.evaluate(() => window.__spoken.filter(t => t.trim()).length) > 0, 'ElevenLabs épuisé → la lecture continue avec la voix de l\'appareil');
  check(await page.evaluate(() => document.querySelector('#btn-play use').getAttribute('href')) === '#i-pause', 'la lecture ne s\'arrête pas');
  await page.click('#btn-settings');
  await page.click('[data-tab="voice"]');
  await page.click('#eleven-quota-btn');
  await page.waitForTimeout(500);
  check((await page.textContent('#eleven-quota')).includes('10 caractères restants'), `crédits affichés : ${(await page.textContent('#eleven-quota')).slice(0, 60)}`);
  await page.screenshot({ path: `${OUT}/11-credits.png` });
  await ctx.close();
}

// ---------------------------------------------------------------- 5. Intro animée
{
  // captures à des instants précis
  const { ctx, page } = await newPage({ width: 1280, height: 720 });
  await page.goto(BASE);
  check(await page.locator('.intro canvas').count() === 1, "l'intro démarre");
  const t0 = Date.now();
  for (const ms of [600, 1500, 2150, 2550, 3200, 4000]) {
    const wait = ms - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    await page.screenshot({ path: `${OUT}/intro-${String(ms).padStart(4, '0')}.png` });
  }
  await page.waitForTimeout(1800);
  check(await page.locator('.intro').count() === 0, "l'intro se termine et laisse place à l'application (≈5 s)");
  await ctx.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent ✓');
process.exit(failures ? 1 : 0);
