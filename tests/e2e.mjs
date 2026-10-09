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

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

const browser = await chromium.launch({ executablePath: EXE });

async function newPage(viewport = { width: 1280, height: 860 }, { cors = false, log = [] } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(FAKE_TTS);
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('  [pageerror]', e.message); failures++; });
  page.on('console', m => { if (m.type() === 'error') console.log('  [console]', m.text()); });
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route('https://fonts.gstatic.com/**', r => r.abort());
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
