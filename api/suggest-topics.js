import { complete } from "./_llm.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { title, abstract, existingTopics } = req.body || {};
  if (!title) {
    return res.status(400).json({ error: "Paper title is required" });
  }

  const tracked = Array.isArray(existingTopics) ? existingTopics : [];

  const prompt = [
    "You are an AI research assistant advising a physicist working on NV-center magnetometry, quantum sensing, and quantum information.",
    `Based on the scientific paper below, suggest exactly 3 specific, relevant research topics or keywords that are highly related to this paper but are NOT already in the user's tracked list.`,
    "",
    `User's tracked list (DO NOT SUGGEST ANY OF THESE):`,
    tracked.length ? `- ${tracked.join("\n- ")}` : "(None)",
    "",
    `Paper Title: ${title}`,
    `Paper Abstract: ${abstract || "(No abstract provided)"}`,
    "",
    "Format your output as a JSON object containing a single key 'topics' which is an array of exactly 3 strings (e.g. { \"topics\": [\"topic1\", \"topic2\", \"topic3\"] }). Do not wrap in markdown or include extra text; output ONLY valid JSON.",
  ].join("\n");

  try {
    const text = await complete({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 150
    });

    const cleanJson = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const data = JSON.parse(cleanJson);
    
    return res.status(200).json({
      topics: Array.isArray(data.topics) ? data.topics.slice(0, 3) : []
    });

  } catch (err) {
    console.error("suggest-topics:", err);
    // Return empty array on failure so it degrades gracefully
    return res.status(200).json({ topics: [] });
  }
}
