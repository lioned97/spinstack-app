import { complete } from "./_llm.js";

// Helper to parse arXiv query entry XML using RegExp
function parseArxivXml(xml) {
  const entryStart = xml.indexOf("<entry>");
  if (entryStart === -1) return null;
  const entry = xml.slice(entryStart);

  const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(entry);
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(entry);
  const publishedMatch = /<published>([\s\S]*?)<\/published>/.exec(entry);
  
  let title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";
  let abstract = summaryMatch ? summaryMatch[1].replace(/\s+/g, " ").trim() : "";
  let year = publishedMatch ? parseInt(publishedMatch[1].slice(0, 4), 10) : new Date().getFullYear();

  // Remove "arXiv:" prefix if any
  title = title.replace(/^arXiv:\s*/gi, "");

  const authors = [];
  const authorRegex = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
  let match;
  while ((match = authorRegex.exec(entry)) !== null) {
    authors.push({ name: match[1].replace(/\s+/g, " ").trim() });
  }

  return {
    title,
    abstract,
    authors,
    year,
    venue: "arXiv",
    source: "arxiv"
  };
}

// Helper to parse CrossRef works JSON response
function parseCrossRefJson(item) {
  const title = Array.isArray(item.title) ? item.title[0] : (item.title || "");
  let abstract = item.abstract || "";
  // Strip JATS tags
  abstract = abstract.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  
  const authors = (item.author || []).map(a => ({
    name: `${a.given || ""} ${a.family || ""}`.trim()
  })).filter(a => a.name);

  let year = new Date().getFullYear();
  if (item["published-print"] && item["published-print"]["date-parts"]) {
    year = item["published-print"]["date-parts"][0][0];
  } else if (item["published-online"] && item["published-online"]["date-parts"]) {
    year = item["published-online"]["date-parts"][0][0];
  } else if (item.created && item.created["date-parts"]) {
    year = item.created["date-parts"][0][0];
  }

  const venue = Array.isArray(item["container-title"]) ? item["container-title"][0] : (item["container-title"] || "");

  return {
    title,
    abstract,
    authors,
    year,
    venue,
    doi: item.DOI,
    source: "crossref"
  };
}

