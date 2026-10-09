// Proxy CORS personnel pour Re:Lecteur — à déployer gratuitement sur Cloudflare Workers.
//
// 1. Va sur https://dash.cloudflare.com → Workers & Pages → Create → Worker
// 2. Remplace le code par ce fichier, puis « Deploy »
// 3. Copie l'adresse (ex. https://relecteur-proxy.ton-nom.workers.dev)
// 4. Dans Re:Lecteur → Réglages → Avancé → Proxy personnel, colle :
//      https://relecteur-proxy.ton-nom.workers.dev/?url={url}
//
// Optionnel : limite l'utilisation à ton site en remplaçant ALLOWED_ORIGINS.

const ALLOWED_ORIGINS = ['*']; // ex. ['https://yasinmihci.github.io']
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes('*') ? '*' : (ALLOWED_ORIGINS.includes(origin) ? origin : 'null');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (request.method !== 'GET') return new Response('Méthode non autorisée', { status: 405, headers: cors(origin) });
    if (!ALLOWED_ORIGINS.includes('*') && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Origine non autorisée', { status: 403, headers: cors(origin) });
    }

    const target = new URL(request.url).searchParams.get('url');
    let url;
    try { url = new URL(target); } catch { return new Response('Paramètre ?url= manquant ou invalide', { status: 400, headers: cors(origin) }); }
    if (!/^https?:$/.test(url.protocol)) return new Response('Protocole refusé', { status: 400, headers: cors(origin) });

    const upstream = await fetch(url.href, {
      headers: {
        'User-Agent': UA,
        Accept: request.headers.get('Accept') || 'text/html,application/xhtml+xml,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7',
        Referer: url.origin + '/',
      },
      redirect: 'follow',
      cf: { cacheTtl: 3600, cacheEverything: true },
    });

    const headers = new Headers(cors(origin));
    const type = upstream.headers.get('Content-Type');
    if (type) headers.set('Content-Type', type);
    headers.set('Cache-Control', 'public, max-age=3600');
    headers.set('X-Final-Url', upstream.url);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
