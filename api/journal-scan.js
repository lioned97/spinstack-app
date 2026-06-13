// /api/journal-scan — abstract-triage for Nature-family journals.
//
// Nature RSS lists titles + DOIs but NOT abstracts, so we: (1) fetch the
// whitelisted feeds, (2) pull each item's abstract from OpenAlex by DOI
// (server-side, CORS-free), (3) ask the LLM which abstracts are relevant
// to the user's tracked topics. Returns only the relevant items — the
// app turns each into a card the user can attach a PDF to manually.

import { complete } from "./_llm.js";

// whitelist: feed key → { url, venue }. Only these hosts are fetched.
const FEEDS = {
  nature: { url: "https://www.nature.com/nature.rss", venue: "Nature" },
  nphys: { url: "https://www.nature.com/nphys.rss", venue: "Nature Physics" },
  ncomms: { url: "https://www.nature.com/ncomms.rss", venue: "Nature Communications" },
  natrevphys: { url: "https://www.nature.com/natrevphys.rss", venue: "Nature Reviews Physics" },
  nnano: { url: "https://www.nature.com/nnano.rss", venue: "Nature Nanotechnology" },
  nmat: { url: "https://www.nature.com/nmat.rss", venue: "Nature Materials" },
};
const DEFAULT_FEEDS = ["nphys", "nature", "ncomms", "natrevphys"];
const UA = { "User-Agent": "SpinStack/3.0 (personal research tool)" };

const stripTags = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

function parseFeed(xml, venueFallback) {
  const out = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const b of blocks) {
    const body = b.split("</item>")[0];
    const pick = (re) => {
      const m = body.match(re);
      return m ? stripTags(m[1]) : "";
    };
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/);
    const doi = pick(/<prism:doi[^>]*>([\s\S]*?)<\/prism:doi>/);
    const url =
      pick(/<prism:url[^>]*>([\s\S]*?)<\/prism:url>/) ||
      pick(/<link[^>]*>([\s\S]*?)<\/link>/) ||
      (doi ? `https://doi.org/${doi}` : "");
    const date =
      pick(/<prism:coverDate[^>]*>([\s\S]*?)<\/prism:coverDate>/) ||
      pick(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) ||
      pick(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/);
    const venue = pick(/<prism:publicationName[^>]*>([\s\S]*?)<\/prism:publicationName>/) || venueFallback;
    const authors = [...body.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/g)]
      .map((m) => stripTags(m[1]))
      .filter(Boolean);
    const ym = date.match(/\d{4}/);
    if (title && (doi || url)) {
      out.push({ title, doi: doi || null, url, venue, authors, year: ym ? parseInt(ym[0], 10) : null });
    }
  }
  return out;
}

function reconstructAbstract(inv) {
  try {
    const words = [];
    Object.entries(inv).forEach(([w, ps]) => ps.forEach((p) => (words[p] = w)));
    return words.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    console.error("journal-scan:", `method ${req.method} not allowed`);
    return res.status(405).json({ error: "POST only" });
  }
  const { feeds, topics, provider } = req.body || {};
  const keys = (Array.isArray(feeds) && feeds.length ? feeds : DEFAULT_FEEDS).filter((k) => FEEDS[k]);
  const topicList = (Array.isArray(topics) ? topics : []).map(String).filter(Boolean).slice(0, 24);

  try {
    // 1. fetch feeds in parallel
    const feedResults = await Promise.allSettled(
      keys.map((k) =>
        fetch(FEEDS[k].url, { headers: UA }).then((r) => (r.ok ? r.text() : "")).then((xml) => parseFeed(xml, FEEDS[k].venue))
      )
    );
    const byKey = new Map();
    for (const r of feedResults) {
      if (r.status !== "fulfilled") continue;
      for (const it of r.value) {
        const id = (it.doi || it.url).toLowerCase();
        if (!byKey.has(id)) byKey.set(id, it);
      }
    }
    let items = [...byKey.values()].slice(0, 40);
    if (items.length === 0) {
      console.error("journal-scan:", "no items parsed from feeds", keys.join(","));
      return res.status(200).json({ scanned: 0, items: [] });
    }

    // 2. pull abstracts from OpenAlex by DOI (one batched call)
    const dois = items.filter((i) => i.doi).map((i) => i.doi.toLowerCase());
    if (dois.length) {
      try {
        const oaUrl =
          `https://api.openalex.org/works?filter=doi:${dois.join("|")}` +
          `&per_page=${Math.min(dois.length, 50)}&select=doi,abstract_inverted_index,publication_year`;
        const oaRes = await fetch(oaUrl, { headers: UA });
        if (oaRes.ok) {
          const data = await oaRes.json();
          const absByDoi = {};
          for (const w of data.results || []) {
            const d = (w.doi || "").replace("https://doi.org/", "").toLowerCase();
            if (d && w.abstract_inverted_index) {
              absByDoi[d] = { abstract: reconstructAbstract(w.abstract_inverted_index), year: w.publication_year };
            }
          }
          for (const it of items) {
            const hit = it.doi && absByDoi[it.doi.toLowerCase()];
            if (hit) {
              it.abstract = hit.abstract;
              it.year = it.year || hit.year;
            }
          }
        }
      } catch (e) {
        console.error("journal-scan:", "OpenAlex abstract fetch failed:", e.message);
      }
    }
    // can only triage items whose abstract we actually have
    const withAbstract = items.filter((i) => (i.abstract || "").length >= 120);
    if (withAbstract.length === 0) {
      return res.status(200).json({ scanned: items.length, items: [], note: "abstracts not yet indexed" });
    }

    // 3. relevance — one LLM call over the abstracts; keyword fallback
    let relevantIdx = null;
    if (topicList.length) {
      try {
        const prompt =
          `A researcher tracks these topics: ${topicList.join(", ")}.\n` +
          "For each numbered paper, decide whether its abstract is genuinely relevant to those topics. " +
          'Reply with STRICT JSON only: {"relevant": [list of the numbers that are relevant]}.\n\n' +
          withAbstract
            .map((it, i) => `[${i}] ${it.title}\n${(it.abstract || "").slice(0, 500)}`)
            .join("\n\n");
        const text = await complete({
          messages: [{ role: "user", content: prompt }],
          maxTokens: 200,
          prefer: provider,
        });
        const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/gm, "").trim());
        if (Array.isArray(parsed?.relevant)) {
          relevantIdx = new Set(parsed.relevant.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)));
        }
      } catch (e) {
        console.error("journal-scan:", "AI relevance failed, using keyword fallback:", e.message);
      }
    }
    const lowTopics = topicList.map((t) => t.toLowerCase());
    const keep = withAbstract.filter((it, i) => {
      if (relevantIdx) return relevantIdx.has(i);
      if (!lowTopics.length) return true;
      const blob = `${it.title} ${it.abstract}`.toLowerCase();
      return lowTopics.some((t) => blob.includes(t));
    });

    return res.status(200).json({
      scanned: items.length,
      aiFiltered: !!relevantIdx,
      items: keep.map((it) => ({
        title: it.title,
        abstract: it.abstract,
        authors: it.authors,
        year: it.year,
        venue: it.venue,
        url: it.url,
        doi: it.doi,
      })),
    });
  } catch (err) {
    console.error("journal-scan:", err);
    return res.status(502).json({ error: `Journal scan failed: ${err.message}` });
  }
}
