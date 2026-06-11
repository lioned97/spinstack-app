// /api/paper-chat — selection EXPLAIN / QUESTIONS and free chat grounded
// in one paper. Claude when ANTHROPIC_API_KEY is set, else free-tier
// Gemini (see _llm.js). Keys live in Vercel env only.

import { complete } from "./_llm.js";

export default async function handler(req, res) {
  // GET = health check: which provider would answer? (names only, no secrets)
  if (req.method === "GET") {
    const provider = process.env.ANTHROPIC_API_KEY
      ? "claude"
      : process.env.GEMINI_API_KEY
        ? "gemini"
        : null;
    return res.status(200).json({ ok: !!provider, provider });
  }
  if (req.method !== "POST") {
    console.error("paper-chat:", `method ${req.method} not allowed`);
    return res.status(405).json({ error: "POST only" });
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
    const text = await complete({ system, messages: msgs, maxTokens: 500 });

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
