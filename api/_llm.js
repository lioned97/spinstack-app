// Shared LLM completion for the api/ functions (the leading underscore
// keeps Vercel from exposing this file as an endpoint).
//
// Provider order: ANTHROPIC_API_KEY (Claude) → GEMINI_API_KEY (free
// tier, same key the harvester uses) → throw. Lets the app run fully
// free when no Anthropic key is configured.
//
// A message may carry an optional `image` (a data URL like
// "data:image/jpeg;base64,…") for vision tasks — both providers below
// handle it.

function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
  return m ? { mediaType: m[1], data: m[2] } : null;
}

export async function complete({ system, messages, maxTokens = 500 }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (anthropicKey) {
    const body = {
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages: messages.map((m) => {
        const img = m.image ? splitDataUrl(m.image) : null;
        if (!img) return { role: m.role, content: m.content };
        return {
          role: m.role,
          content: [
            { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } },
            { type: "text", text: m.content },
          ],
        };
      }),
    };
    if (system) body.system = system;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${data?.error?.message || "no message"}`);
    return (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }

  if (geminiKey) {
    const payload = {
      contents: messages.map((m) => {
        const parts = [{ text: m.content }];
        const img = m.image ? splitDataUrl(m.image) : null;
        if (img) parts.unshift({ inline_data: { mime_type: img.mediaType, data: img.data } });
        return { role: m.role === "assistant" ? "model" : "user", parts };
      }),
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
    };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
    const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    const data = await r.json();
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${data?.error?.message || "no message"}`);
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    if (!text.trim()) throw new Error("Gemini returned an empty response");
    return text.trim();
  }

  throw new Error("No LLM key configured — set ANTHROPIC_API_KEY or GEMINI_API_KEY in Vercel.");
}
