// /api/paper-chat — selection EXPLAIN / QUESTIONS and free chat grounded
// in one paper, via Claude. ANTHROPIC_API_KEY lives in Vercel env only.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    console.error("paper-chat:", `method ${req.method} not allowed`);
    return res.status(405).json({ error: "POST only" });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("paper-chat:", "ANTHROPIC_API_KEY not set");
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not set." });
  }

  const { mode, paper, selection, messages } = req.body || {};
  if (!paper || !paper.title || !["explain", "questions", "chat"].includes(mode)) {
    console.error("paper-chat:", "bad request body", JSON.stringify({ mode, hasPaper: !!paper }));
    return res.status(400).json({ error: "Bad request: need mode + paper.title" });
  }

  const system = [
    "You are advising a researcher working on NV-center magnetometry, quantum sensing,",
    "Hamiltonian engineering, and open quantum systems (Lindblad dynamics).",
    "Ground every answer in the paper below. Be direct and technical; if something",
    "is uncertain from the abstract alone, say so.",
    "",
    `Paper: ${paper.title}`,
    `Venue/year: ${paper.venue || "?"} ${paper.year || ""}`,
    `Abstract: ${(paper.abstract || "").slice(0, 2500)}`,
    selection ? `\nSelected passage:\n"${String(selection).slice(0, 1500)}"` : "",
  ].join("\n");

  let msgs;
  if (mode === "explain") {
    msgs = [
      {
        role: "user",
        content:
          "In at most 3 sentences, explain what the selected passage means in the context of this paper.",
      },
    ];
  } else if (mode === "questions") {
    msgs = [
      {
        role: "user",
        content:
          "Write exactly 3 incisive questions about the selected passage in this paper's context. " +
          'Reply with ONLY a JSON array of 3 strings — no markdown fences, no commentary.',
      },
    ];
  } else {
    const hist = (Array.isArray(messages) ? messages : [])
      .slice(-12)
      .filter((m) => m && m.text && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({ role: m.role, content: String(m.text).slice(0, 2000) }));
    // Anthropic requires user-first, alternating roles
    const merged = [];
    for (const m of hist) {
      if (merged.length && merged[merged.length - 1].role === m.role) {
        merged[merged.length - 1].content += `\n${m.content}`;
      } else {
        merged.push({ ...m });
      }
    }
    while (merged.length && merged[0].role !== "user") merged.shift();
    if (!merged.length || merged[merged.length - 1].role !== "user") {
      console.error("paper-chat:", "chat mode without a trailing user message");
      return res.status(400).json({ error: "Chat needs a user message." });
    }
    msgs = merged;
  }

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
        max_tokens: 500,
        system,
        messages: msgs,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("paper-chat:", `Anthropic API ${r.status}: ${data?.error?.message || "no message"}`);
      return res.status(502).json({ error: data?.error?.message || `Anthropic API ${r.status}` });
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (mode === "questions") {
      let questions = null;
      try {
        const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/gm, "").trim());
        if (Array.isArray(parsed)) questions = parsed.map(String).slice(0, 3);
      } catch {
        // model ignored the JSON instruction — salvage question-looking lines
        questions = text
          .split("\n")
          .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
          .filter((l) => l.endsWith("?"))
          .slice(0, 3);
      }
      if (!questions || questions.length === 0) {
        console.error("paper-chat:", "questions mode produced no parseable questions:", text.slice(0, 200));
        return res.status(502).json({ error: "Couldn't generate questions." });
      }
      return res.status(200).json({ questions });
    }
    return res.status(200).json({ text: text || "Empty response from model." });
  } catch (err) {
    console.error("paper-chat:", err);
    return res.status(502).json({ error: `Chat failed: ${err.message}` });
  }
}
