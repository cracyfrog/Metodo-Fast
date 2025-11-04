// api/search.js — Vercel Serverless (Node 18+)

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

// Padrões
const DEFAULT_MIN_VIEWS = 100_000;
const DEFAULT_MAX_SUBS = 50_000;
const DEFAULT_MIN_DURATION_SEC = 8 * 60; // 8 min
const DEFAULT_DAYS = 30;
const MAX_PAGES = 2; // por duração/termo (para não estourar timeout)

// Durações para modelos de "vídeos"
const DURATIONS = ['medium', 'long']; // 4–20min e 20+

// Idiomas permitidos por padrão
const DEFAULT_ALLOWED_LANGS = [
  'en','es','fr','de','pt','it','ru','ja','ko','nl','pl','el','ro','da','no','ga'
];

// Aproximação país->idioma
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

// Parâmetros dos modos "de canais"
const SUBNICHO_DAYS = 60;
const SUBNICHO_MIN_VIEWS = 500_000;

const STREAK_WINDOW_DAYS = 30;
const STREAK_MIN_VIEWS = 15_000;
const STREAK_COUNT = 14;
const STREAK_MAX_SUBS = 150_000;
const MAX_CHANNEL_CANDIDATES = 25; // avaliar no máximo X canais

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

// IDs de vídeos (opção com duração)
async function collectVideoIdsWithDurations(terms, apiKey, publishedAfter, pages) {
  const ids = new Set();
  for (const term of terms) {
    for (const duration of DURATIONS) {
      let pageToken = '';
      for (let page = 0; page < pages; page++) {
        const params = new URLSearchParams({
          key: apiKey, part: 'snippet', q: term, type: 'video',
          order: 'viewCount', maxResults: '50', publishedAfter, videoDuration: duration
        });
        if (pageToken) params.set('pageToken', pageToken);
        const r = await fetch(`${YT_API_BASE}/search?${params.toString()}`);
        if (!r.ok) throw new Error(`search.list ${r.status} ${await r.text()}`);
        const data = await r.json();
        for (const it of (data.items || [])) if (it?.id?.videoId) ids.add(it.id.videoId);
        pageToken = data.nextPageToken || '';
        if (!pageToken) break;
        await sleep(60);
      }
    }
  }
  return Array.from(ids);
}

