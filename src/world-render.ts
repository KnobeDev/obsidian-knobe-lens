/**
 * world-render.ts — the "Knowledge world" globe: a 3D view of every sealed
 * KNOBE object in the vault, clustered into continents, with adaptation
 * lineage flying across as great-circle arcs.
 *
 * This is the Obsidian-native twin of Second Brain's memory-map world layout.
 * All 3D math lives in world.ts (pure, unit-tested); this module only renders
 * to a canvas and wires interaction + accessibility.
 *
 * Accessibility is first-class, not an afterthought (WCAG 2.1 A/AA):
 *   - the canvas is role="img" with a live-updated summary label;
 *   - a keyboard-navigable list mirror groups every object by continent — it is
 *     the real interactive substrate, the canvas is decoration;
 *   - selecting from the list rotates the globe to face that object and opens
 *     its detail, so a keyboard/AT user sees focus move;
 *   - selection fires on the up-event only (pointer cancellation, SC 2.5.2);
 *   - prefers-reduced-motion => a static globe, no idle spin.
 */

import { setIcon } from "obsidian";
import {
  Vec3,
  WorldNode,
  layoutWorld,
  project,
  rotatePoint,
  facingAngles,
  arcPoints,
} from "./world";

export type WorldGroupBy = "kind" | "state" | "portfolio";

/** One object on the globe. Carries every field a continent grouping could
 *  need, so switching "Group by" never requires a rebuild from the caller. */
export interface WorldDatum {
  hash: string;
  title: string;
  /** Recognition state, or "external" for a referenced-but-absent parent. */
  state: string;
  contentType: string;
  present: boolean;
  /** Vault path (present objects only) — used to open/select. */
  path: string | null;
  /** Portfolio folder name, or null when unfiled. */
  portfolio: string | null;
  /** Lineage degree (parents + children) — sizes and orders the node. */
  degree: number;
}

export interface WorldEdge {
  from: string; // parent hash
  to: string; // child hash
}

export interface WorldRenderData {
  nodes: WorldDatum[];
  edges: WorldEdge[];
}

export interface WorldGlobeOptions {
  /** Activate an object (canvas click or list button). */
  onSelect: (datum: WorldDatum) => void;
  /** Initial grouping. */
  groupBy?: WorldGroupBy;
}

const R = 300; // sphere radius in world units
const CAM_DIST = 1100; // camera distance on +z
const HOME = { yaw: -0.5, pitch: 0.28 };
const SPIN_PER_FRAME = 0.0016;
const ARC_LIFT = 0.22;
const ARC_SEGMENTS = 20;
const MAX_LABELS = 20;

const STATE_COLOR_VAR: Record<string, string> = {
  verified: "--color-green",
  "verified-body-modified": "--color-yellow",
  failed: "--color-red",
  unreadable: "--text-muted",
  external: "--text-faint",
};
const STATE_LABEL: Record<string, string> = {
  verified: "Verified",
  "verified-body-modified": "Body modified",
  failed: "Failed",
  unreadable: "Unreadable",
  external: "External",
};

const GROUP_LABEL: Record<WorldGroupBy, string> = {
  kind: "Kind",
  state: "Recognition",
  portfolio: "Portfolio",
};

/** The continent key for a datum under the active grouping. */
function clusterKey(d: WorldDatum, groupBy: WorldGroupBy): string {
  if (groupBy === "state") return STATE_LABEL[d.state] ?? d.state;
  if (groupBy === "portfolio") return d.portfolio ?? "Unfiled";
  return d.contentType && d.contentType !== "—" ? d.contentType : "unspecified";
}

interface ScreenPos {
  x: number;
  y: number;
  z: number;
  r: number;
}

export class WorldGlobe {
  private data: WorldRenderData = { nodes: [], edges: [] };
  private groupBy: WorldGroupBy;

  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private listEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private groupControls!: HTMLElement;
  private spinBtn: HTMLButtonElement | null = null;

  private positions: Vec3[] = []; // index-aligned with data.nodes
  private indexOf = new Map<string, number>();
  private screen: (ScreenPos | null)[] = [];
  private lastSig = ""; // structural fingerprint — skip no-op rebuilds so keyboard focus survives

