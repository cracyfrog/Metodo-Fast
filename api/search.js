// api/search.js (Função Serverless da Vercel - Node 18+)

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const MIN_VIEWS = 100_000;
const MAX_SUBS = 50_000;
const MIN_DURATION_SEC = 8 * 60; // mínimo de 8 minutos

// Buscaremos 4–20 min (medium) e 20+ (long) para já evitar shorts
const DURATIONS = ['medium', 'long'];
// Páginas por duração (aumenta resultados, mas consome mais cota)
// 1 = até 50 ids por duração/termo; 2 = até 100; ajuste se quiser
const PAGES_PER_DURATION = 1;

// Espera X ms (evitar QPS alto)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// “1 mês” = 30 dias
const isoOneMonthAgo = () => {
  const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return d.toISOString();
};

// Converte ISO 8601 (PT1H2M5S) para segundos
function parseISODuration(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}

// Escolhe a melhor thumbnail disponível
function pickThumb(thumbnails) {
  return thumbnails?.maxres || thumbnails?.standard || thumbnails?.high || thumbnails?.medium || thumbnails?.default || null;
}

// Coleta IDs de vídeo por termo, já filtrando por duração na busca
async function collectVideoIds(terms, apiKey, publishedAfter) {
  const videoIdSet = new Set();

  for (const term of terms) {
    for (const duration of DURATIONS) {
      let pageToken = '';
      for (let page = 0; page < PAGES_PER_DURATION; page++) {
        const params = new URLSearchParams({
          key: apiKey,
          part: 'snippet',
          q: term,
          type: 'video',
          order: 'viewCount',
          maxResults: '50',
          publishedAfter,
          videoDuration: duration // medium (4–20min) e long (20+)
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
          if (item?.id?.videoId) videoIdSet.add(item.id.videoId);
        }

        pageToken = data.nextPageToken || '';
        if (!pageToken) break;

        await sleep(80);
      }
    }
  }
  return Array.from(videoIdSet);
}

module.exports = async (req, res) => {
  try {
    // CORS básico
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(204).end();

    const apiKey = process.env.YT_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'YT_API_KEY não configurada no ambiente.' });
    }

    const qRaw = (req.query.q || '').trim();
    if (!qRaw) {
      return res.status(400).json({ error: 'Passe o parâmetro q (ex: q=marketing,instagram).' });
    }

    const terms = qRaw.includes(',')
      ? qRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [qRaw];

    const publishedAfter = isoOneMonthAgo();

    // 1) Buscar IDs (pré-filtrando duração na própria busca)
    let videoIds;
    try {
      videoIds = await collectVideoIds(terms, apiKey, publishedAfter);
    } catch (err) {
      return res.status(500).json({ error: 'Falha coletando IDs', details: String(err) });
    }

    if (videoIds.length === 0) {
      // Cache curto quando vazio
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
      return res.json({ items: [] });
    }

    // 2) Pegar detalhes + estatísticas
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
        const title = v?.snippet?.title || '';
        if (!publishedAt) continue;

        const durationSec = parseISODuration(v?.contentDetails?.duration);
        const thumb = pickThumb(v?.snippet?.thumbnails);

        // Orientação: exige relação largura/altura >= 1.2
        const w = Number(thumb?.width || 0);
        const h = Number(thumb?.height || 0);
        const ratio = w > 0 && h > 0 ? w / h : 16 / 9;
        const isHorizontal = ratio >= 1.2;

        const isRecent = new Date(publishedAt).getTime() >= new Date(publishedAfter).getTime();

        if (
          viewCount >= MIN_VIEWS &&
          isRecent &&
          durationSec >= MIN_DURATION_SEC &&
          isHorizontal &&
          !title.toLowerCase().includes('#shorts')
        ) {
          videos.push({
            videoId: v.id,
            title,
            channelId: v.snippet?.channelId || '',
            channelTitle: v.snippet?.channelTitle || '',
            publishedAt,
            viewCount,
            durationSec,
            aspectRatio: ratio,
            thumbnail: thumb?.url || null,
            url: `https://www.youtube.com/watch?v=${v.id}`
          });
        }
      }

      await sleep(80);
    }

    if (videos.length === 0) {
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
      return res.json({ items: [] });
    }

    // 3) Estatísticas dos canais, filtra ≤ 50k inscritos
    const channelIds = Array.from(new Set(videos.map(v => v.channelId))).filter(Boolean);
    const channelStats = {};

    for (let i = 0; i < channelIds.length; i += 50) {
      const batch = channelIds.slice(i, i + 50);
      const params = new URLSearchParams({
        key: apiKey,
        id: batch.join(','),
        part: 'statistics'
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
        channelStats[ch.id] = { subs, hidden };
      }
      await sleep(80);
    }

    const filtered = videos
      .filter(v => {
        const stats = channelStats[v.channelId];
        if (!stats) return false;
        if (stats.subs == null) return false; // desconhecido -> exclui para respeitar a regra
        return stats.subs <= MAX_SUBS;
      })
      .map(v => ({
        ...v,
        subscriberCount: channelStats[v.channelId]?.subs ?? null
      }))
      .sort((a, b) => b.viewCount - a.viewCount);

    // Cache CDN por 1h
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ items: filtered });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro inesperado no servidor.', details: String(err) });
  }
};
