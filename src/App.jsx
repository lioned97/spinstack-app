import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Layers,
  List,
  Bookmark,
  Hash,
  Settings as SettingsIcon,
  ExternalLink,
  Sparkles,
  RefreshCw,
  X,
  Heart,
  Trash2,
  Share2,
  Eye,
  EyeOff,
  Pencil,
  BookOpen,
  MessageCircle,
  Send,
  Paperclip,
  Newspaper,
  Network,
  Plus,
  Map as MapIcon,
  Filter as FilterIcon,
  MoreHorizontal,
  ArrowLeft,
} from "lucide-react";
import { sGet, persist, onSyncStatus } from "./sync.js";
import { savePdf, loadPdf } from "./pdfstore.js";
import PaperCard from "./PaperCard.jsx";

// pdf.js / leaflet ride in their own chunks — loaded on first use
const Reader = React.lazy(() => import("./Reader.jsx"));
const MapView = React.lazy(() => import("./MapView.jsx"));

const HARVEST_URL =
  "https://raw.githubusercontent.com/lioned97/spinstack-harvest/main/papers/latest.json";

// Topics belong to a category; each category has its own search engines
// and card layout. Missing category anywhere = "science" (legacy data).
const CATEGORIES = ["science", "travel"];

const DEFAULT_TOPICS = {
  science: [
    "NV center",
    "nitrogen-vacancy",
    "quantum sensing",
    "magnetometry",
    "open quantum systems",
    "Lindblad dynamics",
    "spin coherence",
    "decoherence",
    "Hamiltonian engineering",
    "quantum memory",
  ],
  // placeholders — edit freely, they're restorable per category
  travel: ["Israel National Trail", "hiking Patagonia", "science museums Europe"],
};

const CATEGORY_ANCHORS = {
  science: {
    "nv center": 1.6,
    "nitrogen-vacancy": 1.6,
    "open quantum": 1.4,
    decoherence: 1.35,
    "quantum sensing": 1.3,
    "spin coherence": 1.3,
    magnetometry: 1.3,
    lindblad: 1.25,
    "hamiltonian engineering": 1.25,
  },
  travel: {},
};

const THEME_COLORS = { dark: "#121316", light: "#faf9fa" };

const SOURCE_LABELS = {
  arxiv: "arXiv",
  "semantic-scholar": "Semantic Scholar",
  "s2-live": "Semantic Scholar (live)",
  openalex: "OpenAlex",
  "openalex-live": "OpenAlex (live)",
  pubmed: "PubMed",
  journal: "Journal feeds",
  wikivoyage: "Wikivoyage",
  wikipedia: "Wikipedia",
  rss: "RSS feeds",
};

const PROVIDER_LABELS = {
  auto: "Auto",
  gemini: "Gemini Flash",
  claude: "Claude Haiku",
  perplexity: "Perplexity Sonar",
};

const SORT_LABELS = {
  relevance: "RELEVANCE",
  papers: "PAPERS FIRST",
  newest: "NEWEST",
  year: "YEAR",
  source: "SOURCE",
  title: "A–Z",
};

// ── helpers ────────────────────────────────────────────────

const nowISO = () => new Date().toISOString();

const catOf = (x) => (x && x.category) || "science";

// Persist the device-local paper pool. Figures are base64 image data —
// far too big for the ~5MB localStorage quota on mobile, and not needed
// for the offline feed (they re-fetch on demand), so strip them before
// writing. Wrapped so a QuotaExceededError can NEVER bubble out of a
// React state updater and white-screen the whole app.
function savePool(arr) {
  try {
    const slim = arr.map((p) =>
      p && p.figures ? { ...p, figures: undefined, figuresTried: undefined } : p
    );
    localStorage.setItem("ss2_pool", JSON.stringify(slim));
  } catch (e) {
    console.warn("ss2_pool not cached:", e && e.name);
  }
}

function arxivIdOf(p) {
  if (p.arxivId) return String(p.arxivId).replace(/v\d+$/, "");
  if (typeof p.id === "string" && p.id.startsWith("arxiv:")) return p.id.slice(6);
  const m = `${p.url || ""} ${p.pdf || ""}`.match(/arxiv\.org\/(?:abs|pdf)\/([0-9.]+)/i);
  return m ? m[1].replace(/\.$/, "") : null;
}

