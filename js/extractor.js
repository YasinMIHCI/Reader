// Extraction du texte du roman : on ne garde que le contenu du chapitre,
// sans menus, boutons de partage, publicités, commentaires, "articles similaires", etc.
// Le résultat est une liste de blocs simples : titres, paragraphes, images, séparateurs.

/* global Readability */

const REMOVE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'form', 'button', 'input', 'select', 'textarea',
  'canvas', 'template', 'object', 'embed', 'audio', 'video', 'link', 'meta',
  '[hidden]', '[style*="display:none"]', '[style*="display: none"]', '[style*="visibility:hidden"]',
  '.screen-reader-text', '.skip-link', '.sr-only', '.visually-hidden',
  // Structure du site
  '#masthead', '.site-header', 'body > header', '#site-header', '.site-footer', '#colophon', 'footer',
  'aside', '.sidebar', '#sidebar', '#secondary', '.widget-area', '.widget', '#wpadminbar', '.menu', '.main-navigation',
  '#site-navigation', '.breadcrumbs', '.breadcrumb', '.cookie', '#cookie-notice', '.cookie-banner', '#cmplz-cookiebanner-container',
  // WordPress / Jetpack
  '.sharedaddy', '.sd-sharing-enabled', '.sd-block', '.sharing', '.jp-relatedposts', '#jp-relatedposts', '#jp-post-flair',
  '.wpcnt', '.wordads-ad-wrapper', '.wordads-tag', '.wpa', '.wpa-about', '.wpadvert', '.wp-block-jetpack-subscriptions',
  '.jetpack-likes-widget-wrapper', '.post-likes-widget-placeholder', '.likes-widget-placeholder', '.wp-block-jetpack-related-posts',
  '.wp-block-jetpack-sharing-buttons', '.jetpack-subscribe-modal', '.wp-block-jetpack-like', '.wp-block-comments',
  '.comments-area', '#comments', '#respond', '.comment-respond', '.comments', '.comment-list',
  '.entry-meta', '.entry-footer', '.post-meta', '.byline', '.posted-on', '.cat-links', '.tags-links', '.tag-links', '.edit-link',
  '.author-box', '.author-info', '.about-author', '.post-author', '.post-tags', '.post-categories',
  '.related-posts', '.yarpp-related', '.crp_related', '.rp4wp-related-posts', '.related',
  '.addtoany_share_save_container', '.a2a_kit', '.addtoany_list', '.heateor_sss_sharing_container', '.shared-counts-wrap',
  '.social', '.social-share', '.share-buttons', '.share-links', '.post-share', '[class*="share-"]', '[class*="sharing-"]',
  '.ad', '.ads', '.adsbygoogle', '.advertisement', '.advert', '[id^="div-gpt"]', '[class*="advert"]', '[id*="advert"]',
  '[class*="banner-ad"]', '.code-block', '.newsletter', '.subscribe', '.mc4wp-form', '.patreon-button', '.kofi-button',
  '.wp-block-search', '.search-form', '.pagination', '.page-links:empty',
  // Thèmes de romans (Madara, etc.)
  '.chapter-warning', '.c-ads', '.ads-holder', '.chapter-nav-ads', '.ad-container', '.wpb_wrapper .ad', '.manga-discussion',
];

const CONTENT_SELECTORS = [
  '#chapter-content', '.chapter-content', '.reading-content', '#chr-content', '.chr-c', '#chapter-c', '.chapter-c',
  '.chapter__content', '.chapter-inner', '.chapter-body', '.novel-content', '#novel-content',
  '.entry-content', '.post-content', '.single-post-content', '.post-entry', '.entry-body', '.post-body',
  '[itemprop="articleBody"]', '.article-content', '.article-body', '.td-post-content', '.blog-post-content',
  'article .content', 'main article', 'article', '.text-left',
];

