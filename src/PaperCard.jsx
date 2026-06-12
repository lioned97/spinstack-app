// ─────────────────────────────────────────────────────────────
// PaperCard — module-level (React function identity matters: when
// this was defined inside App(), every App state change produced a
// new component type, unmounting/remounting every card and re-firing
// the figure-loading effect on each swipe).
// ─────────────────────────────────────────────────────────────
import React, { useEffect } from "react";
import {
  X,
  Heart,
  Sparkles,
  BookOpen,
  Landmark,
  Paperclip,
  MessageCircle,
  Share2,
  ExternalLink,
  Network,
} from "lucide-react";

import { isPaywalled } from "./publisherUtils.js";

const catOf = (x) => (x && x.category) || "science";

// Layout switch per category: dip = ODMR relevance dip, thumb =
// closed-state thumbnail, carousel = open-state image carousel.
const CATEGORY_LAYOUTS = {
  science: { dip: true, thumb: false, carousel: false },
  travel: { dip: false, thumb: true, carousel: true },
};

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
        <path d={d} stroke="var(--red)" strokeWidth="1.6" fill="none" vectorEffect="non-scaling-stroke" />
        <line x1="0" y1={yBase} x2="100" y2={yBase} stroke="var(--line)" strokeWidth="0.5" />
      </svg>
      <div className="lbl">
        RELEVANCE <b>{score.toFixed(2)}</b>
      </div>
    </div>
  );
}

