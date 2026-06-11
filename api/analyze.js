// /api/analyze — "Why this matters for my research" via Claude.
// The ANTHROPIC_API_KEY lives in Vercel project env vars only;
// it never reaches the browser.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    console.error("analyze:", `method ${req.method} not allowed`);
    return res.status(405).json({ error: "POST only" });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("analyze:", "ANTHROPIC_API_KEY not set");
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY not set in Vercel project environment variables." });
  }

  const { paper, context } = req.body || {};
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
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("analyze:", `Anthropic API ${r.status}: ${data?.error?.message || "no message"}`);
      return res.status(502).json({ error: data?.error?.message || `Anthropic API ${r.status}` });
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return res.status(200).json({ analysis: text || "Empty response from model." });
  } catch (err) {
    console.error("analyze:", err);
    return res.status(502).json({ error: `Analysis failed: ${err.message}` });
  }
}
