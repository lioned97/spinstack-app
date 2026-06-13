// /api/science-sources - curated science journals and research-news articles.
//
// The endpoint is called by the normal science search. It fetches a fixed
// allowlist of respected sources, enriches DOI records with Semantic Scholar
// abstracts, and returns items relevant to the user's tracked topics.

import { complete } from "./_llm.js";

const SOURCES = [
  { id: "nature", url: "https://www.nature.com/nature.rss", venue: "Nature", type: "journal" },
  { id: "science", url: "https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=science", venue: "Science", type: "journal" },
  { id: "pnas", url: "https://www.pnas.org/action/showFeed?type=etoc&feed=rss&jc=pnas", venue: "PNAS", type: "journal" },
  { id: "nature-physics", url: "https://www.nature.com/nphys.rss", venue: "Nature Physics", type: "journal" },
  { id: "prl", url: "https://feeds.aps.org/rss/recent/prl.xml", venue: "Physical Review Letters", type: "journal" },
  { id: "quantum-insider", url: "https://thequantuminsider.com/feed/", venue: "The Quantum Insider", type: "article" },
  { id: "physics-world", url: "https://physicsworld.com/feed/", venue: "Physics World", type: "article" },
  { id: "quanta", url: "https://www.quantamagazine.org/feed/", venue: "Quanta Magazine", type: "article" },
];

const UA = { "User-Agent": "SpinStack/3.0 (personal research tool)" };
const STOP_WORDS = new Set([
  "about", "after", "also", "and", "center", "from", "into", "open", "other",
  "research", "system", "systems", "that", "the", "their", "this", "using", "with",
]);

function decodeEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

const stripTags = (value) =>
  decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function pick(body, patterns) {
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return decodeEntities(match[1]).trim();
  }
  return "";
}

function imageFrom(body) {
  return pick(body, [
    /<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i,
    /<enclosure[^>]+type=["']image\/[^"']+["'][^>]+url=["']([^"']+)["']/i,
    /<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image\//i,
    /<img[^>]+src=["']([^"']+)["']/i,
  ]);
}

function parseFeed(xml, source) {
  const blocks = [
    ...xml.split(/<item[\s>]/i).slice(1).map((part) => part.split(/<\/item>/i)[0]),
    ...xml.split(/<entry[\s>]/i).slice(1).map((part) => part.split(/<\/entry>/i)[0]),
  ];
  const out = [];

  for (const body of blocks.slice(0, 5)) {
    const title = stripTags(pick(body, [/<title[^>]*>([\s\S]*?)<\/title>/i]));
    const description = stripTags(
      pick(body, [
        /<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i,
        /<description[^>]*>([\s\S]*?)<\/description>/i,
        /<summary[^>]*>([\s\S]*?)<\/summary>/i,
        /<content[^>]*>([\s\S]*?)<\/content>/i,
      ])
    );
    const rawDoi = stripTags(
      pick(body, [
        /<prism:doi[^>]*>([\s\S]*?)<\/prism:doi>/i,
        /<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier>/i,
      ])
    );
    const doiMatch = `${rawDoi} ${body}`.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
    const doi = doiMatch ? doiMatch[0].replace(/[).,;]+$/, "") : null;
    const url =
      stripTags(
        pick(body, [
          /<prism:url[^>]*>([\s\S]*?)<\/prism:url>/i,
          /<link[^>]*>([\s\S]*?)<\/link>/i,
        ])
      ) ||
      pick(body, [/<link[^>]+href=["']([^"']+)["']/i]) ||
      (doi ? `https://doi.org/${doi}` : "");
    const date = stripTags(
      pick(body, [
        /<prism:coverDate[^>]*>([\s\S]*?)<\/prism:coverDate>/i,
        /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i,
        /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i,
        /<updated[^>]*>([\s\S]*?)<\/updated>/i,
        /<published[^>]*>([\s\S]*?)<\/published>/i,
      ])
    );
    const authors = [
      ...body.matchAll(/<(?:dc:creator|author)[^>]*>([\s\S]*?)<\/(?:dc:creator|author)>/gi),
    ]
      .map((match) => stripTags(match[1]))
      .filter(Boolean);
    const yearMatch = date.match(/\b(20\d{2})\b/);

    if (title && url) {
      out.push({
        title,
        abstract: description,
        authors,
        year: yearMatch ? Number(yearMatch[1]) : new Date().getFullYear(),
        venue: source.venue,
        url,
        doi,
        image: imageFrom(body) || null,
        mediaType: source.type,
        sourceId: source.id,
      });
    }
  }
  return out;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5500);
  try {
    const response = await fetch(url, { headers: UA, signal: controller.signal });
    return response.ok ? response.text() : "";
  } finally {
    clearTimeout(timer);
  }
}