const RE_NEXT = /(chap(itre|\.)?\s*suiv|suivant|next(\s*chap(ter)?)?|→|⟶|>>|»\s*$|^\s*>\s*$)/i;
const RE_PREV = /(chap(itre|\.)?\s*pr[ée]c|pr[ée]c[ée]dent|previous|prev\b|←|⟵|<<|^\s*«\s*$|^\s*<\s*$|^\s*[«‹<]\s*chap)/i;
const RE_INDEX = /(sommaire|table\s+des\s+mati[eè]res|liste\s+des\s+chap|index|toc\b|tous\s+les\s+chap|chapters?\s*list|^\s*chapitres\s*$|retour\s+(au|à)\s+(sommaire|l'index|la\s+liste))/i;
const NAV_WORDS = /(chap(itre|ter|\.)?|suivant|pr[ée]c[ée]dent|next|previous|prev|sommaire|table\s+des\s+mati[eè]res|index|toc|retour|liste|accueil|home|arc|tome|volume|vol\.?|[|\-–—•·/\\<>«»←→⟵⟶\s\d:.,]+)/gi;

const PARASITE_LINE = /^(partager\s*(ceci|cet article|:)?|share\s*(this)?\s*:?|j[’']aime\s*(ceci|chargement)?|like\s*this|like\s*loading|chargement[\s.…]*|loading[\s.…]*|en lien|related|articles?\s+similaires|publicit[ée]s?|advertisements?|report\s+this\s+ad|signaler\s+cette\s+(pub(licit[ée])?|annonce)|this\s+entry\s+was\s+posted.*|publi[ée]\s+(dans|par|le).*|posted\s+(in|by|on).*|tags?\s*:.*|cat[ée]gories?\s*:.*|laisser\s+un\s+commentaire.*|leave\s+a\s+(comment|reply).*|\d+\s+commentaires?|abonnez[- ]vous.*|subscribe.*|s[’']abonner.*|suivre\s+ce\s+blog.*|follow.*|soyez\s+le\s+premier\s+[àa]\s+aimer.*|be\s+the\s+first\s+to\s+like.*|cliquez\s+pour\s+partager.*|click\s+to\s+share.*|(facebook|twitter|x|tumblr|pinterest|reddit|telegram|whatsapp|e-?mail|imprimer|print)(\s*[,|•·]\s*(facebook|twitter|x|tumblr|pinterest|reddit|telegram|whatsapp|e-?mail|imprimer|print))*|ceci\s+vous\s+a\s+plu\s*\?.*|merci\s+(d[’']avoir\s+lu|pour\s+(la|votre)\s+lecture).*|thanks?\s+(you\s+)?for\s+reading.*|vous\s+aimerez\s+aussi.*|you\s+may\s+also\s+like.*|lire\s+la\s+suite.*|continue\s+reading.*|propuls[ée]\s+par\s+wordpress.*|powered\s+by\s+wordpress.*|[ée]dition|modifier|edit)$/i;

const SEPARATOR_LINE = /^[\s*•·~—–\-_=◇◆○●♦✦✧❖⁂#※❀✿☆★◈◉✥⋆+]{3,}$|^(\*\s*){1,}$|^(◇|◆|☆|★|♦|※)$/;

const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BLOCKQUOTE', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'PRE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH', 'FIGURE', 'FIGCAPTION', 'HEADER', 'CENTER', 'ADDRESS', 'DETAILS', 'SUMMARY', 'HR']);

function normText(s) {
  return (s || '')
    .replace(/[​-‍﻿­]/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function absUrl(u, base) {
  if (!u) return null;
  try { return new URL(u.trim(), base).href; } catch { return null; }
}

function bestImageSrc(img, base) {
  const attrs = ['data-orig-file', 'data-large-file', 'data-lazy-src', 'data-src', 'data-original', 'data-lazy', 'data-url'];
  for (const a of attrs) {
    const v = img.getAttribute(a);
    if (v && !v.startsWith('data:')) return absUrl(v, base);
  }
  const srcset = img.getAttribute('data-lazy-srcset') || img.getAttribute('data-srcset') || img.getAttribute('srcset');
  if (srcset) {
    let best = null; let bestW = -1;
    srcset.split(',').forEach(part => {
      const [u, d] = part.trim().split(/\s+/);
      const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 1;
      if (u && w > bestW) { bestW = w; best = u; }
    });
    if (best) return absUrl(best, base);
  }
  const src = img.getAttribute('src');
  if (src && !src.startsWith('data:')) return absUrl(src, base);
  return null;
}

function isJunkImage(img, src) {
  if (!src) return true;
  const w = parseInt(img.getAttribute('width') || '0', 10);
  const h = parseInt(img.getAttribute('height') || '0', 10);
  if ((w && w <= 3) || (h && h <= 3)) return true;
  if (/wp-smiley|emoji|avatar|gravatar|logo|icon|badge|button/i.test((img.className || '') + ' ' + (img.id || ''))) return true;
  if (/(pixel\.wp\.com|stats\.wp\.com|gravatar\.com|feedburner|doubleclick|googlesyndication|facebook\.com\/tr|\/emoji\/|s\.w\.org\/images\/core\/emoji|ko-fi\.com\/img|patreon.*button|buymeacoffee)/i.test(src)) return true;
  return false;
}

function removeParasites(root) {
  REMOVE_SELECTORS.forEach(sel => {
    try { root.querySelectorAll(sel).forEach(el => el.remove()); } catch { /* sélecteur non supporté */ }
  });
  // Commentaires HTML
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach(c => c.remove());
}

function linkKind(a) {
  const text = normText(a.textContent || a.getAttribute('title') || a.getAttribute('aria-label') || '');
  const rel = (a.getAttribute('rel') || '').toLowerCase();
  const cls = (a.className || '') + ' ' + (a.parentElement?.className || '');
  if (rel.includes('next') || /\bnext\b|nav-next|next_page|next-chap/i.test(cls)) return 'next';
  if (rel.includes('prev') || /\bprev\b|nav-previous|prev_page|prev-chap/i.test(cls)) return 'prev';
  if (!text || text.length > 60) return null;
  if (RE_NEXT.test(text)) return 'next';
  if (RE_PREV.test(text)) return 'prev';
  if (RE_INDEX.test(text)) return 'index';
  return null;
}

function nearestBlock(el, stopAt) {
  let cur = el;
  while (cur && cur !== stopAt) {
    if (BLOCK_TAGS.has(cur.tagName) && cur.tagName !== 'LI') return cur;
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Repère les liens de navigation (chapitre précédent / suivant / sommaire) à l'intérieur
 * du contenu, les mémorise, puis supprime les blocs qui ne contiennent que ces liens.
 */
function extractNavFromContent(root, base) {
  const nav = {};
  const toRemove = new Set();
  root.querySelectorAll('a[href]').forEach(a => {
    const kind = linkKind(a);
    if (!kind) return;
    const href = absUrl(a.getAttribute('href'), base);
    if (!href || href.startsWith('javascript:')) return;
    if (!nav[kind]) nav[kind] = href;
    const block = nearestBlock(a, root);
    if (block) {
      const rest = normText(block.textContent).replace(NAV_WORDS, '').trim();
      if (rest.length <= 12 && normText(block.textContent).length < 220) toRemove.add(block);
    } else {
      toRemove.add(a);
    }
  });
  toRemove.forEach(el => el.remove());
  return nav;
}

/** Navigation trouvée dans la page entière (liens rel=next du thème, etc.). */
export function extractNavFromPage(doc, base) {
  const nav = {};
  const set = (k, href) => { const u = absUrl(href, base); if (u && !nav[k] && u !== base) nav[k] = u; };
  doc.querySelectorAll('link[rel="next"], a[rel="next"]').forEach(l => set('next', l.getAttribute('href')));
  doc.querySelectorAll('link[rel="prev"], a[rel="prev"]').forEach(l => set('prev', l.getAttribute('href')));
  doc.querySelectorAll('.nav-next a, .next_page, a.next-chap, a.btn-next, #next_chap, .chapter-next a, a.next').forEach(a => set('next', a.getAttribute('href')));
  doc.querySelectorAll('.nav-previous a, .prev_page, a.prev-chap, a.btn-prev, #prev_chap, .chapter-prev a, a.prev').forEach(a => set('prev', a.getAttribute('href')));
  return nav;
}

function pickContentRoot(doc) {
  for (const sel of CONTENT_SELECTORS) {
    let els;
    try { els = [...doc.querySelectorAll(sel)]; } catch { continue; }
    if (!els.length) continue;
    els = els.filter(e => normText(e.textContent).length > 400);
    if (!els.length) continue;
    // Sur une page de chapitre il n'y en a qu'un ; sinon on garde le plus long.
    els.sort((a, b) => normText(b.textContent).length - normText(a.textContent).length);
    return els[0];
  }
  return null;
}

function readabilityRoot(doc) {
  if (typeof Readability === 'undefined') return null;
  try {
    const clone = doc.cloneNode(true);
    const art = new Readability(clone, { charThreshold: 300, keepClasses: false }).parse();
    if (!art || !art.content) return null;
    const d = new DOMParser().parseFromString(`<div id="rdb">${art.content}</div>`, 'text/html');
    return { root: d.getElementById('rdb'), title: art.title, siteName: art.siteName, lang: art.lang };
  } catch (e) {
    console.warn('Readability a échoué', e);
    return null;
  }
}

/** Texte d'un élément avec les <br> convertis en retours à la ligne. */
function textWithBreaks(el) {
  let out = '';
  const rec = node => {
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1) {
        if (n.tagName === 'BR') out += '\n';
        else if (n.tagName === 'IMG') out += '';
        else { rec(n); if (BLOCK_TAGS.has(n.tagName)) out += '\n'; }
      }
    });
  };
  rec(el);
  return out;
}

function hasBlockChild(el) {
  for (const c of el.children) {
    if (BLOCK_TAGS.has(c.tagName) || c.tagName === 'IMG' || c.tagName === 'PICTURE' || c.querySelector?.('img')) return true;
  }
  return false;
}

/** Transforme l'arbre HTML nettoyé en blocs simples. */
function toBlocks(root, base) {
  const blocks = [];
  let buffer = '';

  const pushText = (raw, type = 'p', extra = {}) => {
    const t = normText(raw);
    if (!t) return;
    const lines = type === 'p' || type === 'quote' ? t.split(/\n+/) : [t.replace(/\n+/g, ' ')];
    lines.forEach(line => {
      line = line.trim();
      if (!line) return;
      if (SEPARATOR_LINE.test(line)) { blocks.push({ type: 'hr' }); return; }
      blocks.push({ type, text: line, ...extra });
    });
  };
  const flush = () => { if (buffer) { pushText(buffer); buffer = ''; } };

  const pushImage = (img, caption) => {
    const src = bestImageSrc(img, base);
    if (isJunkImage(img, src)) {
      const alt = img.getAttribute('alt');
      if (alt && /emoji|wp-smiley/.test(img.className)) buffer += alt;
      return;
    }
    if (blocks.some(b => b.type === 'img' && b.src === src)) return;
    flush();
    blocks.push({ type: 'img', src, alt: normText(img.getAttribute('alt') || ''), caption: caption || '' });
  };

  const walk = node => {
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) { buffer += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'BR') { buffer += '\n'; return; }
      if (tag === 'IMG') { pushImage(n); return; }
      if (tag === 'PICTURE') { const img = n.querySelector('img'); if (img) pushImage(img); return; }
      if (tag === 'HR') { flush(); blocks.push({ type: 'hr' }); return; }
      if (tag === 'FIGURE') {
        flush();
        const cap = normText(n.querySelector('figcaption')?.textContent || '');
        const imgs = n.querySelectorAll('img');
        if (imgs.length) { imgs.forEach((img, i) => pushImage(img, i === imgs.length - 1 ? cap : '')); }
        else pushText(textWithBreaks(n));
        return;
      }
      if (/^H[1-6]$/.test(tag)) {
        flush();
        n.querySelectorAll('img').forEach(img => pushImage(img));
        pushText(n.textContent, 'h', { level: Math.min(Math.max(parseInt(tag[1], 10), 2), 4) });
        return;
      }
      if (tag === 'BLOCKQUOTE' && !hasBlockChild(n)) { flush(); pushText(textWithBreaks(n), 'quote'); return; }
      if ((tag === 'P' || tag === 'LI' || tag === 'DD' || tag === 'DT' || tag === 'PRE' || tag === 'TD' || tag === 'TH' || tag === 'FIGCAPTION') && !hasBlockChild(n)) {
        flush(); pushText(textWithBreaks(n)); return;
      }
      if (BLOCK_TAGS.has(tag) || n.querySelector('img')) { flush(); walk(n); flush(); return; }
      // Élément en ligne (span, em, a, strong…)
      buffer += textWithBreaks(n);
    });
  };
  walk(root);
  flush();
  return blocks;
}

function cleanBlocks(blocks, title) {
  const out = [];
  const titleNorm = normText(title).toLowerCase();
  for (const b of blocks) {
    if (b.type === 'p' || b.type === 'h' || b.type === 'quote') {
      const t = b.text.replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\s]+/u, '');
      if (t.length < 140 && PARASITE_LINE.test(t)) continue;
      if (/^(\d+\s*)?(j[’']aime|likes?)$/i.test(t)) continue;
      if (out.length === 0 && t.toLowerCase() === titleNorm) continue;
    }
    if (b.type === 'hr') {
      if (!out.length || out[out.length - 1].type === 'hr') continue;
    }
    out.push(b);
  }
  // Retire les séparateurs et parasites en fin de chapitre
  while (out.length && out[out.length - 1].type === 'hr') out.pop();
  return out;
}

function detectIndex(root, base) {
  const links = [];
  const seen = new Set();
  let linkText = 0;
  root.querySelectorAll('a[href]').forEach(a => {
    const href = absUrl(a.getAttribute('href'), base);
    const text = normText(a.textContent);
    if (!href || !text || text.length < 2 || seen.has(href) || /^(mailto|javascript):/.test(href)) return;
    if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(href)) return;
    seen.add(href);
    links.push({ text: text.slice(0, 140), href });
    linkText += text.length;
  });
  const total = normText(root.textContent).length || 1;
  const isIndex = links.length >= 8 && linkText / total > 0.45;
  return { isIndex, links: isIndex ? links : [] };
}

function cleanTitle(t, siteName) {
  t = normText(t || '');
  if (!t) return '';
  if (siteName) {
    const re = new RegExp(`\\s*[|–—\\-:]\\s*${siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    t = t.replace(re, '');
  }
  return t.replace(/\s*[|–—]\s*[^|–—]{2,40}$/, m => (t.length - m.length > 8 ? '' : m)).trim();
}

function wordCount(blocks) {
  return blocks.reduce((n, b) => n + (b.text ? b.text.split(/\s+/).length : 0), 0);
}

/**
 * Point d'entrée : page HTML complète.
 */
export function extractFromHtml(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // <base> pour les liens relatifs
  const baseEl = doc.querySelector('base[href]');
  const base = absUrl(baseEl?.getAttribute('href'), url) || url;

  const lang = (doc.documentElement.getAttribute('lang') || '').slice(0, 5) || null;
  const siteName = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || new URL(url).host.replace(/^www\./, '');
  let title = doc.querySelector('h1.entry-title, .entry-title, h1.chapter-title, .chapter-title, h1.post-title, .post-title h1, #chapter-heading, .chr-title, h1')?.textContent
    || doc.querySelector('meta[property="og:title"]')?.getAttribute('content')
    || doc.title;
  title = cleanTitle(title, siteName);

  const pageNav = extractNavFromPage(doc, base);
  const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content');

  removeParasites(doc.body || doc.documentElement);
  let root = pickContentRoot(doc);
  if (!root) {
    const r = readabilityRoot(doc);
    if (r) {
      root = r.root;
      if (!title) title = cleanTitle(r.title, siteName);
    }
  }
  if (!root) root = doc.body;
  removeParasites(root);

  return finalize({ root, base, title, siteName, lang, pageNav, url, ogImage });
}

/**
 * Point d'entrée : contenu renvoyé par une API WordPress (HTML de l'article seul).
 */
export function extractFromApi(api) {
  const doc = new DOMParser().parseFromString(`<div id="api-root">${api.contentHtml}</div>`, 'text/html');
  const root = doc.getElementById('api-root');
  removeParasites(root);
  return finalize({ root, base: api.url, title: normText(api.title), siteName: api.siteName, lang: api.lang, pageNav: {}, url: api.url, ogImage: null });
}

/** Texte collé à la main par l'utilisateur (secours si un site bloque tout). */
export function extractFromPastedText(text, title) {
  const looksHtml = /<\/?(p|div|br|span|h\d)[\s>]/i.test(text);
  if (looksHtml) {
    const doc = new DOMParser().parseFromString(`<div id="paste-root">${text}</div>`, 'text/html');
    const root = doc.getElementById('paste-root');
    removeParasites(root);
    return finalize({ root, base: location.href, title: title || 'Texte collé', siteName: 'Texte collé', lang: null, pageNav: {}, url: null, ogImage: null });
  }
  const blocks = [];
  text.replace(/\r/g, '').split(/\n\s*\n|\n/).forEach(line => {
    const t = normText(line);
    if (!t) return;
    if (SEPARATOR_LINE.test(t)) blocks.push({ type: 'hr' });
    else blocks.push({ type: 'p', text: t });
  });
  return { title: title || blocks.find(b => b.text)?.text.slice(0, 80) || 'Texte collé', siteName: 'Texte collé', lang: detectLang(blocks) || 'fr-FR', blocks, nav: {}, index: [], isIndex: false, wordCount: wordCount(blocks) };
}

const STOPWORDS = {
  'fr-FR': ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'un', 'une', 'que', 'qui', 'je', 'il', 'elle', 'pas', 'ne', 'en', 'du', 'au', 'mais', 'vous', 'sur'],
  'en-US': ['the', 'and', 'is', 'of', 'to', 'a', 'in', 'that', 'it', 'was', 'he', 'she', 'you', 'with', 'for', 'his', 'her', 'but', 'not', 'on'],
  'es-ES': ['el', 'la', 'los', 'las', 'de', 'y', 'que', 'en', 'un', 'una', 'es', 'por', 'con', 'no', 'se', 'su', 'pero', 'como', 'lo', 'del'],
  'de-DE': ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'sie', 'er', 'es', 'mit', 'ein', 'eine', 'zu', 'auf', 'den', 'dem', 'aber', 'auch', 'sich'],
  'it-IT': ['il', 'la', 'di', 'che', 'e', 'non', 'un', 'una', 'per', 'con', 'mi', 'si', 'ma', 'lo', 'gli', 'del', 'della', 'sono', 'era', 'anche'],
  'pt-BR': ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'não', 'um', 'uma', 'com', 'para', 'em', 'do', 'da', 'se', 'mas', 'ele', 'ela', 'você'],
};

/** Devine la langue du texte (pour choisir automatiquement une voix adaptée). */
export function detectLang(blocks) {
  const sample = blocks.filter(b => b.text).map(b => b.text).join(' ').slice(0, 6000).toLowerCase();
  const words = sample.match(/\p{L}+/gu) || [];
  if (words.length < 20) return null;
  let best = null; let bestScore = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const score = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0) / words.length;
    if (score > bestScore) { bestScore = score; best = lang; }
  }
  return bestScore > 0.05 ? best : null;
}

function finalize({ root, base, title, siteName, lang, pageNav, ogImage }) {
  const contentNav = extractNavFromContent(root, base);
  const nav = { ...pageNav, ...contentNav };
  const { isIndex, links } = detectIndex(root, base);
  let blocks = cleanBlocks(toBlocks(root, base), title);

  // Si le contenu commence par un titre identique au titre de la page, on l'enlève (déjà affiché).
  if (blocks[0]?.type === 'h' && normText(blocks[0].text).toLowerCase() === normText(title).toLowerCase()) blocks.shift();
  if (!title) {
    const firstH = blocks.find(b => b.type === 'h');
    title = firstH?.text || blocks.find(b => b.text)?.text.slice(0, 80) || 'Sans titre';
  }
  const textLen = blocks.reduce((n, b) => n + (b.text?.length || 0), 0);
  if (textLen < 80 && !blocks.some(b => b.type === 'img') && !isIndex) {
    throw new Error("Aucun texte de roman n'a été trouvé sur cette page.");
  }
  const guessed = detectLang(blocks);
  if (guessed && (!lang || lang.slice(0, 2) !== guessed.slice(0, 2))) lang = guessed;
  return { title, siteName, lang: lang || 'fr-FR', blocks, nav, isIndex, index: links, wordCount: wordCount(blocks), cover: ogImage || null };
}

// ---------- Découpage en phrases (utilisé pour la lecture à voix haute)

const segmenterCache = {};
function getSegmenter(lang) {
  if (typeof Intl === 'undefined' || !Intl.Segmenter) return null;
  if (!segmenterCache[lang]) {
    try { segmenterCache[lang] = new Intl.Segmenter(lang, { granularity: 'sentence' }); } catch { return null; }
  }
  return segmenterCache[lang];
}

const MAX_SEG = 220;

function splitLong(s) {
  if (s.length <= MAX_SEG) return [s];
  const out = [];
  let rest = s;
  while (rest.length > MAX_SEG) {
    const window = rest.slice(0, MAX_SEG);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' — '), window.lastIndexOf(' – '));
    if (cut < MAX_SEG * 0.4) cut = window.lastIndexOf(' ');
    if (cut < 20) cut = MAX_SEG;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Découpe un paragraphe en phrases. Renvoie [{start, end}] (indices dans le texte),
 * de sorte que la concaténation recouvre tout le texte (espaces inclus).
 */
export function splitSentences(text, lang = 'fr') {
  const parts = [];
  const seg = getSegmenter(lang);
  if (seg) {
    for (const s of seg.segment(text)) parts.push(s.segment);
  } else {
    const re = /[^.!?…]+(?:[.!?…]+["»”’)\]]*\s*|$)/g;
    let m;
    while ((m = re.exec(text)) && m[0]) parts.push(m[0]);
    if (!parts.length) parts.push(text);
  }
  // Fusionne les fragments trop courts (« … », « Hein ? ») avec la phrase suivante pour plus de fluidité
  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last !== undefined && (last.trim().length < 4 || p.trim().length < 3) && (last.length + p.length) < MAX_SEG) {
      merged[merged.length - 1] = last + p;
    } else merged.push(p);
  }
  const ranges = [];
  let pos = 0;
  merged.forEach(p => splitLong(p).forEach(piece => {
    ranges.push({ start: pos, end: pos + piece.length });
    pos += piece.length;
  }));
  return ranges.filter(r => text.slice(r.start, r.end).trim().length);
}
