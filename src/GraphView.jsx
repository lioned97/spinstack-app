// ─────────────────────────────────────────────────────────────
// Knowledge graph — force-directed view of how papers connect via
// citations (Semantic Scholar), shared topics, and the topics
// themselves as cluster nodes. Pure JS spring simulation, no deps.
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";
import { Heart, X as XIcon, ExternalLink, Crosshair } from "lucide-react";

const catOf = (x) => (x && x.category) || "science";

// Spring simulation — run ~200 steps at init, light steps afterwards
function simulate(nodes, links, steps = 1) {
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x || 0.1;
        const dy = nodes[j].y - nodes[i].y || 0.1;
        const d2 = dx * dx + dy * dy + 1;
        const f = 4000 / d2;
        const d = Math.sqrt(d2);
        nodes[i].vx -= (dx / d) * f;
        nodes[i].vy -= (dy / d) * f;
        nodes[j].vx += (dx / d) * f;
        nodes[j].vy += (dy / d) * f;
      }
    for (const { s: si, t: ti } of links) {
      const dx = nodes[ti].x - nodes[si].x;
      const dy = nodes[ti].y - nodes[si].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 120) * 0.04;
      nodes[si].vx += (dx / d) * f;
      nodes[si].vy += (dy / d) * f;
      nodes[ti].vx -= (dx / d) * f;
      nodes[ti].vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      n.vx -= n.x * 0.012;
      n.vy -= n.y * 0.012;
      n.x += n.vx * 0.6;
      n.y += n.vy * 0.6;
      n.vx *= 0.7;
      n.vy *= 0.7;
    }
  }
}

const topicsIn = (paper, topics) => {
  const text = `${paper.title} ${paper.abstract || ""}`.toLowerCase();
  return topics.filter((t) => text.includes(t.name.toLowerCase())).map((t) => t.name);
};

function buildGraph(focus, pool, topics, relatedItems) {
  const nodes = [];
  const links = [];
  const idx = new Map(); // node id -> index
  const add = (node) => {
    idx.set(node.id, nodes.length);
    nodes.push({ vx: 0, vy: 0, x: (Math.random() - 0.5) * 300, y: (Math.random() - 0.5) * 300, ...node });
  };

  const focusTopics = topicsIn(focus, topics);
  add({ id: focus.id, kind: "focus", label: focus.title, paper: focus, x: 0, y: 0 });

  for (const r of relatedItems.slice(0, 12)) {
    if (idx.has(r.id)) continue;
    add({ id: r.id, kind: "paper", label: r.title, paper: r });
    links.push({ s: idx.get(focus.id), t: idx.get(r.id), kind: "cite" });
  }

  // pool papers sharing >= 2 topic keywords with the focus paper
  if (focusTopics.length >= 1) {
    const fset = new Set(focusTopics);
    const locals = pool
      .filter((p) => p.id !== focus.id && catOf(p) === catOf(focus) && !idx.has(p.id))
      .map((p) => ({ p, shared: topicsIn(p, topics).filter((t) => fset.has(t)) }))
      .filter((x) => x.shared.length >= 2)
      .slice(0, 10);
    for (const { p } of locals) add({ id: p.id, kind: "paper", label: p.title, paper: p });
  }

  // topic cluster nodes — connect every graph paper that mentions them
  for (const t of topics.slice(0, 16)) {
    const members = nodes.filter(
      (n) => n.kind !== "topic" && topicsIn(n.paper, [t]).length > 0
    );
    if (members.length < 1 || (members.length === 1 && members[0].kind !== "focus")) continue;
    const tid = `topic:${t.name}`;
    if (!idx.has(tid)) add({ id: tid, kind: "topic", label: t.name });
    for (const m of members) links.push({ s: idx.get(m.id), t: idx.get(tid), kind: "topic" });
  }

  simulate(nodes, links, 200);
  return { nodes, links };
}