  private yaw = HOME.yaw;
  private pitch = HOME.pitch;
  private zoom = 1;
  private spin: boolean;
  private selectedHash: string | null = null;

  private dragging = false;
  private moved = false;
  private last: [number, number] = [0, 0];
  private raf = 0;
  private W = 0;
  private H = 0;
  private dpr = 1;

  private readonly reduce =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  private resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize = () => this.resize();
  // Canvas listeners are tracked so destroy() can remove them symmetrically with
  // the rAF / observers, and so an active pointer capture is always released.
  private pointerHandlers: Array<[string, EventListener]> = [];
  private capturedPointer: number | null = null;

  constructor(private container: HTMLElement, private opts: WorldGlobeOptions) {
    this.groupBy = opts.groupBy ?? "kind";
    this.spin = !this.reduce;
    this.build();
  }

  /* ---- mount ---- */

  private build(): void {
    this.container.empty();
    this.container.addClass("knobe-world");

    const controls = this.container.createDiv({ cls: "knobe-world-controls" });
    // A single-select segmented control is an ARIA radiogroup: one tab stop,
    // arrow keys move between options, selection follows focus (APG radio pattern).
    const groupWrap = controls.createDiv({ cls: "knobe-world-group" });
    const groupLabelId = "knobe-world-group-label";
    groupWrap.createSpan({ cls: "knobe-world-group-label", text: "Group by", attr: { id: groupLabelId } });
    this.groupControls = groupWrap.createDiv({
      cls: "knobe-world-seg",
      attr: { role: "radiogroup", "aria-labelledby": groupLabelId },
    });
    (Object.keys(GROUP_LABEL) as WorldGroupBy[]).forEach((g) => {
      const b = this.groupControls.createEl("button", {
        cls: "knobe-world-seg-btn",
        text: GROUP_LABEL[g],
        attr: {
          role: "radio",
          "data-group": g,
          "aria-checked": String(g === this.groupBy),
          tabindex: g === this.groupBy ? "0" : "-1", // roving tabindex
        },
      });
      b.onclick = () => this.setGroupBy(g);
    });
    this.groupControls.addEventListener("keydown", (e) => this.onGroupKeydown(e));
    // A gentle idle spin sells the globe, but it's trivially pausable and never
    // runs under prefers-reduced-motion (no toggle offered there).
    if (!this.reduce) {
      this.spinBtn = controls.createEl("button", {
        cls: "knobe-world-spin",
        text: this.spin ? "Pause" : "Spin",
        attr: { "aria-pressed": String(this.spin) },
      });
      this.spinBtn.onclick = () => this.toggleSpin();
    }
    const reset = controls.createEl("button", { cls: "knobe-world-reset", text: "Reset view" });
    reset.setAttr("aria-label", "Reset the globe to its home rotation and zoom");
    reset.onclick = () => this.resetView();

    const stage = this.container.createDiv({ cls: "knobe-world-stage" });
    this.canvas = stage.createEl("canvas", { cls: "knobe-world-canvas" });
    this.canvas.setAttr("role", "img");
    this.canvas.setAttr("aria-label", "3D globe of sealed KNOBE objects. A keyboard-navigable list of the same objects follows.");
    // The canvas is presentation; the list below is the accessible substrate.
    this.canvas.tabIndex = -1;

    this.statusEl = this.container.createEl("p", {
      cls: "knobe-world-status knobe-lens-sr-only",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });

    const mirror = this.container.createDiv({ cls: "knobe-world-mirror" });
    mirror.createEl("h5", { cls: "knobe-lens-section", text: "Objects on the globe" });
    mirror.createEl("p", {
      cls: "knobe-lens-muted knobe-world-mirror-hint",
      text: "Select an object to rotate the globe to face it and open its detail.",
    });
    this.listEl = mirror.createDiv({ cls: "knobe-world-list" });

    this.wirePointer();
    this.wireResize();
  }

