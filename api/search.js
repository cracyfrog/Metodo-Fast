// api/search.js (Função Serverless da Vercel - Node 18+)

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const MIN_VIEWS = 100_000;
const MAX_SUBS = 50_000;

// Espera X ms (para evitar QPS alto na API)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const isoOneMonthAgo = () => {
  // “1 mês” simplificado para 30 dias
  const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return d.toISOString();
};

module.exports = async (req, res) => {
  try {
    // CORS básico (permite uso público)
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(204).end();

    const apiKey = process.env.YT_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'YT_API_KEY não configurada no ambiente.' });
    }

    const qRaw = (req.query.q || '').trim();
    if (!qRaw) {
      return res.status(400).json({ error: 'Passe o parâmetro q com uma ou mais palavras-chave (ex: q=marketing,instagram).' });
    }

    // Suporta várias palavras separadas por vírgula
    const terms = qRaw.includes(',')
      ? qRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [qRaw];

    const publishedAfter = isoOneMonthAgo();

    // 1) Busca vídeos por termo (1 página por termo, até 50 resultados)
    const videoIdSet = new Set();

    for (const term of terms) {
      const params = new URLSearchParams({
        key: apiKey,
        part: 'snippet',
        q: term,
        type: 'video',
        order: 'viewCount',
        maxResults: '50',
        publishedAfter
      });

      const url = `${YT_API_BASE}/search?${params.toString()}`;
      const r = await fetch(url);
      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: 'Erro na chamada search.list', details: t });
      }
      const data = await r.json();
      for (const item of (data.items || [])) {
        if (item?.id?.videoId) videoIdSet.add(item.id.videoId);
      }

      await sleep(50);
    }

    const videoIds = Array.from(videoIdSet);
    if (videoIds.length === 0) {
      return res.json({ items: [] });
    }

    // 2) Busca estatísticas dos vídeos
    const videos = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const params = new URLSearchParams({
        key: apiKey,
        id: batch.join(','),
        part: 'statistics,snippet'
      });
      const url = `${YT_API_BASE}/videos?${params.toString()}`;
      const r = await fetch(url);
      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: 'Erro na chamada videos.list', details: t });
      }
      const data = await r.json();

      for (const v of (data.items || [])) {
        const viewCount = Number(v?.statistics?.viewCount || 0);
        const publishedAt = v?.snippet?.publishedAt || null;
        if (!publishedAt) continue;
        const isRecent = new Date(publishedAt).getTime() >= new Date(publishedAfter).getTime();
        if (viewCount >= MIN_VIEWS && isRecent) {
          videos.push({
            videoId: v.id,
            title: v.snippet?.title || '',
            channelId: v.snippet?.channelId || '',
            channelTitle: v.snippet?.channelTitle || '',
            publishedAt,
            viewCount,
            thumbnail: v.snippet?.thumbnails?.medium?.url
              || v.snippet?.thumbnails?.default?.url
              || null,
            url: `https://www.youtube.com/watch?v=${v.id}`
          });
        }
      }

      await sleep(50);
    }

    if (videos.length === 0) {
      return res.json({ items: [] });
    }

    // 3) Busca estatísticas dos canais e filtra por inscritos ≤ 50k
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
        return res.status(r.status).json({ error: 'Erro na chamada channels.list', details: t });
      }
      const data = await r.json();
      for (const ch of (data.items || [])) {
        const hidden = !!ch?.statistics?.hiddenSubscriberCount;
        const subs = hidden ? null : Number(ch?.statistics?.subscriberCount || 0);
        channelStats[ch.id] = { subs, hidden };
      }
      await sleep(50);
    }

    const filtered = videos
      .filter(v => {
        const stats = channelStats[v.channelId];
        if (!stats) return false;
        if (stats.subs == null) return false; // inscritos ocultos => exclui para respeitar a regra
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