async function enrichAbstracts(items) {
  const doiItems = items.filter((item) => item.doi).slice(0, 80);
  if (!doiItems.length) return;
  try {
    const response = await fetch(
      "https://api.semanticscholar.org/graph/v1/paper/batch?fields=externalIds,abstract,year,authors",
      {
        method: "POST",
        headers: { ...UA, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: doiItems.map((item) => `DOI:${item.doi}`) }),
      }
    );
    if (!response.ok) return;
    const papers = await response.json();
    papers.forEach((paper, index) => {
      if (!paper) return;
      const item = doiItems[index];
      if (!item.abstract && paper.abstract) item.abstract = paper.abstract;
      if (paper.year) item.year = paper.year;
      if (!item.authors.length && paper.authors) {
        item.authors = paper.authors.map((author) => author.name).filter(Boolean);
      }
    });
  } catch (error) {
    console.error("science-sources: Semantic Scholar enrichment failed:", error.message);
  }
}

function keywordRelevant(item, topics) {
  if (!topics.length) return true;
  const text = `${item.title} ${item.abstract}`.toLowerCase();
  return topics.some((topic) => {
    const phrase = topic.toLowerCase().trim();
    if (phrase && text.includes(phrase)) return true;
    const tokens = phrase
      .split(/[^a-z0-9-]+/)
      .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
    return tokens.some((token) => text.includes(token));
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { topics, provider, sources } = req.body || {};
  const topicList = (Array.isArray(topics) ? topics : [])
    .map((topic) => String(topic).trim())
    .filter(Boolean)
    .slice(0, 24);
  const requestedSources = Array.isArray(sources) ? new Set(sources.map(String)) : null;
  const activeSources = requestedSources
    ? SOURCES.filter((source) => requestedSources.has(source.id))
    : SOURCES;

  try {
    const settled = await Promise.allSettled(
      activeSources.map(async (source) => parseFeed(await fetchText(source.url), source))
    );
    const byId = new Map();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const item of result.value) {
        const id = (item.doi || item.url).toLowerCase();
        if (!byId.has(id)) byId.set(id, item);
      }
    }

    const items = [...byId.values()].slice(0, 120);
    await enrichAbstracts(items);
    const eligible = items.filter(
      (item) => item.title && (item.abstract.length >= 40 || item.mediaType === "journal")
    );
    const candidates = [
      ...eligible.filter((item) => item.mediaType === "journal").slice(0, 40),
      ...eligible.filter((item) => item.mediaType === "article").slice(0, 20),
    ];

    let relevantIndexes = null;
    if (topicList.length && candidates.length) {
      try {
        const prompt =
          `A researcher tracks these topics: ${topicList.join(", ")}.\n` +
          "Select items that are genuinely relevant. Include research-news articles as well as papers. " +
          'Reply with strict JSON only: {"relevant":[number,...]}.\n\n' +
          candidates
            .map(
              (item, index) =>
                `[${index}] ${item.mediaType.toUpperCase()} | ${item.venue} | ${item.title}\n` +
                (item.abstract || "No abstract available.").slice(0, 500)
            )
            .join("\n\n");
        const text = await complete({
          messages: [{ role: "user", content: prompt }],
          maxTokens: 260,
          prefer: provider,
        });
        const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/gm, "").trim());
        if (Array.isArray(parsed?.relevant)) {
          relevantIndexes = new Set(
            parsed.relevant.map((value) => Number(value)).filter(Number.isInteger)
          );
        }
      } catch (error) {
        console.error("science-sources: AI relevance failed, using keyword fallback:", error.message);
      }
    }

    const relevant = candidates
      .filter((item, index) =>
        relevantIndexes ? relevantIndexes.has(index) : keywordRelevant(item, topicList)
      )
      .slice(0, 30);

    return res.status(200).json({
      scanned: items.length,
      aiFiltered: !!relevantIndexes,
      items: relevant,
    });
  } catch (error) {
    console.error("science-sources:", error);
    return res.status(502).json({ error: `Science source search failed: ${error.message}` });
  }
}
