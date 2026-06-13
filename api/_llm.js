// Shared LLM completion for the api/ functions (the leading underscore
// keeps Vercel from exposing this file as an endpoint).
//
// Providers (any subset may be configured via Vercel env vars):
//   ANTHROPIC_API_KEY   → Claude   (text + vision)
//   GEMINI_API_KEY      → Gemini   (text + vision, free tier)
//   PERPLEXITY_API_KEY  → Sonar    (text only, live web-grounded search)
//
// `prefer` (one of "claude"|"gemini"|"perplexity") picks a provider when
// its key exists and it supports the request; otherwise we fall back
// through availableProviders() order. Vision requests skip Perplexity.
//
// A message may carry an optional `image` (a data URL like
// "data:image/jpeg;base64,…") for vision tasks.

const ENV = {
  claude: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};
const VISION_CAPABLE = new Set(["claude", "gemini"]);
// auto order: free/owned defaults first, Perplexity last (paid)
const AUTO_ORDER = ["claude", "gemini", "perplexity"];

const keyFor = (p) => process.env[ENV[p]];

export function availableProviders() {
  return AUTO_ORDER.filter(keyFor);
}

function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
  return m ? { mediaType: m[1], data: m[2] } : null;
}

async function callClaude(key, { system, messages, maxTokens }) {
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
      "x-api-key": key,
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

async function callGemini(key, { system, messages, maxTokens }) {
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
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
  );
  const data = await r.json();
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${data?.error?.message || "no message"}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text.trim()) throw new Error("Gemini returned an empty response");
  return text.trim();
}

async function callPerplexity(key, { system, messages, maxTokens }) {
  // OpenAI-compatible Chat Completions; sonar models do live web search.
  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  for (const m of messages) {
    // Perplexity is text-only; drop any image, keep the text prompt
    msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  const r = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.PERPLEXITY_MODEL || "sonar",
      messages: msgs,
      max_tokens: maxTokens,
    }),
  });
  const data = await r.json();
  if (!r.ok)
    throw new Error(`Perplexity ${r.status}: ${data?.error?.message || data?.error?.type || "no message"}`);
  return (data.choices?.[0]?.message?.content || "").trim();
}

const RUNNERS = { claude: callClaude, gemini: callGemini, perplexity: callPerplexity };

export async function complete({ system, messages, maxTokens = 500, prefer }) {
  const hasImage = messages.some((m) => m.image);
  // candidate providers: those with a key, vision-capable when needed
  let order = availableProviders().filter((p) => !hasImage || VISION_CAPABLE.has(p));
  if (prefer && order.includes(prefer)) order = [prefer, ...order.filter((p) => p !== prefer)];

  if (order.length === 0) {
    throw new Error(
      hasImage
        ? "No vision-capable LLM key configured — set ANTHROPIC_API_KEY or GEMINI_API_KEY."
        : "No LLM key configured — set ANTHROPIC_API_KEY, GEMINI_API_KEY or PERPLEXITY_API_KEY."
    );
  }

  let lastErr;
  for (const p of order) {
    try {
      return await RUNNERS[p](keyFor(p), { system, messages, maxTokens });
    } catch (err) {
      lastErr = err;
      console.error("_llm:", `${p} failed, trying next:`, err.message);
    }
  }
  throw lastErr || new Error("All providers failed");
}
