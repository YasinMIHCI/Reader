// Intro animée de 5 secondes (canvas 2D, aucune dépendance).
// Storyboard :
//  0.0 – 0.9 s  une horloge d'argent se dessine dans la nuit, runes en rotation
//  0.9 – 2.3 s  les aiguilles s'emballent à rebours, des ombres violettes rampent depuis les bords
//  2.3 – 2.6 s  battement de cœur, flash cramoisi : l'horloge vole en éclats (le temps est remonté)
//  2.6 – 4.3 s  givre et cristaux, cercle magique, apparition du titre « Re:Lecteur »
//  4.3 – 5.0 s  zoom et fondu vers l'application

const DURATION = 5000;
const TAU = Math.PI * 2;

const C = {
  night: '#07040f',
  violet: '#7b3fe4',
  lavender: '#c9a8ff',
  silver: '#ece9f5',
  ice: '#a8e8ff',
  crimson: '#ff2d5f',
  gold: '#e3c07a',
  miasma: '#2a0b45',
};

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp((t - a) / (b - a));
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeIn = t => t * t * t;
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = t => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const ROMAN = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];

/** Génère un glyphe "runique" original (segments aléatoires dans une grille 3x3). */
function makeGlyphs(rand, n) {
  const glyphs = [];
  for (let i = 0; i < n; i++) {
    const strokes = [];
    const k = 2 + Math.floor(rand() * 3);
    for (let j = 0; j < k; j++) {
      const a = [Math.floor(rand() * 3), Math.floor(rand() * 3)];
      let b = [Math.floor(rand() * 3), Math.floor(rand() * 3)];
      if (a[0] === b[0] && a[1] === b[1]) b = [(a[0] + 1) % 3, a[1]];
      strokes.push([a, b]);
    }
    if (rand() > 0.6) strokes.push(['dot', [Math.floor(rand() * 3), Math.floor(rand() * 3)]]);
    glyphs.push(strokes);
  }
  return glyphs;
}

function drawGlyph(ctx, g, size) {
  const u = size / 2;
  ctx.beginPath();
  g.forEach(s => {
    if (s[0] === 'dot') {
      ctx.moveTo((s[1][0] - 1) * u + 1.2, (s[1][1] - 1) * u);
      ctx.arc((s[1][0] - 1) * u, (s[1][1] - 1) * u, 1.2, 0, TAU);
    } else {
      ctx.moveTo((s[0][0] - 1) * u, (s[0][1] - 1) * u);
      ctx.lineTo((s[1][0] - 1) * u, (s[1][1] - 1) * u);
    }
  });
  ctx.stroke();
}

function drawSnowflake(ctx, r, rand) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const ca = Math.cos(a); const sa = Math.sin(a);
    ctx.moveTo(0, 0);
    ctx.lineTo(ca * r, sa * r);
    const b1 = r * 0.55; const bl = r * 0.32;
    for (const side of [-1, 1]) {
      const ba = a + side * 0.7;
      ctx.moveTo(ca * b1, sa * b1);
      ctx.lineTo(ca * b1 + Math.cos(ba) * bl, sa * b1 + Math.sin(ba) * bl);
    }
    if (rand > 0.5) {
      const b2 = r * 0.8; const bl2 = r * 0.18;
      for (const side of [-1, 1]) {
        const ba = a + side * 0.8;
        ctx.moveTo(ca * b2, sa * b2);
        ctx.lineTo(ca * b2 + Math.cos(ba) * bl2, sa * b2 + Math.sin(ba) * bl2);
      }
    }
  }
  ctx.stroke();
}

