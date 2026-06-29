import { LineageGraph } from "./lineage";

const NS = "http://www.w3.org/2000/svg";
const NODE_W = 150;
const NODE_H = 44;
const COL_GAP = 70;
const ROW_GAP = 18;
const PAD = 12;

const STATE_COLOR: Record<string, string> = {
  verified: "var(--color-green)",
  "verified-body-modified": "var(--color-yellow)",
  failed: "var(--color-red)",
  unreadable: "var(--text-muted)",
  external: "var(--text-faint)",
};
const STATE_LABEL: Record<string, string> = {
  verified: "Verified",
  "verified-body-modified": "Body modified",
  failed: "Failed",
  unreadable: "Unreadable",
  external: "External",
};

function svgEl(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Render an accessible layered lineage graph plus a text fallback list. */
export function renderLineage(
  container: HTMLElement,
  graph: LineageGraph,
  onSelect: (hash: string, present: boolean) => void,
): void {
  container.empty();
  if (graph.nodes.length === 0) {
    container.createEl("p", { cls: "knobe-lens-muted", text: "No objects to chart yet." });
    return;
  }
  if (graph.edges.length === 0) {
    container.createEl("p", {
      cls: "knobe-lens-muted",
      text: `${graph.nodes.length} object(s), no recorded parent/child links yet.`,
    });
    return;
  }

  // depth = longest parent chain (0 = root), with a cycle guard
  const incoming = new Map<string, string[]>();
  for (const n of graph.nodes) incoming.set(n.hash, []);
  for (const e of graph.edges) incoming.get(e.to)?.push(e.from);

  // Surface cycles (possible if parents[] was hand-edited) rather than mislay them.
  const cstate = new Map<string, number>(); // 0 unvisited, 1 in-stack, 2 done
  const cyclic = (h: string): boolean => {
    const s = cstate.get(h) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    cstate.set(h, 1);
    for (const p of incoming.get(h) ?? []) if (cyclic(p)) return true;
    cstate.set(h, 2);
    return false;
  };
  if (graph.nodes.some((n) => cyclic(n.hash))) {
    container.createEl("p", { cls: "knobe-lens-muted", text: "Note: the lineage contains a cycle — layout is approximate." });
  }

  const memo = new Map<string, number>();
  const depthOf = (h: string, seen: Set<string> = new Set()): number => {
    if (memo.has(h)) return memo.get(h) as number;
    if (seen.has(h)) return 0;
    seen.add(h);
    const parents = incoming.get(h) ?? [];
    const d = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => depthOf(p, seen)));
    memo.set(h, d);
    return d;
  };

  const cols = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const d = depthOf(n.hash);
    if (!cols.has(d)) cols.set(d, []);
    (cols.get(d) as string[]).push(n.hash);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  for (const [d, hashes] of cols) {
    hashes.forEach((h, i) =>
      pos.set(h, { x: PAD + d * (NODE_W + COL_GAP), y: PAD + i * (NODE_H + ROW_GAP) }),
    );
    maxRows = Math.max(maxRows, hashes.length);
  }
  const width = PAD * 2 + (Math.max(...cols.keys()) + 1) * (NODE_W + COL_GAP) - COL_GAP;
  const height = PAD * 2 + maxRows * (NODE_H + ROW_GAP) - ROW_GAP;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", role: "img", class: "knobe-lineage-svg" });
  svg.setAttribute("aria-label", `Adaptation lineage: ${graph.nodes.length} objects, ${graph.edges.length} links`);

  const defs = svgEl("defs");
  const marker = svgEl("marker", { id: "kl-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  marker.appendChild(svgEl("path", { d: "M0 0 L10 5 L0 10 z", fill: "var(--text-muted)" }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  for (const e of graph.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    svg.appendChild(
      svgEl("path", {
        d: `M ${a.x + NODE_W} ${a.y + NODE_H / 2} L ${b.x} ${b.y + NODE_H / 2}`,
        stroke: "var(--text-muted)", "stroke-width": 1.5, fill: "none", "marker-end": "url(#kl-arrow)",
      }),
    );
  }

  for (const n of graph.nodes) {
    const p = pos.get(n.hash);
    if (!p) continue;
    const label = STATE_LABEL[n.state] ?? n.state;
    const presence = n.present ? "present in vault" : "external, not in vault";
    // Only present nodes are activatable — an inert role=button would mislead AT.
    const g = svgEl(
      "g",
      n.present
        ? { class: "knobe-lineage-node", tabindex: 0, role: "button" }
        : { class: "knobe-lineage-node is-external", role: "img" },
    );
    g.setAttribute("aria-label", `${n.title}, ${label}, ${n.contentType}, ${presence}`);
    g.appendChild(
      svgEl("rect", {
        x: p.x, y: p.y, width: NODE_W, height: NODE_H, rx: 6,
        fill: "var(--background-secondary)",
        stroke: n.present ? STATE_COLOR[n.state] ?? "var(--background-modifier-border)" : "var(--background-modifier-border)",
        "stroke-width": n.present ? 2 : 1, "stroke-dasharray": n.present ? "0" : "4 3",
      }),
    );
    const t1 = svgEl("text", { x: p.x + 10, y: p.y + 18, fill: "var(--text-normal)", "font-size": 12 });
    t1.textContent = n.title.length > 20 ? n.title.slice(0, 19) + "…" : n.title;
    const t2 = svgEl("text", { x: p.x + 10, y: p.y + 33, fill: "var(--text-muted)", "font-size": 10 });
    t2.textContent = `${n.contentType} · ${label}`;
    g.appendChild(t1);
    g.appendChild(t2);
    if (n.present) {
      const activate = () => onSelect(n.hash, n.present);
      g.addEventListener("click", activate);
      g.addEventListener("keydown", (ev) => {
        const k = (ev as KeyboardEvent).key;
        if (k === "Enter" || k === " ") { ev.preventDefault(); activate(); }
      });
    }
    svg.appendChild(g);
  }
  container.appendChild(svg);

  const titleOf = (h: string) => graph.nodes.find((n) => n.hash === h)?.title ?? h.slice(0, 8);
  const list = container.createEl("ul", { cls: "knobe-lineage-fallback" });
  list.setAttr("aria-label", "Lineage relationships");
  for (const e of graph.edges) list.createEl("li", { text: `${titleOf(e.to)} adapts ${titleOf(e.from)}` });
}
