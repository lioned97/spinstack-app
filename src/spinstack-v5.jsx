import { useState, useRef, useEffect, useMemo } from "react";

// ─── Themes: "Dark lab" + "Paper" reading mode ───────────────────────
const THEMES = {
  dark: {
    bg: "#0B0E14", surface: "#151B28", surface2: "#1C2333",
    line: "#262F44", text: "#F2F4FA", muted: "#9AA3B8",
    zpl: "#FF4D3D", zplSoft: "rgba(255,77,61,0.14)",
    pump: "#58F0A8", pumpSoft: "rgba(88,240,168,0.12)",
    warn: "#F5C84B", lib: "#6FA8FF", onAccent: "#fff", shadow: "rgba(0,0,0,0.5)",
  },
  paper: {
    bg: "#F7F5F0", surface: "#FFFFFF", surface2: "#EFECE3",
    line: "#D9D4C7", text: "#1C202B", muted: "#5C6370",
    zpl: "#C93A2C", zplSoft: "rgba(201,58,44,0.08)",
    pump: "#168A55", pumpSoft: "rgba(22,138,85,0.08)",
    warn: "#9A6E00", lib: "#2B6CB0", onAccent: "#fff", shadow: "rgba(60,55,40,0.18)",
  },
};
const MONO = "'IBM Plex Mono', monospace";
const DAY = 86400e3;

// ─── Persistent storage ──────────────────────────────────────────────
async function sGet(key, fb) {
  try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : fb; }
  catch { return fb; }
}
async function sSet(key, val) { try { await window.storage.set(key, JSON.stringify(val)); } catch {} }

// ─── Defaults & seed ─────────────────────────────────────────────────
const DEFAULT_TOPICS = [
  { name: "nitrogen-vacancy", weight: 1.0 },
  { name: "quantum sensing", weight: 0.9 },
  { name: "open quantum systems", weight: 0.9 },
  { name: "Hamiltonian engineering", weight: 0.8 },
  { name: "quantum memory", weight: 0.7 },
];
const SEED = [
  {
    id: "seed-1", src: "arxiv", title: "Robust Hamiltonian Engineering in Interacting NV Ensembles via Composite Pulse Sequences",
    authors: "T. Nakamura, R. Cohen, A. Bar-Gill", venue: "quant-ph", year: "2024",
    summary: "Pulse-sequence design for dense NV ensembles where dipolar interactions dominate decoherence. Average-Hamiltonian conditions decouple both on-site disorder and spin-spin coupling, validated on a high-density sample.",
    struct: {
      why: "Dense NV ensembles promise better magnetometry sensitivity, but dipolar interactions destroy coherence before that gain is realized.",
      findings: ["Composite XY-family sequences suppress disorder and dipolar terms simultaneously.", "Coherence extended ~12× over plain XY8 at high NV density."],
      method: "Average-Hamiltonian engineering with composite pulses, validated experimentally on a high-density sample.",
    },
    tldr: null, tags: ["Hamiltonian engineering", "NV ensembles"], url: null, pdfUrl: null,
  },
  {
    id: "seed-2", src: "arxiv", title: "Lindblad Tomography of a Driven Solid-State Qubit Coupled to a Nuclear Spin Bath",
    authors: "M. Oliveira, K. Schmidt, J. Park", venue: "quant-ph", year: "2024",
    summary: "Experimentally reconstructs the full Lindbladian of a driven NV center, separating coherent drive terms from dissipative channels induced by the 13C bath.",
    struct: {
      why: "Standard T1/T2 modeling hides the actual dissipation channels; full Lindbladian knowledge is needed to validate open-system simulations.",
      findings: ["Complete reconstruction of jump operators and rates under realistic bath coupling.", "Non-secular dissipation channels revealed that T1/T2 fits miss entirely."],
      method: "Driven tomography protocol with an open-source fitting pipeline.",
    },
    tldr: null, tags: ["Lindblad dynamics", "open quantum systems"], url: null, pdfUrl: null,
  },
  {
    id: "seed-3", src: "arxiv", title: "Long-Lived Quantum Memory in 13C Nuclear Spins with Repetitive Readout at Room Temperature",
    authors: "S. Ivanov, L. Chen, P. Maurer", venue: "cond-mat.mes-hall", year: "2024",
    summary: "Combines nuclear-spin storage with repetitive electron-spin readout to build a practical room-temperature quantum memory, then uses it to enhance AC field sensing beyond the electron T2 limit.",
    struct: {
      why: "Electron T2 caps sensing interrogation time; nuclear spins could store quantum information far longer if readout SNR weren't the bottleneck.",
      findings: ["Nuclear memory lifetimes beyond 1 s at ambient conditions.", "Repetitive readout boosts SNR ~30× per shot; memory-enhanced sensing shown end-to-end."],
      method: "Motional-narrowing decoupling on 13C storage plus repetitive electron-spin readout.",
    },
    tldr: null, tags: ["quantum memory", "quantum sensing"], url: null, pdfUrl: null,
  },
];

// ─── arXiv API ───────────────────────────────────────────────────────
async function fetchArxiv(topics) {
  const terms = topics.map(t => `all:%22${encodeURIComponent(t.name)}%22`).join("+OR+");
  const url = `https://export.arxiv.org/api/query?search_query=(${terms})+AND+(cat:quant-ph+OR+cat:cond-mat.mes-hall)&sortBy=submittedDate&sortOrder=descending&max_results=20`;
  const res = await fetch(url);
  const doc = new DOMParser().parseFromString(await res.text(), "text/xml");
  return [...doc.getElementsByTagName("entry")].map(e => {
    const g = tag => e.getElementsByTagName(tag)[0]?.textContent?.trim() || "";
    const rawId = g("id");
    const id = rawId.includes("/abs/") ? rawId.split("/abs/")[1] : rawId;
    const bare = id.replace(/v\d+$/, "");
    return {
      id, src: "arxiv", arxivId: bare,
      title: g("title").replace(/\s+/g, " "),
      authors: [...e.getElementsByTagName("author")].map(a => a.getElementsByTagName("name")[0]?.textContent).filter(Boolean).slice(0, 4).join(", "),
      venue: e.getElementsByTagName("category")[0]?.getAttribute("term") || "quant-ph",
      year: (g("published") || "").slice(0, 4),
      summary: g("summary").replace(/\s+/g, " "),
      struct: null, tldr: null, tags: [],
      url: "https://arxiv.org/abs/" + bare,
      pdfUrl: "https://arxiv.org/pdf/" + bare,
    };
  });
}

// ─── Semantic Scholar (open-access library, all publishers) ──────────
async function fetchSemanticScholar(topics) {
  const query = topics.slice(0, 3).map(t => t.name).join(" ");
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}` +
    `&fields=title,abstract,authors,year,citationCount,externalIds,openAccessPdf,tldr,venue&limit=20&openAccessPdf`;
  const d = await (await fetch(url)).json();
  if (d.error || d.message) throw new Error(d.error || d.message);
  return (d.data || []).filter(p => p.title).map(p => ({
    id: "ss-" + p.paperId, src: "openlib",
    arxivId: p.externalIds?.ArXiv || null,
    title: p.title,
    authors: (p.authors || []).slice(0, 4).map(a => a.name).join(", "),
    venue: p.venue || "open access", year: String(p.year || ""),
    cites: p.citationCount,
    summary: p.abstract || p.tldr?.text || "",
    struct: null,
    tldr: p.tldr?.text ? [p.tldr.text] : null,
    tags: [],
    url: `https://www.semanticscholar.org/paper/${p.paperId}`,
    pdfUrl: p.openAccessPdf?.url || null,
  }));
}

// ─── Harvester feed (GitHub Actions latest.json) ─────────────────────
async function fetchHarvest(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  const cards = (d.papers || []).filter(p => p.title).map(p => ({
    id: p.id, src: p.src === "arxiv" ? "arxiv" : "openlib",
    arxivId: p.arxiv || (typeof p.id === "string" && p.id.startsWith("arxiv:") ? p.id.slice(6) : null),
    title: p.title,
    authors: Array.isArray(p.authors) ? p.authors.slice(0, 4).join(", ") : (p.authors || ""),
    venue: p.venue || "open access", year: String(p.year || ""),
    cites: p.cites ?? null,
    summary: p.summary || "", struct: null, tldr: null,
    tags: p.topic ? [p.topic] : [],
    url: p.url || null, pdfUrl: p.pdf || null,
  }));
  return { cards, meta: { generated: d.generated_utc || "", count: d.count || cards.length } };
}

// ─── Relevance ───────────────────────────────────────────────────────
function scoreCard(card, topics) {
  if (card.src === "idea") return 0.97;
  if (card.src === "gap") return 0.95;
  if (card.src === "feed") return 0.9;
  const text = (card.title + " " + (card.summary || "")).toLowerCase();
  let s = 0, max = 0;
  topics.forEach(t => {
    max += t.weight;
    const words = t.name.toLowerCase().split(/\s+/);
    s += t.weight * (words.filter(w => text.includes(w)).length / words.length);
  });
  return Math.min(0.99, 0.3 + 0.69 * (max ? s / max : 0));
}

