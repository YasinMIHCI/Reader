// Rendu du chapitre + suivi visuel de la voix :
//  - phrase en cours surlignée
//  - mot en cours surligné (CSS Custom Highlight API, sinon <mark>)
//  - marqueur lumineux dans la marge qui suit la ligne lue (avec mini-égaliseur)
//  - défilement automatique fluide qui garde la ligne lue à hauteur d'yeux

import { splitSentences } from './extractor.js';

const hasHighlightAPI = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  (Array.isArray(children) ? children : [children]).forEach(c => c != null && e.append(c));
  return e;
}

function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return "moins d'une minute";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

export class ReaderView extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.segments = [];   // [{el, text, block}]
    this.current = -1;
    this.wordRange = null;
    this.follow = true;
    this.userScrollUntil = 0;
    this.scrollAnim = null;
    this.lastLineTop = null;
    this.anchor = 0.38;
    this.autoScroll = true;
    this.detached = false; // l'utilisateur a fait défiler loin de la voix
    this.marker = null;

    if (hasHighlightAPI) {
      this.hlWord = new Highlight();
      CSS.highlights.set('tts-word', this.hlWord);
    }

    const markUser = () => {
      if (this.scrollAnim) { cancelAnimationFrame(this.scrollAnim); this.scrollAnim = null; }
      this.userScrollUntil = performance.now() + 6000;
      this.dispatchEvent(new CustomEvent('userscroll'));
    };
    window.addEventListener('wheel', markUser, { passive: true });
    window.addEventListener('touchmove', markUser, { passive: true });
    window.addEventListener('keydown', e => {
      if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key) || (['ArrowUp', 'ArrowDown'].includes(e.key) && !e.target.closest?.('input,select,textarea'))) markUser();
    });
    window.addEventListener('resize', () => this.updateMarker(false));
  }

  clear() {
    this.container.innerHTML = '';
    this.segments = [];
    this.current = -1;
    this.clearWord();
  }

  /**
   * @param chapter  chapitre stocké
   * @param opts.imageUrl  (block, index) => url à afficher pour l'image
   */
  render(chapter, { imageUrl, onNav, onIndexLink, knownIds, readTitle = true, estimateSeconds } = {}) {
    this.clear();
    const lang = (chapter.lang || 'fr').slice(0, 2);
    const article = el('article', { class: 'chapter', lang: chapter.lang || 'fr' });
    this.article = article;
    this.marker = el('div', { class: 'voice-marker', 'aria-hidden': 'true' }, [el('span'), el('span'), el('span'), el('span')]);
    article.append(this.marker);

    const addSegments = (parent, text, blockIndex) => {
      const ranges = splitSentences(text, lang);
      let pos = 0;
      ranges.forEach(r => {
        if (r.start > pos) parent.append(text.slice(pos, r.start));
        const raw = text.slice(r.start, r.end);
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        const core = raw.slice(lead.length, raw.length - trail.length);
        if (lead) parent.append(lead);
        const span = el('span', { class: 'seg', 'data-i': this.segments.length, text: core });
        parent.append(span);
        if (trail) parent.append(trail);
        this.segments.push({ el: span, text: core, block: blockIndex });
        pos = r.end;
      });
      if (pos < text.length) parent.append(text.slice(pos));
    };

    // En-tête
    const header = el('header', { class: 'chapter-head' });
    const site = el('div', { class: 'chapter-site' });
    if (chapter.url) {
      site.append(el('a', { href: chapter.url, target: '_blank', rel: 'noopener noreferrer', text: chapter.siteName || new URL(chapter.url).host }));
    } else site.textContent = chapter.siteName || '';
    header.append(site);
    const h1 = el('h1', { class: 'chapter-title', 'data-b': -1 });
    if (readTitle) addSegments(h1, chapter.title, -1);
    else h1.textContent = chapter.title;
    header.append(h1);
    const secs = estimateSeconds ? estimateSeconds() : (chapter.wordCount || 0) / 2.6;
    header.append(el('div', { class: 'chapter-meta', text: `${(chapter.wordCount || 0).toLocaleString('fr-FR')} mots · ≈ ${fmtDuration(secs)} d'écoute` }));
    header.append(this.navBar(chapter, onNav, 'top'));
    article.append(header);

    const body = el('div', { class: 'chapter-body' });
    chapter.blocks.forEach((b, i) => {
      if (b.type === 'p' || b.type === 'quote') {
        const p = el(b.type === 'quote' ? 'blockquote' : 'p', { 'data-b': i });
        addSegments(p, b.text, i);
        body.append(p);
      } else if (b.type === 'h') {
        const h = el('h' + (b.level || 2), { 'data-b': i });
        addSegments(h, b.text, i);
        body.append(h);
      } else if (b.type === 'hr') {
        body.append(el('div', { class: 'sep', 'data-b': i, 'aria-hidden': 'true' }, [el('span', { text: '◆' }), el('span', { text: '◇' }), el('span', { text: '◆' })]));
      } else if (b.type === 'img') {
        const src = imageUrl ? imageUrl(b, i) : b.src;
        const img = el('img', { src, alt: b.alt || '', loading: 'lazy', decoding: 'async', 'data-img': i });
        img.addEventListener('error', () => { if (img.src !== b.src) img.src = b.src; else img.closest('figure')?.classList.add('broken'); }, { once: false });
        img.addEventListener('click', () => this.dispatchEvent(new CustomEvent('imageclick', { detail: { src: img.src, alt: b.alt } })));
        const fig = el('figure', { 'data-b': i }, [img]);
        if (b.caption) fig.append(el('figcaption', { text: b.caption }));
        body.append(fig);
      }
    });
    article.append(body);

    // Sommaire détecté
    if (chapter.isIndex && chapter.index?.length) {
      const box = el('section', { class: 'toc-box' }, [
        el('h2', { text: 'Sommaire détecté' }),
        el('p', { class: 'muted', text: 'Cette page ressemble à une table des matières. Choisis un chapitre :' }),
      ]);
      const list = el('ol', { class: 'toc-list' });
      chapter.index.forEach(l => {
        const known = knownIds?.has?.(l.id);
        list.append(el('li', {}, [el('button', { type: 'button', class: 'toc-link' + (known ? ' known' : ''), onclick: () => onIndexLink?.(l.href) }, [
          el('span', { text: l.text }), known ? el('span', { class: 'badge', text: 'en mémoire' }) : null,
        ])]));
      });
      box.append(list);
      article.append(box);
    }

    // Fin du chapitre
    article.append(el('footer', { class: 'chapter-end' }, [
      el('div', { class: 'end-ornament', 'aria-hidden': 'true', text: '❖' }),
      el('p', { text: 'Fin du chapitre' }),
      this.navBar(chapter, onNav, 'bottom'),
    ]));

    this.container.append(article);

    // clic sur une phrase = lecture depuis cette phrase
    article.addEventListener('click', e => {
      const s = e.target.closest?.('.seg');
      if (!s || window.getSelection()?.toString()) return;
      this.dispatchEvent(new CustomEvent('seek', { detail: { index: +s.dataset.i } }));
    });
    return this.segments;
  }

  navBar(chapter, onNav, where) {
    const nav = chapter.nav || {};
    const bar = el('nav', { class: `chapter-nav ${where}` });
    const mk = (kind, label, icon) => el('button', {
      type: 'button', class: `btn ghost nav-${kind}`, disabled: !nav[kind],
      title: nav[kind] || 'Non trouvé sur la page',
      onclick: () => nav[kind] && onNav?.(kind, nav[kind]),
    }, [icon === 'l' ? el('span', { class: 'ico', text: '‹' }) : null, el('span', { text: label }), icon === 'r' ? el('span', { class: 'ico', text: '›' }) : null]);
    bar.append(mk('prev', 'Précédent', 'l'));
    if (nav.index) bar.append(mk('index', 'Sommaire'));
    bar.append(mk('next', 'Suivant', 'r'));
    return bar;
  }

  /** Met à jour les boutons de navigation après découverte tardive des liens. */
  updateNav(chapter, onNav) {
    this.container.querySelectorAll('.chapter-nav').forEach(old => {
      const where = old.classList.contains('top') ? 'top' : 'bottom';
      old.replaceWith(this.navBar(chapter, onNav, where));
    });
  }

  setImage(blockIndex, url) {
    const img = this.container.querySelector(`img[data-img="${blockIndex}"]`);
    if (img && url) img.src = url;
  }

  // ------- Suivi de lecture

  setCurrent(i, { scroll = true } = {}) {
    if (i === this.current) return;
    const prev = this.segments[this.current];
    if (prev) {
      prev.el.classList.remove('current');
      this.restoreSegText(prev);
    }
    this.clearWord();
    const seg = this.segments[i];
    this.current = i;
    if (!seg) return;
    // phrases déjà lues (utile en mode focus)
    this.container.querySelectorAll('.seg.read').forEach(s => { if (+s.dataset.i >= i) s.classList.remove('read'); });
    for (let k = Math.max(0, i - 400); k < i; k++) this.segments[k].el.classList.add('read');
    seg.el.classList.add('current');
    const blockEl = seg.el.closest('[data-b]');
    if (blockEl !== this.activeBlock) {
      this.activeBlock?.classList.remove('active');
      blockEl?.classList.add('active');
      this.activeBlock = blockEl;
    }
    this.updateMarker(scroll, seg.el.getBoundingClientRect());
  }

  clearWord() {
    if (hasHighlightAPI) this.hlWord.clear();
    this.wordRange = null;
  }

  restoreSegText(seg) {
    if (!hasHighlightAPI && seg.el.childElementCount) seg.el.textContent = seg.text;
  }

  setWord(i, charIndex, charLength) {
    if (i !== this.current) this.setCurrent(i);
    const seg = this.segments[i];
    if (!seg) return;
    const len = Math.max(1, Math.min(charLength || 1, seg.text.length - charIndex));
    if (charIndex < 0 || charIndex >= seg.text.length) return;
    let rect;
    if (hasHighlightAPI) {
      const node = seg.el.firstChild;
      if (!node || node.nodeType !== 3) return;
      const r = document.createRange();
      r.setStart(node, charIndex);
      r.setEnd(node, charIndex + len);
      this.hlWord.clear();
      this.hlWord.add(r);
      this.wordRange = r;
      rect = r.getBoundingClientRect();
    } else {
      const t = seg.text;
      seg.el.textContent = '';
      seg.el.append(t.slice(0, charIndex));
      const m = el('mark', { class: 'w', text: t.slice(charIndex, charIndex + len) });
      seg.el.append(m, t.slice(charIndex + len));
      rect = m.getBoundingClientRect();
    }
    this.updateMarker(true, rect);
  }

  /** Positionne le marqueur dans la marge, et fait défiler si la ligne a changé. */
  updateMarker(scroll, rect) {
    if (!this.marker || !this.article) return;
    const seg = this.segments[this.current];
    if (!seg) { this.marker.classList.remove('on'); return; }
    if (!rect || (!rect.height && !rect.width)) {
      rect = this.wordRange ? this.wordRange.getBoundingClientRect() : seg.el.getClientRects()[0] || seg.el.getBoundingClientRect();
    }
    const aRect = this.article.getBoundingClientRect();
    const top = rect.top - aRect.top;
    this.marker.style.transform = `translateY(${top + rect.height / 2}px)`;
    this.marker.classList.add('on');
    if (!scroll || !this.autoScroll) return;
    const lineTop = Math.round(rect.top + window.scrollY);
    if (this.lastLineTop !== null && Math.abs(lineTop - this.lastLineTop) < 4) return;
    this.lastLineTop = lineTop;
    this.followTo(rect);
  }

  isFollowing() { return performance.now() > this.userScrollUntil; }

  /** Défilement doux (animation maison, plus régulière que scroll-behavior:smooth). */
  followTo(rect, force = false) {
    if (!force && (!this.isFollowing() || this.detached)) {
      this.dispatchEvent(new CustomEvent('offscreen', { detail: { visible: rect.top > 0 && rect.bottom < window.innerHeight } }));
      return;
    }
    const target = Math.max(0, window.scrollY + rect.top - window.innerHeight * this.anchor);
    const startY = window.scrollY;
    const dist = target - startY;
    if (Math.abs(dist) < 3) return;
    if (this.scrollAnim) cancelAnimationFrame(this.scrollAnim);
    const dur = Math.min(900, 380 + Math.abs(dist) * 0.6);
    const t0 = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    const step = now => {
      const p = Math.min(1, (now - t0) / dur);
      window.scrollTo(0, startY + dist * ease(p));
      if (p < 1) this.scrollAnim = requestAnimationFrame(step);
      else this.scrollAnim = null;
    };
    this.scrollAnim = requestAnimationFrame(step);
  }

  /** Recentrer sur la voix (bouton « Suivre la voix »). */
  refocus() {
    this.userScrollUntil = 0;
    this.detached = false;
    this.lastLineTop = null;
    const seg = this.segments[this.current];
    if (!seg) return;
    const rect = this.wordRange ? this.wordRange.getBoundingClientRect() : seg.el.getBoundingClientRect();
    this.followTo(rect, true);
  }

  isCurrentVisible() {
    const seg = this.segments[this.current];
    if (!seg) return true;
    const r = seg.el.getBoundingClientRect();
    return r.bottom > 60 && r.top < window.innerHeight - 100;
  }

  setPlaying(on) {
    this.marker?.classList.toggle('playing', !!on);
    this.container.classList.toggle('is-playing', !!on);
  }

  /** Index de la première phrase visible à l'écran (pour démarrer la lecture là où on regarde). */
  firstVisibleSegment() {
    const limit = window.innerHeight * 0.15;
    for (const s of this.segments) {
      const r = s.el.getBoundingClientRect();
      if (r.bottom > limit) return +s.el.dataset.i;
    }
    return 0;
  }

  scrollToSegment(i, instant = false) {
    const seg = this.segments[i];
    if (!seg) return;
    const rect = seg.el.getBoundingClientRect();
    const target = Math.max(0, window.scrollY + rect.top - window.innerHeight * this.anchor);
    window.scrollTo({ top: target, behavior: instant ? 'auto' : 'smooth' });
  }
}

export { fmtDuration };