// Helper to parse Semantic Scholar JSON
function parseS2Json(item) {
  const title = item.title || "";
  const abstract = item.abstract || "";
  const authors = (item.authors || []).map(a => ({ name: a.name })).filter(a => a.name);
  const year = item.year || new Date().getFullYear();
  const venue = item.venue || "";
  
  return {
    title,
    abstract,
    authors,
    year,
    venue,
    doi: item.externalIds?.DOI,
    arxivId: item.externalIds?.ArXiv,
    source: "semanticscholar"
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  const cleanUrl = url.trim();

  try {
    // 1. Check if arXiv ID or URL
    const arxivRegex = /(?:arxiv\.org\/(?:abs|pdf|html)\/|arxiv:)?([0-9]{4}\.[0-9]{4,5}|[a-z\-]+(?:\.[A-Z]{2})?\/[0-9]{7})(v[0-9]+)?/i;
    const arxivMatch = arxivRegex.exec(cleanUrl);
    if (arxivMatch && (cleanUrl.includes("arxiv.org") || /^[0-9]{4}\.[0-9]{4,5}/.test(cleanUrl))) {
      const arxivId = arxivMatch[1];
      const arxivApiUrl = `https://export.arxiv.org/api/query?id_list=${arxivId}`;
      const r = await fetch(arxivApiUrl, { headers: { "User-Agent": "SpinStack/2.0" } });
      if (r.ok) {
        const xml = await r.text();
        const parsed = parseArxivXml(xml);
        if (parsed) {
          parsed.arxivId = arxivId;
          parsed.url = `https://arxiv.org/abs/${arxivId}`;
          parsed.pdf = `https://arxiv.org/pdf/${arxivId}.pdf`;
          return res.status(200).json(parsed);
        }
      }
    }

    // 2. Check if DOI or DOI URL
    const doiRegex = /(?:doi\.org\/|doi:)\s*(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i;
    const doiMatch = doiRegex.exec(cleanUrl);
    if (doiMatch) {
      const doi = doiMatch[1];
      const crossrefUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
      const r = await fetch(crossrefUrl, {
        headers: { "User-Agent": "SpinStack/2.0 (mailto:lioned97@gmail.com; personal research PWA)" }
      });
      if (r.ok) {
        const data = await r.json();
        if (data.message) {
          const parsed = parseCrossRefJson(data.message);
          parsed.url = cleanUrl.startsWith("http") ? cleanUrl : `https://doi.org/${doi}`;
          return res.status(200).json(parsed);
        }
      }
    }

    // 3. Check if Semantic Scholar URL
    const s2Regex = /semanticscholar\.org\/paper\/.*\/([0-9a-f]{40})/i;
    const s2Match = s2Regex.exec(cleanUrl);
    if (s2Match) {
      const s2Id = s2Match[1];
      const s2ApiUrl = `https://api.semanticscholar.org/graph/v1/paper/${s2Id}?fields=title,abstract,authors,year,venue,externalIds`;
      const r = await fetch(s2ApiUrl);
      if (r.ok) {
        const data = await r.json();
        const parsed = parseS2Json(data);
        parsed.url = cleanUrl;
        return res.status(200).json(parsed);
      }
    }

    // 4. General fallback: Fetch page HTML to look for metadata tags or LLM fallback
    if (cleanUrl.startsWith("http")) {
      const r = await fetch(cleanUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
        }
      });
      if (r.ok) {
        const html = await r.text();

        // 4a. Check meta tags for DOI in HTML
        let embeddedDoi = null;
        const metaDoiRegexes = [
          /<meta\s+name=["']citation_doi["']\s+content=["'](.*?)["']/i,
          /<meta\s+content=["'](.*?)["']\s+name=["']citation_doi["']/i,
          /<meta\s+name=["']dc.identifier["']\s+content=["']doi:(.*?)["']/i,
          /<meta\s+content=["']doi:(.*?)["']\s+name=["']dc.identifier["']/i,
        ];
        for (const regex of metaDoiRegexes) {
          const m = regex.exec(html);
          if (m) {
            embeddedDoi = m[1].trim();
            break;
          }
        }

        if (embeddedDoi) {
          const crossrefUrl = `https://api.crossref.org/works/${encodeURIComponent(embeddedDoi)}`;
          const crRes = await fetch(crossrefUrl, {
            headers: { "User-Agent": "SpinStack/2.0 (mailto:lioned97@gmail.com; personal research PWA)" }
          });
          if (crRes.ok) {
            const data = await crRes.json();
            if (data.message) {
              const parsed = parseCrossRefJson(data.message);
              parsed.url = cleanUrl;
              return res.status(200).json(parsed);
            }
          }
        }

        // 4b. Check meta tags for arXiv ID in HTML
        let embeddedArxiv = null;
        const metaArxivRegexes = [
          /<meta\s+name=["']citation_arxiv_id["']\s+content=["'](.*?)["']/i,
          /<meta\s+content=["'](.*?)["']\s+name=["']citation_arxiv_id["']/i,
        ];
        for (const regex of metaArxivRegexes) {
          const m = regex.exec(html);
          if (m) {
            embeddedArxiv = m[1].trim();
            break;
          }
        }

        if (embeddedArxiv) {
          const arxivApiUrl = `https://export.arxiv.org/api/query?id_list=${embeddedArxiv}`;
          const axRes = await fetch(arxivApiUrl, { headers: { "User-Agent": "SpinStack/2.0" } });
          if (axRes.ok) {
            const axXml = await axRes.text();
            const parsed = parseArxivXml(axXml);
            if (parsed) {
              parsed.arxivId = embeddedArxiv;
              parsed.url = cleanUrl;
              parsed.pdf = `https://arxiv.org/pdf/${embeddedArxiv}.pdf`;
              return res.status(200).json(parsed);
            }
          }
        }

        // 4c. LLM Fallback extraction
        const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
        const pageTitle = titleMatch ? titleMatch[1].trim() : "";

        // Remove script/style tags and grab raw body text
        const bodyText = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 5000);

        const prompt = [
          "You are an academic metadata extraction tool. Extract information about the scientific paper from the following webpage content.",
          "Output your answer as a JSON object with the following fields: 'title', 'abstract', 'authors' (array of objects with 'name' property), 'year' (integer), 'venue' (journal/conference name). Do not include any markdown wrapper or other text, return ONLY valid raw JSON.",
          "",
          `Webpage title: ${pageTitle}`,
          `Content snippet: ${bodyText}`
        ].join("\n");

        try {
          const responseText = await complete({
            messages: [{ role: "user", content: prompt }],
            maxTokens: 500
          });
          const cleanJson = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
          const parsed = JSON.parse(cleanJson);
          
          return res.status(200).json({
            title: parsed.title || pageTitle || "Unknown Paper",
            abstract: parsed.abstract || "",
            authors: Array.isArray(parsed.authors) ? parsed.authors.map(a => typeof a === "string" ? { name: a } : a) : [],
            year: parseInt(parsed.year, 10) || new Date().getFullYear(),
            venue: parsed.venue || "",
            url: cleanUrl,
            source: "llm-extract"
          });
        } catch (llmErr) {
          console.error("LLM fallback extraction failed:", llmErr);
        }
      }
    }

    // Fallback when fetch fails or not a URL
    return res.status(200).json({
      title: cleanUrl.startsWith("http") ? cleanUrl.split("/").pop() || "Uploaded Paper" : "Uploaded Paper",
      abstract: "",
      authors: [],
      year: new Date().getFullYear(),
      venue: "",
      url: cleanUrl.startsWith("http") ? cleanUrl : "",
      source: "fallback"
    });

  } catch (err) {
    console.error("paper-meta:", err);
    return res.status(502).json({ error: `Failed to resolve metadata: ${err.message}` });
  }
}