// ─── AI provider ─────────────────────────────────────────────────────
async function askAI(provider, geminiKey, prompt) {
  if (provider === "gemini") {
    if (!geminiKey) throw new Error("Add your Gemini API key in Settings first.");
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || "Gemini error");
    return d.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 2000,
      messages: [{ role: "user", content: prompt }] }) });
  const d = await r.json();
  return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}
function parseAI(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const a = clean.indexOf("["), o = clean.indexOf("{");
  const isArr = a !== -1 && (o === -1 || a < o);
  const start = isArr ? a : o;
  const end = isArr ? clean.lastIndexOf("]") : clean.lastIndexOf("}");
  return JSON.parse(clean.slice(start, end + 1));
}

// ─── Knowledge map ───────────────────────────────────────────────────
function buildEdges(papers) {
  const sig = p => new Set((p.title + " " + (p.tags || []).join(" ")).toLowerCase().match(/[a-z]{6,}/g) || []);
  const sigs = papers.map(sig);
  const edges = [];
  for (let i = 0; i < papers.length; i++)
    for (let j = i + 1; j < papers.length; j++) {
      let shared = 0;
      sigs[i].forEach(w => { if (sigs[j].has(w)) shared++; });
      if (shared >= 1) edges.push([i, j, Math.min(3, shared)]);
    }
  return edges;
}
function layoutGraph(n, edges, w, h) {
  const pos = Array.from({ length: n }, (_, i) => ({
    x: w / 2 + Math.cos(i * 2.4) * (60 + (i % 5) * 18),
    y: h / 2 + Math.sin(i * 2.4) * (60 + (i % 4) * 18), vx: 0, vy: 0,
  }));
  for (let it = 0; it < 220; it++) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
      const f = 1400 / (dx * dx + dy * dy + 0.01);
      pos[i].vx += dx * f; pos[i].vy += dy * f; pos[j].vx -= dx * f; pos[j].vy -= dy * f;
    }
    edges.forEach(([a, b, wt]) => {
      const dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - 75) * 0.02 * wt;
      pos[a].vx -= dx / d * f; pos[a].vy -= dy / d * f;
      pos[b].vx += dx / d * f; pos[b].vy += dy / d * f;
    });
    pos.forEach(p => {
      p.vx += (w / 2 - p.x) * 0.004; p.vy += (h / 2 - p.y) * 0.004;
      p.x = Math.max(18, Math.min(w - 18, p.x + p.vx * 0.08));
      p.y = Math.max(18, Math.min(h - 18, p.y + p.vy * 0.08));
      p.vx *= 0.6; p.vy *= 0.6;
    });
  }
  return pos;
}

// ─── Visual components ───────────────────────────────────────────────
// Unique ESR-spectrum fingerprint per paper (deterministic from title)
function SpectrumStrip({ seed, C }) {
  const pts = useMemo(() => {
    let h = 0;
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const dips = [];
    const n = 2 + (h % 3);
    for (let i = 0; i < n; i++) { h = (h * 1103515245 + 12345) >>> 0; dips.push(12 + (h % 76)); }
    const out = [];
    for (let x = 0; x <= 100; x += 1.5) {
      let y = 4;
      dips.forEach((d, i) => { const w = 2.5 + i * 1.2; y += 11 / (1 + ((x - d) / w) ** 2); });
      out.push(`${x},${y.toFixed(1)}`);
    }
    return out.join(" ");
  }, [seed]);
  return (
    <svg viewBox="0 0 100 18" preserveAspectRatio="none" style={{ width: "100%", height: 16, display: "block", opacity: 0.5 }}>
      <polyline points={pts} fill="none" stroke={C.zpl} strokeWidth="0.9" />
    </svg>
  );
}
function SpinDiagram({ dx, C }) {
  const t = Math.max(-1, Math.min(1, dx / 140));
  const bright = Math.max(0, t), dark = Math.max(0, -t);
  return (
    <svg width="74" height="56" viewBox="0 0 74 56" style={{ display: "block", flexShrink: 0 }}>
      <line x1="14" y1="12" x2="42" y2="12" stroke={dark > 0.1 ? C.muted : C.line} strokeWidth="2" style={{ opacity: 0.5 + dark * 0.5 }} />
      <line x1="14" y1="20" x2="42" y2="20" stroke={dark > 0.1 ? C.muted : C.line} strokeWidth="2" style={{ opacity: 0.5 + dark * 0.5 }} />
      <line x1="14" y1="46" x2="42" y2="46" stroke={bright > 0.1 ? C.zpl : C.muted} strokeWidth={2 + bright * 1.5}
        style={{ filter: bright > 0.2 ? `drop-shadow(0 0 ${4 + bright * 6}px ${C.zpl})` : "none" }} />
      <line x1="28" y1="22" x2="28" y2="43" stroke={bright > 0.1 ? C.zpl : C.line} strokeWidth="1.5" strokeDasharray="3 3" style={{ opacity: 0.4 + bright * 0.6 }} />
      <text x="48" y="15" fill={C.muted} fontSize="8" fontFamily={MONO} opacity={0.5 + dark * 0.5}>ms=±1</text>
      <text x="48" y="49" fill={bright > 0.1 ? C.zpl : C.muted} fontSize="8" fontFamily={MONO} opacity={0.6 + bright * 0.4}>ms=0</text>
    </svg>
  );
}
function PLMeter({ value, C }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 4, borderRadius: 2, background: C.line, overflow: "hidden" }}>
        <div style={{ width: `${value * 100}%`, height: "100%", background: `linear-gradient(90deg, ${C.zpl}88, ${C.zpl})` }} />
      </div>
      <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>{(value * 100).toFixed(0)}% match</span>
    </div>
  );
}
function Chip({ children, color, onRemove, C }) {
  const c = color || C.muted;
  return (
    <span style={{
      fontFamily: MONO, fontSize: 10, padding: "4px 9px", borderRadius: 4, color: c,
      background: `${c}1A`, border: `1px solid ${c}40`,
      display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
    }}>
      {children}
      {onRemove && <span onClick={onRemove} style={{ cursor: "pointer", color: C.zpl, fontWeight: 700 }}>×</span>}
    </span>
  );
}
function FeasChip({ f, C }) {
  const map = { doable: [C.pump, "● doable now"], stretch: [C.warn, "◐ needs one capability"], moonshot: [C.zpl, "○ moonshot"] };
  const [color, label] = map[f] || map.stretch;
  return <Chip color={color} C={C}>{label}</Chip>;
}
function ActionBtn({ children, onClick, border, color, size, glow, disabled, label, C }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} style={{
      width: size, height: size, borderRadius: "50%", background: C.surface,
      border: `1.5px solid ${border}`, color, fontSize: size * 0.38,
      opacity: disabled ? 0.35 : 1, display: "flex", alignItems: "center", justifyContent: "center",
      boxShadow: glow ? `0 0 18px ${C.zplSoft}` : "none", cursor: "pointer",
    }}>{children}</button>
  );
}

// Structured why/findings block
function StructBlock({ struct, C, full }) {
  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontFamily: MONO, fontSize: 9, color: C.pump, letterSpacing: "0.08em", marginBottom: 4 }}>WHY THEY DID IT</div>
        <div style={{ fontSize: 13, lineHeight: 1.55, color: C.text }}>{struct.why}</div>
      </div>
      <div style={{ background: C.zplSoft, border: `1px solid ${C.zpl}30`, borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
        <div style={{ fontFamily: MONO, fontSize: 9, color: C.zpl, letterSpacing: "0.08em", marginBottom: 6 }}>WHAT THEY FOUND</div>
        {struct.findings.map((b, i) => (
          <div key={i} style={{ fontSize: 13, lineHeight: 1.5, color: C.text, display: "flex", gap: 7, marginBottom: i < struct.findings.length - 1 ? 5 : 0 }}>
            <span style={{ color: C.zpl }}>›</span><span>{b}</span>
          </div>
        ))}
      </div>
      {full && struct.method && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: "0.08em", marginBottom: 4 }}>HOW</div>
          <div style={{ fontSize: 13, lineHeight: 1.55, color: C.text }}>{struct.method}</div>
        </div>
      )}
    </>
  );
}