const isArxivUrl = (u) => {
  try {
    return /(^|\.)arxiv\.org$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
};

// Semantic Scholar lookup id for the related-papers graph
const s2IdOf = (p) => {
  if (p.doi) return `DOI:${p.doi}`;
  const ax = arxivIdOf(p);
  if (ax) return `ARXIV:${ax}`;
  if (typeof p.id === "string") {
    if (p.id.startsWith("s2:")) return p.id.slice(3);
    if (p.id.startsWith("doi:")) return `DOI:${p.id.slice(4)}`;
  }
  // OpenAlex-live items carry the DOI as a URL in id/url
  const m = `${p.id || ""} ${p.url || ""}`.match(/doi\.org\/(10\.\S+?)(?:[\s"']|$)/i);
  if (m) return `DOI:${m[1]}`;
  return null;
};

const isDefaultTopic = (t) =>
  (DEFAULT_TOPICS[catOf(t)] || []).some(
    (d) => d.toLowerCase() === (t.name || "").toLowerCase()
  );

// OpenAlex ships abstracts as inverted index — rebuild text.
function reconstructAbstract(inv) {
  try {
    const words = [];
    Object.entries(inv).forEach(([w, positions]) => positions.forEach((p) => (words[p] = w)));
    return words.join(" ").trim();
  } catch {
    return "";
  }
}

function normalizeOpenAlex(r) {
  if (!r) return null;
  const title = r.title || r.display_name || "";
  if (!title) return null;
  const year = r.publication_year;
  return {
    id: r.doi || r.id || `${title.slice(0, 40)}-${year}`,
    title,
    abstract:
      r.abstract ||
      (r.abstract_inverted_index ? reconstructAbstract(r.abstract_inverted_index) : "") ||
      "Abstract unavailable.",
    authors: (r.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    year,
    venue: r.primary_location?.source?.display_name || "OpenAlex",
    url: r.doi || r.id || "",
    source: "openalex-live",
    harvestedAt: nowISO(),
  };
}

// Semantic Scholar live search — normalized like the harvester:
// id priority doi > arXiv > s2 paperId.
function normalizeS2(r) {
  if (!r) return null;
  const title = r.title || "";
  if (!title) return null;
  const ext = r.externalIds || {};
  const doi = ext.DOI;
  const axv = ext.ArXiv;
  const id = doi
    ? `doi:${doi.toLowerCase()}`
    : axv
      ? `arxiv:${axv}`
      : `s2:${r.paperId}`;
  return {
    id,
    doi,
    arxivId: axv,
    title,
    abstract: r.abstract || "",
    authors: (r.authors || []).map((a) => a.name).filter(Boolean),
    year: r.year,
    venue: r.venue || (axv ? "arXiv" : "Semantic Scholar"),
    url: r.openAccessPdf?.url || r.url || "",
    pdf: r.openAccessPdf?.url,
    source: "s2-live",
    harvestedAt: nowISO(),
  };
}

// MediaWiki search (Wikivoyage/Wikipedia) → item schema, travel category.
function normalizeWiki(page, { tag, venue, host }) {
  if (!page) return null;
  const title = page.title || "";
  const extract = (page.extract || "").trim();
  if (!title || extract.length < 120 || extract.includes("may refer to")) return null;
  const thumb = page.thumbnail?.source;
  const coord = page.coordinates?.[0];
  return {
    ...(coord && coord.lat != null ? { coordinates: [coord.lat, coord.lon] } : {}),
    id: `${tag}:${page.pageid}`,
    title,
    abstract: extract.slice(0, 1200),
    authors: [],
    year: new Date().getFullYear(),
    venue,
    url: `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    images: thumb ? [thumb] : [],
    category: "travel",
    source: venue.toLowerCase(),
    harvestedAt: nowISO(),
  };
}

const WIKI_SOURCES = [
  { tag: "wv", venue: "Wikivoyage", host: "en.wikivoyage.org" },
  { tag: "wp", venue: "Wikipedia", host: "en.wikipedia.org" },
];

async function fetchWiki(topicName, src) {
  const url =
    `https://${src.host}/w/api.php?action=query&generator=search` +
    `&gsrsearch=${encodeURIComponent(topicName)}&gsrlimit=6` +
    `&prop=extracts%7Cpageimages%7Ccoordinates&exintro=1&explaintext=1` +
    `&piprop=thumbnail&pithumbsize=640&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return Object.values(data.query?.pages || {})
    .map((p) => normalizeWiki(p, src))
    .filter(Boolean);
}

// arXiv Atom (via our /api/arxiv CORS middleman) → item schema
function parseArxivAtom(xmlText) {
  const out = [];
  try {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    for (const e of doc.querySelectorAll("entry")) {
      const rawId = (e.querySelector("id")?.textContent || "").split("/").pop() || "";
      const baseId = rawId.replace(/v\d+$/, "");
      if (!baseId) continue;
      const title = (e.querySelector("title")?.textContent || "").replace(/\s+/g, " ").trim();
      const published = e.querySelector("published")?.textContent || "";
      out.push({
        id: `arxiv:${baseId}`,
        arxivId: rawId,
        title,
        abstract: (e.querySelector("summary")?.textContent || "").replace(/\s+/g, " ").trim(),
        authors: [...e.querySelectorAll("author > name")].map((n) => n.textContent).filter(Boolean),
        year: parseInt(published.slice(0, 4), 10) || null,
        venue: "arXiv",
        url: `https://arxiv.org/abs/${rawId}`,
        pdf: `https://arxiv.org/pdf/${rawId}`,
        source: "arxiv",
        harvestedAt: nowISO(),
      });
    }
  } catch {}
  return out;
}

// the search string a topic actually uses: name + optional extra keywords
const topicQuery = (t) => (t.keywords ? `${t.name} ${t.keywords}` : t.name).trim();

// Live science search across arXiv + Semantic Scholar + OpenAlex in
// parallel, honouring the topic's per-source toggles and arXiv category.
async function fetchScienceTopic(t) {
  const enabled = (s) => !t.sources || t.sources.length === 0 || t.sources.includes(s);
  const q = topicQuery(t);
  const jobs = [];
  if (enabled("arxiv")) {
    jobs.push(
      fetch(
        `/api/arxiv?q=${encodeURIComponent(q)}${t.arxivCat ? `&cat=${encodeURIComponent(t.arxivCat)}` : ""}&max=10`
      )
        .then((r) => (r.ok ? r.text() : ""))
        .then((xml) => ["arxiv", parseArxivAtom(xml)])
    );
  }
  if (enabled("semantic-scholar")) {
    jobs.push(
      fetch(
        `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
          q
        )}&limit=8&fields=title,abstract,year,venue,authors,externalIds,url,openAccessPdf`
      )
        .then((r) => (r.ok ? r.json() : { data: [] }))
        .then((d) => ["s2", (d.data || []).map(normalizeS2)])
    );
  }
  if (enabled("openalex")) {
    jobs.push(
      fetch(
        `https://api.openalex.org/works?filter=title_and_abstract.search:${encodeURIComponent(
          q
        )}&per_page=12&sort=publication_year:desc`
      )
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((d) => ["openalex", (d.results || []).map(normalizeOpenAlex)])
    );
  }
  const settled = await Promise.allSettled(jobs);
  const items = [];
  const counts = { arxiv: 0, s2: 0, openalex: 0 };
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    const [tag, list] = r.value;
    const ok = list.filter((p) => p && qualityFilter(p));
    counts[tag] = ok.length;
    items.push(...ok);
  }
  return { items, counts };
}

function qualityFilter(p) {
  if (!p || !p.id || !p.title) return false;
  if (catOf(p) === "travel") {
    const a = p.abstract || "";
    return a.length >= 120 && !a.includes("may refer to");
  }
  const y = parseInt(p.year, 10);
  const cy = new Date().getFullYear();
  if (!(y >= 2000 && y <= cy + 1)) return false;
  const blob = `${p.venue || ""} ${p.url || ""}`.toLowerCase();
  const junk = ["zenodo", "ssrn", "cairn", "researchgate"];
  if (junk.some((t) => blob.includes(t))) return blob.includes("arxiv");
  return true;
}

function scoreCard(paper, topics, affinity) {
  let score = 1.0;
  const cat = catOf(paper);
  const text = `${paper.title} ${paper.abstract || ""} ${paper.venue || ""}`.toLowerCase();
  const cy = new Date().getFullYear();

  const anchors = CATEGORY_ANCHORS[cat] || {};
  for (const [k, w] of Object.entries(anchors)) if (text.includes(k)) score *= w;

  for (const t of topics) if (text.includes(t.name.toLowerCase())) score += 0.35;

  for (const [t, w] of Object.entries(affinity.topics || {}))
    if (text.includes(t)) score += w;
  for (const a of paper.authors || []) {
    const w = (affinity.authors || {})[a.toLowerCase().trim()];
    if (w) score += w;
  }

  // recency only matters for science — travel guides don't age like papers
  if (cat === "science") {
    const y = parseInt(paper.year, 10) || cy;
    if (y > cy) score *= 0.6;
    else if (y === cy) score *= 1.35;
    else if (y === cy - 1) score *= 1.15;
    else if (y < cy - 3) score *= 0.75;

    if (text.includes("arxiv")) score += 0.2;
    if (text.includes("experiment")) score += 0.15;
  }
  return score;
}

// ── main component ─────────────────────────────────────────
export default function App() {
  const [pool, setPool] = useState(() => sGet("ss2_pool", []));
  const [saved, setSaved] = useState(() => sGet("ss2_saved", {}));
  const [skipped, setSkipped] = useState(() => sGet("ss2_skipped", {}));
  const [topics, setTopics] = useState(() =>
    sGet("ss2_topics", [
      ...DEFAULT_TOPICS.science.map((name, i) => ({
        id: `d${i}`,
        name,
        category: "science",
        addedAt: nowISO(),
      })),
      ...DEFAULT_TOPICS.travel.map((name, i) => ({
        id: `dt${i}`,
        name,
        category: "travel",
        addedAt: nowISO(),
      })),
    ])
  );
  const [affinity, setAffinity] = useState(() => sGet("ss2_affinity", { topics: {}, authors: {} }));
  const [analyses, setAnalyses] = useState(() => sGet("ss2_analyses", {}));
  const [annots, setAnnots] = useState(() => sGet("ss2_annot", {}));
  const [ink, setInk] = useState(() => sGet("ss2_ink", {})); // {paperId: [strokes]}
  const [readingPaper, setReadingPaper] = useState(null); // {paper, url}
  const [chats, setChats] = useState(() => sGet("ss2_chats", {})); // {paperId: [{role, text, at}]}
  const [chatFor, setChatFor] = useState(null); // {paper, selection?, questions?: []}
  const [chatBusy, setChatBusy] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [lightbox, setLightbox] = useState(null); // {dataUrl, caption} of full-screen figure
  const [filterSheet, setFilterSheet] = useState(false); // collapsed filter/sort sheet (P7b)
  const [sourcePop, setSourcePop] = useState(false); // sources popover (P3b)
  const [rowMenu, setRowMenu] = useState(null); // saved-row ⋯ popover (P7c)
  const [showAiHelp, setShowAiHelp] = useState(false);
  const [showMap, setShowMap] = useState(false); // travel places map overlay
  const [aiStatus, setAiStatus] = useState(null); // {ok, provider} from /api/paper-chat health
  const [relatedView, setRelatedView] = useState(null); // {paper, loading, items} overlay
  const [settings, setSettings] = useState(() =>
    sGet("ss2_settings", {
      uiMode: "feed",
      harvestUrl: HARVEST_URL,
      theme: "auto",
      activeCategory: "all",
      updatedAt: nowISO(),
    })
  );
  const [lastSeen, setLastSeen] = useState(() => sGet("ss2_last_seen", ""));

  const [tab, setTab] = useState("stack");
  const [toast, setToast] = useState("");
  const [syncStatus, setSyncStatus] = useState("syncing");
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [analyzingId, setAnalyzingId] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [newTopic, setNewTopic] = useState("");
  const [newTopicCategory, setNewTopicCategory] = useState("science");
  const [feedsText, setFeedsText] = useState(() =>
    (sGet("ss2_settings", {}).travelFeeds || []).join("\n")
  );
  const [editingTopicId, setEditingTopicId] = useState(null);
  const [editDraft, setEditDraft] = useState({ name: "", keywords: "", arxivCat: "", sources: [] });
  const [sharePaper, setSharePaper] = useState(null);
  const [deckIndex, setDeckIndex] = useState(0);
  const [drag, setDrag] = useState({ x: 0, active: false });
  const dragStart = useRef(0);
  const chatMsgsRef = useRef(null);
  const fileInputRef = useRef(null);
  const uploadTargetRef = useRef(null); // paper awaiting a PDF file pick

  // keep the chat scrolled to the newest message
  useEffect(() => {
    const el = chatMsgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chats, chatFor, chatBusy]);

  // AI health check when Settings opens (which provider answers, if any)
  useEffect(() => {
    if (tab !== "settings" || aiStatus) return;
    fetch("/api/paper-chat")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAiStatus(d || { ok: false, provider: null }))
      .catch(() => setAiStatus({ ok: false, provider: null, offline: true }));
  }, [tab, aiStatus]);

  useEffect(() => onSyncStatus(setSyncStatus), []);

  const toastTimer = useRef(null);
  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2500);
  };

  function updateSettings(patch) {
    const ns = { ...settings, ...patch, updatedAt: nowISO() };
    setSettings(ns);
    persist("ss2_settings", ns);
  }

  // ── theme: auto / dark / light ──
  const theme = settings.theme || "auto";
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const eff = theme === "auto" ? (mq.matches ? "light" : "dark") : theme;
      document.documentElement.dataset.theme = eff;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", THEME_COLORS[eff] || THEME_COLORS.dark);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  // ── one-time default-topic seeding ──
  // Make ALL built-in defaults (science + travel) visible as real topics
  // in the row, so the Topics tab always lists them. Tombstoned names are
  // respected — an explicit delete stays deleted (Restore can revive).
  useEffect(() => {
    if (settings.defaultsSeededV2) return;
    const have = new Set(topics.map((t) => t.name.toLowerCase()));
    const missing = [
      ...DEFAULT_TOPICS.science.map((name) => ({ name, category: "science" })),
      ...DEFAULT_TOPICS.travel.map((name) => ({ name, category: "travel" })),
    ].filter((d) => !have.has(d.name.toLowerCase()));
    if (missing.length) {
      const nt = [
        ...topics,
        ...missing.map((d, i) => ({
          id: `seed${Date.now()}-${i}`,
          name: d.name,
          category: d.category,
          addedAt: nowISO(),
          updatedAt: nowISO(),
        })),
      ];
      setTopics(nt);
      persist("ss2_topics", nt);
    }
    updateSettings({ defaultsSeededV2: true, travelSeeded: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── feed loading ──
  async function loadFeed(showStatus = true) {
    setLoadingFeed(true);
    try {
      const res = await fetch(settings.harvestUrl || HARVEST_URL);
      if (!res.ok) throw new Error(`feed ${res.status}`);
      const raw = await res.json();
      const incoming = (Array.isArray(raw) ? raw : raw.papers || []).filter(qualityFilter);
      // merge with existing pool (live-injected topic papers survive refresh);
      // carry over device-local enrichments (figures, resolved pdf) so a
      // fresh harvest record doesn't clobber them
      const prevById = new Map(pool.map((x) => [x.id, x]));
      const byId = new Map();
      for (const p of [...incoming, ...pool]) {
        if (!p?.id || byId.has(p.id)) continue;
        const old = prevById.get(p.id);
        byId.set(
          p.id,
          old && old !== p
            ? {
                ...p,
                pdf: p.pdf ?? old.pdf,
                pdfLocal: p.pdfLocal ?? old.pdfLocal,
                figures: p.figures ?? old.figures,
                figuresTried: p.figuresTried ?? old.figuresTried,
                coordinates: p.coordinates ?? old.coordinates,
              }
            : p
        );
      }
      const merged = [...byId.values()];
      setPool(merged);
      savePool(merged); // device-local cache, not synced
      if (showStatus) showToast(`${merged.length} papers loaded`);
    } catch {
      if (showStatus) showToast(navigator.onLine ? "Feed unavailable" : "Offline — showing cached papers");
    } finally {
      setLoadingFeed(false);
    }
  }
  useEffect(() => {
    loadFeed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── re-run search: live OpenAlex + Semantic Scholar per visible topic,
  // plus a harvest feed refresh, merged into the pool in one pass ──
  async function rerunSearch() {
    if (rerunning) return;
    setRerunning(true);
    showToast("Re-running search…");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const fresh = [];
      for (const t of topics.filter((x) => !x.deleted && !x.hidden)) {
        if (catOf(t) === "travel") {
          // both wikis in parallel — different hosts, no shared rate limit
          const results = await Promise.allSettled(
            WIKI_SOURCES.map((src) => fetchWiki(t.name, src))
          );
          for (const r of results)
            if (r.status === "fulfilled") fresh.push(...r.value.filter(qualityFilter));
          await sleep(300);
          continue;
        }
        // arXiv + OpenAlex + S2 in parallel (honours the topic's source
        // toggles / category / keywords); one gap per topic covers S2
        try {
          const { items } = await fetchScienceTopic(t);
          fresh.push(...items);
        } catch {}
        await sleep(350);
      }
      // re-fetch the harvest feed too
      try {
        const res = await fetch(settings.harvestUrl || HARVEST_URL);
        if (res.ok) {
          const raw = await res.json();
          fresh.push(...(Array.isArray(raw) ? raw : raw.papers || []).filter(qualityFilter));
        }
      } catch {}

      const before = new Set(pool.map((p) => p.id));
      const byId = new Map();
      for (const p of [...pool, ...fresh]) if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
      const merged = [...byId.values()];
      const added = merged.length - before.size;
      setPool(merged);
      savePool(merged);
      showToast(added > 0 ? `${added} new papers found` : "No new papers found");
    } catch {
      showToast("Re-run failed — check connection");
    } finally {
      setRerunning(false);
    }
  }

  // ── derived ──
  // deleted topics are tombstones (so deletion survives the sync union —
  // a hard remove would resurrect from the remote row on next pull)
  const liveTopics = useMemo(() => topics.filter((t) => !t.deleted), [topics]);
  const visibleTopics = useMemo(() => liveTopics.filter((t) => !t.hidden), [liveTopics]);

  // preferred AI provider sent to the /api/* endpoints ("auto" = let the
  // server pick the first configured one)
  const aiProvider =
    settings.aiProvider && settings.aiProvider !== "auto" ? settings.aiProvider : undefined;

  // Scan Nature-family journals: triage by ABSTRACT (the RSS has no
  // abstract, so the server pulls it from OpenAlex), keep AI-judged
  // relevant ones, add them as cards. No PDF — the user attaches one.
  async function scanJournals() {
    if (scanning) return;
    setScanning(true);
    showToast("Scanning Nature journals…");
    try {
      const sci = topics.filter((t) => !t.deleted && !t.hidden && catOf(t) === "science");
      const topicNames = sci.map((t) => t.name);
      const res = await fetch("/api/journal-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topics: topicNames, provider: aiProvider }),
      });
      const data = res.ok ? await res.json() : null;
      const found = (data?.items || [])
        .map((it) => ({
          id: it.doi ? `doi:${it.doi.toLowerCase()}` : `nature:${it.url}`,
          title: it.title,
          abstract: it.abstract || "",
          authors: it.authors || [],
          year: it.year,
          venue: it.venue || "Nature",
          url: it.url,
          doi: it.doi || undefined,
          source: "nature",
          category: "science",
          harvestedAt: nowISO(),
        }))
        .filter((p) => p.id && p.title);
      const before = new Set(pool.map((p) => p.id));
      const byId = new Map();
      for (const p of [...found, ...pool]) if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
      const merged = [...byId.values()];
      const added = merged.length - before.size;
      setPool(merged);
      savePool(merged);
      if (added > 0) showToast(`Added ${added} relevant Nature paper${added > 1 ? "s" : ""} — attach a PDF to read`);
      else if (data && (data.note || (data.items || []).length === 0))
        showToast(data?.note === "abstracts not yet indexed" ? "New articles not indexed yet — try again later" : "No new relevant papers found");
      else showToast("No new relevant papers found");
    } catch {
      showToast("Journal scan failed — check connection");
    } finally {
      setScanning(false);
    }
  }

  // category switcher (B2): "all" | "science" | "travel"
  const activeCategory = settings.activeCategory || "all";
  const chipTopics = useMemo(
    () =>
      activeCategory === "all"
        ? visibleTopics
        : visibleTopics.filter((t) => catOf(t) === activeCategory),
    [visibleTopics, activeCategory]
  );

  const triage = useMemo(() => {
    const list = pool.filter((p) => !saved[p.id] && !skipped[p.id]);
    return list
      .map((p) => ({ ...p, _score: scoreCard(p, visibleTopics, affinity) }))
      .sort((a, b) => b._score - a._score);
  }, [pool, saved, skipped, visibleTopics, affinity]);

  const categoryTriage = useMemo(
    () =>
      activeCategory === "all"
        ? triage
        : triage.filter((p) => catOf(p) === activeCategory),
    [triage, activeCategory]
  );

  // topic filter (A5): empty selection = ALL; stale/hidden/off-category names drop out
  const feedFilter = useMemo(() => {
    const names = new Set(chipTopics.map((t) => t.name.toLowerCase()));
    return (settings.feedFilter || []).filter((n) => names.has(n.toLowerCase()));
  }, [settings.feedFilter, chipTopics]);

  const sourceFilter = settings.sourceFilter || [];
  const filteredTriage = useMemo(() => {
    let list = categoryTriage;
    if (sourceFilter.length) list = list.filter((p) => sourceFilter.includes(p.source));
    if (feedFilter.length === 0) return list;
    const wanted = feedFilter.map((n) => n.toLowerCase());
    return list.filter((p) => {
      const text = `${p.title} ${p.abstract || ""}`.toLowerCase();
      return wanted.some((n) => text.includes(n));
    });
  }, [categoryTriage, feedFilter, sourceFilter]);

  // sources present in the pool (P3b)
  const poolSources = useMemo(
    () => [...new Set(pool.map((p) => p.source).filter(Boolean))].sort(),
    [pool]
  );

  function toggleSource(s) {
    const all = poolSources;
    const current = sourceFilter.length ? sourceFilter : all;
    const next = current.includes(s) ? current.filter((x) => x !== s) : [...current, s];
    // everything checked = no filter; never allow an empty set (= show nothing)
    updateSettings({
      sourceFilter: next.length === 0 || next.length >= all.length ? [] : next,
    });
  }

  // feed sort (A3): deck always uses relevance (filteredTriage order)
  const sortMode = settings.sortMode || "relevance";
  const feedList = useMemo(() => {
    const list = [...filteredTriage];
    if (sortMode === "newest")
      return list.sort((a, b) => (b.harvestedAt || "").localeCompare(a.harvestedAt || ""));
    if (sortMode === "year")
      return list.sort((a, b) => ((b.year || 0) - (a.year || 0)) || (b._score - a._score));
    if (sortMode === "papers")
      // science papers before travel articles, relevance within each
      return list.sort(
        (a, b) =>
          (catOf(a) === "science" ? 0 : 1) - (catOf(b) === "science" ? 0 : 1) ||
          b._score - a._score
      );
    if (sortMode === "source")
      return list.sort(
        (a, b) =>
          String(a.venue || a.source || "").localeCompare(String(b.venue || b.source || "")) ||
          b._score - a._score
      );
    if (sortMode === "title")
      return list.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return filteredTriage;
  }, [filteredTriage, sortMode]);

  // saved list: category filter (P3a) + sorting
  const savedSort = settings.savedSort || "recent";
  const savedCategory = settings.savedCategory || "all";
  const savedList = useMemo(() => {
    let list = Object.values(saved);
    if (savedCategory !== "all") list = list.filter((p) => catOf(p) === savedCategory);
    if (savedSort === "year") return list.sort((a, b) => (b.year || 0) - (a.year || 0));
    if (savedSort === "title")
      return list.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return list.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
  }, [saved, savedSort, savedCategory]);

  const newCount = useMemo(
    () => triage.filter((p) => (p.harvestedAt || "") > (lastSeen || "")).length,
    [triage, lastSeen]
  );

  // travel items pinnable on the map (need harvested coordinates)
  const mapItems = useMemo(
    () => categoryTriage.filter((p) => catOf(p) === "travel" && Array.isArray(p.coordinates)),
    [categoryTriage]
  );

  // weekly digest (#3): what landed in the last 7 days, what you saved,
  // which topics were hot — all client-side from the pool
  const digest = useMemo(() => {
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const fresh = pool.filter((p) => (p.harvestedAt || "") > weekAgo);
    const score = (p) => scoreCard(p, visibleTopics, affinity);
    const top = {};
    for (const c of CATEGORIES) {
      top[c] = fresh
        .filter((p) => catOf(p) === c && !saved[p.id] && !skipped[p.id])
        .map((p) => ({ ...p, _score: score(p) }))
        .sort((a, b) => b._score - a._score)
        .slice(0, 5);
    }
    const topicCounts = visibleTopics
      .map((t) => ({
        name: t.name,
        n: fresh.filter((p) =>
          `${p.title} ${p.abstract || ""}`.toLowerCase().includes(t.name.toLowerCase())
        ).length,
      }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
    const savedWeek = Object.values(saved)
      .filter((p) => (p.savedAt || "") > weekAgo)
      .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
    return { freshCount: fresh.length, top, topicCounts, savedWeek };
  }, [pool, visibleTopics, affinity, saved, skipped]);

  // Semantic Scholar citations + references, scored against the profile.
  // Shared by the saved-row "related" panel and the graph view.
  async function fetchS2Related(p) {
    const sid = s2IdOf(p);
    if (!sid) return [];
    const fields = "title,abstract,year,venue,authors,externalIds,url,openAccessPdf";
    const found = [];
    let okCalls = 0;
    for (const kind of ["citations", "references"]) {
      try {
        const res = await fetch(
          `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(sid)}/${kind}?limit=30&fields=${fields}`
        );
        if (res.ok) {
          okCalls++;
          const d = await res.json();
          for (const row of d.data || []) {
            const n = normalizeS2(row.citingPaper || row.citedPaper);
            if (n && qualityFilter(n)) found.push(n);
          }
        }
      } catch {}
      await new Promise((r2) => setTimeout(r2, 350)); // S2 rate-limit courtesy
    }
    if (okCalls === 0) throw new Error("s2 unreachable");
    const seen = new Set([p.id]);
    return found
      .filter((x) => !seen.has(x.id) && seen.add(x.id))
      .map((x) => ({ ...x, _score: scoreCard(x, visibleTopics, affinity) }))
      .sort((a, b) => b._score - a._score);
  }

  // related-papers overlay (Issue 2): a normal feed, filtered to papers
  // connected to the focus paper — S2 citations/references + pool papers
  // sharing >= 2 topics. No graph, no SVG.
  const topicNamesIn = (paper, topicList) => {
    const text = `${paper.title} ${paper.abstract || ""}`.toLowerCase();
    return topicList.filter((t) => text.includes(t.name.toLowerCase())).map((t) => t.name);
  };

  async function openRelated(p) {
    setRelatedView({ paper: p, loading: true, items: [] });
    // pool papers that already share >= 2 of my topics with this one
    const mine = new Set(topicNamesIn(p, visibleTopics));
    const locals =
      mine.size >= 2
        ? pool.filter(
            (x) =>
              x.id !== p.id &&
              topicNamesIn(x, visibleTopics).filter((n) => mine.has(n)).length >= 2
          )
        : [];

    // travel papers have no citation graph — stick to local + a wiki pass
    const isSci = catOf(p) === "science";

    // (a) S2 citations + references, and (b) a NEW live search built by
    // AI from the paper's topic / methods / main idea (item 4)
    const jobs = [];
    if (isSci) jobs.push(fetchS2Related(p).catch(() => []));
    jobs.push(
      (async () => {
        try {
          const er = await fetch("/api/expand", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: aiProvider,
              paper: {
                title: p.title,
                abstract: p.abstract,
                methods: p.methods || [],
              },
            }),
          });
          if (!er.ok) return [];
          const { queries, arxivCat } = await er.json();
          const found = [];
          for (const q of (queries || []).slice(0, 3)) {
            try {
              if (isSci) {
                const { items } = await fetchScienceTopic({ name: q, arxivCat: arxivCat || undefined });
                found.push(...items);
              } else {
                for (const src of WIKI_SOURCES)
                  found.push(...(await fetchWiki(q, src)).filter(qualityFilter));
              }
            } catch {}
            await new Promise((r) => setTimeout(r, 350));
          }
          return found;
        } catch {
          return [];
        }
      })()
    );
    const settled = await Promise.all(jobs);
    const discovered = settled.flat();

    const byId = new Map();
    for (const x of [...discovered, ...locals])
      if (x?.id && x.id !== p.id && !byId.has(x.id)) byId.set(x.id, x);
    const items = [...byId.values()]
      .map((x) => ({ ...x, _score: x._score ?? scoreCard(x, visibleTopics, affinity) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 40);
    setRelatedView({ paper: p, loading: false, items });
    if (items.length === 0) showToast("No related papers found");
  }

  // App-icon badge (where the platform supports it)
  useEffect(() => {
    if ("setAppBadge" in navigator) {
      (newCount > 0 ? navigator.setAppBadge(newCount) : navigator.clearAppBadge()).catch(() => {});
    }
  }, [newCount]);

  // clamp deck index
  useEffect(() => {
    if (deckIndex >= filteredTriage.length) setDeckIndex(0);
  }, [filteredTriage.length, deckIndex]);

  // ── swipe verdicts ──
  function verdict(paper, kept) {
    // learn
    const next = {
      topics: { ...(affinity.topics || {}) },
      authors: { ...(affinity.authors || {}) },
    };
    const delta = kept ? 0.35 : -0.2;
    const text = `${paper.title} ${paper.abstract || ""}`.toLowerCase();
    for (const t of visibleTopics) {
      const k = t.name.toLowerCase();
      if (text.includes(k)) next.topics[k] = +((next.topics[k] || 0) + delta).toFixed(3);
    }
    for (const a of (paper.authors || []).slice(0, 3)) {
      const k = a.toLowerCase().trim();
      next.authors[k] = +((next.authors[k] || 0) + delta).toFixed(3);
    }
    setAffinity(next);
    persist("ss2_affinity", next);

    if (kept) {
      const ns = { ...saved, [paper.id]: { ...paper, savedAt: nowISO() } };
      setSaved(ns);
      persist("ss2_saved", ns);
    } else {
      const nk = { ...skipped, [paper.id]: true };
      setSkipped(nk);
      persist("ss2_skipped", nk);
    }
    const log = sGet("ss2_swipe_log", []);
    persist("ss2_swipe_log", [{ id: paper.id, kept, at: nowISO() }, ...log].slice(0, 500));
    showToast(kept ? "Saved · profile updated" : "Skipped · profile updated");
  }

  function unsave(id) {
    const ns = { ...saved };
    delete ns[id];
    setSaved(ns);
    persist("ss2_saved", ns);
  }

  // ── keyboard (desktop swipe mode) ──
  useEffect(() => {
    if (tab !== "stack" || settings.uiMode !== "swipe") return;
    const fn = (e) => {
      const p = filteredTriage[deckIndex];
      if (!p) return;
      if (e.key === "ArrowRight") verdict(p, true);
      if (e.key === "ArrowLeft") verdict(p, false);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, settings.uiMode, filteredTriage, deckIndex, affinity, topics, saved, skipped]);

  // ── touch drag (swipe mode) ──
  const onTouchStart = (e) => {
    dragStart.current = e.touches[0].clientX;
    setDrag({ x: 0, active: true });
  };
  const onTouchMove = (e) => {
    if (!drag.active) return;
    setDrag({ x: e.touches[0].clientX - dragStart.current, active: true });
  };
  const onTouchEnd = () => {
    const p = filteredTriage[deckIndex];
    if (p && Math.abs(drag.x) > 80) verdict(p, drag.x > 0);
    setDrag({ x: 0, active: false });
  };

  // ── topics ──
  async function addTopic(e) {
    e.preventDefault();
    const name = newTopic.trim();
    if (!name) return;
    if (topics.some((t) => !t.deleted && t.name.toLowerCase() === name.toLowerCase())) {
      setNewTopic("");
      return showToast("Topic already tracked");
    }
    const category = newTopicCategory;
    const tomb = topics.find((t) => t.deleted && t.name.toLowerCase() === name.toLowerCase());
    const nt = tomb
      ? topics.map((t) =>
          t === tomb
            ? { ...t, deleted: false, hidden: false, category, updatedAt: nowISO() }
            : t
        )
      : [...topics, { id: `${Date.now()}`, name, category, addedAt: nowISO(), updatedAt: nowISO() }];
    setTopics(nt);
    persist("ss2_topics", nt);
    setNewTopic("");
    showToast(`Tracking “${name}” — building search…`);
    // live injection across all engines; AI expands the topic into a
    // small search strategy first (synonyms, subtopics, arXiv category)
    try {
      let fresh = [];
      let toastMsg;
      if (category === "travel") {
        const results = await Promise.allSettled(WIKI_SOURCES.map((src) => fetchWiki(name, src)));
        for (const r of results)
          if (r.status === "fulfilled") fresh.push(...r.value.filter(qualityFilter));
        toastMsg = `Added ${fresh.length} guides for “${name}”`;
      } else {
        let queries = [name];
        let aiCat = null;
        let aiUsed = false;
        try {
          const er = await fetch("/api/expand", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ topic: name, provider: aiProvider }),
          });
          if (er.ok) {
            const exp = await er.json();
            const extra = (exp.queries || []).filter(
              (q) => q.toLowerCase() !== name.toLowerCase()
            );
            queries = [name, ...extra].slice(0, 3);
            aiCat = exp.arxivCat || null;
            aiUsed = extra.length > 0 || !!aiCat;
          }
        } catch {}
        const totals = { arxiv: 0, s2: 0, openalex: 0 };
        for (const q of queries) {
          try {
            const { items, counts } = await fetchScienceTopic({
              name: q,
              arxivCat: aiCat || undefined,
            });
            fresh.push(...items);
            for (const k of Object.keys(totals)) totals[k] += counts[k] || 0;
          } catch {}
          await new Promise((r) => setTimeout(r, 350)); // S2 courtesy gap
        }
        if (aiCat) {
          // remember the AI-picked category on the topic — the harvester
          // will scope its arXiv searches with it from the next run
          setTopics((prev) => {
            const nt2 = prev.map((x) =>
              x.name.toLowerCase() === name.toLowerCase() && !x.deleted
                ? { ...x, arxivCat: aiCat, updatedAt: nowISO() }
                : x
            );
            persist("ss2_topics", nt2);
            return nt2;
          });
        }
        const uniq = new Map();
        for (const p of fresh) if (p?.id && !uniq.has(p.id)) uniq.set(p.id, p);
        fresh = [...uniq.values()];
        toastMsg =
          fresh.length === 0
            ? `No live results for “${name}” — the daily harvest will keep trying. Tip: edit the topic (pencil) to add keywords.`
            : `Added ${fresh.length} papers (${totals.arxiv} arXiv · ${totals.s2} S2 · ${totals.openalex} OpenAlex)${aiUsed ? " · AI search" : ""}`;
      }
      const byId = new Map();
      for (const p of [...fresh, ...pool]) if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
      const merged = [...byId.values()];
      setPool(merged);
      savePool(merged);
      showToast(toastMsg);
    } catch {
      showToast("Live fetch failed — daily harvest will cover it");
    }
  }

  function removeTopic(id) {
    // tombstone, not splice — see liveTopics
    const nt = topics.map((t) =>
      t.id === id ? { ...t, deleted: true, updatedAt: nowISO() } : t
    );
    setTopics(nt);
    persist("ss2_topics", nt);
  }

  function updateTopic(id, patch) {
    const nt = topics.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: nowISO() } : t));
    setTopics(nt);
    persist("ss2_topics", nt);
  }

  function toggleHidden(t) {
    updateTopic(t.id, { hidden: !t.hidden });
    showToast(t.hidden ? `“${t.name}” visible again` : `“${t.name}” hidden from feed`);
  }

  function startEdit(t) {
    setEditingTopicId(t.id);
    setEditDraft({
      name: t.name,
      keywords: t.keywords || "",
      arxivCat: t.arxivCat || "",
      sources: t.sources || [],
    });
  }

  function toggleEditSource(s) {
    setEditDraft((d) => {
      const all = ["arxiv", "semantic-scholar", "openalex", "pubmed"];
      const current = d.sources.length ? d.sources : all;
      const next = current.includes(s) ? current.filter((x) => x !== s) : [...current, s];
      return { ...d, sources: next.length === 0 || next.length >= all.length ? [] : next };
    });
  }

  function submitTopicEdit(e) {
    e.preventDefault();
    const name = editDraft.name.trim();
    if (!name) return;
    if (
      topics.some(
        (t) => !t.deleted && t.id !== editingTopicId && t.name.toLowerCase() === name.toLowerCase()
      )
    ) {
      return showToast("Topic already exists");
    }
    updateTopic(editingTopicId, {
      name,
      keywords: editDraft.keywords.trim(),
      arxivCat: editDraft.arxivCat.trim(),
      sources: editDraft.sources,
    });
    setEditingTopicId(null);
    showToast("Topic updated — the next harvest uses these settings");
  }

  function restoreDefaults(category) {
    const live = new Set(liveTopics.map((t) => t.name.toLowerCase()));
    const missing = (DEFAULT_TOPICS[category] || []).filter((d) => !live.has(d.toLowerCase()));
    if (missing.length === 0) return showToast(`All default ${category} topics present`);
    const missingSet = new Set(missing.map((m) => m.toLowerCase()));
    // revive tombstoned defaults, append truly new ones
    let nt = topics.map((t) =>
      t.deleted && missingSet.has(t.name.toLowerCase())
        ? { ...t, deleted: false, hidden: false, category, updatedAt: nowISO() }
        : t
    );
    const revived = new Set(
      nt.filter((t) => !t.deleted).map((t) => t.name.toLowerCase())
    );
    nt = [
      ...nt,
      ...missing
        .filter((name) => !revived.has(name.toLowerCase()))
        .map((name, i) => ({
          id: `${Date.now()}-${i}`,
          name,
          category,
          addedAt: nowISO(),
          updatedAt: nowISO(),
        })),
    ];
    setTopics(nt);
    persist("ss2_topics", nt);
    showToast(`Restored ${missing.length} default ${category} topic${missing.length > 1 ? "s" : ""}`);
  }

  function toggleFeedFilter(name) {
    const cur = settings.feedFilter || [];
    const has = cur.some((n) => n.toLowerCase() === name.toLowerCase());
    updateSettings({
      feedFilter: has ? cur.filter((n) => n.toLowerCase() !== name.toLowerCase()) : [...cur, name],
    });
  }

  // ── PDF reader (C1) ──
  function saveAnnotsFor(paperId, list) {
    const na = { ...annots, [paperId]: list.slice(-300) };
    setAnnots(na);
    persist("ss2_annot", na);
  }

  function saveInkFor(paperId, list) {
    const ni = { ...ink, [paperId]: list.slice(-300) };
    setInk(ni);
    persist("ss2_ink", ni);
  }

  // resolution order: uploaded file → paper.pdf → arXiv id → Unpaywall (needs email) → none
  const canRead = (p) =>
    !!(p.pdfLocal || p.pdf || arxivIdOf(p) || (p.doi && settings.email));

  // ── manual PDF upload (the app can't fetch it → the user attaches it) ──
  function pickPdfFor(p) {
    uploadTargetRef.current = p;
    fileInputRef.current?.click();
  }

  async function onPdfPicked(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    const p = uploadTargetRef.current;
    uploadTargetRef.current = null;
    if (!file || !p) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return showToast("That's not a PDF file");
    }
    try {
      await savePdf(p.id, file);
      setPool((prev) => {
        const merged = prev.map((x) => (x.id === p.id ? { ...x, pdfLocal: true } : x));
        savePool(merged);
        return merged;
      });
      // saved papers carry their own copy of the record — flag it there too
      if (saved[p.id]) {
        const ns = { ...saved, [p.id]: { ...saved[p.id], pdfLocal: true } };
        setSaved(ns);
        persist("ss2_saved", ns);
      }
      showToast("PDF attached — opening…");
      setReadingPaper({ paper: p, url: URL.createObjectURL(file), local: true });
    } catch {
      showToast("Couldn't store the PDF on this device");
    }
  }

  async function openReader(p) {
    // a locally-uploaded PDF (IndexedDB) always wins — it's what the user chose
    if (p.pdfLocal) {
      try {
        const blob = await loadPdf(p.id);
        if (blob) {
          setReadingPaper({ paper: p, url: URL.createObjectURL(blob), local: true });
          return;
        }
      } catch {}
    }
    let pdfUrl = p.pdf || null;
    const ax = arxivIdOf(p);
    if (!pdfUrl && ax) pdfUrl = `https://arxiv.org/pdf/${ax}`;
    if (!pdfUrl && p.doi && settings.email) {
      showToast("Looking for an open-access PDF…");
      try {
        const res = await fetch(
          `https://api.unpaywall.org/v2/${encodeURIComponent(p.doi)}?email=${encodeURIComponent(
            settings.email
          )}`
        );
        if (res.ok) {
          const d = await res.json();
          pdfUrl = d.best_oa_location?.url_for_pdf || null;
          if (pdfUrl) {
            // cache the resolution on the pool item (device-local)
            const merged = pool.map((x) => (x.id === p.id ? { ...x, pdf: pdfUrl } : x));
            setPool(merged);
            savePool(merged);
          }
        }
      } catch {}
    }
    if (!pdfUrl) {
      if (settings.libraryProxy && p.url) {
        window.open(settings.libraryProxy + encodeURIComponent(p.url), "_blank");
        showToast("Opening via library proxy");
      } else {
        showToast("No open-access PDF found");
      }
      return;
    }
    // arXiv goes through our proxy (CORS); other hosts are tried direct
    const fetchUrl = isArxivUrl(pdfUrl) ? `/api/pdf?url=${encodeURIComponent(pdfUrl)}` : pdfUrl;
    setReadingPaper({ paper: p, url: fetchUrl });
  }

  function closeReader() {
    if (readingPaper?.local) URL.revokeObjectURL(readingPaper.url);
    setReadingPaper(null);
    setChatFor(null); // reader-panel chat must not pop up as an app overlay
  }

  // ── paper chat (C2) ──
  function appendChat(paperId, msg) {
    setChats((prev) => {
      const list = [...(prev[paperId] || []), msg].slice(-60);
      const next = { ...prev, [paperId]: list };
      persist("ss2_chats", next);
      return next;
    });
  }

  async function paperChatApi(mode, paper, selection, messages) {
    const res = await fetch("/api/paper-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        provider: aiProvider,
        paper: { title: paper.title, abstract: paper.abstract, venue: paper.venue, year: paper.year },
        selection,
        messages,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `API ${res.status}`);
    return data;
  }

  function openChat(paper) {
    setChatDraft("");
    setChatFor({ paper });
  }

  // hand the conversation to a full assistant, carrying the paper link
  // and the question that was asked right beforehand
  async function continueIn(provider) {
    if (!chatFor) return;
    const paper = chatFor.paper;
    const ax = arxivIdOf(paper);
    const link = paper.pdf || (ax ? `https://arxiv.org/pdf/${ax}` : paper.url || "");
    const lastUser = [...(chats[paper.id] || [])].reverse().find((m) => m.role === "user");
    const prompt =
      `I'm reading this paper: "${paper.title}"` +
      (link ? `\nPaper PDF/link: ${link}` : "") +
      (lastUser ? `\nMy question: ${lastUser.text}` : "\nHelp me understand it in depth.");
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {}
    const q = encodeURIComponent(prompt);
    const urls = {
      chatgpt: `https://chatgpt.com/?q=${q}`,
      claude: `https://claude.ai/new?q=${q}`,
      gemini: "https://gemini.google.com/app", // no prefill support — clipboard carries it
    };
    window.open(urls[provider], "_blank");
    showToast(
      provider === "gemini" ? "Prompt copied — paste it into Gemini" : "Prompt copied & prefilled"
    );
  }

  // EXPLAIN / QUESTIONS from the reader's selection menu
  async function handlePaperAI(mode, paper, selection) {
    setChatDraft("");
    setChatFor({ paper, selection });
    setChatBusy(true);
    try {
      if (mode === "explain") {
        appendChat(paper.id, {
          role: "user",
          text: `Explain: “${selection.slice(0, 400)}${selection.length > 400 ? "…" : ""}”`,
          at: nowISO(),
        });
        const d = await paperChatApi("explain", paper, selection);
        appendChat(paper.id, { role: "assistant", text: d.text, at: nowISO() });
      } else {
        const d = await paperChatApi("questions", paper, selection);
        setChatFor({ paper, selection, questions: d.questions || [] });
      }
    } catch (err) {
      showToast(`Chat failed: ${err.message}`.slice(0, 120));
    } finally {
      setChatBusy(false);
    }
  }

  async function sendChat(text) {
    const msg = (text || "").trim();
    if (!msg || !chatFor || chatBusy) return;
    const paper = chatFor.paper;
    const history = [...(chats[paper.id] || []), { role: "user", text: msg }]
      .slice(-12)
      .map(({ role, text: t }) => ({ role, text: t }));
    appendChat(paper.id, { role: "user", text: msg, at: nowISO() });
    setChatDraft("");
    setChatFor((c) => (c ? { ...c, questions: undefined } : c));
    setChatBusy(true);
    try {
      const d = await paperChatApi("chat", paper, chatFor.selection, history);
      appendChat(paper.id, { role: "assistant", text: d.text, at: nowISO() });
    } catch (err) {
      showToast(`Chat failed: ${err.message}`.slice(0, 120));
    } finally {
      setChatBusy(false);
    }
  }

  // ── figures (C2): lazy-extracted from arXiv PDFs, device-local cache ──
  async function loadFigures(p) {
    const ax = arxivIdOf(p);
    if (!ax) return;
    const stamp = (patch) => {
      setPool((prev) => {
        const merged = prev.map((x) => (x.id === p.id ? { ...x, ...patch } : x));
        savePool(merged);
        return merged;
      });
    };
    stamp({ figuresTried: true });
    try {
      const res = await fetch(`/api/figures?arxiv=${encodeURIComponent(ax)}`);
      const d = res.ok ? await res.json() : { figures: [] };
      // normalize to objects so we can attach verified captions later
      const figs = (d.figures || []).map((f) =>
        typeof f === "string" ? { dataUrl: f, caption: "" } : f
      );
      stamp({ figures: figs, figuresTried: true });
    } catch {
      /* offline or function cold-failed — figuresTried stays set */
    }
  }

  // open a figure full-screen; on first open, have the vision model
  // confirm the scraped caption matches — or write one (item 5). Result
  // is cached on the pool figure (device-local) so it's checked once.
  async function openLightbox(fig, paper, idx) {
    const f = typeof fig === "string" ? { dataUrl: fig, caption: "" } : fig;
    setLightbox({ ...f, verifying: !f.captionChecked });
    if (f.captionChecked || !f.dataUrl) return;
    try {
      const res = await fetch("/api/figure-caption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: f.dataUrl, caption: f.caption || "" }),
      });
      const d = res.ok ? await res.json() : null;
      const checked = {
        ...f,
        caption: d?.caption || f.caption || "",
        aiGenerated: !!d?.aiGenerated,
        captionChecked: true,
      };
      setLightbox((lb) => (lb && lb.dataUrl === f.dataUrl ? { ...checked, verifying: false } : lb));
      // cache back onto the pool figure
      if (paper && Number.isInteger(idx)) {
        setPool((prev) => {
          const merged = prev.map((x) => {
            if (x.id !== paper.id || !Array.isArray(x.figures)) return x;
            const figs = x.figures.map((g, i) =>
              i === idx ? { ...(typeof g === "string" ? { dataUrl: g } : g), ...checked } : g
            );
            return { ...x, figures: figs };
          });
          savePool(merged);
          return merged;
        });
      }
    } catch {
      setLightbox((lb) => (lb && lb.dataUrl === f.dataUrl ? { ...lb, verifying: false } : lb));
    }
  }

  // ── share ──
  function buildShareText(p) {
    const list = p.authors || [];
    const authors = list.slice(0, 3).join(", ") + (list.length > 3 ? " et al." : "");
    return `${p.title}${authors ? ` — ${authors}` : ""} · ${p.year}${p.summary ? `\n${p.summary}` : ""}`;
  }

  async function share(p) {
    const text = buildShareText(p);
    if (navigator.share) {
      try {
        await navigator.share({ title: p.title, text, url: p.url || undefined });
        return;
      } catch (err) {
        if (err.name === "AbortError") return; // user closed the native sheet
      }
    }
    setSharePaper(p);
  }

  async function copyShareLink() {
    if (!sharePaper) return;
    try {
      await navigator.clipboard.writeText(sharePaper.url || buildShareText(sharePaper));
      showToast("Link copied");
    } catch {
      showToast("Copy failed");
    }
    setSharePaper(null);
  }

  // ── analyze (Claude via /api) ──
  async function analyze(paper) {
    if (analyses[paper.id]) {
      setExpanded((x) => ({ ...x, [paper.id]: true }));
      return;
    }
    setAnalyzingId(paper.id);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: aiProvider,
          paper: {
            title: paper.title,
            abstract: paper.abstract,
            venue: paper.venue,
            year: paper.year,
          },
          context: {
            topics: topics.map((t) => t.name),
            savedTitles: Object.values(saved)
              .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""))
              .map((p) => p.title),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `API ${res.status}`);
      const na = { ...analyses, [paper.id]: { text: data.analysis, at: nowISO() } };
      setAnalyses(na);
      persist("ss2_analyses", na);
      setExpanded((x) => ({ ...x, [paper.id]: true }));
    } catch (err) {
      showToast(`Analysis failed: ${err.message}`.slice(0, 120));
    } finally {
      setAnalyzingId(null);
    }
  }

  function markAllSeen() {
    const iso = nowISO();
    setLastSeen(iso);
    persist("ss2_last_seen", iso);
  }

  // ── shared props for the module-level PaperCard ──
  const cardProps = {
    drag,
    lastSeen,
    analyses,
    expanded,
    analyzingId,
    settings,
    canRead,
    onVerdict: verdict,
    onAnalyze: analyze,
    onToggleExpanded: (id, value) => setExpanded((x) => ({ ...x, [id]: value })),
    onOpenReader: openReader,
    onPickPdf: pickPdfFor,
    onOpenProxy: (p) => {
      window.open(settings.libraryProxy + encodeURIComponent(p.url), "_blank");
      showToast("Opening via library proxy");
    },
    onChat: openChat,
    onShare: share,
    onSetLightbox: openLightbox,
    onLoadFigures: loadFigures,
    onRelated: openRelated,
  };

  // ── views ──
  const deckPaper = filteredTriage[deckIndex];

  const rerunButton = (
    <button
      className="btn ghost"
      style={{ border: "1px solid var(--line)" }}
      disabled={rerunning}
      onClick={rerunSearch}
    >
      <RefreshCw
        size={14}
        style={{ verticalAlign: "-2px" }}
        className={rerunning ? "spin" : ""}
      />{" "}
      {rerunning ? "Searching…" : "Re-run search"}
    </button>
  );

  return (
    <div className="app">
      <header className="hdr">
        <h1>SpinStack</h1>
        <span className="readout">
          {tab} · {filteredTriage.length} queued
        </span>
        {newCount > 0 && (
          <button className="badge badge-btn" onClick={markAllSeen} title="Mark all seen">
            {newCount} new — mark seen
          </button>
        )}
        <span className="spacer" />
        {tab === "stack" && (
          <div className="mode" role="tablist" aria-label="View mode">
            {["feed", "swipe"].map((m) => (
              <button
                key={m}
                className={(settings.uiMode === m || (m === "feed" && settings.uiMode !== "swipe")) ? "on" : ""}
                onClick={() => updateSettings({ uiMode: m })}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        )}
        <button onClick={() => loadFeed(true)} title="Refresh feed" aria-label="Refresh feed">
          <RefreshCw size={16} color={loadingFeed ? "var(--teal)" : "var(--dim)"} className={loadingFeed ? "spin" : ""} />
        </button>
        <span className={`sync-dot ${syncStatus}`} title={`Sync: ${syncStatus}`} />
      </header>

      {tab === "stack" && (
        <div className="catbar">
          <div className="mode" role="radiogroup" aria-label="Category">
            {["all", ...CATEGORIES].map((c) => (
              <button
                key={c}
                className={activeCategory === c ? "on" : ""}
                onClick={() => updateSettings({ activeCategory: c })}
              >
                {c.toUpperCase()}
              </button>
            ))}
          </div>
          {activeCategory === "travel" && (
            <button
              className="chip map-chip"
              onClick={() =>
                mapItems.length ? setShowMap(true) : showToast("No pinned places yet — they arrive with the next harvest")
              }
              title="Show harvested places on a map"
            >
              <MapIcon size={12} style={{ verticalAlign: "-2px" }} /> MAP
            </button>
          )}
        </div>
      )}

      {tab === "stack" && (
        <div className="toolbar">
          <button
            className={`chip${feedFilter.length || sourceFilter.length ? " on" : ""}`}
            onClick={() => setFilterSheet(true)}
            aria-label="Filter and sort"
          >
            <FilterIcon size={11} style={{ verticalAlign: "-1px" }} /> FILTER
            {feedFilter.length + (sourceFilter.length ? 1 : 0) > 0 &&
              ` · ${feedFilter.length + (sourceFilter.length ? 1 : 0)}`}
          </button>
          <span style={{ position: "relative" }}>
            <button
              className={`chip${sourceFilter.length ? " on" : ""}`}
              onClick={() => setSourcePop((v) => !v)}
              aria-label="Filter by source"
            >
              ⊞ SOURCES
            </button>
            {sourcePop && (
              <div className="source-popover">
                {poolSources.map((s) => (
                  <label key={s}>
                    <input
                      type="checkbox"
                      checked={!sourceFilter.length || sourceFilter.includes(s)}
                      onChange={() => toggleSource(s)}
                    />
                    {SOURCE_LABELS[s] || s}
                  </label>
                ))}
              </div>
            )}
          </span>
          <span className="spacer" />
          {settings.uiMode !== "swipe" && (
            <button
              className={`chip${sortMode !== "relevance" ? " on" : ""}`}
              onClick={() => setFilterSheet(true)}
              aria-label="Sort"
            >
              ⇅ {SORT_LABELS[sortMode] || "RELEVANCE"} ▾
            </button>
          )}
        </div>
      )}

      {tab === "stack" &&
        (sortMode !== "relevance" || feedFilter.length > 0 || sourceFilter.length > 0) && (
          <div className="active-readout">
            <span>Sorted by <b>{SORT_LABELS[sortMode] || "RELEVANCE"}</b></span>
            {feedFilter.length > 0 && (
              <span>· Topics: <b>{feedFilter.join(", ")}</b></span>
            )}
            {sourceFilter.length > 0 && (
              <span>· Sources: <b>{sourceFilter.map((s) => SOURCE_LABELS[s] || s).join(", ")}</b></span>
            )}
            <button className="clear-link" onClick={() => updateSettings({ sortMode: "relevance", feedFilter: [], sourceFilter: [] })}>
              clear
            </button>
          </div>
        )}

      {filterSheet && (
        <div className="share-overlay" onClick={() => setFilterSheet(false)}>
          <div className="share-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="section-h" style={{ margin: 0 }}>
              Filter by topic
            </div>
            <div className="chips">
              <button
                className={`chip${feedFilter.length === 0 ? " on" : ""}`}
                onClick={() => updateSettings({ feedFilter: [] })}
              >
                ALL
              </button>
              {chipTopics.map((t) => (
                <button
                  key={t.id}
                  className={`chip${feedFilter.some((n) => n.toLowerCase() === t.name.toLowerCase()) ? " on" : ""}`}
                  onClick={() => toggleFeedFilter(t.name)}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <div className="section-h" style={{ margin: "8px 0 0" }}>
              Sort by
            </div>
            <div className="chips">
              {[
                ["relevance", "RELEVANCE"],
                ...(activeCategory === "all" ? [["papers", "PAPERS FIRST"]] : []),
                ["newest", "NEWEST"],
                ["year", "YEAR"],
                ["source", "SOURCE"],
                ["title", "A–Z"],
              ].map(([m, label]) => (
                <button
                  key={m}
                  className={`chip${sortMode === m ? " on" : ""}`}
                  onClick={() => updateSettings({ sortMode: m })}
                >
                  {label}
                </button>
              ))}
            </div>
            <button className="btn skip" onClick={() => setFilterSheet(false)}>
              Done
            </button>
          </div>
        </div>
      )}

      {tab === "stack" && settings.uiMode !== "swipe" && (
        <main>
          {loadingFeed && feedList.length === 0 ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="card shimmer">
                <div className="shimmer-line short" />
                <div className="shimmer-line" />
                <div className="shimmer-line mid" />
              </div>
            ))
          ) : feedList.length === 0 ? (
            <div className="empty">
              <div className="big">Queue clear</div>
              The harvester runs daily at 06:00 UTC. Tap ↻ to refresh, or re-run the search across
              your topics now.
              <div style={{ marginTop: 16 }}>{rerunButton}</div>
            </div>
          ) : (
            feedList.slice(0, 60).map((p, i) => (
              <PaperCard key={p.id} p={p} eager={i < 6} {...cardProps} />
            ))
          )}
        </main>
      )}

      {tab === "stack" && settings.uiMode === "swipe" && (
        <main className="deck">
          {!deckPaper ? (
            <div className="empty">
              <div className="big">Queue clear</div>
              Swipe right to save, left to skip. New papers land daily.
              <div style={{ marginTop: 16 }}>{rerunButton}</div>
            </div>
          ) : (
            <>
              <div className="deck-meta">
                {deckIndex + 1} / {filteredTriage.length} · → save · ← skip
              </div>
              <div
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                style={{ position: "relative" }}
              >
                {drag.active && drag.x > 30 && <span className="verdict keep">SAVE</span>}
                {drag.active && drag.x < -30 && <span className="verdict skip">SKIP</span>}
                <PaperCard
                  p={deckPaper}
                  deck
                  eager
                  {...cardProps}
                  style={{
                    transform: `translateX(${drag.x}px) rotate(${drag.x / 24}deg)`,
                    opacity: 1 - Math.min(0.5, Math.abs(drag.x) / 400),
                  }}
                />
              </div>
              <div className="actions">
                <button className="btn skip" onClick={() => verdict(deckPaper, false)}>
                  <X size={16} style={{ verticalAlign: "-3px" }} /> Skip
                </button>
                <button className="btn save" onClick={() => verdict(deckPaper, true)}>
                  <Heart size={16} style={{ verticalAlign: "-3px" }} /> Save
                </button>
              </div>
            </>
          )}
        </main>
      )}

      {tab === "saved" && (
        <main>
          {Object.keys(saved).length > 0 && (
            <div className="chiprow" role="group" aria-label="Saved category">
              {["all", ...CATEGORIES].map((c) => (
                <button
                  key={c}
                  className={`chip${savedCategory === c ? " on" : ""}`}
                  onClick={() => updateSettings({ savedCategory: c })}
                >
                  {c.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          {savedList.length > 1 && (
            <div className="chiprow" role="group" aria-label="Sort saved">
              {[
                ["recent", "RECENT"],
                ["year", "YEAR"],
                ["title", "A–Z"],
              ].map(([m, label]) => (
                <button
                  key={m}
                  className={`chip${savedSort === m ? " on" : ""}`}
                  onClick={() => updateSettings({ savedSort: m })}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {savedList.length === 0 ? (
            <div className="empty">
              <div className="big">Nothing saved yet</div>
              Papers you save appear here on every device.
            </div>
          ) : (
            savedList.map((p) => (
                <div className="row" key={p.id}>
                  <div className="grow">
                    <div className="title">{p.title}</div>
                    <div className="sub">
                      {p.year} · {String(p.venue || "").slice(0, 40)}
                    </div>
                    {analyses[p.id] && expanded[p.id] && (
                      <div className="analysis" style={{ marginTop: 8 }}>
                        <span className="tag">Why this matters · Claude</span>
                        {analyses[p.id].text}
                      </div>
                    )}
                  </div>
                  <div className="row-actions">
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noreferrer" aria-label="Open paper">
                        <ExternalLink size={16} color="var(--dim)" />
                      </a>
                    )}
                    <button onClick={() => openChat(p)} title="Chat" aria-label="Chat about this paper">
                      <MessageCircle size={16} color="var(--dim)" />
                    </button>
                    <button onClick={() => unsave(p.id)} title="Remove" aria-label="Remove">
                      <Trash2 size={16} color="var(--dim)" />
                    </button>
                    <span style={{ position: "relative" }}>
                      <button
                        onClick={() => setRowMenu(rowMenu === p.id ? null : p.id)}
                        title="More actions"
                        aria-label="More actions"
                      >
                        <MoreHorizontal size={16} color={rowMenu === p.id ? "var(--teal)" : "var(--dim)"} />
                      </button>
                      {rowMenu === p.id && (
                        <div className="row-popover">
                          <button
                            onClick={() => {
                              setRowMenu(null);
                              analyses[p.id]
                                ? setExpanded((x) => ({ ...x, [p.id]: !x[p.id] }))
                                : analyze(p);
                            }}
                          >
                            Why?
                          </button>
                          {catOf(p) === "science" && (
                            <button
                              onClick={() => {
                                setRowMenu(null);
                                openRelated(p);
                              }}
                            >
                              Related
                            </button>
                          )}
                          <button
                            onClick={() => {
                              setRowMenu(null);
                              canRead(p) ? openReader(p) : pickPdfFor(p);
                            }}
                          >
                            {canRead(p) ? "Read" : "Attach PDF"}
                          </button>
                          <button
                            onClick={() => {
                              setRowMenu(null);
                              share(p);
                            }}
                          >
                            Share
                          </button>
                        </div>
                      )}
                    </span>
                  </div>
                </div>
              ))
          )}
        </main>
      )}

      {tab === "digest" && (
        <main>
          <div className="section-h" style={{ marginTop: 8 }}>This week</div>
          <p className="hint" style={{ marginTop: 2 }}>
            {digest.freshCount} new item{digest.freshCount === 1 ? "" : "s"} harvested in the last 7
            days · {digest.savedWeek.length} saved by you.
          </p>
          {digest.topicCounts.length > 0 && (
            <>
              <div className="section-h">Hot topics</div>
              <div className="chips" style={{ marginTop: 4 }}>
                {digest.topicCounts.map((t) => (
                  <span key={t.name} className="chip method">
                    {t.name} · {t.n}
                  </span>
                ))}
              </div>
            </>
          )}
          {CATEGORIES.map((c) =>
            digest.top[c].length === 0 ? null : (
              <div key={c}>
                <div className="section-h">Top {c} this week</div>
                {digest.top[c].map((p) => (
                  <div className="row" key={p.id}>
                    <div className="grow">
                      <div className="title">{p.title}</div>
                      <div className="sub">
                        {p.year} · {String(p.venue || p.source || "").slice(0, 36)} · match{" "}
                        {p._score.toFixed(2)}
                      </div>
                    </div>
                    <button onClick={() => verdict(p, true)} title="Save" aria-label={`Save ${p.title}`}>
                      <Heart size={15} color="var(--teal)" />
                    </button>
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noreferrer" aria-label="Open">
                        <ExternalLink size={15} color="var(--dim)" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )
          )}
          {digest.savedWeek.length > 0 && (
            <>
              <div className="section-h">Saved this week</div>
              {digest.savedWeek.map((p) => (
                <div className="row" key={p.id}>
                  <div className="grow">
                    <div className="title">{p.title}</div>
                    <div className="sub">
                      {p.year} · {String(p.venue || "").slice(0, 40)}
                    </div>
                  </div>
                  {p.url && (
                    <a href={p.url} target="_blank" rel="noreferrer" aria-label="Open">
                      <ExternalLink size={15} color="var(--dim)" />
                    </a>
                  )}
                </div>
              ))}
            </>
          )}
          {digest.freshCount === 0 && (
            <div className="empty">
              <div className="big">Quiet week so far</div>
              The harvester runs daily at 06:00 UTC — check back after the next run.
            </div>
          )}
        </main>
      )}

      {tab === "topics" && (
        <main>
          <form onSubmit={addTopic} className="field" style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              placeholder="Add a topic — e.g. dynamical decoupling"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
            />
            <button className="btn ghost" type="submit" style={{ border: "1px solid var(--line)" }}>
              Add
            </button>
          </form>
          <div className="field" style={{ marginTop: -6 }}>
            <div className="mode" role="radiogroup" aria-label="New topic category">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={newTopicCategory === c ? "on" : ""}
                  onClick={() => setNewTopicCategory(c)}
                >
                  {c.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <p className="hint">
            Science topics fetch from OpenAlex, travel topics from Wikivoyage/Wikipedia — both join
            the daily harvest from tomorrow. Hidden topics (eye toggle) stay harvested but leave
            your feed.
          </p>
          {CATEGORIES.map((cat) => {
            const catTopics = liveTopics.filter((t) => catOf(t) === cat);
            return (
              <div key={cat}>
                <div className="section-h">{cat} topics</div>
                {catTopics.length === 0 && (
                  <p className="hint">No {cat} topics tracked yet.</p>
                )}
                {catTopics.map((t) => (
                  <div className="row" key={t.id} style={t.hidden ? { opacity: 0.55 } : undefined}>
                    <Hash size={14} color="var(--teal)" />
                    <div className="grow">
                      {editingTopicId === t.id ? (
                        <form onSubmit={submitTopicEdit} className="topic-editor">
                          <input
                            className="input"
                            value={editDraft.name}
                            onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                            autoFocus
                            placeholder="Topic name"
                            onKeyDown={(e) => e.key === "Escape" && setEditingTopicId(null)}
                          />
                          <input
                            className="input"
                            value={editDraft.keywords}
                            onChange={(e) => setEditDraft((d) => ({ ...d, keywords: e.target.value }))}
                            placeholder="Extra search keywords (optional)"
                          />
                          {catOf(t) === "science" && (
                            <>
                              <input
                                className="input"
                                value={editDraft.arxivCat}
                                onChange={(e) => setEditDraft((d) => ({ ...d, arxivCat: e.target.value }))}
                                placeholder="arXiv category, e.g. quant-ph (optional)"
                              />
                              <div className="chips">
                                {["arxiv", "semantic-scholar", "openalex", "pubmed"].map((s) => {
                                  const on =
                                    editDraft.sources.length === 0 || editDraft.sources.includes(s);
                                  return (
                                    <button
                                      type="button"
                                      key={s}
                                      className={`chip${on ? " on" : ""}`}
                                      onClick={() => toggleEditSource(s)}
                                    >
                                      {SOURCE_LABELS[s]}
                                    </button>
                                  );
                                })}
                              </div>
                              <p className="hint" style={{ margin: 0 }}>
                                All sources active when all are lit. PubMed runs in the daily
                                harvest only. The harvester picks these settings up automatically.
                              </p>
                            </>
                          )}
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              className="btn ghost"
                              type="submit"
                              style={{ border: "1px solid var(--line)" }}
                            >
                              Save
                            </button>
                            <button
                              className="btn skip"
                              type="button"
                              onClick={() => setEditingTopicId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className="title">
                            {t.name}
                            {isDefaultTopic(t) && <span className="chip default">DEFAULT</span>}
                          </div>
                          {affinity.topics?.[t.name.toLowerCase()] !== undefined && (
                            <div className="sub">
                              learned weight {affinity.topics[t.name.toLowerCase()].toFixed(2)}
                            </div>
                          )}
                          {(t.arxivCat || t.keywords || (t.sources || []).length > 0) && (
                            <div className="sub">
                              {[
                                t.arxivCat && `cat:${t.arxivCat}`,
                                t.keywords && `+ ${t.keywords}`,
                                (t.sources || []).length > 0 && t.sources.map((s) => SOURCE_LABELS[s] || s).join(", "),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    <button onClick={() => startEdit(t)} title="Edit topic" aria-label={`Edit ${t.name}`}>
                      <Pencil size={15} color="var(--dim)" />
                    </button>
                    <button
                      onClick={() => toggleHidden(t)}
                      title={t.hidden ? "Show in feed" : "Hide from feed"}
                      aria-label={`${t.hidden ? "Show" : "Hide"} ${t.name}`}
                    >
                      {t.hidden ? <EyeOff size={15} color="var(--dim)" /> : <Eye size={15} color="var(--teal)" />}
                    </button>
                    <button onClick={() => removeTopic(t.id)} aria-label={`Remove ${t.name}`}>
                      <Trash2 size={15} color="var(--dim)" />
                    </button>
                  </div>
                ))}
                <div className="field">
                  <button
                    className="btn ghost"
                    style={{ border: "1px solid var(--line)" }}
                    onClick={() => restoreDefaults(cat)}
                  >
                    Restore default {cat} topics
                  </button>
                </div>
              </div>
            );
          })}
        </main>
      )}

      {tab === "settings" && (
        <main>
          <div className="field">
            <label>Theme</label>
            <div className="mode" role="radiogroup" aria-label="Theme">
              {["auto", "dark", "light"].map((m) => (
                <button
                  key={m}
                  className={theme === m ? "on" : ""}
                  onClick={() => updateSettings({ theme: m })}
                >
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
            <p className="hint">Auto follows your system’s light/dark preference.</p>
          </div>
          <div className="field">
            <label>Harvest feed URL</label>
            <input
              className="input"
              value={settings.harvestUrl}
              onChange={(e) => updateSettings({ harvestUrl: e.target.value })}
            />
            <p className="hint">Daily harvest output (papers/latest.json on GitHub).</p>
          </div>
          <div className="field">
            <label>Journal scan (Nature)</label>
            <button
              className="btn ghost"
              style={{ border: "1px solid var(--line)" }}
              disabled={scanning}
              onClick={scanJournals}
            >
              <Newspaper size={14} style={{ verticalAlign: "-2px" }} />{" "}
              {scanning ? "Scanning…" : "Scan Nature journals for relevant papers"}
            </button>
            <p className="hint">
              Reads the latest Nature, Nature Physics, Nature Communications & Nature Reviews
              Physics by abstract, keeps the ones AI judges relevant to your science topics, and
              adds them as cards. They have no PDF — tap the 📎 on a card to attach one.
            </p>
          </div>
          <div className="field">
            <label>Travel article feeds</label>
            <textarea
              className="input"
              rows={4}
              placeholder={
                "Defaults when empty:\nAtlas Obscura (latest + places), Nomadic Matt,\nAdventurous Kate, Earth Trekkers.\nAdd your own — one RSS/Atom URL per line."
              }
              value={feedsText}
              onChange={(e) => setFeedsText(e.target.value)}
              onBlur={() =>
                updateSettings({
                  travelFeeds: feedsText
                    .split("\n")
                    .map((s) => s.trim())
                    .filter((s) => /^https?:\/\//.test(s)),
                })
              }
            />
            <p className="hint">
              One RSS/Atom URL per line — the daily harvester pulls these into the travel
              category.
            </p>
          </div>
          <div className="field">
            <label>AI assistant</label>
            <div className="ai-status-pill">
              <span className={`dot ${aiStatus?.ok ? "synced" : "error"}`} />
              {aiStatus === null
                ? "Checking…"
                : aiStatus.ok
                  ? `Ready · ${PROVIDER_LABELS[aiProvider && (aiStatus.providers || []).includes(aiProvider) ? aiProvider : aiStatus.provider] || aiStatus.provider}`
                  : "Not configured"}
              <button onClick={() => setShowAiHelp((v) => !v)}>▾ Setup</button>
            </div>
            <div className="mode" role="radiogroup" aria-label="AI provider" style={{ marginTop: 8 }}>
              {["auto", "gemini", "claude", "perplexity"].map((p) => {
                const configured =
                  p === "auto" || (aiStatus?.providers || []).includes(p);
                return (
                  <button
                    key={p}
                    className={(settings.aiProvider || "auto") === p ? "on" : ""}
                    onClick={() => updateSettings({ aiProvider: p })}
                    title={configured ? "" : "No key set — will fall back to Auto"}
                  >
                    {p.toUpperCase()}
                    {!configured && p !== "auto" ? " •" : ""}
                  </button>
                );
              })}
            </div>
            {showAiHelp && (
              <p className="hint">
                Powers “Why?”, EXPLAIN, QUESTIONS, the paper chat, topic search and figure
                descriptions. Add any of these in Vercel → spinstack-app → Settings → Environment
                Variables, then Redeploy: <b>GEMINI_API_KEY</b> (free,
                aistudio.google.com/apikey), <b>ANTHROPIC_API_KEY</b>, or <b>PERPLEXITY_API_KEY</b>
                (paid, web-grounded search — perplexity.ai/settings/api). A “•” above marks a
                provider with no key yet. Vision figure descriptions always use Gemini or Claude.
              </p>
            )}
          </div>
          <div className="field">
            <label>Reader</label>
            <input
              className="input"
              type="email"
              placeholder="you@university.edu — for Unpaywall OA lookup"
              value={settings.email || ""}
              onChange={(e) => updateSettings({ email: e.target.value.trim() })}
              style={{ marginBottom: 8 }}
            />
            <input
              className="input"
              placeholder="Library proxy prefix, e.g. https://ezproxy.huji.ac.il/login?url="
              value={settings.libraryProxy || ""}
              onChange={(e) => updateSettings({ libraryProxy: e.target.value.trim() })}
              style={{ marginBottom: 8 }}
            />
            <input
              className="input"
              placeholder="Proxy button label, e.g. HUJI"
              value={settings.proxyLabel || ""}
              onChange={(e) => updateSettings({ proxyLabel: e.target.value.trim() })}
            />
            <p className="hint">
              Email unlocks Unpaywall open-access PDF lookup for DOI papers. The library proxy
              opens paywalled papers in your browser via your institution — credentials never
              touch the app.
            </p>
          </div>
          <div className="field">
            <label>Sync</label>
            <p className="hint">
              All devices share one database row — no login. Status:{" "}
              <span style={{ color: "var(--teal)" }}>{syncStatus}</span>. Saves, skips, topics,
              analyses and settings sync automatically; offline changes push when you reconnect.
            </p>
          </div>
          <div className="field">
            <label>Maintenance</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {rerunButton}
              <button
                className="btn ghost"
                style={{ border: "1px solid var(--line)" }}
                onClick={markAllSeen}
              >
                Mark all papers seen
              </button>
              <button
                className="btn ghost"
                style={{ border: "1px solid var(--line)" }}
                onClick={() => {
                  const nk = {};
                  setSkipped(nk);
                  persist("ss2_skipped", nk);
                  showToast("Skip history cleared");
                }}
              >
                Clear skip history
              </button>
            </div>
          </div>
          <div className="field">
            <label>About</label>
            <p className="hint">
              SpinStack v2 · harvester runs daily 06:00 UTC via GitHub Actions · summaries by
              Gemini at harvest time · “Why this matters” by Claude on demand.
            </p>
          </div>
        </main>
      )}

      <nav className="tabs">
        <button className={tab === "stack" ? "on" : ""} onClick={() => setTab("stack")}>
          {settings.uiMode === "swipe" ? <Layers size={18} /> : <List size={18} />}
          STACK
          {newCount > 0 && <span className="nbadge">{newCount > 99 ? "99+" : newCount}</span>}
        </button>
        <button className={tab === "saved" ? "on" : ""} onClick={() => setTab("saved")}>
          <Bookmark size={18} />
          SAVED
        </button>
        <button className={tab === "digest" ? "on" : ""} onClick={() => setTab("digest")}>
          <Newspaper size={18} />
          DIGEST
        </button>
        <button className={tab === "topics" ? "on" : ""} onClick={() => setTab("topics")}>
          <Hash size={18} />
          TOPICS
        </button>
        <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>
          <SettingsIcon size={18} />
          SETUP
        </button>
      </nav>

      {relatedView && (
        <div className="related-overlay">
          <header className="reader-hdr">
            <button onClick={() => setRelatedView(null)} aria-label="Back">
              <ArrowLeft size={18} color="var(--dim)" />
            </button>
            <span className="reader-title" style={{ maxWidth: "75%" }}>
              Related to: {relatedView.paper.title}
            </span>
          </header>
          <div className="related-scroll">
            {relatedView.loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="card shimmer">
                  <div className="shimmer-line short" />
                  <div className="shimmer-line" />
                  <div className="shimmer-line mid" />
                </div>
              ))
            ) : relatedView.items.length === 0 ? (
              <div className="empty">
                <div className="big">No related papers found</div>
                Brand-new papers often aren't indexed by Semantic Scholar yet — try again in a few
                days.
              </div>
            ) : (
              relatedView.items.map((p) => <PaperCard key={p.id} p={p} {...cardProps} />)
            )}
          </div>
        </div>
      )}

      {readingPaper && (
        <Suspense
          fallback={
            <div className="reader">
              <div className="empty">Loading reader…</div>
            </div>
          }
        >
          <Reader
            paper={readingPaper.paper}
            url={readingPaper.url}
            annots={annots[readingPaper.paper.id] || []}
            onSave={(list) => saveAnnotsFor(readingPaper.paper.id, list)}
            ink={ink[readingPaper.paper.id] || []}
            onSaveInk={(list) => saveInkFor(readingPaper.paper.id, list)}
            onClose={closeReader}
            onAction={(mode, { selection }) => handlePaperAI(mode, readingPaper.paper, selection)}
            showToast={showToast}
            chats={chats[readingPaper.paper.id] || []}
            chatBusy={chatBusy}
            chatDraft={chatDraft}
            chatFor={chatFor}
            onSendChat={sendChat}
            onChatDraftChange={setChatDraft}
            onOpenChat={() => setChatFor((c) => c || { paper: readingPaper.paper })}
            onContinueIn={continueIn}
          />
        </Suspense>
      )}

      {showMap && (
        <Suspense
          fallback={
            <div className="map-overlay">
              <div className="empty">Loading map…</div>
            </div>
          }
        >
          <MapView items={mapItems} onClose={() => setShowMap(false)} />
        </Suspense>
      )}

      {chatFor && !readingPaper && (
        <div className="share-overlay chat-overlay" onClick={() => setChatFor(null)}>
          <div className="share-sheet chat-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="section-h" style={{ margin: 0 }}>
              Paper chat · Claude
            </div>
            <p className="hint" style={{ margin: 0 }}>
              {chatFor.paper.title.slice(0, 90)}
              {chatFor.paper.title.length > 90 ? "…" : ""}
            </p>
            <div className="chat-msgs" ref={chatMsgsRef}>
              {(chats[chatFor.paper.id] || []).length === 0 && !chatBusy && (
                <p className="hint">
                  Ask anything about this paper — or select text in the reader and tap EXPLAIN /
                  QUESTIONS.
                </p>
              )}
              {(chats[chatFor.paper.id] || []).map((m, i) => (
                <div key={`${m.at}-${i}`} className={`bubble ${m.role}`}>
                  {m.text}
                </div>
              ))}
              {chatBusy && <div className="bubble assistant">…</div>}
            </div>
            {(chatFor.questions || []).length > 0 && (
              <div className="chips">
                {chatFor.questions.map((q) => (
                  <button key={q} className="chip qchip" onClick={() => sendChat(q)}>
                    {q}
                  </button>
                ))}
              </div>
            )}
            <div className="continue-row">
              <span className="continue-lbl">CONTINUE IN</span>
              <button className="chip" onClick={() => continueIn("chatgpt")}>
                ChatGPT
              </button>
              <button className="chip" onClick={() => continueIn("gemini")}>
                Gemini
              </button>
              <button className="chip" onClick={() => continueIn("claude")}>
                Claude
              </button>
            </div>
            <form
              className="chat-input"
              onSubmit={(e) => {
                e.preventDefault();
                sendChat(chatDraft);
              }}
            >
              <input
                className="input"
                placeholder="Ask about this paper…"
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
              />
              <button
                className="btn ghost"
                type="submit"
                disabled={chatBusy || !chatDraft.trim()}
                aria-label="Send"
                style={{ border: "1px solid var(--line)" }}
              >
                <Send size={15} />
              </button>
            </form>
          </div>
        </div>
      )}

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox.dataUrl || lightbox} alt="Figure" onClick={(e) => e.stopPropagation()} />
          {lightbox.verifying ? (
            <p className="lightbox-caption dim">Reading the figure…</p>
          ) : lightbox.caption ? (
            <p className="lightbox-caption" onClick={(e) => e.stopPropagation()}>
              {lightbox.aiGenerated && <span className="ai-tag">AI-generated description</span>}
              {lightbox.caption}
            </p>
          ) : null}
        </div>
      )}

      {sharePaper && (
        <div className="share-overlay" onClick={() => setSharePaper(null)}>
          <div className="share-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="section-h" style={{ margin: "0 0 4px" }}>
              Share paper
            </div>
            <a
              className="btn ghost"
              href={`https://wa.me/?text=${encodeURIComponent(
                buildShareText(sharePaper) + (sharePaper.url ? `\n${sharePaper.url}` : "")
              )}`}
              target="_blank"
              rel="noreferrer"
              onClick={() => setSharePaper(null)}
            >
              WhatsApp
            </a>
            <a
              className="btn ghost"
              href={`mailto:?subject=${encodeURIComponent(sharePaper.title)}&body=${encodeURIComponent(
                buildShareText(sharePaper) + (sharePaper.url ? `\n${sharePaper.url}` : "")
              )}`}
              onClick={() => setSharePaper(null)}
            >
              Email
            </a>
            <button className="btn ghost" onClick={copyShareLink}>
              Copy link
            </button>
            <button className="btn skip" onClick={() => setSharePaper(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        style={{ display: "none" }}
        onChange={onPdfPicked}
      />

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
