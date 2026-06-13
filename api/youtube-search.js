// /api/youtube-search - server-side YouTube search without exposing a key.
//
// YouTube embeds a JSON result tree in its public search page. We extract
// videoRenderer objects from that response and return a small normalized list.

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

function readJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function rendererObjects(html, limit) {
  const results = [];
  const marker = '"videoRenderer":';
  let position = 0;
  while (results.length < limit) {
    const markerAt = html.indexOf(marker, position);
    if (markerAt < 0) break;
    const start = html.indexOf("{", markerAt + marker.length);
    if (start < 0) break;
    const raw = readJsonObject(html, start);
    position = start + Math.max(1, raw?.length || 1);
    if (!raw) continue;
    try {
      results.push(JSON.parse(raw));
    } catch {}
  }
  return results;
}

const textOf = (value) =>
  value?.simpleText ||
  (value?.runs || [])
    .map((run) => run.text || "")
    .join("")
    .trim();

function normalize(renderer) {
  const videoId = renderer.videoId;
  const title = textOf(renderer.title);
  if (!videoId || !title) return null;
  const thumbnails = renderer.thumbnail?.thumbnails || [];
  const description =
    textOf(renderer.detailedMetadataSnippets?.[0]?.snippetText) ||
    textOf(renderer.descriptionSnippet);
  const channel = textOf(renderer.ownerText) || textOf(renderer.longBylineText);
  const published = textOf(renderer.publishedTimeText);
  const duration = textOf(renderer.lengthText);
  return {
    videoId,
    title,
    description,
    channel,
    published,
    duration,
    thumbnail: thumbnails[thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const query = String(req.query?.q || "").trim().slice(0, 160);
  const max = Math.min(8, Math.max(1, Number(req.query?.max) || 5));
  if (!query) return res.status(400).json({ error: "Missing q" });

  try {
    const response = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=US`,
      { headers: UA }
    );
    if (!response.ok) throw new Error(`YouTube ${response.status}`);
    const html = await response.text();
    const byId = new Map();
    for (const video of rendererObjects(html, max * 3).map(normalize).filter(Boolean)) {
      if (!byId.has(video.videoId)) byId.set(video.videoId, video);
    }
    const videos = [...byId.values()].slice(0, max);
    return res.status(200).json({ videos });
  } catch (error) {
    console.error("youtube-search:", error);
    return res.status(502).json({ error: `YouTube search failed: ${error.message}` });
  }
}