  /** Roving-tabindex arrow-key navigation for the Group-by radiogroup (APG). */
  private onGroupKeydown(e: KeyboardEvent): void {
    const btns = Array.from(this.groupControls.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    if (!btns.length) return;
    const current = btns.findIndex((b) => b.getAttr("data-group") === this.groupBy);
    let next = -1;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (current + 1) % btns.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (current - 1 + btns.length) % btns.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = btns.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    this.setGroupBy(btns[next].getAttr("data-group") as WorldGroupBy);
    btns[next].focus();
  }

  /* ---- public API ---- */

  /** Replace the dataset and redraw. Positions are re-derived (they depend on
   *  the current grouping); a still-present selection is preserved. A background
   *  auto-refresh that changes nothing structural is a no-op, so the list DOM
   *  (and any keyboard focus inside it) is left untouched. */
  render(data: WorldRenderData): void {
    const sig = this.signatureOf(data);
    if (sig === this.lastSig) return; // nothing changed — keep DOM + focus intact
    this.lastSig = sig;
    this.data = data;
    this.rebuildLayout();
    if (this.selectedHash && !this.indexOf.has(this.selectedHash)) this.selectedHash = null;
    this.renderList();
    this.resize(); // sizes the canvas then draws
    this.updateCanvasLabel();
  }

  /** A fingerprint of everything that affects layout or the list: the node set,
   *  their cluster-relevant fields, the edges, and the active grouping. */
  private signatureOf(data: WorldRenderData): string {
    const nodes = data.nodes
      .map((d) => `${d.hash}:${d.state}:${d.contentType}:${d.portfolio ?? ""}:${d.degree}`)
      .join("|");
    const edges = data.edges.map((e) => `${e.from}>${e.to}`).join("|");
    return `${this.groupBy}::${nodes}::${edges}`;
  }

  /** Reflect an external selection (e.g. the dashboard selected a row) without
   *  re-opening it — updates the list highlight and faces the globe. */
  setSelected(hash: string | null, face = false): void {
    this.selectedHash = hash && this.indexOf.has(hash) ? hash : null;
    this.updateListSelection();
    if (face && this.selectedHash) this.faceNode(this.selectedHash);
    else this.draw();
    this.updateCanvasLabel();
  }

  /** Repaint with the current theme palette. Call when Obsidian's CSS changes;
   *  the host view forwards the workspace "css-change" event here (one listener,
   *  not a MutationObserver per globe instance). */
  repaint(): void {
    this.draw();
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.onWindowResize);
    // Release any capture from a drag interrupted by the view closing, and drop
    // the canvas listeners symmetrically with the observers above.
    if (this.capturedPointer != null) {
      try {
        this.canvas.releasePointerCapture(this.capturedPointer);
      } catch {
        /* already released on detach */
      }
      this.capturedPointer = null;
    }
    this.dragging = false;
    for (const [type, fn] of this.pointerHandlers) this.canvas.removeEventListener(type, fn);
    this.pointerHandlers = [];
  }

  /* ---- layout ---- */

  private setGroupBy(g: WorldGroupBy): void {
    if (g === this.groupBy) return;
    this.groupBy = g;
    for (const b of Array.from(this.groupControls.children)) {
      const el = b as HTMLElement;
      const on = el.getAttr("data-group") === g; // keyed to data, not the visible label
      el.setAttr("aria-checked", String(on));
      el.setAttr("tabindex", on ? "0" : "-1");
    }
    this.rebuildLayout();
    this.renderList();
    this.draw();
    this.updateCanvasLabel();
    this.lastSig = this.signatureOf(this.data); // grouping is baked into the fingerprint
    this.setStatus(`Grouped by ${GROUP_LABEL[g].toLowerCase()}.`);
  }

  private rebuildLayout(): void {
    const worldNodes: WorldNode[] = this.data.nodes.map((d) => ({
      cluster: clusterKey(d, this.groupBy),
      weight: d.degree,
    }));
    this.positions = layoutWorld(worldNodes, R);
    this.indexOf = new Map(this.data.nodes.map((d, i) => [d.hash, i]));
  }