export default function PaperCard({
  p,
  deck = false,
  eager = false,
  style,
  drag = { x: 0, active: false },
  lastSeen,
  analyses,
  expanded,
  analyzingId,
  settings,
  canRead,
  onVerdict,
  onAnalyze,
  onToggleExpanded,
  onOpenReader,
  onPickPdf,
  onOpenProxy,
  onChat,
  onShare,
  onSetLightbox,
  onLoadFigures,
  onGraph,
}) {
  const isNew = (p.harvestedAt || "") > (lastSeen || "");
  const an = analyses[p.id];
  const open = !!expanded[p.id];
  const cat = catOf(p);
  const layout = CATEGORY_LAYOUTS[cat] || CATEGORY_LAYOUTS.science;
  const imgs = (p.images || []).filter(Boolean);
  const score = p._score ?? 1;

  // figure extraction (once per device): eagerly for the top of the feed
  // and the deck card so closed cards show figures too, lazily on "More"
  // for the rest (onLoadFigures no-ops without an arXiv id)
  useEffect(() => {
    if ((open || eager) && cat === "science" && !p.figures && !p.figuresTried) {
      onLoadFigures(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, eager]);

  return (
    <article className={`card${deck && drag.active ? " dragging" : ""}`} style={style}>
      <div className="eyebrow">
        <span className="src">
          {cat === "science"
            ? p.source || p.venue || "paper"
            : `${cat} · ${p.source || p.venue || ""}`}
        </span>
        <span>{p.year}</span>
        {cat === "science" && p.venue && String(p.venue).toLowerCase() !== String(p.source || "").toLowerCase() && (
          <span>· {String(p.venue).slice(0, 36)}</span>
        )}
        {isNew && <span style={{ color: "var(--red)" }}>· NEW</span>}
      </div>
      {layout.thumb && imgs.length > 0 && !open ? (
        <div className="thumbrow">
          <img className="thumb" src={imgs[0]} loading="lazy" alt="" />
          <h2>{p.title}</h2>
        </div>
      ) : (
        <h2>{p.title}</h2>
      )}
      {(p.authors || []).length > 0 && (
        <div className="authors">
          {(p.authors || []).slice(0, 4).join(", ")}
          {(p.authors || []).length > 4 ? " et al." : ""}
        </div>
      )}
      {open && layout.carousel && imgs.length > 0 && (
        <div className="carousel">
          {imgs.slice(0, 5).map((src) => (
            <img key={src} src={src} loading="lazy" alt="" />
          ))}
        </div>
      )}
      {cat === "science" && (p.figures || []).length > 0 && (
        <div className="figrow">
          {p.figures
            .slice(0, open ? 3 : 2)
            // tolerate both formats: old cache = dataURL string, new = {dataUrl, caption}
            .map((f) => (typeof f === "string" ? { dataUrl: f, caption: "" } : f))
            .map((f, i) => (
              <img
                key={i}
                src={f.dataUrl}
                loading="lazy"
                alt={f.caption || `Figure ${i + 1}`}
                onClick={() => onSetLightbox(f)}
              />
            ))}
        </div>
      )}
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
      {layout.dip ? (
        <OdmrDip score={score} />
      ) : (
        <div className="match-lbl">
          MATCH <b>{score.toFixed(2)}</b>
        </div>
      )}
      {an && open && (
        <div className="analysis">
          <span className="tag">Why this matters · Claude</span>
          {an.text}
        </div>
      )}
      <div className="actions">
        {!deck && (
          <>
            <button className="btn skip" onClick={() => onVerdict(p, false)}>
              <X size={15} style={{ verticalAlign: "-3px" }} /> Skip
            </button>
            <button className="btn save" onClick={() => onVerdict(p, true)}>
              <Heart size={15} style={{ verticalAlign: "-3px" }} /> Save
            </button>
          </>
        )}
        <button
          className="btn ghost"
          disabled={analyzingId === p.id}
          onClick={() => (open && an ? onToggleExpanded(p.id, false) : onAnalyze(p))}
          title="Why this matters for my research"
        >
          <Sparkles size={15} style={{ verticalAlign: "-3px" }} />{" "}
          {analyzingId === p.id ? "…" : an && open ? "Hide" : "Why?"}
        </button>
        {!open && (p.abstract || "").length > 220 && !an && (
          <button className="btn ghost" onClick={() => onToggleExpanded(p.id, true)}>
            More
          </button>
        )}
        {canRead(p) ? (
          <button className="btn ghost" onClick={() => onOpenReader(p)} title="Read PDF" aria-label="Read PDF">
            <BookOpen size={15} style={{ verticalAlign: "-3px" }} />
          </button>
        ) : settings.libraryProxy && p.url && isPaywalled(p) ? (
          // paywalled publisher + proxy configured → primary CTA, not a ghost icon
          <button className="btn proxy-btn" onClick={() => onOpenProxy(p)}>
            <Landmark size={15} style={{ verticalAlign: "-3px" }} />{" "}
            {settings.proxyLabel ? `Open via ${settings.proxyLabel}` : "Open via library"}
          </button>
        ) : (
          <>
            {settings.libraryProxy && p.url && (
              <button
                className="btn ghost"
                onClick={() => onOpenProxy(p)}
                title="Open via library"
                aria-label="Open via library"
              >
                <Landmark size={15} style={{ verticalAlign: "-3px" }} />
              </button>
            )}
            <button
              className="btn ghost"
              onClick={() => onPickPdf(p)}
              title="Attach a PDF file for the reader"
              aria-label="Attach PDF"
            >
              <Paperclip size={15} style={{ verticalAlign: "-3px" }} />
            </button>
          </>
        )}
        {cat === "science" && onGraph && (
          <button className="btn ghost" onClick={() => onGraph(p)} title="Connections graph" aria-label="Connections graph">
            <Network size={15} style={{ verticalAlign: "-3px" }} />
          </button>
        )}
        <button className="btn ghost" onClick={() => onChat(p)} title="Chat about this paper" aria-label="Chat about this paper">
          <MessageCircle size={15} style={{ verticalAlign: "-3px" }} />
        </button>
        <button className="btn ghost" onClick={() => onShare(p)} title="Share" aria-label="Share">
          <Share2 size={15} style={{ verticalAlign: "-3px" }} />
        </button>
        {p.url && (
          <a className="btn ghost" href={p.url} target="_blank" rel="noreferrer" title="Open paper">
            <ExternalLink size={15} style={{ verticalAlign: "-3px" }} />
          </a>
        )}
      </div>
    </article>
  );
}
