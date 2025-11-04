// api/search.js — Vercel Serverless (Node 18+)

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

// Padrões
const DEFAULT_MIN_VIEWS = 100_000;
const DEFAULT_MAX_SUBS = 50_000;
const DEFAULT_MIN_DURATION_SEC = 8 * 60; // 8 min
const DEFAULT_DAYS = 30;
const MAX_PAGES = 2; // limite por duração/termo (para não estourar timeout do plano free)

// Durações que queremos na busca (evita Shorts já no search)
const DURATIONS = ['medium', 'long']; // medium=4–20min, long=20+

// Idiomas permitidos por padrão (2 letras)
const DEFAULT_ALLOWED_LANGS = [
  'en','es','fr','de','pt','it','ru','ja','ko','nl','pl','el','ro','da','no','ga'
];

// Mapeia país do canal -> idioma (aproximação)
const COUNTRY_TO_LANG = {
  US:'en', GB:'en', AU:'en', NZ:'en', IE:'en', IN:'en',
  BR:'pt', PT:'pt',
  ES:'es', MX:'es', AR:'es', CO:'es', CL:'es', PE:'es', VE:'es', UY:'es',
  EC:'es', BO:'es', CR:'es', DO:'es', GT:'es', HN:'es', NI:'es', PA:'es', PR:'es', SV:'es', PY:'es',
  FR:'fr', BE:'fr', LU:'fr', CH:'fr',
  DE:'de', AT:'de',
  IT:'it', SM:'it', VA:'it',
  RU:'ru', BY:'ru', KZ:'ru',
  JP:'ja',
  KR:'ko',
  NL:'nl',
  PL:'pl',
  GR:'el',
  RO:'ro', MD:'ro',
  DK:'da',
  NO:'no'
};

// Sleep simples
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Helpers
const normalizeLang = (code) => (code || '').toLowerCase().split('-')[0] || null;

const isoXDaysAgo = (days) => {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
};

function parseISODuration(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}

function pickThumb(thumbnails) {
  return thumbnails?.maxres || thumbnails?.standard || thumbnails?.high || thumbnails?.medium || thumbnails?.default || null;
}

// Coleta IDs por termo, duração e páginas
async function collectVideoIds(terms, apiKey, publishedAfter, pages) {
  const ids = new Set();

  for (const term of terms) {
    for (const duration of DURATIONS) {
      let pageToken = '';
      for (let page = 0; page < pages; page++) {
        const params = new URLSearchParams({
          key: apiKey,
          part: 'snippet',
          q: term,
          type: 'video',
          order: 'viewCount',
          maxResults: '50',
          publishedAfter,
          videoDuration: duration
        });
        if (pageToken) params.set('pageToken', pageToken);

        const url = `${YT_API_BASE}/search?${params.toString()}`;
        const r = await fetch(url);
        if (!r.ok) {
          const t = await r.text();
          throw new Error(`Erro search.list: ${r.status} ${t}`);
        }
        const data = await r.json();

        for (const item of (data.items || [])) {
          if (item?.id?.videoId) ids.add(item.id.videoId);
        }

        pageToken = data.nextPageToken || '';
        if (!pageToken) break;
        await sleep(60);
      }
    }
  }

  return Array.from(ids);
}

