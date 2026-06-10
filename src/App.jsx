import React, { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";
import { sGet, persist, onSyncStatus } from "./sync.js";

const HARVEST_URL =
  "https://raw.githubusercontent.com/lioned97/spinstack-harvest/main/papers/latest.json";

const DEFAULT_TOPICS = [
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
];

// ── helpers ────────────────────────────────────────────────

const nowISO = () => new Date().toISOString();

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

function qualityFilter(p) {
  if (!p || !p.id || !p.title) return false;
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
  const text = `${paper.title} ${paper.abstract || ""} ${paper.venue || ""}`.toLowerCase();
  const cy = new Date().getFullYear();

  const anchors = {
    "nv center": 1.6,
    "nitrogen-vacancy": 1.6,
    "open quantum": 1.4,
    decoherence: 1.35,
    "quantum sensing": 1.3,
    "spin coherence": 1.3,
    magnetometry: 1.3,
    lindblad: 1.25,
    "hamiltonian engineering": 1.25,
  };
  for (const [k, w] of Object.entries(anchors)) if (text.includes(k)) score *= w;

  for (const t of topics) if (text.includes(t.name.toLowerCase())) score += 0.35;

  for (const [t, w] of Object.entries(affinity.topics || {}))
    if (text.includes(t)) score += w;
  for (const a of paper.authors || []) {
    const w = (affinity.authors || {})[a.toLowerCase().trim()];
    if (w) score += w;
  }

  const y = parseInt(paper.year, 10) || cy;
  if (y > cy) score *= 0.6;
  else if (y === cy) score *= 1.35;
  else if (y === cy - 1) score *= 1.15;
  else if (y < cy - 3) score *= 0.75;

  if (text.includes("arxiv")) score += 0.2;
  if (text.includes("experiment")) score += 0.15;
  return score;
}

// ── the signature: relevance as an ODMR dip ────────────────
// Deeper dip = stronger resonance = more relevant. Score ~[0.3, 4+]
// maps to dip depth 10–95%.
function OdmrDip({ score }) {
  const depth = Math.max(0.1, Math.min(0.95, (score - 0.3) / 3.7));
  const yBase = 5;
  const yDip = yBase + depth * 16;
  const d = `M0 ${yBase} L34 ${yBase} C 42 ${yBase}, 44 ${yDip}, 50 ${yDip} C 56 ${yDip}, 58 ${yBase}, 66 ${yBase} L100 ${yBase}`;
  return (
    <div className="odmr" aria-label={`Relevance ${score.toFixed(2)}`}>
      <svg viewBox="0 0 100 26" preserveAspectRatio="none">
        <path d={d} stroke="#ff5a57" strokeWidth="1.6" fill="none" vectorEffect="non-scaling-stroke" />
        <line x1="0" y1={yBase} x2="100" y2={yBase} stroke="#1e2630" strokeWidth="0.5" />
      </svg>
      <div className="lbl">
        RELEVANCE <b>{score.toFixed(2)}</b>
      </div>
    </div>
  );
}

// ── main component ─────────────────────────────────────────
export default function App() {
  const [pool, setPool] = useState(() => sGet("ss2_pool", []));
  const [saved, setSaved] = useState(() => sGet("ss2_saved", {}));
  const [skipped, setSkipped] = useState(() => sGet("ss2_skipped", {}));
  const [topics, setTopics] = useState(() =>
    sGet(
      "ss2_topics",
      DEFAULT_TOPICS.map((name, i) => ({ id: `d${i}`, name, addedAt: nowISO() }))
    )
  );
  const [affinity, setAffinity] = useState(() => sGet("ss2_affinity", { topics: {}, authors: {} }));
  const [analyses, setAnalyses] = useState(() => sGet("ss2_analyses", {}));
  const [settings, setSettings] = useState(() =>
    sGet("ss2_settings", { uiMode: "feed", harvestUrl: HARVEST_URL, updatedAt: nowISO() })
  );
  const [lastSeen, setLastSeen] = useState(() => sGet("ss2_last_seen", ""));

  const [tab, setTab] = useState("stack");
  const [toast, setToast] = useState("");
  const [syncStatus, setSyncStatus] = useState("syncing");
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [analyzingId, setAnalyzingId] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [newTopic, setNewTopic] = useState("");
  const [deckIndex, setDeckIndex] = useState(0);
  const [drag, setDrag] = useState({ x: 0, active: false });
  const dragStart = useRef(0);

  useEffect(() => onSyncStatus(setSyncStatus), []);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => setToast(""), 2500);
  };

  // ── feed loading ──
  async function loadFeed(showStatus = true) {
    setLoadingFeed(true);
    try {
      const res = await fetch(settings.harvestUrl || HARVEST_URL);
      if (!res.ok) throw new Error(`feed ${res.status}`);
      const raw = await res.json();
      const incoming = (Array.isArray(raw) ? raw : raw.papers || []).filter(qualityFilter);
      // merge with existing pool (live-injected topic papers survive refresh)
      const byId = new Map();
      for (const p of [...incoming, ...pool]) if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
      const merged = [...byId.values()];
      setPool(merged);
      localStorage.setItem("ss2_pool", JSON.stringify(merged)); // device-local cache, not synced
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

  // ── derived ──
  const triage = useMemo(() => {
    const list = pool.filter((p) => !saved[p.id] && !skipped[p.id]);
    return list
      .map((p) => ({ ...p, _score: scoreCard(p, topics, affinity) }))
      .sort((a, b) => b._score - a._score);
  }, [pool, saved, skipped, topics, affinity]);

  const newCount = useMemo(
    () => triage.filter((p) => (p.harvestedAt || "") > (lastSeen || "")).length,
    [triage, lastSeen]
  );

  // App-icon badge (where the platform supports it)
  useEffect(() => {
    if ("setAppBadge" in navigator) {
      (newCount > 0 ? navigator.setAppBadge(newCount) : navigator.clearAppBadge()).catch(() => {});
    }
  }, [newCount]);

  // clamp deck index
  useEffect(() => {
    if (deckIndex >= triage.length) setDeckIndex(0);
  }, [triage.length, deckIndex]);

  // ── swipe verdicts ──
  function verdict(paper, kept) {
    // learn
    const next = {
      topics: { ...(affinity.topics || {}) },
      authors: { ...(affinity.authors || {}) },
    };
    const delta = kept ? 0.35 : -0.2;
    const text = `${paper.title} ${paper.abstract || ""}`.toLowerCase();
    for (const t of topics) {
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
      const p = triage[deckIndex];
      if (!p) return;
      if (e.key === "ArrowRight") verdict(p, true);
      if (e.key === "ArrowLeft") verdict(p, false);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, settings.uiMode, triage, deckIndex, affinity, topics, saved, skipped]);

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
    const p = triage[deckIndex];
    if (p && Math.abs(drag.x) > 80) verdict(p, drag.x > 0);
    setDrag({ x: 0, active: false });
  };

  // ── topics ──
  async function addTopic(e) {
    e.preventDefault();
    const name = newTopic.trim();
    if (!name) return;
    if (topics.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      setNewTopic("");
      return showToast("Topic already tracked");
    }
    const nt = [...topics, { id: `${Date.now()}`, name, addedAt: nowISO() }];
    setTopics(nt);
    persist("ss2_topics", nt);
    setNewTopic("");
    showToast(`Tracking “${name}” — fetching papers…`);
    // live OpenAlex injection (CORS-safe); daily harvest picks it up too
    try {
      const url = `https://api.openalex.org/works?filter=title_and_abstract.search:${encodeURIComponent(
        name
      )}&per_page=12&sort=publication_year:desc`;
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      const data = await res.json();
      const fresh = (data.results || []).map(normalizeOpenAlex).filter(qualityFilter);
      const byId = new Map();
      for (const p of [...fresh, ...pool]) if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
      const merged = [...byId.values()];
      setPool(merged);
      localStorage.setItem("ss2_pool", JSON.stringify(merged));
      showToast(`Added ${fresh.length} papers for “${name}”`);
    } catch {
      showToast("Live fetch failed — daily harvest will cover it");
    }
  }

  function removeTopic(id) {
    const nt = topics.filter((t) => t.id !== id);
    setTopics(nt);
    persist("ss2_topics", nt);
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
      showToast(`Analysis failed: ${err.message}`.slice(0, 60));
    } finally {
      setAnalyzingId(null);
    }
  }

  function markAllSeen() {
    const iso = nowISO();
    setLastSeen(iso);
    persist("ss2_last_seen", iso);
  }

  function setUiMode(uiMode) {
    const ns = { ...settings, uiMode, updatedAt: nowISO() };
    setSettings(ns);
    persist("ss2_settings", ns);
  }

  // ── card renderer (shared by feed + deck) ──
  function PaperCard({ p, deck = false, style }) {
    const isNew = (p.harvestedAt || "") > (lastSeen || "");
    const an = analyses[p.id];
    const open = !!expanded[p.id];
    return (
      <article className={`card${deck && drag.active ? " dragging" : ""}`} style={style}>
        <div className="eyebrow">
          <span className="src">{p.source || p.venue || "paper"}</span>
          <span>{p.year}</span>
          {p.venue && <span>· {String(p.venue).slice(0, 36)}</span>}
          {isNew && <span style={{ color: "#ff5a57" }}>· NEW</span>}
        </div>
        <h2>{p.title}</h2>
        <div className="authors">
          {(p.authors || []).slice(0, 4).join(", ")}
          {(p.authors || []).length > 4 ? " et al." : ""}
        </div>
        {p.summary ? (
          <p className="summary">{p.summary}</p>
        ) : (
          <p className="abstract">{(p.abstract || "").slice(0, open ? 4000 : 220)}{!open && (p.abstract || "").length > 220 ? "…" : ""}</p>
        )}
        {open && p.summary && p.abstract && <p className="abstract">{p.abstract}</p>}
        {(p.methods || []).length > 0 && (
          <div className="chips">
            {p.methods.slice(0, 5).map((m) => (
              <span key={m} className="chip method">
                {m}
              </span>
            ))}
          </div>
        )}
        <OdmrDip score={p._score ?? scoreCard(p, topics, affinity)} />
        {an && open && (
          <div className="analysis">
            <span className="tag">Why this matters · Claude</span>
            {an.text}
          </div>
        )}
        <div className="actions">
          {!deck && (
            <>
              <button className="btn skip" onClick={() => verdict(p, false)}>
                <X size={15} style={{ verticalAlign: "-3px" }} /> Skip
              </button>
              <button className="btn save" onClick={() => verdict(p, true)}>
                <Heart size={15} style={{ verticalAlign: "-3px" }} /> Save
              </button>
            </>
          )}
          <button
            className="btn ghost"
            disabled={analyzingId === p.id}
            onClick={() => (open && an ? setExpanded((x) => ({ ...x, [p.id]: false })) : analyze(p))}
            title="Why this matters for my research"
          >
            <Sparkles size={15} style={{ verticalAlign: "-3px" }} />{" "}
            {analyzingId === p.id ? "…" : an && open ? "Hide" : "Why?"}
          </button>
          {!open && (p.abstract || "").length > 220 && !an && (
            <button className="btn ghost" onClick={() => setExpanded((x) => ({ ...x, [p.id]: true }))}>
              More
            </button>
          )}
          {p.url && (
            <a className="btn ghost" href={p.url} target="_blank" rel="noreferrer" title="Open paper">
              <ExternalLink size={15} style={{ verticalAlign: "-3px" }} />
            </a>
          )}
        </div>
      </article>
    );
  }

  // ── views ──
  const deckPaper = triage[deckIndex];

  return (
    <div className="app">
      <header className="hdr">
        <h1>SpinStack</h1>
        <span className="readout">
          {tab} · {triage.length} queued
        </span>
        {newCount > 0 && <span className="badge">{newCount} new</span>}
        <span className="spacer" />
        {tab === "stack" && (
          <div className="mode" role="tablist" aria-label="View mode">
            <button className={settings.uiMode === "feed" ? "on" : ""} onClick={() => setUiMode("feed")}>
              FEED
            </button>
            <button className={settings.uiMode === "swipe" ? "on" : ""} onClick={() => setUiMode("swipe")}>
              SWIPE
            </button>
          </div>
        )}
        <button onClick={() => loadFeed(true)} title="Refresh feed" aria-label="Refresh feed">
          <RefreshCw size={16} color={loadingFeed ? "#4dd8c7" : "#8a97a6"} className={loadingFeed ? "spin" : ""} />
        </button>
        <span className={`sync-dot ${syncStatus}`} title={`Sync: ${syncStatus}`} />
      </header>

      {tab === "stack" && newCount > 0 && (
        <div className="deck-meta">
          <button onClick={markAllSeen} style={{ color: "#4dd8c7" }}>
            mark all seen
          </button>
        </div>
      )}

      {tab === "stack" && settings.uiMode === "feed" && (
        <main>
          {triage.length === 0 ? (
            <div className="empty">
              <div className="big">Queue clear</div>
              The harvester runs daily at 06:00 UTC. Tap ↻ to refresh, or add a topic to fetch papers now.
            </div>
          ) : (
            triage.slice(0, 60).map((p) => <PaperCard key={p.id} p={p} />)
          )}
        </main>
      )}

      {tab === "stack" && settings.uiMode === "swipe" && (
        <main className="deck">
          {!deckPaper ? (
            <div className="empty">
              <div className="big">Queue clear</div>
              Swipe right to save, left to skip. New papers land daily.
            </div>
          ) : (
            <>
              <div className="deck-meta">
                {deckIndex + 1} / {triage.length} · → save · ← skip
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
          {Object.keys(saved).length === 0 ? (
            <div className="empty">
              <div className="big">Nothing saved yet</div>
              Papers you save appear here on every device.
            </div>
          ) : (
            Object.values(saved)
              .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""))
              .map((p) => (
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
                  <button
                    onClick={() =>
                      analyses[p.id]
                        ? setExpanded((x) => ({ ...x, [p.id]: !x[p.id] }))
                        : analyze(p)
                    }
                    title="Why this matters"
                    aria-label="Analyze"
                  >
                    <Sparkles size={16} color={analyzingId === p.id ? "#4dd8c7" : "#8a97a6"} />
                  </button>
                  {p.url && (
                    <a href={p.url} target="_blank" rel="noreferrer" aria-label="Open paper">
                      <ExternalLink size={16} color="#8a97a6" />
                    </a>
                  )}
                  <button onClick={() => unsave(p.id)} title="Remove" aria-label="Remove">
                    <Trash2 size={16} color="#8a97a6" />
                  </button>
                </div>
              ))
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
          <p className="hint">
            New topics fetch papers immediately from OpenAlex and join the daily harvest from
            tomorrow.
          </p>
          <div className="section-h">Tracked topics</div>
          {topics.map((t) => (
            <div className="row" key={t.id}>
              <Hash size={14} color="#4dd8c7" />
              <div className="grow">
                <div className="title">{t.name}</div>
                {affinity.topics?.[t.name.toLowerCase()] !== undefined && (
                  <div className="sub">
                    learned weight {affinity.topics[t.name.toLowerCase()].toFixed(2)}
                  </div>
                )}
              </div>
              <button onClick={() => removeTopic(t.id)} aria-label={`Remove ${t.name}`}>
                <Trash2 size={15} color="#8a97a6" />
              </button>
            </div>
          ))}
        </main>
      )}

      {tab === "settings" && (
        <main>
          <div className="field">
            <label>Harvest feed URL</label>
            <input
              className="input"
              value={settings.harvestUrl}
              onChange={(e) => {
                const ns = { ...settings, harvestUrl: e.target.value, updatedAt: nowISO() };
                setSettings(ns);
                persist("ss2_settings", ns);
              }}
            />
            <p className="hint">Daily harvest output (papers/latest.json on GitHub).</p>
          </div>
          <div className="field">
            <label>Sync</label>
            <p className="hint">
              All devices share one database row — no login. Status:{" "}
              <span style={{ color: "#4dd8c7" }}>{syncStatus}</span>. Saves, skips, topics,
              analyses and settings sync automatically; offline changes push when you reconnect.
            </p>
          </div>
          <div className="field">
            <label>Maintenance</label>
            <button
              className="btn ghost"
              style={{ border: "1px solid var(--line)", marginRight: 8 }}
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
        <button className={tab === "topics" ? "on" : ""} onClick={() => setTab("topics")}>
          <Hash size={18} />
          TOPICS
        </button>
        <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>
          <SettingsIcon size={18} />
          SETUP
        </button>
      </nav>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
