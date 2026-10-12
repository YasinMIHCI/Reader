// Récap « Précédemment… » : résumé du chapitre précédent affiché en tête du chapitre.
// - gratuit : sélection automatique des phrases les plus importantes (surtout vers la fin)
// - option IA (clé OpenAI) : vrai résumé rédigé

import { scoreText } from './mood.js';
import { splitSentences } from './extractor.js';

const STOP_CAPS = new Set(['Le', 'La', 'Les', 'Un', 'Une', 'Des', 'Il', 'Elle', 'Ils', 'Elles', 'Je', 'Tu', 'Nous', 'Vous', 'On', 'Ce', 'Cette', 'Ces',
  'Mais', 'Et', 'Puis', 'Alors', 'Pourtant', 'Quand', 'Si', 'Dans', 'Sur', 'Avec', 'Pour', 'Par', 'En', 'Au', 'Aux', 'Du', 'De', 'Son', 'Sa', 'Ses',
  'Mon', 'Ma', 'Mes', 'Ton', 'Ta', 'Tes', 'Leur', 'Leurs', 'Oui', 'Non', 'Ah', 'Oh', 'Hein', 'Quoi', 'Pourquoi', 'Comment', 'Que', 'Qui', 'Rien',
  'Tout', 'Après', 'Avant', 'Pendant', 'Enfin', 'Ensuite', 'Soudain', 'The', 'And', 'He', 'She', 'It', 'They', 'But']);

/**
 * Résumé gratuit : les phrases les plus « porteuses » du chapitre, dans l'ordre du récit.
 * @returns {string[]}
 */
export function extractiveRecap(chapter, count = 5) {
  const lang = (chapter.lang || 'fr').slice(0, 2);
  const sents = [];
  const blocks = chapter.blocks.filter(b => b.text && (b.type === 'p' || b.type === 'quote'));
  blocks.forEach((b, bi) => {
    splitSentences(b.text, lang).forEach(r => {
      const t = b.text.slice(r.start, r.end).trim();
      if (t.length < 35 || t.length > 260) return;
      sents.push({ t, pos: bi / Math.max(1, blocks.length - 1), dialogue: /^[«“"—–-]|^\p{Lu}[\p{L}'’.-]*\s*:\s*[“«"]/u.test(t) });
    });
  });
  if (!sents.length) return [];
  // personnages / lieux récurrents : mots à majuscule hors début de phrase
  const freq = new Map();
  sents.forEach(s => {
    (s.t.slice(1).match(/\b\p{Lu}[\p{L}'’-]{2,}/gu) || []).forEach(w => { if (!STOP_CAPS.has(w)) freq.set(w, (freq.get(w) || 0) + 1); });
  });
  const scored = sents.map((s, i) => {
    const names = (s.t.match(/\b\p{Lu}[\p{L}'’-]{2,}/gu) || []).filter(w => freq.get(w) >= 2);
    const mood = scoreText(s.t).scores;
    const intensity = Math.max(mood.action, mood.triste, mood.tension, mood.effrayant, mood.epique, mood.romantique);
    let sc = names.length * 1.2 + Math.min(intensity, 3) * 0.8;
    sc += s.pos > 0.6 ? 2 : s.pos > 0.35 ? 0.8 : 0;   // ce qui s'est passé juste avant compte le plus
    if (s.dialogue) sc -= 0.8;                         // la narration résume mieux que les répliques
    if (/[?]$/.test(s.t)) sc -= 0.5;
    return { ...s, i, sc };
  });
  // dernière phrase narrative : le « cliffhanger »
  const last = [...scored].reverse().find(s => !s.dialogue);
  const top = scored.filter(s => s !== last).sort((a, b) => b.sc - a.sc).slice(0, count - (last ? 1 : 0));
  if (last) top.push(last);
  // évite deux phrases quasi identiques et garde l'ordre du récit
  return top.sort((a, b) => a.i - b.i).map(s => s.t);
}

/** Résumé rédigé par l'IA (clé OpenAI). */
export async function aiRecap(chapter, key) {
  const text = chapter.blocks.filter(b => b.text).map(b => b.text).join('\n');
  // début + (surtout) fin du chapitre pour limiter le coût
  const sample = text.length > 16000 ? `${text.slice(0, 4000)}\n[…]\n${text.slice(-12000)}` : text;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      max_tokens: 350,
      messages: [
        { role: 'system', content: 'Tu écris des récapitulatifs « Précédemment… » pour un lecteur de romans. Réponds en français, au passé, en 4 à 6 phrases courtes sous forme de puces (« - »). Concentre-toi sur les événements importants et la fin du chapitre. Pas de citation longue, pas d\'introduction.' },
        { role: 'user', content: `Chapitre : ${chapter.title}\n\n${sample}` },
      ],
    }),
  });
  if (!res.ok) {
    let msg = `OpenAI : erreur ${res.status}`;
    try { msg = `OpenAI : ${(await res.json()).error?.message || msg}`; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '')
    .split('\n').map(l => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
}