  private toggleSpin(): void {
    this.spin = !this.spin;
    if (this.spinBtn) {
      this.spinBtn.setText(this.spin ? "Pause" : "Spin");
      this.spinBtn.setAttr("aria-pressed", String(this.spin));
    }
    this.setStatus(this.spin ? "Globe spinning." : "Globe paused.");
    if (this.spin) this.startLoop();
    else if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private resetView(): void {
    this.yaw = HOME.yaw;
    this.pitch = HOME.pitch;
    this.zoom = 1;
    this.spin = !this.reduce;
    if (this.spinBtn) {
      this.spinBtn.setText(this.spin ? "Pause" : "Spin");
      this.spinBtn.setAttr("aria-pressed", String(this.spin));
    }
    this.selectedHash = null;
    this.updateListSelection();
    this.updateCanvasLabel();
    this.setStatus("View reset.");
    if (this.spin) this.startLoop();
    else this.draw();
  }

  /* ---- sizing ---- */

  private wireResize(): void {
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    }
    window.addEventListener("resize", this.onWindowResize);
  }

  private resize(): void {
    const cssW = Math.max(0, this.canvas.clientWidth);
    const cssH = Math.max(0, this.canvas.clientHeight);
    if (cssW === 0 || cssH === 0) return; // not laid out yet
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.W = cssW;
    this.H = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    this.ctx = ctx;
    if (this.spin) this.startLoop();
    else this.draw();
  }

  /* ---- theme-aware colors ---- */

