// /api/pdf — streaming proxy so pdf.js can fetch arXiv PDFs without CORS
// issues. STRICT whitelist: arXiv hosts, /pdf/ paths only. Never an open
// proxy — anything else is 403.

export default async function handler(req, res) {
  const raw = req.query?.url || "";
  let target;
  try {
    target = new URL(String(raw));
  } catch {
    console.error("pdf:", "unparseable url", String(raw).slice(0, 200));
    return res.status(400).json({ error: "Bad url" });
  }
  const host = target.hostname.toLowerCase();
  const allowedHost =
    host === "arxiv.org" || host === "www.arxiv.org" || host === "export.arxiv.org";
  if (target.protocol !== "https:" || !allowedHost || !target.pathname.startsWith("/pdf/")) {
    console.error("pdf:", "blocked non-whitelisted url", target.href.slice(0, 200));
    return res.status(403).json({ error: "URL not allowed" });
  }

  try {
    const r = await fetch(target.href, { redirect: "follow" });
    if (!r.ok) {
      console.error("pdf:", `upstream ${r.status} for ${target.href}`);
      return res.status(502).json({ error: `Upstream ${r.status}` });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "public, s-maxage=604800");
    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(200).send(buf);
  } catch (err) {
    console.error("pdf:", err);
    return res.status(502).json({ error: "PDF fetch failed" });
  }
}
