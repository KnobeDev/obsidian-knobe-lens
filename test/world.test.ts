import { describe, expect, it } from "vitest";
import {
  Vec3,
  WorldNode,
  fibonacciSphere,
  layoutWorld,
  rotatePoint,
  facingAngles,
  project,
  depthOrder,
  arcPoints,
} from "../src/world";

const len = (p: Vec3): number => Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
const dist = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};
const finite = (p: Vec3): boolean => isFinite(p.x) && isFinite(p.y) && isFinite(p.z);

describe("fibonacciSphere", () => {
  it("returns n unit-length points, well spread, deterministic", () => {
    const pts = fibonacciSphere(50);
    expect(pts.length).toBe(50);
    expect(pts.every((p) => Math.abs(len(p) - 1) < 1e-9)).toBe(true);
    let minD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) minD = Math.min(minD, dist(pts[i], pts[j]));
    }
    expect(minD).toBeGreaterThan(0.15);
  });

  it("handles n=1 without landing on a pole singularity", () => {
    const one = fibonacciSphere(1);
    expect(one.length).toBe(1);
    expect(Math.abs(len(one[0]) - 1)).toBeLessThan(1e-9);
  });
});

describe("layoutWorld", () => {
  const R = 300;
  const nodes: WorldNode[] = [];
  for (let i = 0; i < 40; i++) nodes.push({ cluster: i % 4, weight: 40 - i });

  it("puts one point per node, every point on the sphere", () => {
    const pos = layoutWorld(nodes, R);
    expect(pos.length).toBe(nodes.length);
    expect(pos.every((p) => Math.abs(len(p) - R) < 1e-6)).toBe(true);
  });

  it("does not mutate its input", () => {
    const snapshot = JSON.stringify(nodes);
    layoutWorld(nodes, R);
    expect(JSON.stringify(nodes)).toBe(snapshot);
  });

  it("makes clusters cohere: intra-cluster mean distance < inter-cluster", () => {
    const pos = layoutWorld(nodes, R);
    let intra = 0, intraN = 0, inter = 0, interN = 0;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const d = dist(pos[i], pos[j]);
        if (nodes[i].cluster === nodes[j].cluster) { intra += d; intraN++; }
        else { inter += d; interN++; }
      }
    }
    expect(intra / intraN).toBeLessThan(inter / interN);
  });

  it("is deterministic", () => {
    const a = layoutWorld(nodes, R);
    const b = layoutWorld(nodes, R);
    expect(a.every((p, i) => dist(p, b[i]) < 1e-12)).toBe(true);
  });

  it("survives a single unclustered node", () => {
    const lone = layoutWorld([{ cluster: null, weight: 0 }], R);
    expect(lone.length).toBe(1);
    expect(finite(lone[0])).toBe(true);
    expect(Math.abs(len(lone[0]) - R)).toBeLessThan(1e-6);
  });

  it("handles an empty input", () => {
    expect(layoutWorld([], R)).toEqual([]);
  });
});

describe("rotatePoint / facingAngles", () => {
  it("treats a full yaw turn as identity", () => {
    const p = { x: 120, y: -40, z: 250 };
    expect(dist(rotatePoint(p, Math.PI * 2, 0), p)).toBeLessThan(1e-9);
  });

  it("rotates any point to face the camera (+z)", () => {
    const samples: Vec3[] = [
      { x: 300, y: 0, z: 0 }, { x: 0, y: 300, z: 0 }, { x: 0, y: 0, z: -300 },
      { x: -120, y: 200, z: 90 }, { x: 5, y: -5, z: 5 },
    ];
    for (const s of samples) {
      const a = facingAngles(s);
      const r = rotatePoint(s, a.yaw, a.pitch);
      expect(Math.abs(r.z - len(s))).toBeLessThan(1e-9);
    }
  });
});

describe("project", () => {
  const distCam = 1100;
  it("keeps the camera axis centred and scales near > far", () => {
    const front = project({ x: 0, y: 0, z: 300 }, 0, 0, distCam);
    const back = project({ x: 0, y: 0, z: -300 }, 0, 0, distCam);
    expect(Math.abs(front.x)).toBeLessThan(1e-9);
    expect(Math.abs(front.y)).toBeLessThan(1e-9);
    expect(front.s).toBeGreaterThan(back.s);
    expect(front.z).toBeGreaterThan(0);
    expect(back.z).toBeLessThan(0);
  });

  it("stays finite off-axis and rotated", () => {
    const off = project({ x: 100, y: 50, z: 300 }, 0.3, -0.2, distCam);
    expect(isFinite(off.x) && isFinite(off.y) && isFinite(off.s)).toBe(true);
  });
});

describe("depthOrder", () => {
  it("sorts far to near (ascending camera z)", () => {
    const order = depthOrder([{ z: 5 }, { z: -200 }, { z: 90 }, { z: 0 }]);
    expect(order.join(",")).toBe("1,3,0,2");
  });
});

describe("arcPoints", () => {
  const R = 300;
  it("returns segments+1 points from a to b, lifted above the surface", () => {
    const a = { x: R, y: 0, z: 0 }, b = { x: 0, y: R, z: 0 };
    const arc = arcPoints(a, b, 0.25, 20);
    expect(arc.length).toBe(21);
    expect(dist(arc[0], a)).toBeLessThan(1e-6);
    expect(dist(arc[20], b)).toBeLessThan(1e-6);
    expect(len(arc[10])).toBeGreaterThan(R * 1.05);
    expect(arc.every(finite)).toBe(true);
  });

  it("survives antipodal and coincident endpoints", () => {
    const anti = arcPoints({ x: R, y: 0, z: 0 }, { x: -R, y: 0, z: 0 }, 0.25, 16);
    expect(anti.length).toBe(17);
    expect(anti.every(finite)).toBe(true);
    const same = arcPoints({ x: R, y: 0, z: 0 }, { x: R, y: 0, z: 0 }, 0.25, 8);
    expect(same.length).toBeGreaterThanOrEqual(2);
    expect(same.every(finite)).toBe(true);
  });
});
