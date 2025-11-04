// api/search.js — Vercel Serverless (Node 18+)
// Suporta modelos: gold, silver, bronze, fresh, recorrentes, subnicho
// Mantém filtros: duração mínima 8 min, horizontal, sem #shorts, idiomas permitidos

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

// Parâmetros padrão
const DEFAULT_MIN_VIEWS = 100_000;
const DEFAULT_MAX_SUBS = 50_000;
const DEFAULT_MIN_DURATION_SEC = 8 * 60; // 8 min
const DEFAULT_DAYS = 30;
const MAX_PAGES = 2; // por duração/termo
const MIN_ASPECT_RATIO = 1.2; // horizontal

// Durações desejadas na busca (evita Shorts já no search)
const DURATIONS = ['medium', 'long']; // medium=4–20min, long=20+

// Idiomas padrão (ISO-639-1)
const DEFAULT_ALLOWED_LANGS = [
  'en','es','fr','de','pt','it','ru','ja','ko','nl','pl','el','ro','da','no','ga'
];

// Aproximação país -> idioma (fallback)
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

// Limites para o modelo "recorrentes" (canais consistentes)
const STREAK_MIN_VIEWS = 15_000;
const STREAK_MIN_COUNT = 14;
const STREAK_DAYS = 30;
const STREAK_MAX_SUBS = 150_000;
const STREAK_CHANNEL_LIMIT = 20; // quantos canais avaliamos por requisição (para não estourar tempo)

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

function aspectRatioOfThumb(thumbnails) {
  const t = pickThumb(thumbnails);
  const w = Number(t?.width || 0);
  const h = Number(t?.height || 0);
  if (w > 0 && h > 0) return w / h;
  return 16 / 9;
}

// Modelos pré-definidos (se ?model= for usado)
const MODELS = {
  gold:       { mode: 'normal',     days: 30, minViews: 100_000, maxSubs: 50_000 },
  silver:     { mode: 'normal',     days: 90, minViews: 100_000, maxSubs: 50_000 },
  bronze:     { mode: 'normal',     days: 90, minViews: 100_000, maxSubs: 150_000 },
  fresh:      { mode: 'normal',     days: 7,  minViews: 15_000,  maxSubs: 150_000 },
  recorrentes:{ mode: 'streak14',   days: STREAK_DAYS, minViews: STREAK_MIN_VIEWS, maxSubs: STREAK_MAX_SUBS },
  subnicho:   { mode: 'normal',     days: 60, minViews: 500_000, maxSubs: null } // sem limite de inscritos
};

// Busca IDs e canais por termos/duração/páginas
async function collectSearchIdsAndChannels({ terms, apiKey, publishedAfter, pages }) {
  const videoIds = new Set();
  const channelIds = new Set();

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
          const vid = item?.id?.videoId;
          const ch = item?.snippet?.channelId;
          if (vid) videoIds.add(vid);
          if (ch) channelIds.add(ch);
        }

        pageToken = data.nextPageToken || '';
        if (!pageToken) break;
        await sleep(60);
      }
    }
  }

  return { videoIds: Array.from(videoIds), channelIds: Array.from(channelIds) };
}

// Detalhes dos vídeos em lotes
async function fetchVideosDetails(apiKey, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const params = new URLSearchParams({
      key: apiKey,
      id: batch.join(','),
      part: 'statistics,snippet,contentDetails'
    });
    const url = `${YT_API_BASE}/videos?${params.toString()}`;
    const r = await fetch(url);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Erro videos.list: ${r.status} ${t}`);
    }
    const data = await r.json();
    for (const v of (data.items || [])) out.push(v);
    await sleep(60);
  }
  return out;
}

// Metadados dos canais (inclui uploads playlist)
async function fetchChannelsMeta(apiKey, channelIds) {
  const meta = {};
  for (let i = 0; i < channelIds.length; i += 50) {
    const batch = channelIds.slice(i, i + 50);
    const params = new URLSearchParams({
      key: apiKey,
      id: batch.join(','),
      part: 'statistics,snippet,brandingSettings,contentDetails'
    });
    const url = `${YT_API_BASE}/channels?${params.toString()}`;
    const r = await fetch(url);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Erro channels.list: ${r.status} ${t}`);
    }
    const data = await r.json();
    for (const ch of (data.items || [])) {
      const hidden = !!ch?.statistics?.hiddenSubscriberCount;
      const subs = hidden ? null : Number(ch?.statistics?.subscriberCount || 0);
      const country = ch?.brandingSettings?.channel?.country || ch?.snippet?.country || null;
      const uploads = ch?.contentDetails?.relatedPlaylists?.uploads || null;
      const countryCode = country ? country.toUpperCase() : null;
      const langHint = countryCode ? COUNTRY_TO_LANG[countryCode] || null : null;
      meta[ch.id] = { subs, hidden, country: countryCode, langHint, uploads };
    }
    await sleep(60);
  }
  return meta;
}

