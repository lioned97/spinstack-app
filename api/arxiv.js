// /api/arxiv — CORS middleman for the arXiv Atom API so the browser's
// live topic search can include arXiv (export.arxiv.org can't be called
// from the page). GET /api/arxiv?q=<terms>&cat=<category>&max=<n>

export default async function handler(req, res) {
  const q = String(req.query?.q || "").slice(0, 200).trim();
  const cat = String(req.query?.cat || "").slice(0, 40).trim();
  const max = Math.min(Math.max(parseInt(req.query?.max, 10) || 10, 1), 30);
  if (!q && !cat) {
    console.error("arxiv:", "missing q/cat");
    return res.status(400).json({ error: "Need q or cat" });
  }
  if (cat && !/^[a-z-]+(\.[A-Za-z-]+)?$/.test(cat)) {
    console.error("arxiv:", "bad category", cat);
    return res.status(400).json({ error: "Bad category" });
  }

  const queryUrl = (qExpr) => {
    const parts = [];
    if (qExpr) parts.push(qExpr);
    if (cat) parts.push(`cat:${cat}`);
    return (
      "https://export.arxiv.org/api/query?" +
      `search_query=${encodeURIComponent(parts.join(" AND "))}` +
      `&sortBy=submittedDate&sortOrder=descending&max_results=${max}`
    );
  };

  try {
    const headers = { "User-Agent": "SpinStack/2.0 (personal research tool)" };
    // exact phrase first; multi-word topics often have zero exact-phrase
    // hits, so fall back to AND-of-terms
    let r = await fetch(queryUrl(q ? `all:"${q}"` : ""), { headers });
    if (!r.ok) {
      console.error("arxiv:", `upstream ${r.status}`);
      return res.status(502).json({ error: `arXiv ${r.status}` });
    }
    let xml = await r.text();
    const words = q.split(/\s+/).filter(Boolean);
    if (!xml.includes("<entry") && words.length > 1) {
      r = await fetch(queryUrl(words.map((w) => `all:${w}`).join(" AND ")), { headers });
      if (r.ok) xml = await r.text();
      else console.error("arxiv:", `fallback upstream ${r.status}`);
    }
    res.setHeader("Content-Type", "application/atom+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=600");
    return res.status(200).send(xml);
  } catch (err) {
    console.error("arxiv:", err);
    return res.status(502).json({ error: "arXiv fetch failed" });
  }
}