export function playIntro({ container, onDone, reducedMotion = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'intro';
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', 'Animation d\'introduction : Re:Lecteur');
  const canvas = document.createElement('canvas');
  const skip = document.createElement('button');
  skip.className = 'intro-skip';
  skip.type = 'button';
  skip.textContent = 'Passer ›';
  wrap.append(canvas, skip);
  (container || document.body).appendChild(wrap);
  const ctx = canvas.getContext('2d');

  let W = 0; let H = 0; let dpr = 1; let R = 100;
  const clockCv = document.createElement('canvas');
  const cctx = clockCv.getContext('2d');

  const rand = rng(20160404);
  const glyphs = makeGlyphs(rand, 36);

  // Étoiles
  const stars = Array.from({ length: 160 }, () => ({ x: rand(), y: rand(), r: rand() * 1.3 + 0.2, tw: rand() * TAU, sp: 0.5 + rand() * 2 }));
  // Ombres rampantes (tentacules) depuis les bords
  const tendrils = Array.from({ length: 14 }, (_, i) => {
    const side = i % 4;
    return { side, pos: rand(), len: 0.45 + rand() * 0.35, w: 10 + rand() * 26, ph: rand() * TAU, freq: 1.5 + rand() * 2, delay: rand() * 0.35 };
  });
  // Flocons / cristaux
  const flakes = Array.from({ length: 70 }, () => ({ x: rand(), y: rand() * 1.2 - 0.2, r: 2 + rand() * 9, vy: 0.03 + rand() * 0.08, vx: (rand() - 0.5) * 0.04, rot: rand() * TAU, vr: (rand() - 0.5) * 1.2, kind: rand(), tw: rand() * TAU }));
  // Éclats de l'horloge (générés au moment de la rupture)
  let shards = null;
  let snapshot = null;
  // Étincelles
  const sparks = Array.from({ length: 90 }, () => ({ a: rand() * TAU, v: 0.4 + rand() * 1.4, r: 0.6 + rand() * 1.8, life: 0.5 + rand() * 0.8, hue: rand() }));

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    R = Math.min(W, H) * 0.27;
    clockCv.width = Math.ceil(R * 2.4 * dpr); clockCv.height = clockCv.width;
  }
  resize();
  window.addEventListener('resize', resize);

  let titleFontReady = false;
  try {
    Promise.race([
      document.fonts?.load('700 64px "Cinzel"'),
      new Promise(r => setTimeout(r, 400)),
    ]).then(() => { titleFontReady = true; });
  } catch { titleFontReady = true; }

  // ----- Horloge (dessinée dans un canvas hors-écran pour pouvoir la briser)
  function drawClock(t) {
    const s = clockCv.width;
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, s, s);
    cctx.setTransform(dpr, 0, 0, dpr, s / 2, s / 2);
    const draw = easeOut(seg(t, 0.1, 0.9));
    const glow = 0.5 + 0.5 * Math.sin(t * 6);

    // anneau extérieur qui se trace
    cctx.lineCap = 'round';
    cctx.shadowColor = C.lavender; cctx.shadowBlur = 18;
    cctx.strokeStyle = C.silver; cctx.lineWidth = 2.2;
    cctx.beginPath(); cctx.arc(0, 0, R, -Math.PI / 2, -Math.PI / 2 + TAU * draw); cctx.stroke();
    cctx.lineWidth = 1; cctx.globalAlpha = 0.6;
    cctx.beginPath(); cctx.arc(0, 0, R * 0.93, Math.PI / 2, Math.PI / 2 - TAU * draw, true); cctx.stroke();
    cctx.globalAlpha = 1;

    // anneau de runes en rotation (sens inverse)
    const runeA = seg(t, 0.35, 1.0);
    if (runeA > 0) {
      cctx.save();
      cctx.rotate(-t * 0.6);
      cctx.strokeStyle = C.lavender; cctx.lineWidth = 1.1; cctx.shadowBlur = 10;
      cctx.globalAlpha = runeA * 0.85;
      const n = glyphs.length;
      for (let i = 0; i < n; i++) {
        cctx.save();
        cctx.rotate((i / n) * TAU);
        cctx.translate(0, -R * 0.83);
        drawGlyph(cctx, glyphs[i], R * 0.06);
        cctx.restore();
      }
      cctx.restore();
      cctx.globalAlpha = 1;
    }

    // graduations
    const ticks = seg(t, 0.3, 0.9);
    for (let i = 0; i < 60; i++) {
      const p = clamp(ticks * 60 - i);
      if (p <= 0) continue;
      const major = i % 5 === 0;
      const a = (i / 60) * TAU - Math.PI / 2;
      const r1 = R * (major ? 0.62 : 0.66); const r2 = R * 0.7;
      cctx.globalAlpha = p;
      cctx.strokeStyle = major ? C.gold : C.silver;
      cctx.lineWidth = major ? 2.4 : 1;
      cctx.beginPath();
      cctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      cctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      cctx.stroke();
    }
    cctx.globalAlpha = 1;

    // chiffres romains
    const num = seg(t, 0.5, 1.1);
    if (num > 0) {
      cctx.fillStyle = C.silver;
      cctx.shadowBlur = 8;
      cctx.font = `600 ${Math.round(R * 0.1)}px ${titleFontReady ? '"Cinzel", ' : ''}Georgia, serif`;
      cctx.textAlign = 'center'; cctx.textBaseline = 'middle';
      for (let i = 0; i < 12; i++) {
        const p = clamp(num * 12 - i);
        if (p <= 0) continue;
        const a = (i / 12) * TAU - Math.PI / 2;
        cctx.globalAlpha = p;
        cctx.fillText(ROMAN[i], Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5);
      }
      cctx.globalAlpha = 1;
    }

    // aiguilles : 10h10 puis rotation à rebours qui accélère
    const spin = easeIn(seg(t, 0.9, 2.3));
    const minuteA = (10 / 60) * TAU - spin * TAU * 9;
    const hourA = (10 / 12) * TAU - spin * TAU * 1.6;
    const handsA = seg(t, 0.55, 0.9);
    if (handsA > 0) {
      cctx.globalAlpha = handsA;
      // traînée de flou de mouvement
      const trails = spin > 0.05 ? 7 : 1;
      for (let k = trails - 1; k >= 0; k--) {
        const lag = k * 0.045 * spin;
        const ma = minuteA + lag * TAU * 3;
        const ha = hourA + lag * TAU * 0.5;
        cctx.globalAlpha = handsA * (k === 0 ? 1 : 0.18 * (1 - k / trails));
        cctx.strokeStyle = C.gold; cctx.shadowColor = C.gold; cctx.shadowBlur = 12;
        cctx.lineWidth = 4;
        cctx.beginPath(); cctx.moveTo(0, 0); cctx.lineTo(Math.sin(ha) * R * 0.38, -Math.cos(ha) * R * 0.38); cctx.stroke();
        cctx.strokeStyle = C.silver; cctx.lineWidth = 2.2;
        cctx.beginPath(); cctx.moveTo(-Math.sin(ma) * R * 0.1, Math.cos(ma) * R * 0.1); cctx.lineTo(Math.sin(ma) * R * 0.6, -Math.cos(ma) * R * 0.6); cctx.stroke();
      }
      cctx.globalAlpha = handsA;
      cctx.fillStyle = C.crimson; cctx.shadowColor = C.crimson; cctx.shadowBlur = 14 + glow * 10;
      cctx.beginPath(); cctx.arc(0, 0, R * 0.035, 0, TAU); cctx.fill();
      cctx.globalAlpha = 1;
    }

    // fissures juste avant la rupture
    const crack = seg(t, 2.15, 2.42);
    if (crack > 0) {
      cctx.strokeStyle = '#fff'; cctx.shadowColor = C.crimson; cctx.shadowBlur = 16; cctx.lineWidth = 1.4;
      const cr = rng(7);
      for (let i = 0; i < 9; i++) {
        let a = cr() * TAU; let r = 0; let x = 0; let y = 0;
        cctx.beginPath(); cctx.moveTo(0, 0);
        while (r < R * crack) {
          r += R * (0.08 + cr() * 0.1);
          a += (cr() - 0.5) * 0.6;
          x = Math.cos(a) * r; y = Math.sin(a) * r;
          cctx.lineTo(x, y);
        }
        cctx.stroke();
      }
    }
    cctx.shadowBlur = 0;
  }

  function makeShards() {
    const sr = rng(99);
    const out = [];
    const rings = [0, 0.38, 0.72, 1.12];
    for (let ri = 0; ri < rings.length - 1; ri++) {
      const n = 6 + ri * 5;
      let a0 = sr() * TAU;
      const cuts = [];
      for (let i = 0; i < n; i++) cuts.push(a0 + (i / n) * TAU + (sr() - 0.5) * (TAU / n) * 0.5);
      for (let i = 0; i < n; i++) {
        const aA = cuts[i]; const aB = cuts[(i + 1) % n] + (i === n - 1 ? TAU : 0);
        const r0 = rings[ri] * R; const r1 = rings[ri + 1] * R;
        const pts = [];
        const steps = 3;
        for (let k = 0; k <= steps; k++) { const a = lerp(aA, aB, k / steps); pts.push([Math.cos(a) * r1, Math.sin(a) * r1]); }
        if (r0 < 1) pts.push([0, 0]);
        else for (let k = steps; k >= 0; k--) { const a = lerp(aA, aB, k / steps); pts.push([Math.cos(a) * r0, Math.sin(a) * r0]); }
        const mid = (aA + aB) / 2; const mr = (r0 + r1) / 2;
        out.push({
          pts, cx: Math.cos(mid) * mr, cy: Math.sin(mid) * mr,
          vx: Math.cos(mid) * (0.6 + sr() * 1.2), vy: Math.sin(mid) * (0.6 + sr() * 1.2) - 0.2,
          vr: (sr() - 0.5) * 6, delay: sr() * 0.06,
        });
      }
    }
    return out;
  }

  function drawBackground(t) {
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
    const calm = seg(t, 2.5, 3.2);
    g.addColorStop(0, calm > 0 ? `rgba(${Math.round(lerp(40, 22, calm))},${Math.round(lerp(14, 30, calm))},${Math.round(lerp(70, 64, calm))},1)` : '#28104a');
    g.addColorStop(0.55, '#0e0620');
    g.addColorStop(1, C.night);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // étoiles
    stars.forEach(s => {
      const a = (0.35 + 0.65 * Math.abs(Math.sin(s.tw + t * s.sp))) * seg(t, 0, 0.6);
      ctx.globalAlpha = a;
      ctx.fillStyle = s.r > 1.1 ? C.lavender : C.silver;
      ctx.beginPath(); ctx.arc(s.x * W, s.y * H + t * 4 * s.r, s.r, 0, TAU); ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawTendrils(t) {
    const grow = easeInOut(seg(t, 0.8, 2.35));
    const recede = easeIn(seg(t, 2.35, 2.75));
    const amt = grow * (1 - recede);
    if (amt <= 0) return;
    ctx.save();
    ctx.lineCap = 'round';
    tendrils.forEach(td => {
      const p = clamp((amt - td.delay) / (1 - td.delay));
      if (p <= 0) return;
      let x0, y0, dx, dy;
      if (td.side === 0) { x0 = td.pos * W; y0 = -20; dx = 0; dy = 1; }
      else if (td.side === 1) { x0 = W + 20; y0 = td.pos * H; dx = -1; dy = 0; }
      else if (td.side === 2) { x0 = td.pos * W; y0 = H + 20; dx = 0; dy = -1; }
      else { x0 = -20; y0 = td.pos * H; dx = 1; dy = 0; }
      // direction vers le centre
      const cx = W / 2 - x0; const cy = H / 2 - y0; const cl = Math.hypot(cx, cy);
      dx = lerp(dx, cx / cl, 0.6); dy = lerp(dy, cy / cl, 0.6);
      const L = Math.min(W, H) * td.len * p;
      const n = 22;
      const nx = -dy; const ny = dx;
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const f = i / n;
          const wob = Math.sin(f * td.freq * 4 + t * 5 + td.ph) * 18 * f;
          const x = x0 + dx * L * f + nx * wob;
          const y = y0 + dy * L * f + ny * wob;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        if (pass === 0) {
          ctx.strokeStyle = 'rgba(123,63,228,0.35)';
          ctx.shadowColor = C.violet; ctx.shadowBlur = 30;
          ctx.lineWidth = td.w * 1.4;
        } else {
          ctx.strokeStyle = 'rgba(14,4,26,0.95)';
          ctx.shadowBlur = 0;
          ctx.lineWidth = td.w;
        }
        ctx.stroke();
      }
      // pointe en forme de main ouverte stylisée (trois "doigts")
      const tipF = 1;
      const wob = Math.sin(tipF * td.freq * 4 + t * 5 + td.ph) * 18;
      const tx = x0 + dx * L + nx * wob; const ty = y0 + dy * L + ny * wob;
      ctx.strokeStyle = 'rgba(14,4,26,0.95)'; ctx.lineWidth = td.w * 0.35;
      for (let k = -1; k <= 1; k++) {
        const a = Math.atan2(dy, dx) + k * 0.45 + Math.sin(t * 7 + td.ph + k) * 0.15;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + Math.cos(a) * td.w * 1.2, ty + Math.sin(a) * td.w * 1.2); ctx.stroke();
      }
    });
    // vignette sombre qui se resserre
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * lerp(0.7, 0.25, amt), W / 2, H / 2, Math.max(W, H) * 0.8);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, `rgba(8,0,16,${0.85 * amt})`);
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawClockLayer(t) {
    if (t < 2.45) {
      drawClock(t);
      const pulse = t > 2.0 ? 1 + Math.sin(seg(t, 2.0, 2.45) * Math.PI * 3) * 0.02 : 1;
      const s = clockCv.width / dpr;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(pulse, pulse);
      ctx.drawImage(clockCv, -s / 2, -s / 2, s, s);
      ctx.restore();
    } else {
      if (!shards) { shards = makeShards(); snapshot = clockCv; }
      const p = seg(t, 2.45, 3.9);
      const s = clockCv.width / dpr;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      shards.forEach(sh => {
        const q = easeOut(clamp((p - sh.delay) / (1 - sh.delay)));
        const dist = q * Math.max(W, H) * 0.42;
        ctx.save();
        ctx.globalAlpha = 1 - easeIn(p);
        ctx.translate(sh.cx + sh.vx * dist, sh.cy + sh.vy * dist + q * q * 80);
        ctx.rotate(sh.vr * q);
        ctx.translate(-sh.cx, -sh.cy);
        ctx.beginPath();
        sh.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.save();
        ctx.clip();
        ctx.fillStyle = 'rgba(40,16,80,0.35)';
        ctx.fill();
        ctx.drawImage(snapshot, -s / 2, -s / 2, s, s);
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 1;
        ctx.shadowColor = C.ice; ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.restore();
      });
      ctx.restore();
    }
  }

  function drawFlash(t) {
    // battement de cœur rouge
    const beat = seg(t, 2.25, 2.45);
    if (beat > 0 && beat < 1) {
      const r = easeOut(beat) * Math.max(W, H);
      ctx.save();
      ctx.strokeStyle = C.crimson; ctx.globalAlpha = 1 - beat; ctx.lineWidth = 30 * (1 - beat) + 2;
      ctx.shadowColor = C.crimson; ctx.shadowBlur = 40;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, r * 0.6, 0, TAU); ctx.stroke();
      ctx.restore();
    }
    const f = seg(t, 2.42, 2.75);
    if (f > 0 && f < 1) {
      ctx.save();
      ctx.globalAlpha = Math.pow(1 - f, 2);
      ctx.fillStyle = f < 0.15 ? '#fff' : C.lavender;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    // étincelles de la rupture
    const sp = seg(t, 2.45, 3.6);
    if (sp > 0 && sp < 1) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      sparks.forEach(s => {
        const life = clamp(sp / s.life);
        if (life >= 1) return;
        const d = easeOut(life) * Math.max(W, H) * 0.5 * s.v;
        ctx.globalAlpha = 1 - life;
        ctx.fillStyle = s.hue > 0.5 ? C.ice : C.lavender;
        ctx.beginPath(); ctx.arc(W / 2 + Math.cos(s.a) * d, H / 2 + Math.sin(s.a) * d, s.r * (1.5 - life), 0, TAU); ctx.fill();
      });
      ctx.restore();
    }
  }

  function drawMagicCircle(t) {
    const p = easeOut(seg(t, 2.65, 3.6));
    if (p <= 0) return;
    const r = Math.min(W, H) * 0.36;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(t * 0.25);
    ctx.globalAlpha = 0.55 * p * (1 - seg(t, 4.4, 5));
    ctx.strokeStyle = C.ice; ctx.shadowColor = C.ice; ctx.shadowBlur = 14; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU * p); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.86, 0, -TAU * p, true); ctx.stroke();
    // hexagramme
    const tri = off => {
      ctx.beginPath();
      for (let i = 0; i <= 3; i++) {
        const a = off + (i / 3) * TAU - Math.PI / 2;
        const pp = Math.min(1, p * 1.2);
        const x = Math.cos(a) * r * 0.86 * pp; const y = Math.sin(a) * r * 0.86 * pp;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    tri(0); tri(Math.PI / 3);
    // runes sur l'anneau
    ctx.strokeStyle = C.lavender; ctx.lineWidth = 1;
    const n = 24;
    for (let i = 0; i < Math.floor(n * p); i++) {
      ctx.save();
      ctx.rotate((i / n) * TAU);
      ctx.translate(0, -r * 0.93);
      drawGlyph(ctx, glyphs[i % glyphs.length], r * 0.045);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawFlakes(t, dt) {
    const a = seg(t, 2.5, 3.0) * (1 - seg(t, 4.5, 5));
    if (a <= 0) return;
    ctx.save();
    ctx.lineCap = 'round';
    flakes.forEach(f => {
      f.y += f.vy * dt; f.x += f.vx * dt + Math.sin(t * 2 + f.tw) * 0.0006; f.rot += f.vr * dt;
      if (f.y > 1.05) f.y = -0.05;
      const tw = 0.55 + 0.45 * Math.sin(t * 4 + f.tw);
      ctx.save();
      ctx.translate(f.x * W, f.y * H);
      ctx.rotate(f.rot);
      ctx.globalAlpha = a * tw * (f.r > 6 ? 0.9 : 0.6);
      ctx.strokeStyle = f.kind > 0.4 ? C.ice : C.silver;
      ctx.shadowColor = C.ice; ctx.shadowBlur = 8;
      ctx.lineWidth = f.r > 6 ? 1.3 : 1;
      if (f.r > 4.5) drawSnowflake(ctx, f.r, f.kind);
      else { ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(0, 0, f.r * 0.35, 0, TAU); ctx.fill(); }
      ctx.restore();
    });
    ctx.restore();
  }

  function drawTitle(t) {
    const appear = seg(t, 2.75, 3.7);
    if (appear <= 0) return;
    const out = seg(t, 4.35, 5);
    const size = Math.max(36, Math.min(W * 0.11, 110));
    const font = `700 ${size}px ${titleFontReady ? '"Cinzel", ' : ''}Georgia, "Times New Roman", serif`;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = font;
    const parts = [{ s: 'Re', c: 'violet' }, { s: ':', c: 'crimson' }, { s: 'Lecteur', c: 'silver' }];
    const letters = [];
    parts.forEach(p => [...p.s].forEach(ch => letters.push({ ch, c: p.c })));
    const widths = letters.map(l => ctx.measureText(l.ch).width);
    const spacing = size * 0.04;
    const total = widths.reduce((a, b) => a + b, 0) + spacing * (letters.length - 1);
    let x = W / 2 - total / 2;
    const y = H / 2 - size * 0.12;
    letters.forEach((l, i) => {
      const lp = easeOutBack(clamp(appear * 1.6 - i * 0.07));
      if (lp <= 0) { x += widths[i] + spacing; return; }
      const glitch = (t > 2.75 && t < 3.05) ? (Math.random() - 0.5) * 10 * (1 - seg(t, 2.75, 3.05)) : 0;
      const yy = y + (1 - lp) * size * 0.5;
      ctx.globalAlpha = clamp(lp) * (1 - out);
      // aberration chromatique à l'apparition
      if (lp < 1) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(255,45,95,0.6)'; ctx.fillText(l.ch, x - 3 + glitch, yy);
        ctx.fillStyle = 'rgba(120,220,255,0.6)'; ctx.fillText(l.ch, x + 3 - glitch, yy);
        ctx.globalCompositeOperation = 'source-over';
      }
      let fill;
      if (l.c === 'violet') {
        fill = ctx.createLinearGradient(x, yy - size / 2, x, yy + size / 2);
        fill.addColorStop(0, '#e2c9ff'); fill.addColorStop(1, C.violet);
      } else if (l.c === 'crimson') fill = C.crimson;
      else {
        fill = ctx.createLinearGradient(x, yy - size / 2, x, yy + size / 2);
        fill.addColorStop(0, '#ffffff'); fill.addColorStop(1, '#b9b3d6');
      }
      ctx.shadowColor = l.c === 'crimson' ? C.crimson : C.lavender;
      ctx.shadowBlur = 24;
      ctx.fillStyle = fill;
      ctx.fillText(l.ch, x + glitch * 0.3, yy);
      x += widths[i] + spacing;
    });
    ctx.shadowBlur = 0;

    // trait décoratif qui se dessine
    const line = easeInOut(seg(t, 3.3, 4.0));
    if (line > 0) {
      const lw = total * 0.9 * line;
      const ly = y + size * 0.62;
      ctx.globalAlpha = 1 - out;
      const lg = ctx.createLinearGradient(W / 2 - lw / 2, 0, W / 2 + lw / 2, 0);
      lg.addColorStop(0, 'rgba(168,232,255,0)'); lg.addColorStop(0.5, C.ice); lg.addColorStop(1, 'rgba(168,232,255,0)');
      ctx.strokeStyle = lg; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(W / 2 - lw / 2, ly); ctx.lineTo(W / 2 + lw / 2, ly); ctx.stroke();
      // losange central
      ctx.fillStyle = C.ice; ctx.shadowColor = C.ice; ctx.shadowBlur = 12;
      ctx.save(); ctx.translate(W / 2, ly); ctx.rotate(Math.PI / 4);
      const d = 5 * line; ctx.fillRect(-d / 2, -d / 2, d, d); ctx.restore();
    }

    // sous-titre
    const sub = seg(t, 3.45, 4.1);
    if (sub > 0) {
      const ss = Math.max(11, Math.min(W * 0.026, 19));
      ctx.font = `500 ${ss}px ${titleFontReady ? '"Cinzel", ' : ''}Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.globalAlpha = sub * (1 - out);
      ctx.fillStyle = C.lavender;
      ctx.shadowColor = C.violet; ctx.shadowBlur = 10;
      const text = W < 520 ? 'Commencer une nouvelle lecture' : 'Commencer une nouvelle lecture dans un autre monde';
      const spaced = [...text].join(' ');
      ctx.fillText(spaced, W / 2, y + size * 0.62 + ss * 1.8 + (1 - easeOut(sub)) * 10);
      if (W < 520) ctx.fillText('dans un autre monde'.split('').join(' '), W / 2, y + size * 0.62 + ss * 3.4 + (1 - easeOut(sub)) * 10);
    }
    ctx.restore();
  }

  let start = null;
  let last = null;
  let raf = 0;
  let finished = false;
  const total = reducedMotion ? 1600 : DURATION;

  function frame(now) {
    if (finished) return;
    if (start === null) { start = now; last = now; }
    const ms = now - start;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // en mouvement réduit : on montre directement la scène finale
    const t = reducedMotion ? 3.9 + (ms / total) * 1.1 : ms / 1000;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // petite secousse au moment du battement
    const shake = t > 2.3 && t < 2.6 ? (1 - seg(t, 2.3, 2.6)) * 9 : 0;
    ctx.save();
    if (shake) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    // zoom final
    const z = 1 + easeIn(seg(t, 4.3, 5)) * 0.18;
    ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2);

    drawBackground(t);
    drawMagicCircle(t);
    drawTendrils(t);
    if (!reducedMotion) drawClockLayer(t);
    drawFlakes(t, dt);
    drawTitle(t);
    drawFlash(t);
    ctx.restore();

    if (ms >= total) { finish(); return; }
    raf = requestAnimationFrame(frame);
  }

  function finish() {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKey);
    wrap.classList.add('intro-out');
    onDone?.();
    setTimeout(() => wrap.remove(), 700);
  }

  const onKey = e => { if (['Escape', 'Enter', ' '].includes(e.key)) { e.preventDefault(); finish(); } };
  skip.addEventListener('click', e => { e.stopPropagation(); finish(); });
  wrap.addEventListener('click', finish);
  window.addEventListener('keydown', onKey);
  raf = requestAnimationFrame(frame);

  return { skip: finish };
}