// Lista vídeos de uma playlist (uploads) até publishedAfter ou limite
async function fetchUploadsWithin(apiKey, uploadsPlaylistId, publishedAfter, maxItems = 60) {
  const items = [];
  let pageToken = '';
  while (items.length < maxItems) {
    const params = new URLSearchParams({
      key: apiKey,
      part: 'contentDetails,snippet',
      playlistId: uploadsPlaylistId,
      maxResults: '50'
    });
    if (pageToken) params.set('pageToken', pageToken);

    const url = `${YT_API_BASE}/playlistItems?${params.toString()}`;
    const r = await fetch(url);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Erro playlistItems.list: ${r.status} ${t}`);
    }
    const data = await r.json();
    const list = (data.items || []).map(it => {
      const vid = it?.contentDetails?.videoId || null;
      const pub = it?.contentDetails?.videoPublishedAt || it?.snippet?.publishedAt || null;
      return { videoId: vid, publishedAt: pub };
    }).filter(x => x.videoId && x.publishedAt);

    // Mantém apenas os dentro da janela
    for (const x of list) {
      if (new Date(x.publishedAt).getTime() >= new Date(publishedAfter).getTime()) {
        items.push(x);
      }
    }

    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
    // Se o último da página já é antigo, podemos parar
    const last = list[list.length - 1];
    if (last && new Date(last.publishedAt).getTime() < new Date(publishedAfter).getTime()) break;

    await sleep(60);
  }
  return items.slice(0, maxItems);
}

// Calcula streak consecutivo a partir do vídeo mais recente
function computeStreakQualified(videosSortedDesc, { minViews, minDurationSec, publishedAfter }) {
  let count = 0;
  for (const v of videosSortedDesc) {
    const viewCount = Number(v?.statistics?.viewCount || 0);
    const dur = parseISODuration(v?.contentDetails?.duration);
    const titleLower = (v?.snippet?.title || '').toLowerCase();
    const ratio = aspectRatioOfThumb(v?.snippet?.thumbnails);
    const isRecent = new Date(v?.snippet?.publishedAt || v?.contentDetails?.videoPublishedAt || 0)
                      .getTime() >= new Date(publishedAfter).getTime();

    const qualifies =
      isRecent &&
      viewCount >= minViews &&
      dur >= minDurationSec &&
      ratio >= MIN_ASPECT_RATIO &&
      !titleLower.includes('#shorts');

    if (qualifies) {
      count += 1;
    } else {
      break; // precisa ser seguido
    }
  }
  return count;
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

    // Modelo (opcional) ou parâmetros explícitos
    const modelKey = (req.query.model || '').toLowerCase();
    const modelCfg = MODELS[modelKey] || null;

    // Defaults e overrides
    const minDurationSec = Math.max(0, parseInt(req.query.minDurationSec || DEFAULT_MIN_DURATION_SEC, 10) || DEFAULT_MIN_DURATION_SEC);
    const days = Math.max(1, parseInt(req.query.days || (modelCfg ? modelCfg.days : DEFAULT_DAYS), 10));
    const minViews = Math.max(0, parseInt(req.query.minViews || (modelCfg ? modelCfg.minViews : DEFAULT_MIN_VIEWS), 10));
    // maxSubs: null significa sem limite
    const maxSubsParam = (req.query.maxSubs ?? (modelCfg ? modelCfg.maxSubs : DEFAULT_MAX_SUBS));
    const maxSubs = (maxSubsParam === null || maxSubsParam === 'null') ? null : (isNaN(parseInt(maxSubsParam, 10)) ? null : parseInt(maxSubsParam, 10));
    let pages = Math.max(1, parseInt(req.query.pages || '1', 10) || 1);
    pages = Math.min(pages, MAX_PAGES);

    const allowedLangs = (req.query.langs || '')
      ? (req.query.langs.split(',').map(s => normalizeLang(s)).filter(Boolean))
      : DEFAULT_ALLOWED_LANGS;
    const allowedLangsSet = new Set(allowedLangs);

    const terms = qRaw.includes(',') ? qRaw.split(',').map(s => s.trim()).filter(Boolean) : [qRaw];
    const publishedAfter = isoXDaysAgo(days);

    // Se for o modelo especial "recorrentes" (streak de 14 vídeos seguidos)
    if ((modelCfg && modelCfg.mode === 'streak14') || (req.query.mode === 'streak14')) {
      // 1) Coleta canais candidatos pela busca
      const { channelIds } = await collectSearchIdsAndChannels({ terms, apiKey, publishedAfter, pages });

      if (!channelIds.length) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        return res.json({ items: [], meta: { total: 0, mode: 'streak14' } });
      }

      // 2) Metadados dos canais (subs, uploads, país)
      const channelMetaAll = await fetchChannelsMeta(apiKey, channelIds);

      // 3) Filtra por inscritos ≤ 150k e idioma (quando possível)
      const eligibleChannels = channelIds
        .filter(id => {
          const ch = channelMetaAll[id];
          if (!ch) return false;
          if (ch.subs == null) return false; // precisa saber para aplicar ≤150k
          if (ch.subs > STREAK_MAX_SUBS) return false;
          // idioma: só pelo país aqui; será validado nos vídeos também
          return true;
        })
        .slice(0, STREAK_CHANNEL_LIMIT); // limitamos a quantidade avaliada por request

      if (!eligibleChannels.length) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        return res.json({ items: [], meta: { total: 0, mode: 'streak14' } });
      }

      // 4) Para cada canal, pega vídeos do uploads dentro da janela
      const perChannelVideosIds = new Map();
      for (const chId of eligibleChannels) {
        const upl = channelMetaAll[chId]?.uploads || null;
        if (!upl) continue;
        const vids = await fetchUploadsWithin(apiKey, upl, isoXDaysAgo(STREAK_DAYS), 60);
        if (vids.length) perChannelVideosIds.set(chId, vids.map(v => v.videoId));
        await sleep(50);
      }

      const allIds = Array.from(new Set([].concat(...Array.from(perChannelVideosIds.values()))));
      if (!allIds.length) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        return res.json({ items: [], meta: { total: 0, mode: 'streak14' } });
      }

      // 5) Detalhes de todos os vídeos coletados
      const details = await fetchVideosDetails(apiKey, allIds);
      const detailsById = new Map(details.map(v => [v.id, v]));

      // 6) Avalia streak por canal
      const results = [];
      for (const chId of eligibleChannels) {
        const meta = channelMetaAll[chId];
        const ids = perChannelVideosIds.get(chId) || [];
        if (!ids.length) continue;

        // Monta lista de vídeos com detalhes e filtra janela
        const vids = ids
          .map(id => detailsById.get(id))
          .filter(Boolean)
          .filter(v => new Date(v?.snippet?.publishedAt || 0).getTime() >= new Date(isoXDaysAgo(STREAK_DAYS)).getTime())
          // ordena do mais recente para o mais antigo
          .sort((a,b) => new Date(b.snippet.publishedAt).getTime() - new Date(a.snippet.publishedAt).getTime());

        // Filtra por idioma (vídeo ou país do canal)
        const langTag = vids[0]?.snippet?.defaultAudioLanguage || vids[0]?.snippet?.defaultLanguage || null;
        const videoLang = normalizeLang(langTag) || meta.langHint || null;
        if (!videoLang || !allowedLangsSet.has(videoLang)) continue;

        // Streak consecutivo a partir do mais recente
        const streak = computeStreakQualified(vids, {
          minViews: STREAK_MIN_VIEWS,
          minDurationSec: minDurationSec,
          publishedAfter: isoXDaysAgo(STREAK_DAYS)
        });

        if (streak >= STREAK_MIN_COUNT) {
          // Pega o vídeo mais recente qualificado para exibir no card
          const representative = vids.find(v => {
            const vc = Number(v?.statistics?.viewCount || 0);
            const dur = parseISODuration(v?.contentDetails?.duration);
            const titleLower = (v?.snippet?.title || '').toLowerCase();
            const ratio = aspectRatioOfThumb(v?.snippet?.thumbnails);
            const isRecent = new Date(v?.snippet?.publishedAt || 0).getTime() >= new Date(isoXDaysAgo(STREAK_DAYS)).getTime();
            return vc >= STREAK_MIN_VIEWS && dur >= minDurationSec && ratio >= MIN_ASPECT_RATIO && !titleLower.includes('#shorts') && isRecent;
          }) || vids[0];

          const thumb = pickThumb(representative?.snippet?.thumbnails);
          results.push({
            model: 'recorrentes',
            videoId: representative.id,
            title: representative.snippet?.title || '',
            channelId: chId,
            channelTitle: representative.snippet?.channelTitle || '',
            publishedAt: representative.snippet?.publishedAt || '',
            viewCount: Number(representative.statistics?.viewCount || 0),
            durationSec: parseISODuration(representative.contentDetails?.duration),
            aspectRatio: aspectRatioOfThumb(representative.snippet?.thumbnails),
            thumbnail: thumb?.url || null,
            url: `https://www.youtube.com/watch?v=${representative.id}`,
            subscriberCount: meta.subs ?? null,
            language: videoLang,
            streakCount: streak
          });
        }
      }

      results.sort((a,b) => b.viewCount - a.viewCount);
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
      return res.json({ items: results, meta: { total: results.length, mode: 'streak14' } });
    }

    // Modo "normal" (gold, silver, bronze, fresh, subnicho, ou parâmetros manuais)
    const { videoIds, channelIds } = await collectSearchIdsAndChannels({ terms, apiKey, publishedAfter, pages });
    if (!videoIds.length) {
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
      return res.json({ items: [], meta: { total: 0, mode: 'normal' } });
    }

    // Detalhes dos vídeos
    const videos = await fetchVideosDetails(apiKey, videoIds);

    // Metadados dos canais
    const channelMeta = await fetchChannelsMeta(apiKey, channelIds);

    // Filtro principal
    const filtered = [];
    for (const v of videos) {
      const viewCount = Number(v?.statistics?.viewCount || 0);
      const publishedAt = v?.snippet?.publishedAt || null;
      if (!publishedAt) continue;

      // janela temporal
      const isRecent = new Date(publishedAt).getTime() >= new Date(publishedAfter).getTime();
      if (!isRecent) continue;

      // duração, orientação e shorts
      const durationSec = parseISODuration(v?.contentDetails?.duration);
      const ratio = aspectRatioOfThumb(v?.snippet?.thumbnails);
      const titleLower = (v?.snippet?.title || '').toLowerCase();
      if (durationSec < minDurationSec) continue;
      if (ratio < MIN_ASPECT_RATIO) continue;
      if (titleLower.includes('#shorts')) continue;

      // views
      if (viewCount < minViews) continue;

      // idioma
      const langTag = v?.snippet?.defaultAudioLanguage || v?.snippet?.defaultLanguage || null;
      const videoLang = normalizeLang(langTag);
      const ch = channelMeta[v?.snippet?.channelId || ''] || {};
      const lang = videoLang || ch.langHint || null;
      if (!lang || !allowedLangsSet.has(lang)) continue;

      // inscritos (se aplicável)
      if (maxSubs !== null) {
        if (ch.subs == null) continue; // precisamos saber pra aplicar o limite
        if (ch.subs > maxSubs) continue;
      }
      // Se maxSubs é null (ex.: subnicho), não filtra por inscritos (aceita inclusive ocultos)

      const thumb = pickThumb(v?.snippet?.thumbnails);
      filtered.push({
        model: modelKey || 'custom',
        videoId: v.id,
        title: v.snippet?.title || '',
        channelId: v.snippet?.channelId || '',
        channelTitle: v.snippet?.channelTitle || '',
        publishedAt,
        viewCount,
        durationSec,
        aspectRatio: ratio,
        thumbnail: thumb?.url || null,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        subscriberCount: ch.subs ?? null,
        language: lang
      });
    }

    filtered.sort((a, b) => b.viewCount - a.viewCount);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ items: filtered, meta: { total: filtered.length, mode: 'normal' } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro inesperado no servidor', details: String(err) });
  }
};
