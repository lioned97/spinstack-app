// /api/figure-caption — vision check for an extracted figure caption.
// Given the figure image and the caption text scraped from the PDF, a
// vision model decides whether the caption actually describes the
// figure. If it doesn't (or there is no caption), the model writes a
// short description, flagged aiGenerated so the UI can say so.

import { complete } from "./_llm.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    console.error("figure-caption:", `method ${req.method} not allowed`);
    return res.status(405).json({ error: "POST only" });
  }
  const { image, caption } = req.body || {};
  if (!image || !/^data:image\//.test(image)) {
    console.error("figure-caption:", "missing/invalid image");
    return res.status(400).json({ error: "Need a figure image (data URL)" });
  }

  const prompt =
    "You are shown a figure extracted from a physics/quantum research paper" +
    (caption
      ? `, and the caption text scraped from the PDF near it:\n"${String(caption).slice(0, 600)}"\n\n` +
        "Decide whether that caption actually describes what is visible in the figure."
      : ". No caption was found near it.\n\n") +
    " Reply with STRICT JSON only, no markdown:\n" +
    '{"match": true|false, "caption": "<the original caption if it matches well, otherwise a 1-2 sentence plain description of what the figure actually shows — axes, what is plotted, the apparent takeaway>"}';

  try {
    const text = await complete({
      messages: [{ role: "user", content: prompt, image }],
      maxTokens: 220,
    });
    let parsed = null;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?|```$/gm, "").trim());
    } catch {
      console.error("figure-caption:", "unparseable:", text.slice(0, 150));
    }
    if (!parsed || typeof parsed.caption !== "string" || !parsed.caption.trim()) {
      // fall back to whatever the PDF gave us
      return res.status(200).json({ caption: caption || "", aiGenerated: false });
    }
    const matched = parsed.match === true && !!caption;
    return res.status(200).json({
      caption: parsed.caption.trim(),
      // AI-generated whenever we did NOT keep the original PDF caption
      aiGenerated: !matched,
    });
  } catch (err) {
    console.error("figure-caption:", err);
    return res.status(502).json({ error: `Caption check failed: ${err.message}` });
  }
}
