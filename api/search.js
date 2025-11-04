// api/search.js (Função Serverless da Vercel - Node 18+)

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const MIN_VIEWS = 100_000;
const MAX_SUBS = 50_000;
const MIN_DURATION_SEC = 8 * 60; // mínimo de 8 minutos

// Espera X ms (para evitar QPS alto na API)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// “1 mês” simplificado para 30 dias
const isoOneMonthAgo = () => {
  const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return d.toISOString();
};

// Converte ISO 8601 (ex: PT1H2M5S) para segundos
function parseISODuration(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}

// Pega a melhor thumbnail disponível
function pickThumb(thumbnails) {
  return thumbnails?.maxres || thumbnails?.standard || thumbnails?.high || thumbnails?.medium || thumbnails?.default || null;
}

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

    // 2) Busca estatísticas + detalhes (inclui duração) dos vídeos
    const videos = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const params = new URLSearchParams({
        key: apiKey,
        id: batch.join(','),
        part: 'statistics,snippet,contentDetails' // duration vem aqui
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
        const title = v?.snippet?.title || '';
        const titleLower = title.toLowerCase();
        if (!publishedAt) continue;

        // Duração e orientação
        const durationSec = parseISODuration(v?.contentDetails?.duration);
        const thumb = pickThumb(v?.snippet?.thumbnails);
        const isHorizontal = thumb?.width && thumb?.height ? (thumb.width >= thumb.height) : true;

        const isRecent = new Date(publishedAt).getTime() >= new Date(publishedAfter).getTime();

        // Aplica todos os critérios
        if (
          viewCount >= MIN_VIEWS &&
          isRecent &&
          durationSec >= MIN_DURATION_SEC && // mínimo de 8 minutos
          isHorizontal &&
          !titleLower.includes('#shorts') // reforço contra Shorts
        ) {
          videos.push({
            videoId: v.id,
            title,
            channelId: v.snippet?.channelId || '',
            channelTitle: v.snippet?.channelTitle || '',
            publishedAt,
            viewCount,
            durationSec,
            thumbnail: thumb?.url || null,
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
        if (stats.subs == null) return false; // inscritos ocultos => exclui
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
