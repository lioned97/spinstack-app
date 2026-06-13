const SOURCE_FALLBACK_LABELS = {
  arxiv: "arXiv",
  "semantic-scholar": "Semantic Scholar",
  "s2-live": "Semantic Scholar",
  openalex: "OpenAlex",
  "openalex-live": "OpenAlex",
  pubmed: "PubMed",
  journal: "Journal feeds",
  "science-news": "Science articles",
  nature: "Nature",
  science: "Science",
  pnas: "PNAS",
  "nature-physics": "Nature Physics",
  prl: "Physical Review Letters",
  "quantum-insider": "The Quantum Insider",
  "physics-world": "Physics World",
  quanta: "Quanta Magazine",
  wikivoyage: "Wikivoyage",
  wikipedia: "Wikipedia",
  youtube: "YouTube",
  rss: "RSS feeds",
};

function canonicalScienceVenue(venue) {
  const normalized = venue.toLowerCase();
  if (normalized === "nature communications") return "Nature Communications";
  if (normalized === "nature physics") return "Nature Physics";
  if (normalized === "physical review letters") return "Physical Review Letters";
  if (normalized === "science" || normalized === "science (new york, n.y.)") return "Science";
  if (normalized.startsWith("proceedings of the national academy of sciences")) return "PNAS";
  return venue;
}

export function sourceNameOf(item) {
  const category = item?.category || "science";
  const venue = String(item?.venue || "").trim();
  if (venue) return category === "science" ? canonicalScienceVenue(venue) : venue;

  const source = String(item?.source || "").trim();
  return SOURCE_FALLBACK_LABELS[source] || source || (category === "travel" ? "Travel source" : "Publication");
}
