// /api/expand — AI search-strategy generator. Given a topic (or a
// paper), Gemini/Claude produces a handful of literature-search queries
// and the best-fitting arXiv category, which the app then runs across
// arXiv + Semantic Scholar + OpenAlex.

import { complete } from "./_llm.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    console.error("expand:", `method ${req.method} not allowed`);
    return res.status(405).json({ error: "POST only" });
  }
  const { topic, paper, provider } = req.body || {};
  if (!topic && !paper?.title) {
    console.error("expand:", "need topic or paper");
    return res.status(400).json({ error: "Need topic or paper" });
  }

  const subject = topic
    ? `Research topic: "${String(topic).slice(0, 120)}"`
    : [
        `Paper title: ${paper.title}`,
        paper.methods?.length ? `Methods: ${paper.methods.join(", ")}` : "",
        `Abstract: ${(paper.abstract || "").slice(0, 1200)}`,
      ]
        .filter(Boolean)
        .join("\n");

  const prompt =
    "You are a research librarian designing a literature-search strategy.\n" +
    `${subject}\n\n` +
    (topic
      ? "Write up to 4 distinct, short search queries (2-4 words each) that together cover this topic: the main term, key synonyms, and the most important subtopics or methods."
      : "Write up to 4 distinct, short search queries (2-4 words each) that find papers closely related to this paper's topic, methods and main idea — not just its exact title.") +
    " Also pick the single best-fitting arXiv category code (e.g. quant-ph, cond-mat.mes-hall, q-bio.BM, physics.optics) or null if none fits.\n" +
    'Reply with ONLY strict JSON: {"queries": ["...", "..."], "arxivCat": "..." | null}';

  try {
    const text = await complete({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 250,
      prefer: provider,
    });
    let parsed = null;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?|```$/gm, "").trim());
    } catch {
      console.error("expand:", "unparseable model output:", text.slice(0, 150));
    }
    const queries = Array.isArray(parsed?.queries)
      ? parsed.queries.map((q) => String(q).slice(0, 60)).filter(Boolean).slice(0, 4)
      : [];
    const arxivCat =
      parsed?.arxivCat && /^[a-z-]+(\.[A-Za-z-]+)?$/.test(String(parsed.arxivCat))
        ? String(parsed.arxivCat)
        : null;
    if (!queries.length) {
      console.error("expand:", "no queries produced");
      return res.status(502).json({ error: "No queries produced" });
    }
    return res.status(200).json({ queries, arxivCat });
  } catch (err) {
    console.error("expand:", err);
    return res.status(502).json({ error: `Expand failed: ${err.message}` });
  }
}
