// ─────────────────────────────────────────────────────────────
// SpinStack PDF reader — pdf.js viewer with text selection,
// highlight/note annotations (text-quote anchored), and a selection
// pill menu (EXPLAIN · QUESTIONS · NOTE · HIGHLIGHT).
//
// Lazy-loaded (React.lazy) so pdf.js stays out of the main bundle.
// Virtualized: only the current page ±2 get a canvas + text layer.
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";
import { X, ZoomIn, ZoomOut, PenLine, Eraser, Presentation, Trash2 } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const nowISO = () => new Date().toISOString();
const newId = () =>
  (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ink palette — dark strokes that read on white pages AND the whiteboard
const INK_COLORS = ["#d8423f", "#0c8d80", "#16202b"];
const BOARD_W = 1000; // whiteboard virtual coordinate space
const BOARD_H = 1400;

// ── freehand ink canvas (shared by PDF pages and the whiteboard) ──
// Strokes are stored in scale-1 coordinates: {id, page, color, w, pts, at}.
function InkLayer({ strokes, scale, tool, color, onCommit, onErase, width, height }) {
  const canvasRef = useRef(null);
  const drawing = useRef(null);

  function drawStroke(ctx, pts, strokeColor, w) {
    if (!pts || pts.length === 0) return;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * scale, pts[0][1] * scale);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * scale, pts[i][1] * scale);
    if (pts.length === 1) ctx.lineTo(pts[0][0] * scale + 0.1, pts[0][1] * scale);
    ctx.stroke();
  }

  function redraw(extra) {
    const c = canvasRef.current;
    if (!c || !width || !height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.floor(width * dpr);
    if (c.width !== W) {
      c.width = W;
      c.height = Math.floor(height * dpr);
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes) drawStroke(ctx, s.pts, s.color, (s.w || 2) * scale);
    if (extra) drawStroke(ctx, extra.pts, extra.color, extra.w * scale);
  }

  useEffect(redraw, [strokes, scale, width, height]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
  };

  function eraseAt(p) {
    const tol = 9 / scale;
    const hit = strokes.find((s) =>
      (s.pts || []).some(([x, y]) => Math.hypot(x - p[0], y - p[1]) < tol)
    );
    if (hit) onErase(hit.id);
  }

  function down(e) {
    if (!tool) return;
    e.preventDefault();
    canvasRef.current.setPointerCapture(e.pointerId);
    if (tool === "eraser") {
      drawing.current = { erasing: true };
      eraseAt(pos(e));
      return;
    }
    drawing.current = { pts: [pos(e)], color, w: 2 };
  }
  function move(e) {
    const d = drawing.current;
    if (!d) return;
    if (d.erasing) return eraseAt(pos(e));
    const p = pos(e);
    const last = d.pts[d.pts.length - 1];
    if (Math.hypot((p[0] - last[0]) * scale, (p[1] - last[1]) * scale) > 2) {
      d.pts.push(p);
      redraw(d);
    }
  }
  function up() {
    const d = drawing.current;
    drawing.current = null;
    if (d && !d.erasing && d.pts.length > 0) {
      onCommit({
        pts: d.pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
        color: d.color,
        w: d.w,
      });
    }
  }

  return (
    <canvas
      ref={canvasRef}
      className={`ink-layer${tool ? " active" : ""}`}
      style={{ width, height }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    />
  );
}

// Walk a text layer's text nodes → concatenated string + node offsets.
function walkText(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let full = "";
  while (walker.nextNode()) {
    const n = walker.currentNode;
    nodes.push({ n, start: full.length });
    full += n.nodeValue;
  }
  return { nodes, full };
}

function nodeAt(nodes, pos) {
  let last = nodes[0];
  for (const e of nodes) {
    if (e.start <= pos) last = e;
    else break;
  }
  return last;
}

// Re-anchor a text-quote annotation inside a rendered text layer.
function findQuoteRange(container, quote, prefix, suffix) {
  if (!quote) return null;
  const { nodes, full } = walkText(container);
  if (!nodes.length) return null;
  let idx = -1;
  if (prefix || suffix) {
    const i = full.indexOf(prefix + quote + suffix);
    if (i >= 0) idx = i + prefix.length;
  }
  if (idx < 0) idx = full.indexOf(quote);
  if (idx < 0) return null;
  const end = idx + quote.length;
  const s = nodeAt(nodes, idx);
  const e = nodeAt(nodes, Math.max(idx, end - 1));
  try {
    const range = document.createRange();
    range.setStart(s.n, idx - s.start);
    range.setEnd(e.n, Math.min(end - e.start, e.n.nodeValue.length));
    return range;
  } catch {
    return null;
  }
}

// Selection → {quote, prefix, suffix} with 32 chars of context each side,
// computed from the SAME walked text used for re-anchoring.
function quoteContext(textLayerEl, range) {
  const { nodes, full } = walkText(textLayerEl);
  if (!nodes.length) return null;
  const abs = (node, offset) => {
    const e = nodes.find((x) => x.n === node);
    return e ? e.start + offset : null;
  };
  let s = abs(range.startContainer, range.startOffset);
  let e = abs(range.endContainer, range.endOffset);
  if (s === null && e === null) return null;
  if (s === null) s = 0; // selection started before this page's layer
  if (e === null) e = full.length; // selection ran past this page's layer
  if (e <= s) return null;
  const quote = full.slice(s, e);
  if (!quote.trim()) return null;
  return {
    quote,
    prefix: full.slice(Math.max(0, s - 32), s),
    suffix: full.slice(e, e + 32),
  };
}

function PageView({ pdf, num, scale, active, pageW, pageH, annots, onHighlightTap, ink, tool, color, onInkCommit, onInkErase }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const hlRef = useRef(null);
  const rectsRef = useRef([]);
  const [textReady, setTextReady] = useState(0);

  useEffect(() => {
    if (!active || !pdf) return;
    let cancelled = false;
    let renderTask;
    (async () => {
      try {
        const page = await pdf.getPage(num);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        renderTask = page.render({
          canvasContext: canvas.getContext("2d"),
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        });
        await renderTask.promise;
        if (cancelled) return;
        const tl = textRef.current;
        if (!tl) return;
        tl.innerHTML = "";
        tl.style.setProperty("--scale-factor", viewport.scale);
        const task = new pdfjsLib.TextLayer({
          textContentSource: page.streamTextContent(),
          container: tl,
          viewport,
        });
        await task.render();
        if (!cancelled) setTextReady((x) => x + 1);
      } catch (e) {
        /* render cancelled mid-scroll or page failed — placeholder stays */
        if (!String(e?.name).includes("RenderingCancelled")) {
          console.error("pageview:", e?.message || e);
        }
      }
    })();
    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {}
    };
  }, [pdf, num, scale, active]);

  // (re)paint highlights once the text layer exists or annotations change
  useEffect(() => {
    const tl = textRef.current;
    const hl = hlRef.current;
    const wrap = wrapRef.current;
    if (!active || !tl || !hl || !wrap || !tl.childNodes.length) return;
    hl.innerHTML = "";
    rectsRef.current = [];
    const wrapRect = wrap.getBoundingClientRect();
    for (const a of annots) {
      if (a.page !== num || a.deleted) continue;
      const range = findQuoteRange(tl, a.quote, a.prefix || "", a.suffix || "");
      if (!range) continue;
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const d = document.createElement("div");
        d.className = "hl";
        const x = r.left - wrapRect.left;
        const y = r.top - wrapRect.top;
        Object.assign(d.style, {
          left: `${x}px`,
          top: `${y}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
        hl.appendChild(d);
        rectsRef.current.push({ id: a.id, x, y, w: r.width, h: r.height });
      }
    }
  }, [annots, active, textReady, num]);

  // tap a highlight (text layer sits above the paint layer, so hit-test)
  function onClick(e) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // selecting, not tapping
    const wrapRect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - wrapRect.left;
    const y = e.clientY - wrapRect.top;
    const hit = rectsRef.current.find(
      (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
    );
    if (hit) onHighlightTap(hit.id);
  }

  return (
    <div
      ref={wrapRef}
      className="pdf-page"
      style={{ width: pageW, height: pageH }}
      onClick={onClick}
    >
      {active && (
        <>
          <canvas ref={canvasRef} />
          <div ref={hlRef} className="hl-layer" />
          <div ref={textRef} className="pdf-textlayer" data-page={num} />
          <InkLayer
            strokes={ink}
            scale={scale}
            tool={tool}
            color={color}
            width={pageW}
            height={pageH}
            onCommit={(s) => onInkCommit(num, s)}
            onErase={onInkErase}
          />
        </>
      )}
    </div>
  );
}

export default function Reader({ paper, url, annots, onSave, ink, onSaveInk, onClose, onAction, showToast }) {
  const [pdf, setPdf] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [base, setBase] = useState(null); // page size at scale 1
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);
  const [menu, setMenu] = useState(null); // {x, y, page, quote, prefix, suffix}
  const [sheet, setSheet] = useState(null); // {annotId, draft}
  const [tool, setTool] = useState(null); // null | "pen" | "eraser"
  const [colorIdx, setColorIdx] = useState(0);
  const [board, setBoard] = useState(false); // whiteboard overlay
  const scrollRef = useRef(null);
  const live = (annots || []).filter((a) => !a.deleted);
  const liveInk = (ink || []).filter((s) => !s.deleted);
  const boardInk = liveInk.filter((s) => s.page === "board");

  function commitStroke(page, s) {
    onSaveInk([
      ...(ink || []),
      { id: newId(), paperId: paper.id, page, ...s, at: nowISO() },
    ]);
  }
  function eraseStroke(id) {
    // tombstone — the sync merge is a union, deletions must win
    onSaveInk((ink || []).map((s) => (s.id === id ? { ...s, deleted: true, at: nowISO() } : s)));
  }
  function clearBoard() {
    if (!boardInk.length) return;
    onSaveInk(
      (ink || []).map((s) => (s.page === "board" && !s.deleted ? { ...s, deleted: true, at: nowISO() } : s))
    );
    showToast("Whiteboard cleared");
  }

  // load document
  useEffect(() => {
    let dead = false;
    const task = pdfjsLib.getDocument({ url });
    task.promise
      .then(async (doc) => {
        if (dead) return;
        const p1 = await doc.getPage(1);
        const vp = p1.getViewport({ scale: 1 });
        if (dead) return;
        setBase({ w: vp.width, h: vp.height });
        setNumPages(doc.numPages);
        setPdf(doc);
      })
      .catch(() => {
        if (!dead) {
          showToast(navigator.onLine ? "Couldn’t load PDF" : "PDF needs connection");
          onClose();
        }
      });
    return () => {
      dead = true;
      task.destroy().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // fit-width base scale
  const fitScale = base
    ? Math.max(0.3, ((scrollRef.current?.clientWidth || window.innerWidth) - 18) / base.w)
    : 1;
  const scale = fitScale * zoom;
  const pageW = base ? Math.floor(base.w * scale) : 0;
  const pageH = base ? Math.floor(base.h * scale) : 0;
  const GAP = 10;

  function onScroll() {
    if (!pageH) return;
    const top = scrollRef.current.scrollTop;
    setCurrent(Math.min(numPages, Math.max(1, Math.floor(top / (pageH + GAP)) + 1)));
    setMenu(null);
  }

  // selection → pill menu
  useEffect(() => {
    let t;
    const onSel = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return setMenu(null);
        const range = sel.getRangeAt(0);
        const startEl =
          range.startContainer.nodeType === 1
            ? range.startContainer
            : range.startContainer.parentElement;
        const tl = startEl?.closest?.(".pdf-textlayer");
        if (!tl) return setMenu(null);
        const ctx = quoteContext(tl, range);
        if (!ctx) return setMenu(null);
        const rect = range.getBoundingClientRect();
        setMenu({
          x: Math.min(window.innerWidth - 150, Math.max(150, rect.left + rect.width / 2)),
          y: Math.max(8, rect.top - 48),
          page: parseInt(tl.dataset.page, 10),
          ...ctx,
        });
      }, 250);
    };
    document.addEventListener("selectionchange", onSel);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      clearTimeout(t);
    };
  }, []);

  function clearSelection() {
    window.getSelection()?.removeAllRanges();
    setMenu(null);
  }

  function addAnnotation(withNote) {
    if (!menu) return;
    const a = {
      id: newId(),
      paperId: paper.id,
      page: menu.page,
      quote: menu.quote,
      prefix: menu.prefix,
      suffix: menu.suffix,
      color: "yellow",
      at: nowISO(),
    };
    onSave([...(annots || []), a]);
    clearSelection();
    if (withNote) setSheet({ annotId: a.id, draft: "" });
    else showToast("Highlighted");
  }

  function aiAction(mode) {
    if (!menu) return;
    const selection = menu.quote;
    clearSelection();
    onAction(mode, { selection });
  }

  const sheetAnnot = sheet ? live.find((a) => a.id === sheet.annotId) : null;

  function saveNote() {
    if (!sheetAnnot) return setSheet(null);
    onSave(
      annots.map((a) =>
        a.id === sheetAnnot.id ? { ...a, note: sheet.draft.trim(), at: nowISO() } : a
      )
    );
    setSheet(null);
    showToast("Note saved");
  }

  function removeAnnot() {
    if (!sheetAnnot) return setSheet(null);
    // tombstone, not splice — sync merge is a union, deletions must win
    onSave(
      annots.map((a) =>
        a.id === sheetAnnot.id ? { ...a, deleted: true, at: nowISO() } : a
      )
    );
    setSheet(null);
    showToast("Highlight removed");
  }

  return (
    <div className="reader">
      <header className="reader-hdr">
        <button onClick={onClose} aria-label="Close reader">
          <X size={18} color="var(--dim)" />
        </button>
        <span className="reader-title">{paper.title}</span>
        <span className="spacer" />
        <span className="reader-pages-lbl">
          {numPages ? `${current} / ${numPages}` : "…"}
        </span>
        <button
          onClick={() => setTool(tool === "pen" ? null : "pen")}
          aria-label="Pen"
          title="Draw on the page"
          className={tool === "pen" ? "tool-on" : ""}
        >
          <PenLine size={17} color={tool === "pen" ? INK_COLORS[colorIdx] : "var(--dim)"} />
        </button>
        {tool === "pen" && (
          <button
            onClick={() => setColorIdx((i) => (i + 1) % INK_COLORS.length)}
            aria-label="Pen color"
            title="Pen color"
          >
            <span className="ink-dot" style={{ background: INK_COLORS[colorIdx] }} />
          </button>
        )}
        <button
          onClick={() => setTool(tool === "eraser" ? null : "eraser")}
          aria-label="Eraser"
          title="Erase strokes"
          className={tool === "eraser" ? "tool-on" : ""}
        >
          <Eraser size={17} color={tool === "eraser" ? "var(--red)" : "var(--dim)"} />
        </button>
        <button onClick={() => setBoard(true)} aria-label="Whiteboard" title="Whiteboard">
          <Presentation size={17} color={boardInk.length ? "var(--teal)" : "var(--dim)"} />
        </button>
        <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))} aria-label="Zoom out">
          <ZoomOut size={17} color="var(--dim)" />
        </button>
        <button onClick={() => setZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))} aria-label="Zoom in">
          <ZoomIn size={17} color="var(--dim)" />
        </button>
      </header>

      <div className="reader-pages" ref={scrollRef} onScroll={onScroll}>
        {!pdf && <div className="empty">Loading PDF…</div>}
        {pdf &&
          base &&
          Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
            <PageView
              key={n}
              pdf={pdf}
              num={n}
              scale={scale}
              active={Math.abs(n - current) <= 2}
              pageW={pageW}
              pageH={pageH}
              annots={live}
              onHighlightTap={(id) => {
                const a = live.find((x) => x.id === id);
                if (a) setSheet({ annotId: id, draft: a.note || "" });
              }}
              ink={liveInk.filter((s) => s.page === n)}
              tool={tool}
              color={INK_COLORS[colorIdx]}
              onInkCommit={commitStroke}
              onInkErase={eraseStroke}
            />
          ))}
      </div>

      {board && (
        <BoardOverlay
          paper={paper}
          strokes={boardInk}
          onCommit={(s) => commitStroke("board", s)}
          onErase={eraseStroke}
          onClear={clearBoard}
          onClose={() => setBoard(false)}
        />
      )}

      {menu && (
        <div className="selmenu" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => aiAction("explain")}>EXPLAIN</button>
          <button onClick={() => aiAction("questions")}>QUESTIONS</button>
          <button onClick={() => addAnnotation(true)}>NOTE</button>
          <button onClick={() => addAnnotation(false)}>HIGHLIGHT</button>
        </div>
      )}

      {sheet && sheetAnnot && (
        <div className="share-overlay reader-sheet" onClick={() => setSheet(null)}>
          <div className="share-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="section-h" style={{ margin: "0 0 4px" }}>
              Highlight · p.{sheetAnnot.page}
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              “{sheetAnnot.quote.slice(0, 180)}
              {sheetAnnot.quote.length > 180 ? "…" : ""}”
            </p>
            <textarea
              className="input"
              rows={3}
              placeholder="Add a note…"
              value={sheet.draft}
              onChange={(e) => setSheet({ ...sheet, draft: e.target.value })}
            />
            <button className="btn ghost" onClick={saveNote}>
              Save note
            </button>
            <button className="btn skip" onClick={removeAnnot}>
              Remove highlight
            </button>
            <button className="btn skip" onClick={() => setSheet(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── per-paper whiteboard: a synced scratch canvas (page: "board") ──
function BoardOverlay({ paper, strokes, onCommit, onErase, onClear, onClose }) {
  const [tool, setTool] = useState("pen");
  const [colorIdx, setColorIdx] = useState(0);
  const wrapRef = useRef(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const fit = () =>
      setScale(Math.max(0.2, ((wrapRef.current?.clientWidth || window.innerWidth) - 16) / BOARD_W));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <div className="board-overlay">
      <header className="reader-hdr">
        <button onClick={onClose} aria-label="Close whiteboard">
          <X size={18} color="var(--dim)" />
        </button>
        <span className="reader-title">Whiteboard · {paper.title}</span>
        <span className="spacer" />
        <button
          onClick={() => setTool("pen")}
          aria-label="Pen"
          className={tool === "pen" ? "tool-on" : ""}
        >
          <PenLine size={17} color={tool === "pen" ? INK_COLORS[colorIdx] : "var(--dim)"} />
        </button>
        <button onClick={() => setColorIdx((i) => (i + 1) % INK_COLORS.length)} aria-label="Pen color">
          <span className="ink-dot" style={{ background: INK_COLORS[colorIdx] }} />
        </button>
        <button
          onClick={() => setTool("eraser")}
          aria-label="Eraser"
          className={tool === "eraser" ? "tool-on" : ""}
        >
          <Eraser size={17} color={tool === "eraser" ? "var(--red)" : "var(--dim)"} />
        </button>
        <button onClick={onClear} aria-label="Clear whiteboard" title="Clear whiteboard">
          <Trash2 size={17} color="var(--dim)" />
        </button>
      </header>
      <div className="board-scroll" ref={wrapRef}>
        {scale > 0 && (
          <div className="board-canvas" style={{ width: BOARD_W * scale, height: BOARD_H * scale }}>
            <InkLayer
              strokes={strokes}
              scale={scale}
              tool={tool}
              color={INK_COLORS[colorIdx]}
              width={BOARD_W * scale}
              height={BOARD_H * scale}
              onCommit={onCommit}
              onErase={onErase}
            />
          </div>
        )}
      </div>
    </div>
  );
}
