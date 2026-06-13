// /api/analyze — "Why this matters for my research". Uses Claude when
// ANTHROPIC_API_KEY is set, otherwise falls back to the free-tier
// Gemini key (see _llm.js). Keys live in Vercel env vars only; they
// never reach the browser.

import { complete } from "./_llm.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    console.error("analyze:", `method ${req.method} not allowed`);
    return res.status(405).json({ error: "POST only" });
  }

  const { paper, context, provider } = req.body || {};
  if (!paper || !paper.title) {
    console.error("analyze:", "missing paper in request body");
    return res.status(400).json({ error: "Missing paper in request body." });
  }

  const topics = (context?.topics || []).slice(0, 12).join(", ");
  const savedTitles = (context?.savedTitles || []).slice(0, 15);

  const prompt = [
    "You are advising a researcher working on NV-center magnetometry, quantum sensing,",
    "Hamiltonian engineering, and open quantum systems (Lindblad dynamics).",
    "",
    `Their tracked topics: ${topics || "NV centers, quantum sensing"}.`,
    savedTitles.length
      ? `Recent papers they saved:\n- ${savedTitles.join("\n- ")}`
      : "No saved-paper history yet.",
    "",
    "For the paper below, answer in under 150 words, plain prose, no headers:",
    "1) Why this matters for their research specifically (connect to their topics/saved work).",
    "2) One concrete way they could use or test it in an NV-center lab.",
    "Be direct and technical; if it's only tangentially relevant, say so honestly.",
    "",
    `Title: ${paper.title}`,
    `Venue/year: ${paper.venue || "?"} ${paper.year || ""}`,
    `Abstract: ${(paper.abstract || "").slice(0, 2500)}`,
  ].join("\n");

  try {
    const text = await complete({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 400,
      prefer: provider,
    });
    return res.status(200).json({ analysis: text || "Empty response from model." });
  } catch (err) {
    console.error("analyze:", err);
    return res.status(502).json({ error: `Analysis failed: ${err.message}` });
  }
}