module.exports = async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(204).end();

    const apiKey = process.env.YT_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'YT_API_KEY não configurada.' });

    const qRaw = (req.query.q || '').trim();
    if (!qRaw) {
      return res.status(400).json({ error: 'Use ?q=palavras (ex: q=marketing,instagram)' });
    }

    // Parâmetros dinâmicos
    const minViews = Math.max(0, parseInt(req.query.minViews || DEFAULT_MIN_VIEWS, 10) || DEFAULT_MIN_VIEWS);
    const maxSubs = Math.max(0, parseInt(req.query.maxSubs || DEFAULT_MAX_SUBS, 10) || DEFAULT_MAX_SUBS);
    const minDurationSec = Math.max(0, parseInt(req.query.minDurationSec || DEFAULT_MIN_DURATION_SEC, 10) || DEFAULT_MIN_DURATION_SEC);
    const days = Math.max(1, parseInt(req.query.days || DEFAULT_DAYS, 10) || DEFAULT_DAYS);
    let pages = Math.max(1, parseInt(req.query.pages || '1', 10) || 1);
    pages = Math.min(pages, MAX_PAGES);

    const langsParam = (req.query.langs || '').trim();
    const allowedLangs = (langsParam
      ? langsParam.split(',').map(s => normalizeLang(s)).filter(Boolean)
      : DEFAULT_ALLOWED_LANGS
    );
    const allowedLangsSet = new Set(allowedLangs);

    // Termos
    const terms = qRaw.includes(',')
      ? qRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [qRaw];

    const publishedAfter = isoXDaysAgo(days);

    // 1) Buscar IDs
    let videoIds;
    try {
      videoIds = await collectVideoIds(terms, apiKey, publishedAfter, pages);
    } catch (err) {
      return res.status(500).json({ error: 'Falha coletando IDs', details: String(err) });
    }

    if (videoIds.length === 0) {
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
      return res.json({ items: [], meta: { total: 0 } });
    }

    // 2) Buscar detalhes dos vídeos
    const videos = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const params = new URLSearchParams({
        key: apiKey,
        id: batch.join(','),
        part: 'statistics,snippet,contentDetails'
      });
      const url = `${YT_API_BASE}/videos?${params.toString()}`;
      const r = await fetch(url);
      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: 'Erro videos.list', details: t });
      }
      const data = await r.json();

      for (const v of (data.items || [])) {
        const viewCount = Number(v?.statistics?.viewCount || 0);
        const publishedAt = v?.snippet?.publishedAt || null;
        if (!publishedAt) continue;

        const durationSec = parseISODuration(v?.contentDetails?.duration);
        const title = v?.snippet?.title || '';
        const thumb = pickThumb(v?.snippet?.thumbnails);
        const w = Number(thumb?.width || 0);
        const h = Number(thumb?.height || 0);
        const ratio = w > 0 && h > 0 ? w / h : 16 / 9;
        const isHorizontal = ratio >= 1.2;
        const isRecent = new Date(publishedAt).getTime() >= new Date(publishedAfter).getTime();
        const titleLower = title.toLowerCase();

        if (
          viewCount >= minViews &&
          isRecent &&
          durationSec >= minDurationSec &&
          isHorizontal &&
          !titleLower.includes('#shorts')
        ) {
          const langTag = v?.snippet?.defaultAudioLanguage || v?.snippet?.defaultLanguage || null;
          const videoLang = normalizeLang(langTag);

          videos.push({
            videoId: v.id,
            title,
            channelId: v.snippet?.channelId || '',
            channelTitle: v.snippet?.channelTitle || '',
            publishedAt,
            viewCount,
            durationSec,
            aspectRatio: ratio,
            videoLang, // pode ser null
            thumbnail: thumb?.url || null,
            url: `https://www.youtube.com/watch?v=${v.id}`
          });
        }
      }

      await sleep(60);
    }

    if (videos.length === 0) {
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
      return res.json({ items: [], meta: { total: 0 } });
    }

    // 3) Buscar estatísticas/país dos canais
    const channelIds = Array.from(new Set(videos.map(v => v.channelId))).filter(Boolean);
    const channelMeta = {};

    for (let i = 0; i < channelIds.length; i += 50) {
      const batch = channelIds.slice(i, i + 50);
      const params = new URLSearchParams({
        key: apiKey,
        id: batch.join(','),
        part: 'statistics,snippet,brandingSettings'
      });
      const url = `${YT_API_BASE}/channels?${params.toString()}`;
      const r = await fetch(url);
      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: 'Erro channels.list', details: t });
      }
      const data = await r.json();

      for (const ch of (data.items || [])) {
        const hidden = !!ch?.statistics?.hiddenSubscriberCount;
        const subs = hidden ? null : Number(ch?.statistics?.subscriberCount || 0);
        const country =
          ch?.brandingSettings?.channel?.country ||
          ch?.snippet?.country ||
          null;
        const countryCode = country ? country.toUpperCase() : null;
        const langHint = countryCode ? COUNTRY_TO_LANG[countryCode] || null : null;
        channelMeta[ch.id] = { subs, hidden, country: countryCode, langHint };
      }
      await sleep(60);
    }

    // 4) Filtros finais: inscritos e idioma
    const filtered = videos
      .filter(v => {
        const ch = channelMeta[v.channelId];
        if (!ch) return false;

        // inscritos
        if (ch.subs == null) return false; // se oculto, exclui para respeitar a regra
        if (ch.subs > maxSubs) return false;

        // idioma
        const lang = v.videoLang || ch.langHint || null;
        if (!lang) return false;
        return allowedLangsSet.has(lang);
      })
      .map(v => ({
        ...v,
        subscriberCount: channelMeta[v.channelId]?.subs ?? null,
        language: v.videoLang || channelMeta[v.channelId]?.langHint || null
      }))
      .sort((a, b) => b.viewCount - a.viewCount);

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ items: filtered, meta: { total: filtered.length } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro inesperado no servidor', details: String(err) });
  }
};