  private cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(this.container).getPropertyValue(name).trim();
    return v || fallback;
  }

  private stateColor(state: string): string {
    return this.cssVar(STATE_COLOR_VAR[state] ?? "--text-muted", "#888");
  }

  /** Resolve every colour the frame needs in one getComputedStyle pass, so a
   *  spinning globe doesn't call it once per node per frame. */
  private palette(): {
    edge: string;
    label: string;
    ring: string;
    muted: string;
    state: Record<string, string>;
  } {
    const cs = getComputedStyle(this.container);
    const v = (name: string, fb: string): string => cs.getPropertyValue(name).trim() || fb;
    const state: Record<string, string> = {};
    for (const [s, varName] of Object.entries(STATE_COLOR_VAR)) state[s] = v(varName, "#888");
    return {
      edge: v("--background-modifier-border", "#888"),
      label: v("--text-normal", "#222"),
      ring: v("--interactive-accent", "#4b7bec"),
      muted: v("--text-muted", "#888"),
      state,
    };
  }

  private worldFit(): number {
    return (Math.min(this.W, this.H) * 0.4 / R) * this.zoom;
  }

  private toScreen(p: Vec3): { x: number; y: number; z: number; s: number } {
    const q = project(p, this.yaw, this.pitch, CAM_DIST);
    const f = this.worldFit();
    return { x: q.x * f + this.W / 2, y: -q.y * f + this.H / 2, z: q.z, s: q.s };
  }

  /* ---- drawing ---- */

  private startLoop(): void {
    if (this.raf) return;
    const step = () => {
      this.raf = 0;
      if (this.spin && !this.dragging && !this.reduce) this.yaw += SPIN_PER_FRAME;
      this.draw();
      if (this.spin && !this.dragging && !this.reduce) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private strokePath3d(pts: Vec3[]): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const s = this.toScreen(pts[i]);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
  }

  private graticule(edge: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.12;
    const SEG = 48;
    for (let i = -2; i <= 2; i++) {
      const lat = (i * Math.PI) / 6, r = Math.cos(lat), y = Math.sin(lat);
      const pts: Vec3[] = [];
      for (let j = 0; j <= SEG; j++) {
        const a = (j / SEG) * 2 * Math.PI;
        pts.push({ x: Math.cos(a) * r * R, y: y * R, z: Math.sin(a) * r * R });
      }
      this.strokePath3d(pts);
    }
    for (let i = 0; i < 6; i++) {
      const lon = (i * Math.PI) / 6;
      const pts: Vec3[] = [];
      for (let j = 0; j <= SEG; j++) {
        const t = (j / SEG) * 2 * Math.PI;
        pts.push({
          x: Math.sin(t) * Math.cos(lon) * R,
          y: Math.cos(t) * R,
          z: Math.sin(t) * Math.sin(lon) * R,
        });
      }
      this.strokePath3d(pts);
    }
    ctx.globalAlpha = 1;
  }

  private draw(): void {
    if (!this.ctx || this.W === 0 || this.H === 0) return;
    if (!this.positions.length) {
      this.clear();
      return;
    }
    const ctx = this.ctx;
    const pal = this.palette();
    const { edge, label, ring } = pal;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);

    // globe disc — a barely-there fill so the sphere reads as solid
    const f = this.worldFit();
    ctx.beginPath();
    ctx.arc(this.W / 2, this.H / 2, R * f * 1.02, 0, 6.2832);
    ctx.fillStyle = edge;
    ctx.globalAlpha = 0.05;
    ctx.fill();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;

    this.graticule(edge);

    // lineage arcs fly across the world; far-side arcs dim, selection focuses
    const sel = this.selectedHash;
    const selIdx = sel ? this.indexOf.get(sel) : undefined;
    ctx.strokeStyle = pal.muted;
    for (const e of this.data.edges) {
      const ia = this.indexOf.get(e.from), ib = this.indexOf.get(e.to);
      if (ia == null || ib == null) continue;
      const pa = this.positions[ia], pb = this.positions[ib];
      if (!pa || !pb) continue;
      const near =
        Math.max(rotatePoint(pa, this.yaw, this.pitch).z, rotatePoint(pb, this.yaw, this.pitch).z) > 0;
      const focused = selIdx == null ? true : ia === selIdx || ib === selIdx;
      ctx.globalAlpha = (focused ? 0.5 : 0.08) * (near ? 1 : 0.35);
      ctx.lineWidth = focused && selIdx != null ? 1.4 : 1;
      this.strokePath3d(arcPoints(pa, pb, ARC_LIFT, ARC_SEGMENTS));
    }
    ctx.globalAlpha = 1;

    // nodes in painter's order (far to near); back hemisphere stays visible but dim
    // Canvas font must be concrete CSS — var() does not parse here.
    ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
    ctx.textAlign = "center";
    this.screen = new Array(this.data.nodes.length).fill(null);
    const order: number[] = [];
    for (let i = 0; i < this.data.nodes.length; i++) {
      const p = this.positions[i];
      if (!p) continue;
      const s = this.toScreen(p);
      const d = this.data.nodes[i];
      const rad = Math.max(1.8, (3 + d.degree * 0.9) * Math.sqrt(this.zoom) * s.s);
      this.screen[i] = { x: s.x, y: s.y, z: s.z, r: rad };
      order.push(i);
    }
    order.sort((a, b) => (this.screen[a]!.z - this.screen[b]!.z));

    for (const i of order) {
      const w = this.screen[i]!;
      const d = this.data.nodes[i];
      const front = w.z > 0;
      const focused = selIdx == null || i === selIdx;
      ctx.globalAlpha = (focused ? 1 : 0.22) * (front ? 1 : 0.32);
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.r, 0, 6.2832);
      ctx.fillStyle = pal.state[d.state] ?? pal.muted;
      ctx.fill();
      if (d.hash === sel) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = ring;
        ctx.stroke();
      } else if (front && focused && !d.present) {
        // external placeholders read as hollow so the gap is visible
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1;
        ctx.strokeStyle = edge;
        ctx.stroke();
      }
    }

    // labels: near side only, capped, plus the selection
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = label;
    let labeled = 0;
    for (let k = order.length - 1; k >= 0 && labeled < MAX_LABELS; k--) {
      const i = order[k];
      const w = this.screen[i]!;
      if (w.z <= 0) continue;
      const d = this.data.nodes[i];
      if (!(w.r > 9 || d.hash === sel)) continue;
      const text = d.title.length > 24 ? d.title.slice(0, 23) + "…" : d.title;
      ctx.fillText(text, w.x, w.y - w.r - 4);
      labeled++;
    }
    ctx.globalAlpha = 1;
  }

  private clear(): void {
    if (!this.ctx) return;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.W, this.H);
  }

  /* ---- rotate to face a node (list/keyboard selection) ---- */

  private faceNode(hash: string): void {
    const i = this.indexOf.get(hash);
    if (i == null || !this.positions[i]) return;
    const a = facingAngles(this.positions[i]);
    this.spin = false; // don't rotate away from what the user just focused
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.yaw = a.yaw;
    this.pitch = a.pitch;
    this.draw();
  }

  /* ---- pointer interaction ---- */

  private nodeAt(px: number, py: number): WorldDatum | null {
    let best: number | null = null;
    let bestZ = -Infinity;
    for (let i = 0; i < this.screen.length; i++) {
      const s = this.screen[i];
      if (!s || s.z <= 0) continue; // only front-hemisphere nodes are clickable
      const dx = px - s.x, dy = py - s.y;
      const hit = Math.max(s.r, 6);
      if (dx * dx + dy * dy <= hit * hit && s.z > bestZ) {
        best = i;
        bestZ = s.z;
      }
    }
    return best == null ? null : this.data.nodes[best];
  }

  private wirePointer(): void {
    const c = this.canvas;
    // Listeners are stored so destroy() can remove them symmetrically.
    const add = (type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void => {
      c.addEventListener(type, fn, opts);
      this.pointerHandlers.push([type, fn]);
    };

    add("pointerdown", (ev) => {
      const e = ev as PointerEvent;
      if (e.button != null && e.button > 0) return; // primary / touch / pen only
      try {
        c.setPointerCapture(e.pointerId);
        this.capturedPointer = e.pointerId;
      } catch {
        /* capture is best-effort */
      }
      this.spin = false; // the user takes the wheel
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
      this.dragging = true;
      this.moved = false;
      this.last = [e.clientX, e.clientY];
      c.addClass("is-grabbing");
    });
    add("pointermove", (ev) => {
      if (!this.dragging) return;
      const e = ev as PointerEvent;
      const dx = e.clientX - this.last[0], dy = e.clientY - this.last[1];
      this.last = [e.clientX, e.clientY];
      if (Math.abs(dx) + Math.abs(dy) > 1) this.moved = true;
      this.yaw += dx * 0.005;
      this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + dy * 0.005));
      this.draw();
    });
    const end = (ev: Event): void => {
      const e = ev as PointerEvent;
      // Select fires on the up-event only (pointer cancellation, SC 2.5.2): a
      // press that dragged away — or was cancelled — must not select.
      if (this.dragging && !this.moved && e.type === "pointerup") {
        const rect = c.getBoundingClientRect();
        const hit = this.nodeAt(e.clientX - rect.left, e.clientY - rect.top);
        if (hit) this.activate(hit, false);
      }
      this.dragging = false;
      this.capturedPointer = null;
      c.removeClass("is-grabbing");
    };
    add("pointerup", end);
    add("pointercancel", end);
    add(
      "wheel",
      (ev) => {
        const e = ev as WheelEvent;
        e.preventDefault();
        const f = e.deltaY < 0 ? 1.12 : 0.89;
        this.zoom = Math.min(5, Math.max(0.15, this.zoom * f));
        this.draw();
      },
      { passive: false },
    );
  }

  /** Select an object: highlight it, face the globe toward it, and notify the
   *  host. `face` is false for a direct canvas click (already visible) and true
   *  for a list/keyboard activation (bring it into view). */
  private activate(d: WorldDatum, face: boolean): void {
    this.selectedHash = d.hash;
    this.updateListSelection();
    if (face) this.faceNode(d.hash);
    else this.draw();
    this.updateCanvasLabel();
    // On a list/keyboard activation focus moves to the detail pane (which
    // self-announces), so a polite status line here would be redundant; keep it
    // for a canvas click, where focus does not move.
    if (!face) this.setStatus(`${d.title} selected — ${STATE_LABEL[d.state] ?? d.state}, ${d.contentType}.`);
    this.opts.onSelect(d);
  }

  /* ---- accessible list mirror ---- */

  private renderList(): void {
    // Preserve keyboard focus across a rebuild: if focus was on a node button,
    // restore it to the same object afterward, so a background refresh never
    // drops a keyboard user to <body> (the structural signature already skips
    // no-op rebuilds; this covers grouping changes and real data changes).
    const active = document.activeElement as HTMLElement | null;
    const refocusHash = active && this.listEl.contains(active) ? active.getAttr("data-hash") : null;

    this.listEl.empty();
    if (this.data.nodes.length === 0) {
      this.listEl.createEl("p", { cls: "knobe-lens-muted", text: "No sealed objects to place yet." });
      return;
    }
    // Group by the active continent key; biggest continents first.
    const groups = new Map<string, WorldDatum[]>();
    for (const d of this.data.nodes) {
      const key = clusterKey(d, this.groupBy);
      const bucket = groups.get(key);
      if (bucket) bucket.push(d);
      else groups.set(key, [d]);
    }
    const keys = [...groups.keys()].sort(
      (a, b) => groups.get(b)!.length - groups.get(a)!.length || a.localeCompare(b),
    );
    keys.forEach((key, gi) => {
      const members = groups.get(key)!.sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title));
      // Index-prefixed so two continents that sanitize to the same token can't
      // collide on a duplicate id (which would break aria-labelledby).
      const groupId = `knobe-world-c-${gi}-${cssSafe(key)}`;
      const section = this.listEl.createEl("section", {
        cls: "knobe-world-continent",
        attr: { "aria-labelledby": groupId },
      });
      const head = section.createDiv({ cls: "knobe-world-continent-head" });
      head.createEl("h6", { attr: { id: groupId }, text: key });
      head.createSpan({
        cls: "knobe-lens-count",
        text: String(members.length),
        attr: { "aria-label": `${members.length} object${members.length === 1 ? "" : "s"}` },
      });
      const ul = section.createEl("ul", { cls: "knobe-world-continent-list" });
      for (const d of members) {
        const li = ul.createEl("li");
        if (d.present) {
          // A real, openable object → an activatable button.
          const b = li.createEl("button", {
            cls: "knobe-world-node-btn",
            attr: { "data-hash": d.hash, type: "button" },
          });
          if (d.hash === this.selectedHash) b.setAttr("aria-current", "true");
          this.nodeRow(b, d);
          b.onclick = () => this.activate(d, true);
        } else {
          // A referenced-but-absent lineage parent: not activatable, so it's a
          // plain text row — present in reading order, never a dead focus stop.
          this.nodeRow(li.createEl("div", { cls: "knobe-world-node-btn is-external" }), d);
        }
      }
    });

    if (refocusHash) {
      this.listEl.querySelector<HTMLElement>(`button[data-hash="${refocusHash}"]`)?.focus();
    }
  }

  /** Dot + title + meta line shared by activatable and external list rows. */
  private nodeRow(parent: HTMLElement, d: WorldDatum): void {
    const dot = parent.createSpan({ cls: "knobe-world-dot", attr: { "aria-hidden": "true" } });
    dot.style.setProperty("--knobe-world-dot", this.stateColor(d.state));
    parent.createSpan({ cls: "knobe-world-node-title", text: d.title });
    parent.createSpan({
      cls: "knobe-world-node-meta",
      text: `${STATE_LABEL[d.state] ?? d.state} · ${d.contentType}${d.present ? "" : " · not in vault"}`,
    });
  }

  private updateListSelection(): void {
    for (const b of Array.from(this.listEl.querySelectorAll("button[data-hash]"))) {
      const el = b as HTMLElement;
      if (el.getAttr("data-hash") === this.selectedHash) el.setAttr("aria-current", "true");
      else el.removeAttribute("aria-current");
    }
  }

  /* ---- status + labels ---- */

  private setStatus(text: string): void {
    if (this.statusEl.textContent !== text) this.statusEl.setText(text);
  }

  private updateCanvasLabel(): void {
    const n = this.data.nodes.length;
    const links = this.data.edges.length;
    const continents = new Set(this.data.nodes.map((d) => clusterKey(d, this.groupBy))).size;
    let label = `3D globe: ${n} sealed object${n === 1 ? "" : "s"} in ${continents} continent${continents === 1 ? "" : "s"} grouped by ${GROUP_LABEL[this.groupBy].toLowerCase()}, ${links} lineage link${links === 1 ? "" : "s"}.`;
    if (this.selectedHash) {
      const d = this.data.nodes[this.indexOf.get(this.selectedHash) as number];
      if (d) label += ` Selected: ${d.title}.`;
    }
    label += " Use the list below to navigate objects by keyboard.";
    this.canvas.setAttr("aria-label", label);
  }
}

/** A DOM-id-safe token derived from a continent key. */
function cssSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "c";
}