export default function GraphView({ pool, topics, focusId, fetchRelated, onVerdict, showToast }) {
  const [graph, setGraph] = useState(null);
  const [strip, setStrip] = useState(null); // selected node's paper
  const [focus, setFocus] = useState(null);
  const [loading, setLoading] = useState(true);
  const svgRef = useRef(null);
  const pan = useRef({ x: 0, y: 0, dragging: false, sx: 0, sy: 0 });
  const [, force] = useState(0);
  const lastTap = useRef({ id: null, at: 0 });

  // pick the focus paper: explicit id, else best science paper in pool
  useEffect(() => {
    const f =
      (focusId && pool.find((p) => p.id === focusId)) ||
      pool.filter((p) => catOf(p) === "science")[0] ||
      pool[0];
    setFocus(f || null);
  }, [focusId, pool]);

  useEffect(() => {
    if (!focus) return;
    let dead = false;
    setLoading(true);
    setStrip(null);
    (async () => {
      let rel = [];
      try {
        rel = (await fetchRelated(focus)) || [];
      } catch {}
      if (dead) return;
      setGraph(buildGraph(focus, pool, topics, rel));
      setLoading(false);
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  function nodeTap(n) {
    const now = Date.now();
    if (lastTap.current.id === n.id && now - lastTap.current.at < 350) {
      // double-tap: re-centre on this node
      lastTap.current = { id: null, at: 0 };
      if (n.kind !== "topic" && n.paper && n.paper.id !== focus?.id) {
        setFocus(n.paper);
        showToast(`Re-centred on “${n.paper.title.slice(0, 40)}…”`);
      }
      return;
    }
    lastTap.current = { id: n.id, at: now };
    if (n.kind !== "topic") setStrip(n.paper);
  }

  function down(e) {
    pan.current.dragging = true;
    pan.current.sx = e.clientX - pan.current.x;
    pan.current.sy = e.clientY - pan.current.y;
  }
  function move(e) {
    if (!pan.current.dragging) return;
    pan.current.x = e.clientX - pan.current.sx;
    pan.current.y = e.clientY - pan.current.sy;
    force((v) => v + 1);
  }
  function up() {
    pan.current.dragging = false;
  }

  if (!focus)
    return (
      <div className="empty">
        <div className="big">Nothing to graph yet</div>
        Load some papers first — the graph builds from your pool.
      </div>
    );

  let view = "0 0 100 100";
  if (graph) {
    const xs = graph.nodes.map((n) => n.x);
    const ys = graph.nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 80;
    const minY = Math.min(...ys) - 80;
    view = `${minX - pan.current.x} ${minY - pan.current.y} ${Math.max(...xs) - minX + 160} ${
      Math.max(...ys) - minY + 160
    }`;
  }

  return (
    <div className="graph-view">
      {loading && <div className="deck-meta">building graph…</div>}
      {graph && (
        <svg
          ref={svgRef}
          viewBox={view}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          {graph.links.map((l, i) => (
            <line
              key={i}
              x1={graph.nodes[l.s].x}
              y1={graph.nodes[l.s].y}
              x2={graph.nodes[l.t].x}
              y2={graph.nodes[l.t].y}
              stroke={l.kind === "cite" ? "var(--teal)" : "var(--dim)"}
              strokeOpacity="0.35"
              strokeWidth={l.kind === "cite" ? 1.6 : 1}
            />
          ))}
          {graph.nodes.map((n) => (
            <g
              key={n.id}
              className={`graph-node ${n.kind === "focus" ? "focus" : ""}`}
              transform={`translate(${n.x},${n.y})`}
              onClick={(e) => {
                e.stopPropagation();
                nodeTap(n);
              }}
              style={{ cursor: "pointer" }}
            >
              <circle
                r={n.kind === "focus" ? 14 : n.kind === "topic" ? 6 : 9}
                fill={n.kind === "topic" ? "var(--line)" : "var(--panel-2)"}
                stroke={n.kind === "focus" ? "var(--red)" : "var(--teal)"}
              />
              <text textAnchor="middle" y={n.kind === "focus" ? 30 : 22}>
                {n.label.slice(0, 28)}
                {n.label.length > 28 ? "…" : ""}
              </text>
            </g>
          ))}
        </svg>
      )}
      {strip && (
        <div className="graph-strip">
          <div className="title">{strip.title}</div>
          <div className="sub" style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--dim)" }}>
            {strip.year} · {String(strip.venue || strip.source || "").slice(0, 36)}
          </div>
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="btn ghost" onClick={() => { onVerdict(strip, true); setStrip(null); }}>
              <Heart size={14} style={{ verticalAlign: "-2px" }} /> Save
            </button>
            <button className="btn ghost" onClick={() => { onVerdict(strip, false); setStrip(null); }}>
              <XIcon size={14} style={{ verticalAlign: "-2px" }} /> Skip
            </button>
            <button className="btn ghost" onClick={() => setFocus(strip)} title="Re-centre graph here">
              <Crosshair size={14} style={{ verticalAlign: "-2px" }} /> Focus
            </button>
            {strip.url && (
              <a className="btn ghost" href={strip.url} target="_blank" rel="noreferrer">
                <ExternalLink size={14} style={{ verticalAlign: "-2px" }} />
              </a>
            )}
            <button className="btn ghost" onClick={() => setStrip(null)} aria-label="Close">
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