// IDs de vídeos (qualquer duração)
async function collectVideoIdsAny(terms, apiKey, publishedAfter, pages) {
  const ids = new Set();
  for (const term of terms) {
    let pageToken = '';
    for (let page = 0; page < pages; page++) {
      const params = new URLSearchParams({
        key: apiKey, part: 'snippet', q: term, type: 'video',
        order: 'viewCount', maxResults: '50', publishedAfter
      });
      if (pageToken) params.set('pageToken', pageToken);
      const r = await fetch(`${YT_API_BASE}/search?${params.toString()}`);
      if (!r.ok) throw new Error(`search.list ${r.status} ${await r.text()}`);
      const data = await r.json();
      for (const it of (data.items || [])) if (it?.id?.videoId) ids.add(it.id.videoId);
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
      await sleep(60);
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
    if (!qRaw) return res.status(400).json({ error: 'Use ?q=palavras (ex: q=marketing,instagram)' });

    const mode = (req.query.mode || 'videos').trim(); // 'videos' | 'subnicho' | 'rec_channels'

    // Parâmetros genéricos
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

    const terms = qRaw.includes(',')
      ? qRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [qRaw];

    // ---------- MODO: VIDEOS (Gold/Silver/Bronze/Fresh) ----------
    if (mode === 'videos') {
      const publishedAfter = isoXDaysAgo(days);

      // 1) IDs com duração (evita shorts)
      let videoIds;
      try {
        videoIds = await collectVideoIdsWithDurations(terms, apiKey, publishedAfter, pages);
      } catch (err) {
        return res.status(500).json({ error: 'Falha coletando IDs', details: String(err) });
      }
      if (videoIds.length === 0) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        return res.json({ items: [], meta: { total: 0 } });
      }

      // 2) Detalhes dos vídeos
      const videos = [];
      for (let i = 0; i < videoIds.length; i += 50) {
        const batch = videoIds.slice(i, i + 50);
        const params = new URLSearchParams({
          key: apiKey, id: batch.join(','), part: 'statistics,snippet,contentDetails'
        });
        const r = await fetch(`${YT_API_BASE}/videos?${params.toString()}`);
        if (!r.ok) return res.status(r.status).json({ error: 'Erro videos.list', details: await r.text() });
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
          const ratio = w > 0 && h > 0 ? w / h : 16/9;
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
              type: 'video',
              videoId: v.id,
              title,
              channelId: v.snippet?.channelId || '',
              channelTitle: v.snippet?.channelTitle || '',
              publishedAt,
              viewCount,
              durationSec,
              aspectRatio: ratio,
              videoLang,
              thumbnail: thumb?.url || null,
              url: `https://www.youtube.com/watch?v=${v.id}`
            });
          }
        }
        await sleep(60);
      }
      if (!videos.length) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        return res.json({ items: [], meta: { total: 0 } });
      }

      // 3) Estatísticas e país dos canais
      const channelIds = Array.from(new Set(videos.map(v => v.channelId))).filter(Boolean);
      const channelMeta = {};
      for (let i = 0; i < channelIds.length; i += 50) {
        const batch = channelIds.slice(i, i + 50);
        const params = new URLSearchParams({
          key: apiKey, id: batch.join(','), part: 'statistics,snippet,brandingSettings'
        });
        const r = await fetch(`${YT_API_BASE}/channels?${params.toString()}`);
        if (!r.ok) return res.status(r.status).json({ error: 'Erro channels.list', details: await r.text() });
        const data = await r.json();
        for (const ch of (data.items || [])) {
          const hidden = !!ch?.statistics?.hiddenSubscriberCount;
          const subs = hidden ? null : Number(ch?.statistics?.subscriberCount || 0);
          const country = ch?.brandingSettings?.channel?.country || ch?.snippet?.country || null;
          const countryCode = country ? country.toUpperCase() : null;
          const langHint = countryCode ? COUNTRY_TO_LANG[countryCode] || null : null;
          channelMeta[ch.id] = { subs, hidden, country: countryCode, langHint };
        }
        await sleep(60);
      }

      // 4) Filtro por inscritos/idioma
      const filtered = videos
        .filter(v => {
          const ch = channelMeta[v.channelId];
          if (!ch) return false;
          if (maxSubs > 0) { // 0 significa "ignorar limite"
            if (ch.subs == null) return false;
            if (ch.subs > maxSubs) return false;
          }
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
    }

    // ---------- MODO: OPORTUNIDADE DE SUBNICHO (CANAIS) ----------
    if (mode === 'subnicho') {
      const publishedAfter = isoXDaysAgo(SUBNICHO_DAYS);

      // 1) Vídeos com grande hit (500k+) para achar canais
      let videoIds;
      try {
        videoIds = await collectVideoIdsAny(terms, apiKey, publishedAfter, pages);
      } catch (err) {
        return res.status(500).json({ error: 'Falha coletando IDs', details: String(err) });
      }
      if (!videoIds.length) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        return res.json({ items: [], meta: { total: 0 } });
      }

      // 2) Detalhes dos vídeos e coleta de canais que bateram 500k+
      const candidateByChannel = new Map(); // channelId -> best video (maior view)
      for (let i = 0; i < videoIds.length; i += 50) {
        const batch = videoIds.slice(i, i + 50);
        const params = new URLSearchParams({ key: apiKey, id: batch.join(','), part: 'statistics,snippet' });
        const r = await fetch(`${YT_API_BASE}/videos?${params.toString()}`);
        if (!r.ok) return res.status(r.status).json({ error: 'Erro videos.list', details: await r.text() });
        const data = await r.json();

        for (const v of (data.items || [])) {
          const vc = Number(v?.statistics?.viewCount || 0);
          const publishedAt = v?.snippet?.publishedAt || null;
          if (!publishedAt) continue;
          const isRecent = new Date(publishedAt).getTime() >= new Date(publishedAfter).getTime();
          if (vc >= SUBNICHO_MIN_VIEWS && isRecent) {
            const chId = v?.snippet?.channelId;
            const prev = candidateByChannel.get(chId);
            if (!prev || vc > prev.viewCount) {
              candidateByChannel.set(chId, {
                videoId: v.id,
                viewCount: vc,
                publishedAt,
                title: v?.snippet?.title || ''
              });
            }
          }
        }
        await sleep(60);
      }

      const channelIds = Array.from(candidateByChannel.keys());
      if (!channelIds.length) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        return res.json({ items: [], meta: { total: 0 } });
      }

      // 3) Info dos canais e filtro de idioma
      const items = [];
      for (let i = 0; i < channelIds.length; i += 50) {
        const batch = channelIds.slice(i, i + 50);
        const params = new URLSearchParams({
          key: apiKey, id: batch.join(','), part: 'statistics,snippet,brandingSettings'
        });
        const r = await fetch(`${YT_API_BASE}/channels?${params.toString()}`);
        if (!r.ok) return res.status(r.status).json({ error: 'Erro channels.list', details: await r.text() });
        const data = await r.json();

        for (const ch of (data.items || [])) {
          const country = ch?.brandingSettings?.channel?.country || ch?.snippet?.country || null;
          const countryCode = country ? country.toUpperCase() : null;
          const langHint = countryCode ? COUNTRY_TO_LANG[countryCode] || null : null;
          const lang = langHint || null;
          if (!lang || !allowedLangsSet.has(lang)) continue;

          const best = candidateByChannel.get(ch.id);
          const subsHidden = !!ch?.statistics?.hiddenSubscriberCount;
          const subs = subsHidden ? null : Number(ch?.statistics?.subscriberCount || 0);
          const thumb = pickThumb(ch?.snippet?.thumbnails);

          items.push({
            type: 'channel',
            channelId: ch.id,
            channelTitle: ch?.snippet?.title || '',
            subscriberCount: subs,
            language: lang,
            thumbnail: thumb?.url || null,
            title: ch?.snippet?.title || '',
            viewCount: best?.viewCount ?? null,
            publishedAt: best?.publishedAt ?? null,
            url: `https://www.youtube.com/channel/${ch.id}`
          });
        }
        await sleep(60);
      }

      const sorted = items.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
      return res.json({ items: sorted, meta: { total: sorted.length } });
    }

    // ---------- MODO: MODELAGEM DE VIEWS RECORRENTES (CANAIS) ----------
    if (mode === 'rec_channels') {
      const publishedAfter = isoXDaysAgo(STREAK_WINDOW_DAYS);

      // 1) Achar canais candidatos via vídeos recentes (min 15k em 30 dias)
      let videoIds;
      try {
        videoIds = await collectVideoIdsAny(terms, apiKey, publishedAfter, 1); // só 1 página para não estourar
      } catch (err) {
        return res.status(500).json({ error: 'Falha coletando IDs', details: String(err) });
      }
      if (!videoIds.length) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        return res.json({ items: [], meta: { total: 0 } });
      }

      // 2) Pega vídeos e canais candidatos
      const channelSet = new Set();
      for (let i = 0; i < videoIds.length; i += 50) {
        const batch = videoIds.slice(i, i + 50);
        const params = new URLSearchParams({ key: apiKey, id: batch.join(','), part: 'statistics,snippet' });
        const r = await fetch(`${YT_API_BASE}/videos?${params.toString()}`);
        if (!r.ok) return res.status(r.status).json({ error: 'Erro videos.list', details: await r.text() });
        const data = await r.json();
        for (const v of (data.items || [])) {
          const vc = Number(v?.statistics?.viewCount || 0);
          const publishedAt = v?.snippet?.publishedAt || null;
          if (!publishedAt) continue;
          const isRecent = new Date(publishedAt).getTime() >= new Date(publishedAfter).getTime();
          if (vc >= STREAK_MIN_VIEWS && isRecent) {
            if (v?.snippet?.channelId) channelSet.add(v.snippet.channelId);
          }
        }
        await sleep(60);
      }

      const candidateChannels = Array.from(channelSet).slice(0, MAX_CHANNEL_CANDIDATES);
      if (!candidateChannels.length) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
        return res.json({ items: [], meta: { total: 0 } });
      }

      // 3) Para cada canal: checar se últimos 14 uploads (em 30 dias) têm 15k+ views
      const qualified = [];
      for (let i = 0; i < candidateChannels.length; i += 50) {
        const batch = candidateChannels.slice(i, i + 50);
        const params = new URLSearchParams({
          key: apiKey, id: batch.join(','), part: 'statistics,snippet,brandingSettings,contentDetails'
        });
        const r = await fetch(`${YT_API_BASE}/channels?${params.toString()}`);
        if (!r.ok) return res.status(r.status).json({ error: 'Erro channels.list', details: await r.text() });
        const data = await r.json();

        for (const ch of (data.items || [])) {
          const subsHidden = !!ch?.statistics?.hiddenSubscriberCount;
          const subs = subsHidden ? null : Number(ch?.statistics?.subscriberCount || 0);
          if (subs == null || subs > STREAK_MAX_SUBS) continue;

          const country = ch?.brandingSettings?.channel?.country || ch?.snippet?.country || null;
          const lang = country ? (COUNTRY_TO_LANG[country.toUpperCase()] || null) : null;
          if (!lang || !allowedLangsSet.has(lang)) continue;

          const uploadsId = ch?.contentDetails?.relatedPlaylists?.uploads;
          if (!uploadsId) continue;

          // Playlist dos uploads
          const videoIdsForCheck = [];
          let pageToken = '';
          do {
            const p = new URLSearchParams({
              key: apiKey, part: 'contentDetails,snippet', playlistId: uploadsId, maxResults: '50'
            });
            if (pageToken) p.set('pageToken', pageToken);
            const pr = await fetch(`${YT_API_BASE}/playlistItems?${p.toString()}`);
            if (!pr.ok) return res.status(pr.status).json({ error: 'Erro playlistItems.list', details: await pr.text() });
            const pdata = await pr.json();

            for (const it of (pdata.items || [])) {
              const vId = it?.contentDetails?.videoId;
              const publishedAt = it?.contentDetails?.videoPublishedAt || it?.snippet?.publishedAt || null;
              if (!vId || !publishedAt) continue;
              const withinWindow = new Date(publishedAt).getTime() >= new Date(publishedAfter).getTime();
              if (withinWindow) videoIdsForCheck.push({ vId, publishedAt });
            }
            pageToken = pdata.nextPageToken || '';
            // Não precisamos de tudo; basta pegar os mais recentes dentro da janela
            if (videoIdsForCheck.length >= STREAK_COUNT) break;
            await sleep(60);
          } while (pageToken);

          // Pegamos os 14 mais recentes dentro da janela
          videoIdsForCheck.sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt));
          const streak = videoIdsForCheck.slice(0, STREAK_COUNT);
          if (streak.length < STREAK_COUNT) continue;

          const ids = streak.map(s => s.vId);
          const vparams = new URLSearchParams({ key: apiKey, id: ids.join(','), part: 'statistics' });
          const vr = await fetch(`${YT_API_BASE}/videos?${vparams.toString()}`);
          if (!vr.ok) return res.status(vr.status).json({ error: 'Erro videos.list (streak)', details: await vr.text() });
          const vdata = await vr.json();

          let allAbove = true;
          for (const v of (vdata.items || [])) {
            const vc = Number(v?.statistics?.viewCount || 0);
            if (vc < STREAK_MIN_VIEWS) { allAbove = false; break; }
          }
          if (!allAbove) continue;

          const thumb = pickThumb(ch?.snippet?.thumbnails);
          qualified.push({
            type: 'channel',
            channelId: ch.id,
            channelTitle: ch?.snippet?.title || '',
            subscriberCount: subs,
            language: lang,
            thumbnail: thumb?.url || null,
            title: ch?.snippet?.title || '',
            url: `https://www.youtube.com/channel/${ch.id}`
          });

          // 