// ═══ MAIN APP ═════════════════════════════════════════════════════════
export default function SpinStack() {
  const [theme, setTheme] = useState("dark");
  const C = THEMES[theme];
  const S = useMemo(() => makeStyles(C), [theme]);

  const [topics, setTopics] = useState(DEFAULT_TOPICS);
  const [feeds, setFeeds] = useState([]);
  const [paperCards, setPaperCards] = useState(SEED);   // arxiv + openlib
  const [genCards, setGenCards] = useState([]);
  const [ideas, setIdeas] = useState([]);
  const [predictions, setPredictions] = useState([]);
  const [labProfile, setLabProfile] = useState("");
  const [recallMeta, setRecallMeta] = useState({});
  const [swiped, setSwiped] = useState([]);
  const [saved, setSaved] = useState([]);
  const [history, setHistory] = useState([]);
  const [streak, setStreak] = useState({ date: "", count: 1, reviewed: 0 });
  const [view, setView] = useState("deck");
  const [detail, setDetail] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [provider, setProvider] = useState("claude");
  const [geminiKey, setGeminiKey] = useState("");
  const [harvestUrl, setHarvestUrl] = useState("");
  const [harvestMeta, setHarvestMeta] = useState(null);
  const [persona, setPersona] = useState("peer");
  const [drag, setDrag] = useState({ dx: 0, dy: 0, active: false });
  const [leaving, setLeaving] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(null);
  const [newTopic, setNewTopic] = useState("");
  const [feedPrompt, setFeedPrompt] = useState("");
  const [chat, setChat] = useState({});
  const [chatInput, setChatInput] = useState("");
  const [revealed, setRevealed] = useState({});
  const [mapSel, setMapSel] = useState([]);
  const [proposal, setProposal] = useState(null);
  const [predClaim, setPredClaim] = useState("");
  const startRef = useRef(null);
  const loaded = useRef(false);
  const autoFetched = useRef(false);

  // ── load / persist ──
  useEffect(() => {
    (async () => {
      const [t, f, sv, sw, st, gc, id, pr, lp, rm, th, hu] = await Promise.all([
        sGet("topics", DEFAULT_TOPICS), sGet("feeds", []), sGet("saved", []),
        sGet("swiped", []), sGet("streak", null), sGet("genCards", []),
        sGet("ideas", []), sGet("predictions", []), sGet("labProfile", ""),
        sGet("recallMeta", {}), sGet("theme", "dark"), sGet("harvestUrl", ""),
      ]);
      setTopics(t); setFeeds(f); setSaved(sv); setSwiped(sw); setGenCards(gc);
      setIdeas(id); setPredictions(pr); setLabProfile(lp); setRecallMeta(rm); setTheme(th);
      setHarvestUrl(hu);
      const today = new Date().toISOString().slice(0, 10);
      if (st) {
        const yest = new Date(Date.now() - DAY).toISOString().slice(0, 10);
        if (st.date === today) setStreak(st);
        else if (st.date === yest) setStreak({ date: today, count: st.count + 1, reviewed: 0 });
        else setStreak({ date: today, count: 1, reviewed: 0 });
      } else setStreak({ date: today, count: 1, reviewed: 0 });
      loaded.current = true;
    })();
  }, []);
  const persist = (key, val) => { if (loaded.current) sSet(key, val); };
  useEffect(() => persist("topics", topics), [topics]);
  useEffect(() => persist("feeds", feeds), [feeds]);
  useEffect(() => persist("saved", saved), [saved]);
  useEffect(() => persist("swiped", swiped), [swiped]);
  useEffect(() => persist("streak", streak), [streak]);
  useEffect(() => persist("genCards", genCards), [genCards]);
  useEffect(() => persist("ideas", ideas), [ideas]);
  useEffect(() => persist("predictions", predictions), [predictions]);
  useEffect(() => persist("labProfile", labProfile), [labProfile]);
  useEffect(() => persist("recallMeta", recallMeta), [recallMeta]);
  useEffect(() => persist("theme", theme), [theme]);
  useEffect(() => persist("harvestUrl", harvestUrl), [harvestUrl]);
  // auto-load freshest harvest on app start
  useEffect(() => {
    if (loaded.current && harvestUrl.trim() && !autoFetched.current) {
      autoFetched.current = true;
      syncAll();
    }
  }, [harvestUrl]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 1800); return () => clearTimeout(t); }, [toast]);

  // ── recall due ──
  const today = new Date().toISOString().slice(0, 10);
  const recallCards = useMemo(() => {
    return saved.filter(p => {
      const m = recallMeta[p.id];
      const due = m ? Date.now() > m.due : Date.now() - (p.savedAt || 0) > DAY;
      return due && !swiped.includes(`rc-${p.id}-${today}`);
    }).slice(0, 3).map(p => ({
      id: `rc-${p.id}-${today}`, src: "recall", ref: p,
      title: p.title, authors: p.authors, venue: "recall", year: p.year,
      summary: p.summary, struct: p.struct, tldr: p.tldr, tags: [], url: p.url, pdfUrl: p.pdfUrl,
    }));
  }, [saved, recallMeta, swiped, today]);

  // ── deck ──
  const deck = useMemo(() => {
    const feedCards = feeds.filter(f => f.active).flatMap(f => f.cards.map(c => ({ ...c, feedName: f.name })));
    const papers = [...paperCards, ...feedCards]
      .filter(c => !swiped.includes(c.id))
      .map(c => ({ ...c, relevance: scoreCard(c, topics) }))
      .sort((a, b) => b.relevance - a.relevance);
    const gen = genCards.filter(c => !swiped.includes(c.id)).map(c => ({ ...c, relevance: scoreCard(c, topics) }));
    return [...recallCards.map(c => ({ ...c, relevance: 1 })), ...gen, ...papers];
  }, [paperCards, feeds, genCards, recallCards, swiped, topics]);
  const top = deck[0];

  // ── swipe ──
  function learn(card, dir) {
    if (card.src !== "arxiv" && card.src !== "feed" && card.src !== "openlib") return;
    const text = (card.title + " " + (card.summary || "")).toLowerCase();
    setTopics(ts => ts.map(t => {
      const hit = t.name.toLowerCase().split(/\s+/).some(w => text.includes(w));
      if (!hit) return t;
      const w = t.weight + (dir === "right" ? 0.05 : -0.03);
      return { ...t, weight: Math.max(0.1, Math.min(1.5, +w.toFixed(2))) };
    }));
  }
  function commitSwipe(dir) {
    if (!top || leaving) return;
    setLeaving({ id: top.id, dir });
    const card = top;
    setTimeout(() => {
      setSwiped(s => [...s, card.id]);
      setHistory(h => [...h, { card, action: dir }]);
      if (card.src === "recall") {
        const pid = card.ref.id;
        const m = recallMeta[pid] || { interval: 1 };
        const interval = dir === "right" ? Math.min(60, (m.interval || 1) * 2) : 1;
        setRecallMeta(r => ({ ...r, [pid]: { interval, due: Date.now() + interval * DAY } }));
        setToast(dir === "right" ? `Remembered — next recall in ${interval}d` : "No worries — back tomorrow");
      } else if (card.src === "idea" || card.src === "gap") {
        if (dir === "right") {
          setIdeas(i => [...i, { ...card.payload, id: card.id, createdAt: Date.now() }]);
          setToast("Added to ideas backlog");
        }
      } else if (dir === "right") {
        setSaved(s => [...s, { ...card, savedAt: Date.now() }]);
        setToast("Saved to reading list");
      }
      learn(card, dir);
      setStreak(st => ({ ...st, reviewed: st.reviewed + 1 }));
      setLeaving(null); setDrag({ dx: 0, dy: 0, active: false });
    }, 260);
  }
  function undo() {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory(h => h.slice(0, -1));
    setSwiped(s => s.filter(id => id !== last.card.id));
    if (last.action === "right") {
      if (last.card.src === "idea" || last.card.src === "gap") setIdeas(i => i.filter(x => x.id !== last.card.id));
      else if (last.card.src !== "recall") setSaved(s => s.filter(p => p.id !== last.card.id));
    }
    setToast("Undone");
  }
  function onDown(e) { if (leaving) return; const p = e.touches ? e.touches[0] : e; startRef.current = { x: p.clientX, y: p.clientY }; setDrag(d => ({ ...d, active: true })); }
  function onMove(e) { if (!startRef.current || leaving) return; const p = e.touches ? e.touches[0] : e; setDrag({ dx: p.clientX - startRef.current.x, dy: (p.clientY - startRef.current.y) * 0.3, active: true }); }
  function onUp() {
    if (!startRef.current) return; startRef.current = null;
    if (drag.dx > 110) commitSwipe("right");
    else if (drag.dx < -110) commitSwipe("left");
    else setDrag({ dx: 0, dy: 0, active: false });
  }
  const dx = leaving ? (leaving.dir === "right" ? 600 : -600) : drag.dx;
  const rot = dx / 18;
  const saveOp = Math.min(1, Math.max(0, dx / 110));
  const passOp = Math.min(1, Math.max(0, -dx / 110));

  // ── sync: harvester feed first, live sources as fallback ──
  async function syncAll() {
    setBusy("sync");
    let fresh = [], note = "";
    // 1) pre-harvested stack from GitHub Actions (one fetch, ~100 papers, 3 sources)
    if (harvestUrl.trim()) {
      try {
        const { cards, meta } = await fetchHarvest(harvestUrl.trim());
        setHarvestMeta(meta);
        fresh = cards;
        note = ` · harvest ${meta.generated}`;
      } catch (e) {
        setToast("Harvest fetch failed (" + e.message + ") — using live sources");
      }
    }
    // 2) live fallback / default when no harvester is configured
    if (!fresh.length) {
      const results = await Promise.allSettled([fetchArxiv(topics), fetchSemanticScholar(topics)]);
      results.forEach(r => { if (r.status === "fulfilled") fresh = fresh.concat(r.value); });
      if (results.every(r => r.status === "rejected")) {
        setToast("All sources failed — try again");
        setBusy(null);
        return;
      }
    }
    // dedupe against existing cards, swiped history, and cross-source arXiv ids
    const known = new Set([...paperCards.map(c => c.id), ...swiped]);
    const knownArxiv = new Set(paperCards.map(c => c.arxivId).filter(Boolean));
    const add = [];
    fresh.forEach(c => {
      if (known.has(c.id)) return;
      if (c.arxivId && knownArxiv.has(c.arxivId)) return;
      known.add(c.id);
      if (c.arxivId) knownArxiv.add(c.arxivId);
      add.push(c);
    });
    setPaperCards(a => [...add, ...a.filter(c => !c.id.startsWith("seed-"))].slice(0, 150));
    setToast(add.length ? `${add.length} new papers${note}` : "No new papers — stack is current");
    setView("deck");
    setBusy(null);
  }

  // ── feed generation ──
  async function generateFeed() {
    const q = feedPrompt.trim();
    if (!q) return;
    setBusy("feed");
    try {
      const raw = await askAI(provider, geminiKey,
        `Create 6 swipeable discovery cards for this request: "${q}".\nRespond ONLY with a JSON array, no prose. Each item: {"title": string, "authors": string (source/creator/region, short), "summary": string (2-3 sentences), "tldr": [3 short strings], "tags": [up to 3 short strings]}`);
      const items = parseAI(raw);
      const fid = "feed-" + Date.now();
      const cards = items.map((it, i) => ({
        id: fid + "-" + i, src: "feed", title: it.title, authors: it.authors || "",
        venue: "custom feed", year: String(new Date().getFullYear()),
        summary: it.summary || "", struct: null, tldr: it.tldr || null, tags: it.tags || [], url: null, pdfUrl: null,
      }));
      const name = q.length > 34 ? q.slice(0, 34) + "…" : q;
      setFeeds(f => [...f, { id: fid, name, prompt: q, active: true, cards }]);
      setFeedPrompt(""); setToast(`Feed created — ${cards.length} cards added`); setView("deck");
    } catch (e) { setToast("Feed generation failed: " + e.message); }
    setBusy(null);
  }

  // ── collision / gaps / proposal (unchanged logic) ──
  async function collide(pA, pB) {
    if (saved.length < 2 && !(pA && pB)) { setToast("Save at least 2 papers first"); return; }
    let a = pA, b = pB;
    if (!a || !b) {
      const pool = [...saved];
      a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      b = pool[Math.floor(Math.random() * pool.length)];
    }
    setBusy("collide");
    try {
      const raw = await askAI(provider, geminiKey,
        `You are a research ideation engine for an NV-center / open-quantum-systems lab.\n` +
        (labProfile ? `Lab capabilities: ${labProfile}\n` : "") +
        `Combine these two papers into ONE novel, non-obvious research hypothesis:\n` +
        `Paper A: "${a.title}" — ${a.summary}\nPaper B: "${b.title}" — ${b.summary}\n` +
        `Respond ONLY with JSON: {"title": string (short, punchy), "hypothesis": string (3-4 sentences), "first_experiment": string, "feasibility": "doable"|"stretch"|"moonshot"}`);
      const it = parseAI(raw);
      const card = {
        id: "idea-" + Date.now(), src: "idea",
        title: it.title, authors: "collision: " + [a, b].map(p => p.title.slice(0, 28) + "…").join(" × "),
        venue: "idea", year: String(new Date().getFullYear()),
        summary: it.hypothesis, struct: null, tldr: [it.first_experiment], tags: [], url: null, pdfUrl: null,
        payload: { title: it.title, hypothesis: it.hypothesis, first: it.first_experiment, feasibility: it.feasibility, sources: [a.title, b.title], kind: "collision" },
        feasibility: it.feasibility,
      };
      setGenCards(g => [card, ...g]);
      setToast("⚡ Collision card added to stack"); setView("deck"); setMapSel([]);
    } catch (e) { setToast("Collision failed: " + e.message); }
    setBusy(null);
  }
  async function detectGaps() {
    if (saved.length < 3) { setToast("Save at least 3 papers first"); return; }
    setBusy("gaps");
    try {
      const corpus = saved.slice(-15).map(p => `- ${p.title}: ${(p.summary || "").slice(0, 180)}`).join("\n");
      const raw = await askAI(provider, geminiKey,
        `You are a research-gap detector for an NV-center / open-quantum-systems researcher.\n` +
        (labProfile ? `Lab capabilities: ${labProfile}\n` : "") +
        `Their saved reading list:\n${corpus}\n` +
        `Identify 3 concrete unexplored gaps: parameter regimes untouched, techniques never combined, or assumptions never tested. Be specific.\n` +
        `Respond ONLY with a JSON array of 3 items: {"title": string, "gap": string (3-4 sentences), "first_step": string, "feasibility": "doable"|"stretch"|"moonshot"}`);
      const items = parseAI(raw);
      const cards = items.map((it, i) => ({
        id: `gap-${Date.now()}-${i}`, src: "gap",
        title: it.title, authors: "gap detected in your library", venue: "gap",
        year: String(new Date().getFullYear()),
        summary: it.gap, struct: null, tldr: [it.first_step], tags: [], url: null, pdfUrl: null,
        payload: { title: it.title, hypothesis: it.gap, first: it.first_step, feasibility: it.feasibility, sources: [], kind: "gap" },
        feasibility: it.feasibility,
      }));
      setGenCards(g => [...cards, ...g]);
      setToast(`◌ ${cards.length} gap cards added to stack`); setView("deck");
    } catch (e) { setToast("Gap detection failed: " + e.message); }
    setBusy(null);
  }
  async function makeProposal(idea) {
    setBusy("prop");
    try {
      const raw = await askAI(provider, geminiKey,
        `Turn this research idea into a concise one-page proposal seed for an NV-center lab group meeting.\n` +
        (labProfile ? `Lab capabilities: ${labProfile}\n` : "") +
        `Idea: ${idea.title}\nHypothesis: ${idea.hypothesis}\nFirst experiment: ${idea.first}\n` +
        (idea.sources?.length ? `Built from: ${idea.sources.join(" + ")}\n` : "") +
        `Format as plain text with sections: MOTIVATION, APPROACH, EXPECTED SIGNAL, WHAT COULD KILL IT, FIRST 2 WEEKS. Under 300 words, technical.`);
      setProposal({ title: idea.title, text: raw.trim() });
    } catch (e) { setToast("Proposal failed: " + e.message); }
    setBusy(null);
  }

  // ── structured breakdown: why / findings / how ──
  async function genStruct(card) {
    setBusy("struct");
    try {
      const raw = await askAI(provider, geminiKey,
        `Break down this paper for an expert in NV-center quantum sensing. Respond ONLY with JSON:\n` +
        `{"why": string (1-2 sentences: the motivation — what problem pushed them to do this), ` +
        `"findings": [2-3 short strings: the concrete results], "method": string (1 sentence: how they did it)}\n` +
        `Title: ${card.title}\nAbstract: ${card.summary}`);
      const struct = parseAI(raw);
      const upd = c => c.id === card.id ? { ...c, struct } : c;
      setPaperCards(a => a.map(upd)); setSaved(s => s.map(upd));
      setDetail(d => d && d.id === card.id ? { ...d, struct } : d);
    } catch (e) { setToast("Breakdown failed: " + e.message); }
    setBusy(null);
  }

  // ── chat ──
  async function sendChat() {
    const q = chatInput.trim();
    if (!q || !detail || busy === "chat") return;
    const pid = detail.id;
    const thread = chat[pid] || [];
    setChat(c => ({ ...c, [pid]: [...thread, { role: "user", text: q }] }));
    setChatInput(""); setBusy("chat");
    try {
      const personaPrompt = persona === "devil"
        ? `You are "Reviewer 2" — a sharp, skeptical referee. Attack weaknesses: untested regimes, weak controls, overclaimed scaling, hidden assumptions. Incisive but fair, concise.`
        : `You are a peer scientist helping discuss this work. Concise and technical.`;
      const convo = thread.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n");
      const raw = await askAI(provider, geminiKey,
        `${personaPrompt}\nSubject: "${detail.title}" by ${detail.authors}.\nSummary: ${detail.summary}\n` +
        (convo ? `Conversation so far:\n${convo}\n` : "") + `User: ${q}`);
      setChat(c => ({ ...c, [pid]: [...(c[pid] || []), { role: "ai", text: raw.trim() }] }));
    } catch (e) {
      setChat(c => ({ ...c, [pid]: [...(c[pid] || []), { role: "ai", text: "⚠ " + e.message }] }));
    }
    setBusy(null);
  }

  // ── predictions ──
  function stakePrediction(stance) {
    const claim = predClaim.trim();
    if (!claim || !detail) return;
    setPredictions(p => [...p, { id: "pred-" + Date.now(), paperId: detail.id, paperTitle: detail.title, claim, stance, date: Date.now(), resolved: null }]);
    setPredClaim(""); setToast(`Prediction staked: ${stance === "yes" ? "will hold up" : "won't hold up"}`);
  }
  const predScore = useMemo(() => {
    const res = predictions.filter(p => p.resolved);
    return { right: res.filter(p => p.resolved === "right").length, total: res.length, open: predictions.length - res.length };
  }, [predictions]);

  // ── map ──
  const mapData = useMemo(() => {
    if (view !== "map" || saved.length < 3) return null;
    const papers = saved.slice(-30);
    const edges = buildEdges(papers);
    const pos = layoutGraph(papers.length, edges, 340, 340);
    return { papers, edges, pos };
  }, [view, saved]);

  function bibtex(p) {
    return `@article{${p.id.replace(/[^a-zA-Z0-9]/g, "")},\n  title={${p.title}},\n  author={${p.authors}},\n  journal={${p.src === "arxiv" ? "arXiv:" + p.id : p.venue}},\n  year={${p.year}}\n}`;
  }

  const verdictLabels = top?.src === "recall" ? ["GOT IT", "FORGOT"]
    : (top?.src === "idea" || top?.src === "gap") ? ["KEEP", "PASS"] : ["SAVE", "PASS"];

  const srcBadge = c =>
    c.src === "idea" ? ["⚡ collision idea", C.warn]
    : c.src === "gap" ? ["◌ research gap", C.warn]
    : c.src === "recall" ? ["↻ recall — can you remember it?", C.pump]
    : c.src === "feed" ? [`◈ ${c.feedName || "custom feed"}`, C.pump]
    : c.src === "openlib" ? [`◫ ${(c.venue || "open access").slice(0, 26)} · ${c.year}${c.cites != null ? ` · ${c.cites} cites` : ""}`, C.lib]
    : [`arXiv:${c.id.startsWith("seed") ? "demo" : c.id} · ${c.venue} · ${c.year}`, C.muted];

  // ─── render ───
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Space Grotesk', system-ui, sans-serif", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative", transition: "background .25s" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        input, textarea { outline: none; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
        @keyframes pulse { 0%,100% { opacity: .4 } 50% { opacity: 1 } }
      `}</style>

      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: theme === "dark" ? 0.05 : 0.04, pointerEvents: "none" }}>
        <defs><pattern id="lat" width="48" height="48" patternUnits="userSpaceOnUse">
          <circle cx="24" cy="24" r="1.4" fill={C.text} />
          <line x1="24" y1="24" x2="48" y2="0" stroke={C.text} strokeWidth="0.4" />
          <line x1="24" y1="24" x2="0" y2="0" stroke={C.text} strokeWidth="0.4" />
          <line x1="24" y1="24" x2="24" y2="48" stroke={C.text} strokeWidth="0.4" />
        </pattern></defs>
        <rect width="100%" height="100%" fill="url(#lat)" />
      </svg>

      {/* ── header ── */}
      <header style={{ padding: "14px 16px 8px", zIndex: 5 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 20, letterSpacing: "-0.02em" }}>
              Spin<span style={{ color: C.zpl }}>Stack</span>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginTop: 2 }}>
              🔥 {streak.count}d streak · {streak.reviewed} reviewed · {ideas.length} ideas
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setTheme(t => t === "dark" ? "paper" : "dark")} style={{ ...S.pill, padding: "7px 11px" }} aria-label="Toggle reading theme">
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button onClick={() => setShowSettings(true)} style={{ ...S.pill, padding: "7px 11px" }} aria-label="Settings">⚙</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 12, overflowX: "auto", paddingBottom: 2 }}>
          {[["deck", `Stack ${deck.length}`], ["feeds", "Feeds"], ["ideas", `Ideas ${ideas.length}`], ["map", "Map"], ["saved", `Saved ${saved.length}`]].map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} style={{ ...S.tab(view === v), flexShrink: 0 }}>{label}</button>
          ))}
        </div>
      </header>

      {/* ════ STACK ════ */}
      {view === "deck" && (
        <>
          <main style={{ flex: 1, position: "relative", padding: "8px 16px", zIndex: 4 }}>
            {deck.length === 0 && (
              <div style={{ textAlign: "center", marginTop: 70, color: C.muted }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>◇</div>
                <div style={{ fontWeight: 500, color: C.text, marginBottom: 6 }}>Stack empty</div>
                <div style={{ fontSize: 13, maxWidth: 250, margin: "0 auto 18px" }}>
                  Sync papers, generate a collision card, or run the gap detector.
                </div>
                <button onClick={syncAll} disabled={busy === "sync"} style={{ ...S.pill, borderColor: C.zpl, color: C.zpl }}>
                  {busy === "sync" ? "Syncing…" : "↻ Sync papers"}
                </button>
              </div>
            )}
            {deck.slice(1, 3).map((p, i) => (
              <div key={p.id} style={{ ...S.card, position: "absolute", left: 16, right: 16, transform: `scale(${1 - (i + 1) * 0.04}) translateY(${(i + 1) * 12}px)`, opacity: 1 - (i + 1) * 0.35, pointerEvents: "none" }}>
                <div style={{ height: 160 }} />
              </div>
            ))}
            {top && (() => {
              const [badge, badgeColor] = srcBadge(top);
              const isRecall = top.src === "recall";
              const isIdea = top.src === "idea" || top.src === "gap";
              const isPaper = top.src === "arxiv" || top.src === "openlib";
              const show = !isRecall || revealed[top.id];
              return (
                <div
                  onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
                  onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}
                  onClick={() => {
                    if (Math.abs(drag.dx) >= 5) return;
                    if (isRecall) setRevealed(r => ({ ...r, [top.id]: !r[top.id] }));
                    else setDetail(top);
                  }}
                  style={{
                    ...S.card, position: "relative", touchAction: "pan-y",
                    border: `1px solid ${isIdea ? C.warn + "60" : isRecall ? C.pump + "55" : C.line}`,
                    transform: `translate(${dx}px, ${drag.dy}px) rotate(${rot}deg)`,
                    transition: drag.active && !leaving ? "none" : "transform .26s ease",
                    boxShadow: saveOp > 0.1 ? `0 8px 40px ${C.zpl}40` : `0 8px 32px ${C.shadow}`,
                  }}>
                  <div style={{ ...S.verdict, right: 16, color: C.zpl, borderColor: C.zpl, opacity: saveOp }}>{verdictLabels[0]}</div>
                  <div style={{ ...S.verdict, left: 16, color: C.muted, borderColor: C.muted, opacity: passOp }}>{verdictLabels[1]}</div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                    <div style={{ fontFamily: MONO, fontSize: 11, color: badgeColor, lineHeight: 1.4 }}>{badge}</div>
                    <SpinDiagram dx={dx} C={C} />
                  </div>

                  {isPaper && <SpectrumStrip seed={top.title} C={C} />}

                  <h2 style={{ fontSize: 18, lineHeight: 1.32, fontWeight: 700, margin: "6px 0 8px" }}>{top.title}</h2>
                  <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>{top.authors}</div>

                  {isIdea && top.feasibility && <div style={{ marginBottom: 10 }}><FeasChip f={top.feasibility} C={C} /></div>}
                  {top.tags?.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                      {top.tags.map((t, i) => <Chip key={t} color={i === 0 ? C.pump : C.muted} C={C}>{t}</Chip>)}
                    </div>
                  )}

                  {isRecall && !show ? (
                    <div style={{ background: C.pumpSoft, border: `1px solid ${C.pump}40`, borderRadius: 10, padding: "16px 12px", marginBottom: 12, textAlign: "center" }}>
                      <div style={{ fontSize: 13.5, marginBottom: 10 }}>What was the key method or result?</div>
                      <button style={{ ...S.pill, borderColor: C.pump, color: C.pump }}
                        onClick={e => { e.stopPropagation(); setRevealed(r => ({ ...r, [top.id]: true })); }}>
                        Reveal answer
                      </button>
                    </div>
                  ) : top.struct ? (
                    <StructBlock struct={top.struct} C={C} />
                  ) : top.tldr ? (
                    <div style={{ background: C.zplSoft, border: `1px solid ${C.zpl}30`, borderRadius: 10, padding: "10px 12px", marginBottom: 12 }}>
                      <div style={{ fontFamily: MONO, fontSize: 9, color: C.zpl, marginBottom: 6, letterSpacing: "0.08em" }}>
                        {isIdea ? "FIRST EXPERIMENT" : "KEY POINT"}
                      </div>
                      {top.tldr.map((b, i) => (
                        <div key={i} style={{ fontSize: 13, lineHeight: 1.5, display: "flex", gap: 7, marginBottom: i < top.tldr.length - 1 ? 5 : 0 }}>
                          <span style={{ color: C.zpl }}>›</span><span>{b}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontSize: 13.5, lineHeight: 1.6, color: C.text, marginBottom: 12, display: "-webkit-box", WebkitLineClamp: 5, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {top.summary}
                    </p>
                  )}
                  {isIdea && top.summary && top.tldr && (
                    <p style={{ fontSize: 13.5, lineHeight: 1.55, marginBottom: 12, display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {top.summary}
                    </p>
                  )}
                  {isPaper && !top.struct && (
                    <button style={{ ...S.pill, padding: "5px 10px", fontSize: 11, marginBottom: 10 }}
                      onClick={e => { e.stopPropagation(); genStruct(top); }} disabled={busy === "struct"}>
                      {busy === "struct" ? "Breaking down…" : "✦ Why & findings"}
                    </button>
                  )}
                  {!isRecall && !isIdea && <PLMeter value={top.relevance} C={C} />}
                  <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginTop: 8 }}>
                    {isRecall ? "swipe right = remembered · left = forgot" : "tap card for details, chat & PDF"}
                  </div>
                </div>
              );
            })()}
          </main>
          {top && (
            <footer style={{ display: "flex", justifyContent: "center", gap: 18, padding: "10px 0 24px", zIndex: 5 }}>
              <ActionBtn label="Pass" onClick={() => commitSwipe("left")} border={C.line} color={C.muted} size={56} C={C}>✕</ActionBtn>
              <ActionBtn label="Undo" onClick={undo} border={C.line} color={C.muted} size={44} disabled={!history.length} C={C}>↩</ActionBtn>
              <ActionBtn label="Details" onClick={() => top.src !== "recall" && setDetail(top)} border={C.line} color={C.text} size={44} disabled={top.src === "recall"} C={C}>ⓘ</ActionBtn>
              <ActionBtn label="Save" onClick={() => commitSwipe("right")} border={C.zpl} color={C.zpl} size={56} glow C={C}>♥</ActionBtn>
            </footer>
          )}
        </>
      )}

      {/* ════ FEEDS ════ */}
      {view === "feeds" && (
        <main style={{ flex: 1, overflowY: "auto", padding: "8px 16px 30px", zIndex: 4 }}>
          <section style={{ ...S.card, padding: 16, marginBottom: 14 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.zpl, letterSpacing: "0.08em", marginBottom: 10 }}>
              PAPER TOPICS — ARXIV + SEMANTIC SCHOLAR
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 12 }}>
              {topics.map(t => (
                <Chip key={t.name} color={t.weight >= 1 ? C.pump : C.muted} C={C} onRemove={() => setTopics(ts => ts.filter(x => x.name !== t.name))}>
                  {t.name} <span style={{ opacity: 0.6 }}>{t.weight.toFixed(1)}</span>
                </Chip>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={newTopic} onChange={e => setNewTopic(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && newTopic.trim()) { setTopics(ts => [...ts, { name: newTopic.trim(), weight: 0.8 }]); setNewTopic(""); } }}
                placeholder="Add topic — e.g. spin squeezing" style={S.input} />
              <button style={S.pill} onClick={() => { if (newTopic.trim()) { setTopics(ts => [...ts, { name: newTopic.trim(), weight: 0.8 }]); setNewTopic(""); } }}>Add</button>
            </div>
            <button onClick={syncAll} disabled={busy === "sync"} style={{ ...S.pill, borderColor: C.zpl, color: C.zpl, marginTop: 12, width: "100%", padding: "11px 0" }}>
              {busy === "sync"
                ? <span style={{ animation: "pulse 1s infinite" }}>{harvestUrl.trim() ? "Loading hourly harvest…" : "Syncing arXiv + Semantic Scholar…"}</span>
                : harvestUrl.trim() ? "↻ Sync from your harvester" : "↻ Sync papers (live sources)"}
            </button>
            <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
              {harvestUrl.trim()
                ? <>Reading your GitHub Actions harvest (arXiv + Semantic Scholar + OpenAlex, hourly).{harvestMeta ? ` Last harvest: ${harvestMeta.generated} UTC · ${harvestMeta.count} papers.` : ""} Configure in ⚙ Settings.</>
                : <>◫ Live mode: arXiv + Semantic Scholar. For the hourly 100-paper harvester pipeline, paste your latest.json URL in ⚙ Settings.</>}
            </div>
          </section>

          <section style={{ ...S.card, padding: 16 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.pump, letterSpacing: "0.08em", marginBottom: 10 }}>CUSTOM FEEDS — DESCRIBE ANYTHING</div>
            <textarea value={feedPrompt} onChange={e => setFeedPrompt(e.target.value)} rows={2}
              placeholder='e.g. "treks in Europe in September"'
              style={{ ...S.input, width: "100%", resize: "none", marginBottom: 8, fontFamily: "inherit" }} />
            <button onClick={generateFeed} disabled={busy === "feed" || !feedPrompt.trim()}
              style={{ ...S.pill, borderColor: C.pump, color: C.pump, width: "100%", padding: "11px 0", opacity: feedPrompt.trim() ? 1 : 0.4 }}>
              {busy === "feed" ? <span style={{ animation: "pulse 1s infinite" }}>Generating cards…</span> : "✦ Generate feed"}
            </button>
            {feeds.length > 0 && <div style={{ height: 14 }} />}
            {feeds.map(f => (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: `1px solid ${C.line}` }}>
                <button onClick={() => setFeeds(fs => fs.map(x => x.id === f.id ? { ...x, active: !x.active } : x))}
                  style={{ width: 38, height: 22, borderRadius: 11, border: `1px solid ${f.active ? C.pump : C.line}`, background: f.active ? C.pumpSoft : "transparent", position: "relative", flexShrink: 0, cursor: "pointer" }}
                  aria-label={f.active ? "Turn feed off" : "Turn feed on"}>
                  <span style={{ position: "absolute", top: 2, left: f.active ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: f.active ? C.pump : C.muted, transition: "left .15s" }} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>{f.cards.length} cards</div>
                </div>
                <button style={{ ...S.pill, color: C.muted, padding: "5px 10px" }} onClick={() => setFeeds(fs => fs.filter(x => x.id !== f.id))}>Delete</button>
              </div>
            ))}
          </section>
        </main>
      )}

      {/* ════ IDEAS ════ */}
      {view === "ideas" && (
        <main style={{ flex: 1, overflowY: "auto", padding: "8px 16px 30px", zIndex: 4 }}>
          <section style={{ ...S.card, padding: 16, marginBottom: 14 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.pump, letterSpacing: "0.08em", marginBottom: 8 }}>LAB PROFILE — TUNES FEASIBILITY OF EVERY IDEA</div>
            <textarea value={labProfile} onChange={e => setLabProfile(e.target.value)} rows={3}
              placeholder="e.g. confocal ODMR setup, NV ensembles + single NVs, AWG pulse control, 532nm excitation, MATLAB analysis pipeline, no cryostat…"
              style={{ ...S.input, width: "100%", resize: "none", fontFamily: "inherit" }} />
          </section>

          <section style={{ display: "flex", gap: 10, marginBottom: 14 }}>
            <button onClick={() => collide()} disabled={busy === "collide" || saved.length < 2}
              style={{ ...S.pill, flex: 1, padding: "13px 0", borderColor: C.warn, color: C.warn, opacity: saved.length < 2 ? 0.4 : 1 }}>
              {busy === "collide" ? <span style={{ animation: "pulse 1s infinite" }}>Colliding…</span> : "⚡ Collision card"}
            </button>
            <button onClick={detectGaps} disabled={busy === "gaps" || saved.length < 3}
              style={{ ...S.pill, flex: 1, padding: "13px 0", borderColor: C.warn, color: C.warn, opacity: saved.length < 3 ? 0.4 : 1 }}>
              {busy === "gaps" ? <span style={{ animation: "pulse 1s infinite" }}>Scanning…</span> : "◌ Detect gaps"}
            </button>
          </section>
          {saved.length < 3 && (
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginBottom: 14, textAlign: "center" }}>
              Generators need saved papers to work with — go swipe right on a few.
            </div>
          )}

          <div style={{ fontFamily: MONO, fontSize: 10, color: C.warn, letterSpacing: "0.08em", margin: "4px 0 10px" }}>
            IDEAS BACKLOG ({ideas.length})
          </div>
          {ideas.length === 0 && (
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>
              Swipe right on ⚡ collision or ◌ gap cards in the stack to keep them here.
            </div>
          )}
          {[...ideas].reverse().map(idea => (
            <div key={idea.id} style={{ ...S.card, padding: 16, marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.35 }}>{idea.title}</div>
                <FeasChip f={idea.feasibility} C={C} />
              </div>
              <p style={{ fontSize: 13, lineHeight: 1.55, color: C.text, margin: "0 0 8px" }}>{idea.hypothesis}</p>
              {idea.first && (
                <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted, marginBottom: 10 }}>→ first: {idea.first}</div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button style={{ ...S.pill, borderColor: C.warn, color: C.warn }} onClick={() => makeProposal(idea)} disabled={busy === "prop"}>
                  {busy === "prop" ? "Drafting…" : "📄 Proposal seed"}
                </button>
                <button style={{ ...S.pill, color: C.muted }} onClick={() => setIdeas(i => i.filter(x => x.id !== idea.id))}>Delete</button>
              </div>
            </div>
          ))}

          <div style={{ fontFamily: MONO, fontSize: 10, color: C.zpl, letterSpacing: "0.08em", margin: "18px 0 10px" }}>
            PREDICTIONS — SCORE {predScore.right}/{predScore.total} · {predScore.open} OPEN
          </div>
          {predictions.length === 0 && (
            <div style={{ fontSize: 13, color: C.muted }}>
              Stake predictions on bold claims from any paper's detail sheet. Resolve them when follow-up work appears.
            </div>
          )}
          {[...predictions].reverse().map(p => (
            <div key={p.id} style={{ ...S.card, padding: 14, marginBottom: 10 }}>
              <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 4 }}>"{p.claim}"</div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginBottom: 8 }}>
                {p.paperTitle.slice(0, 48)}… · you bet: <span style={{ color: p.stance === "yes" ? C.pump : C.zpl }}>{p.stance === "yes" ? "holds up" : "won't hold"}</span> · {Math.round((Date.now() - p.date) / DAY)}d ago
              </div>
              {p.resolved ? (
                <Chip color={p.resolved === "right" ? C.pump : C.zpl} C={C}>{p.resolved === "right" ? "✓ you were right" : "✗ you were wrong"}</Chip>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={{ ...S.pill, padding: "5px 10px", color: C.pump }}
                    onClick={() => setPredictions(ps => ps.map(x => x.id === p.id ? { ...x, resolved: "right" } : x))}>I was right</button>
                  <button style={{ ...S.pill, padding: "5px 10px", color: C.zpl }}
                    onClick={() => setPredictions(ps => ps.map(x => x.id === p.id ? { ...x, resolved: "wrong" } : x))}>I was wrong</button>
                </div>
              )}
            </div>
          ))}
        </main>
      )}

      {/* ════ MAP ════ */}
      {view === "map" && (
        <main style={{ flex: 1, overflowY: "auto", padding: "8px 16px 30px", zIndex: 4 }}>
          {!mapData ? (
            <div style={{ textAlign: "center", color: C.muted, fontSize: 13, maxWidth: 260, margin: "80px auto 0" }}>
              The knowledge map needs at least 3 saved papers. The empty space between clusters is where your next idea lives.
            </div>
          ) : (
            <>
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginBottom: 8, lineHeight: 1.5 }}>
                Your library as a graph — links = shared concepts. Tap two nodes, then collide them.
              </div>
              <div style={{ ...S.card, padding: 8, marginBottom: 12 }}>
                <svg viewBox="0 0 340 340" style={{ width: "100%", display: "block" }}>
                  {mapData.edges.map(([a, b, w], i) => (
                    <line key={i} x1={mapData.pos[a].x} y1={mapData.pos[a].y} x2={mapData.pos[b].x} y2={mapData.pos[b].y}
                      stroke={C.line} strokeWidth={0.6 + w * 0.5} opacity={0.8} />
                  ))}
                  {mapData.papers.map((p, i) => {
                    const sel = mapSel.includes(p.id);
                    return (
                      <g key={p.id} onClick={() => setMapSel(s => sel ? s.filter(x => x !== p.id) : (s.length >= 2 ? [s[1], p.id] : [...s, p.id]))} style={{ cursor: "pointer" }}>
                        <circle cx={mapData.pos[i].x} cy={mapData.pos[i].y} r={sel ? 10 : 7}
                          fill={sel ? C.zpl : p.src === "feed" ? C.pump : p.src === "openlib" ? C.lib : C.surface2}
                          stroke={sel ? C.zpl : C.muted} strokeWidth="1.5"
                          style={sel ? { filter: `drop-shadow(0 0 6px ${C.zpl})` } : {}} />
                        <circle cx={mapData.pos[i].x} cy={mapData.pos[i].y} r={16} fill="transparent" />
                      </g>
                    );
                  })}
                </svg>
              </div>
              {mapSel.map(id => {
                const p = saved.find(x => x.id === id);
                return p ? (
                  <div key={id} style={{ fontFamily: MONO, fontSize: 11, color: C.zpl, marginBottom: 6, lineHeight: 1.4 }}>
                    ● {p.title.slice(0, 70)}{p.title.length > 70 ? "…" : ""}
                  </div>
                ) : null;
              })}
              <button
                onClick={() => {
                  const [a, b] = mapSel.map(id => saved.find(x => x.id === id));
                  if (a && b) collide(a, b);
                }}
                disabled={mapSel.length !== 2 || busy === "collide"}
                style={{ ...S.pill, width: "100%", padding: "13px 0", borderColor: C.warn, color: C.warn, marginTop: 6, opacity: mapSel.length === 2 ? 1 : 0.4 }}>
                {busy === "collide" ? <span style={{ animation: "pulse 1s infinite" }}>Colliding…</span> : `⚡ Collide selected (${mapSel.length}/2)`}
              </button>
            </>
          )}
        </main>
      )}

      {/* ════ SAVED ════ */}
      {view === "saved" && (
        <main style={{ flex: 1, overflowY: "auto", padding: "8px 16px 30px", zIndex: 4 }}>
          {saved.length === 0 ? (
            <div style={{ textAlign: "center", marginTop: 80, color: C.muted, fontSize: 13 }}>
              Nothing saved yet. Swipe right on cards worth keeping.
            </div>
          ) : (
            <>
              <button style={{ ...S.pill, width: "100%", padding: "10px 0", marginBottom: 12 }}
                onClick={() => { navigator.clipboard?.writeText(saved.map(bibtex).join("\n\n")); setToast("All BibTeX copied"); }}>
                Copy all as BibTeX ({saved.length})
              </button>
              {saved.map(p => (
                <div key={p.id} style={{ ...S.card, padding: 16, marginBottom: 12, cursor: "pointer" }} onClick={() => setDetail(p)}>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: srcBadge(p)[1], marginBottom: 6 }}>
                    {srcBadge(p)[0]}
                    {recallMeta[p.id] && ` · recall in ${Math.max(0, Math.ceil((recallMeta[p.id].due - Date.now()) / DAY))}d`}
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.35, marginBottom: 6 }}>{p.title}</div>
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>{p.authors}</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button style={S.pill} onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(bibtex(p)); setToast("BibTeX copied"); }}>BibTeX</button>
                    {p.pdfUrl && <button style={{ ...S.pill, borderColor: C.lib, color: C.lib }} onClick={e => { e.stopPropagation(); window.open(p.pdfUrl, "_blank"); }}>PDF ↗</button>}
                    {p.url && <button style={S.pill} onClick={e => { e.stopPropagation(); window.open(p.url, "_blank"); }}>Page ↗</button>}
                    <button style={{ ...S.pill, color: C.muted }} onClick={e => { e.stopPropagation(); setSaved(s => s.filter(x => x.id !== p.id)); }}>Remove</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </main>
      )}

      {/* ════ DETAIL SHEET ════ */}
      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: "fixed", inset: 0, background: theme === "dark" ? "rgba(5,7,12,0.78)" : "rgba(40,36,28,0.45)", zIndex: 20, display: "flex", alignItems: "flex-end" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface2, width: "100%", height: "88vh", display: "flex", flexDirection: "column", borderRadius: "20px 20px 0 0", borderTop: `2px solid ${C.zpl}` }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: C.line, margin: "12px auto 0" }} />
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px 10px" }}>
              <div style={{ fontFamily: MONO, fontSize: 11, color: srcBadge(detail)[1], marginBottom: 8 }}>{srcBadge(detail)[0]}</div>
              <h2 style={{ fontSize: 19, lineHeight: 1.32, fontWeight: 700, margin: "0 0 6px" }}>{detail.title}</h2>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>{detail.authors}</div>

              {detail.struct ? (
                <StructBlock struct={detail.struct} C={C} full />
              ) : (
                <p style={{ fontSize: 14, lineHeight: 1.65, margin: "0 0 14px" }}>{detail.summary}</p>
              )}
              {detail.tldr && !detail.struct && (
                <div style={{ background: C.zplSoft, border: `1px solid ${C.zpl}30`, borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: C.zpl, marginBottom: 6, letterSpacing: "0.08em" }}>
                    {detail.src === "idea" || detail.src === "gap" ? "FIRST EXPERIMENT" : "KEY POINT"}
                  </div>
                  {detail.tldr.map((b, i) => (
                    <div key={i} style={{ fontSize: 13, lineHeight: 1.5, display: "flex", gap: 7, marginBottom: 5 }}>
                      <span style={{ color: C.zpl }}>›</span><span>{b}</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {!detail.struct && detail.summary && (detail.src === "arxiv" || detail.src === "openlib" || detail.src === "feed") && (
                  <button onClick={() => genStruct(detail)} disabled={busy === "struct"} style={{ ...S.pill, borderColor: C.zpl, color: C.zpl }}>
                    {busy === "struct" ? "Breaking down…" : "✦ Why & findings"}
                  </button>
                )}
                {detail.pdfUrl && <button style={{ ...S.pill, borderColor: C.lib, color: C.lib }} onClick={() => window.open(detail.pdfUrl, "_blank")}>Read PDF ↗</button>}
                {detail.url && <button style={S.pill} onClick={() => window.open(detail.url, "_blank")}>Page ↗</button>}
              </div>

              {(detail.src === "arxiv" || detail.src === "openlib" || detail.src === "feed") && (
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", marginBottom: 16 }}>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: C.warn, letterSpacing: "0.08em", marginBottom: 8 }}>STAKE A PREDICTION</div>
                  <input value={predClaim} onChange={e => setPredClaim(e.target.value)}
                    placeholder='Claim — e.g. "12× coherence gain will replicate"' style={{ ...S.input, width: "100%", marginBottom: 8 }} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={{ ...S.pill, flex: 1, color: C.pump, opacity: predClaim.trim() ? 1 : 0.4 }} disabled={!predClaim.trim()} onClick={() => stakePrediction("yes")}>Will hold up</button>
                    <button style={{ ...S.pill, flex: 1, color: C.zpl, opacity: predClaim.trim() ? 1 : 0.4 }} disabled={!predClaim.trim()} onClick={() => stakePrediction("no")}>Won't hold</button>
                  </div>
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "6px 0 10px" }}>
                <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: "0.08em" }}>
                  DISCUSS — {provider === "gemini" ? "GEMINI" : "CLAUDE"}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => setPersona("peer")} style={{ ...S.tab(persona === "peer"), padding: "4px 10px", fontSize: 10 }}>Peer</button>
                  <button onClick={() => setPersona("devil")} style={{ ...S.tab(persona === "devil"), padding: "4px 10px", fontSize: 10 }}>😈 Reviewer 2</button>
                </div>
              </div>
              {(chat[detail.id] || []).map((m, i) => (
                <div key={i} style={{
                  maxWidth: "88%", marginBottom: 8, padding: "9px 12px", borderRadius: 12, fontSize: 13.5, lineHeight: 1.55,
                  marginLeft: m.role === "user" ? "auto" : 0,
                  background: m.role === "user" ? C.zplSoft : C.surface,
                  border: `1px solid ${m.role === "user" ? C.zpl + "50" : C.line}`,
                  whiteSpace: "pre-wrap",
                }}>{m.text}</div>
              ))}
              {busy === "chat" && <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, animation: "pulse 1s infinite" }}>{persona === "devil" ? "sharpening knives…" : "thinking…"}</div>}
            </div>
            <div style={{ display: "flex", gap: 8, padding: "10px 16px 22px", borderTop: `1px solid ${C.line}` }}>
              <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && sendChat()}
                placeholder={persona === "devil" ? "Defend this idea against Reviewer 2…" : "e.g. how does this compare to XY8?"}
                style={{ ...S.input, flex: 1 }} />
              <button onClick={sendChat} disabled={busy === "chat" || !chatInput.trim()}
                style={{ ...S.pill, background: C.zpl, color: C.onAccent, border: "none", padding: "10px 16px", opacity: chatInput.trim() ? 1 : 0.4 }}>↑</button>
            </div>
          </div>
        </div>
      )}

      {/* ════ PROPOSAL MODAL ════ */}
      {proposal && (
        <div onClick={() => setProposal(null)} style={{ position: "fixed", inset: 0, background: theme === "dark" ? "rgba(5,7,12,0.85)" : "rgba(40,36,28,0.5)", zIndex: 26, display: "flex", alignItems: "center", padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface2, width: "100%", maxHeight: "84vh", overflowY: "auto", borderRadius: 16, padding: 20, border: `1px solid ${C.warn}` }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.warn, letterSpacing: "0.08em", marginBottom: 8 }}>PROPOSAL SEED</div>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12 }}>{proposal.title}</div>
            <pre style={{ fontSize: 13, lineHeight: 1.65, whiteSpace: "pre-wrap", fontFamily: "'Space Grotesk', sans-serif", margin: "0 0 14px" }}>{proposal.text}</pre>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ ...S.pill, flex: 1, background: C.warn, color: theme === "dark" ? "#0B0E14" : "#fff", border: "none", fontWeight: 700 }}
                onClick={() => { navigator.clipboard?.writeText(`${proposal.title}\n\n${proposal.text}`); setToast("Proposal copied"); }}>Copy</button>
              <button style={{ ...S.pill, flex: 1 }} onClick={() => setProposal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ════ SETTINGS ════ */}
      {showSettings && (
        <div onClick={() => setShowSettings(false)} style={{ position: "fixed", inset: 0, background: theme === "dark" ? "rgba(5,7,12,0.78)" : "rgba(40,36,28,0.45)", zIndex: 25, display: "flex", alignItems: "flex-end" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface2, width: "100%", borderRadius: "20px 20px 0 0", padding: "22px 20px 32px", borderTop: `2px solid ${C.line}` }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, letterSpacing: "0.08em", marginBottom: 12 }}>THEME</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
              <button onClick={() => setTheme("dark")} style={{ ...S.tab(theme === "dark"), flex: 1, padding: "10px 0" }}>☾ Dark lab</button>
              <button onClick={() => setTheme("paper")} style={{ ...S.tab(theme === "paper"), flex: 1, padding: "10px 0" }}>☀ Paper (reading)</button>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, letterSpacing: "0.08em", marginBottom: 12 }}>HARVEST SOURCE — HOURLY PIPELINE</div>
            <input value={harvestUrl} onChange={e => setHarvestUrl(e.target.value)}
              placeholder="https://raw.githubusercontent.com/you/repo/main/papers/latest.json"
              style={{ ...S.input, width: "100%", marginBottom: 6, fontSize: 11.5, fontFamily: MONO }} />
            <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.muted, lineHeight: 1.5, marginBottom: 18 }}>
              Paste the raw URL of latest.json from your harvester repo. The app loads it on launch and on every sync — ~100 fresh papers from 3 sources, refreshed hourly by GitHub Actions.
              {harvestMeta ? ` Connected ✓ last harvest ${harvestMeta.generated} UTC, ${harvestMeta.count} papers.` : ""}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, letterSpacing: "0.08em", marginBottom: 12 }}>AI PROVIDER</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button onClick={() => setProvider("claude")} style={{ ...S.tab(provider === "claude"), flex: 1, padding: "10px 0" }}>Claude (built-in)</button>
              <button onClick={() => setProvider("gemini")} style={{ ...S.tab(provider === "gemini"), flex: 1, padding: "10px 0" }}>Gemini (your key)</button>
            </div>
            {provider === "gemini" && (
              <>
                <input type="password" value={geminiKey} onChange={e => setGeminiKey(e.target.value)}
                  placeholder="Paste Gemini API key (AIza…)" style={{ ...S.input, width: "100%", marginBottom: 8 }} />
                <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.muted, lineHeight: 1.5, marginBottom: 8 }}>
                  Key lives in memory only (not stored) and is sent directly to Google's API. Get one free at aistudio.google.com.
                </div>
              </>
            )}
            <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.muted, lineHeight: 1.5 }}>
              Sources: arXiv + Semantic Scholar (open access, all publishers). AI powers: why/findings breakdowns · feeds · chat & Reviewer 2 · collisions · gaps · proposals.
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: "fixed", bottom: 100, left: "50%", transform: "translateX(-50%)", background: C.surface2, border: `1px solid ${C.zpl}`, color: C.text, padding: "9px 18px", borderRadius: 10, fontSize: 13, zIndex: 30, boxShadow: `0 4px 24px ${C.shadow}`, whiteSpace: "nowrap", maxWidth: "90vw", overflow: "hidden", textOverflow: "ellipsis" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── theme-aware styles ──────────────────────────────────────────────
function makeStyles(C) {
  return {
    card: { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 18, padding: 20, userSelect: "none" },
    verdict: { position: "absolute", top: 18, padding: "4px 12px", border: "2px solid", borderRadius: 8, fontFamily: MONO, fontWeight: 700, fontSize: 15, letterSpacing: "0.1em", transform: "rotate(-6deg)", pointerEvents: "none", background: C.bg + "CC", zIndex: 2 },
    pill: { background: "transparent", border: `1px solid ${C.line}`, color: C.text, borderRadius: 10, padding: "8px 14px", fontSize: 12, fontFamily: "'Space Grotesk', sans-serif", cursor: "pointer" },
    input: { background: C.bg, border: `1px solid ${C.line}`, color: C.text, borderRadius: 10, padding: "10px 12px", fontSize: 13, fontFamily: "'Space Grotesk', sans-serif" },
    tab: active => ({ background: active ? C.surface2 : "transparent", border: `1px solid ${active ? C.zpl : C.line}`, color: C.text, borderRadius: 10, padding: "7px 13px", fontSize: 12, fontFamily: MONO, cursor: "pointer" }),
  };
}
