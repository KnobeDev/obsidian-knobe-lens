/**
 * world.ts — pure 3D math for the "Knowledge world" globe.
 *
 * A faithful TypeScript port of Second Brain's hcai_world.js (the pure-math
 * module behind its 3D memory map). No DOM, no network, no timers, no
 * randomness: every function is deterministic so the same objects always land
 * on the same continent and the math is unit-testable under vitest.
 *
 * The metaphor: each sealed KNOBE object is a node on a sphere. Objects that
 * share a cluster (content_type / recognition state / portfolio) gather into a
 * "continent" (a spherical cap around an evenly-spread centre); adaptation
 * lineage links become great-circle arcs lifted above the surface so they
 * visibly fly across the world instead of tunnelling through it.
 *
 * Integrity note: the layout is presentation only. It never changes a seal, a
 * hash, or a verdict — it just arranges what the verifier already decided.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One object to place. `cluster` groups it into a continent (null = the
 *  unclustered continent); `weight` (e.g. lineage degree) sizes and orders it. */
export interface WorldNode {
  cluster: string | number | null;
  weight?: number;
}

/** Perspective-projected point: camera-space {x,y} already scaled, plus the
 *  camera-space depth `z` (positive = nearer the viewer) and the scale factor
 *  `s` used for sizing/dimming. */
export interface Projected {
  x: number;
  y: number;
  z: number;
  s: number;
}

export interface Angles {
  yaw: number;
  pitch: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad

function norm(p: Vec3): Vec3 {
  const l = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) || 1;
  return { x: p.x / l, y: p.y / l, z: p.z / l };
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function scale(p: Vec3, s: number): Vec3 {
  return { x: p.x * s, y: p.y * s, z: p.z * s };
}

/** n points spread evenly over the unit sphere (Fibonacci lattice). */
export function fibonacciSphere(n: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    // offset by 0.5 keeps the poles free even for tiny n
    const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * GOLDEN_ANGLE;
    pts.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r });
  }
  return pts;
}

/** Tangent basis at a unit vector c: two unit vectors perpendicular to c and
 *  each other. */
function tangentBasis(c: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(c.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = norm(cross(c, ref));
  const v = cross(c, u); // already unit: c ⊥ u, both unit
  return [u, v];
}

/**
 * Place nodes on a sphere of radius R. Output is index-aligned with the input.
 * Same-cluster nodes share a spherical cap ("continent") whose centre comes
 * from a Fibonacci spread of the cluster centres; within a cap members spiral
 * outward from the highest-weight node. Input is never mutated.
 */
export function layoutWorld(nodes: WorldNode[], R: number): Vec3[] {
  const byCluster: Record<string, number[]> = {};
  nodes.forEach((n, i) => {
    const c = n.cluster == null ? "_" : String(n.cluster);
    (byCluster[c] = byCluster[c] || []).push(i);
  });
  // biggest continents first so they get the most even spread of centres
  const keys = Object.keys(byCluster).sort(
    (a, b) => byCluster[b].length - byCluster[a].length || (a < b ? -1 : 1),
  );
  const centers = fibonacciSphere(keys.length);
  const out: Vec3[] = new Array(nodes.length);
  keys.forEach((key, ci) => {
    const members = byCluster[key]
      .slice()
      .sort((a, b) => (nodes[b].weight || 0) - (nodes[a].weight || 0) || a - b);
    const c = centers[ci];
    const [u, v] = tangentBasis(c);
    // cap angular radius grows gently with membership, capped well under a hemisphere
    const rho = Math.min(0.7, 0.1 + 0.055 * Math.sqrt(members.length));
    members.forEach((nodeIdx, i) => {
      const r = i === 0 ? 0 : rho * Math.sqrt(i / members.length);
      const a = i * GOLDEN_ANGLE;
      const cosR = Math.cos(r), sinR = Math.sin(r);
      const tx = Math.cos(a) * sinR, ty = Math.sin(a) * sinR;
      out[nodeIdx] = {
        x: (c.x * cosR + u.x * tx + v.x * ty) * R,
        y: (c.y * cosR + u.y * tx + v.y * ty) * R,
        z: (c.z * cosR + u.z * tx + v.z * ty) * R,
      };
    });
  });
  return out;
}

/** Rotate a point: yaw about the Y axis, then pitch about the X axis. */
export function rotatePoint(p: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return { x: x1, y: p.y * cp - z1 * sp, z: p.y * sp + z1 * cp };
}

/** Angles that rotate p to face the camera: rotatePoint(p, yaw, pitch).z === |p|. */
export function facingAngles(p: Vec3): Angles {
  const yaw = -Math.atan2(p.x, p.z);
  const h = Math.sqrt(p.x * p.x + p.z * p.z);
  return { yaw, pitch: Math.atan2(p.y, h) };
}

/**
 * Perspective projection. Camera sits on +z at `dist` looking at the origin.
 * Returns camera-space {x, y} already perspective-scaled, the camera-space
 * depth z (positive = nearer the viewer), and the scale factor s.
 */
export function project(p: Vec3, yaw: number, pitch: number, dist: number): Projected {
  const r = rotatePoint(p, yaw, pitch);
  const s = dist / Math.max(dist * 0.2, dist - r.z); // clamp: never explode near the camera
  return { x: r.x * s, y: r.y * s, z: r.z, s };
}

/** Painter's-algorithm order: indices sorted far-to-near (ascending camera z). */
export function depthOrder(pts: { z: number }[]): number[] {
  const idx = pts.map((_, i) => i);
  idx.sort((a, b) => pts[a].z - pts[b].z);
  return idx;
}

function slerp2(ua: Vec3, ub: Vec3, t: number, omega: number, sinO: number): Vec3 {
  const wa = Math.sin((1 - t) * omega) / sinO, wb = Math.sin(t * omega) / sinO;
  return norm({ x: ua.x * wa + ub.x * wb, y: ua.y * wa + ub.y * wb, z: ua.z * wa + ub.z * wb });
}
function slerp(ua: Vec3, ub: Vec3, t: number): Vec3 {
  const cosO = Math.max(-1, Math.min(1, dot(ua, ub)));
  const omega = Math.acos(cosO), sinO = Math.sin(omega);
  if (sinO < 1e-6) return ua;
  return slerp2(ua, ub, t, omega, sinO);
}

/**
 * Great-circle arc between two points on (or near) a sphere, lifted above the
 * surface by `lift` (fraction of the radius, peaking mid-arc) so connections
 * fly across the world instead of tunnelling through it. Returns segments+1
 * points, starting at a and ending at b.
 */
export function arcPoints(a: Vec3, b: Vec3, lift: number, segments: number): Vec3[] {
  const la = Math.sqrt(dot(a, a)), lb = Math.sqrt(dot(b, b));
  const R = (la + lb) / 2 || 1;
  const ua = norm(a), ub = norm(b);
  const cosO = Math.max(-1, Math.min(1, dot(ua, ub)));
  const omega = Math.acos(cosO), sinO = Math.sin(omega);
  const pts: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let p: Vec3;
    if (sinO < 1e-6) {
      // coincident or antipodal: detour through a stable perpendicular waypoint
      if (cosO > 0) {
        p = ua;
      } else {
        const mid = norm(cross(ua, tangentBasis(ua)[0]));
        p = t < 0.5 ? slerp(ua, mid, t * 2) : slerp(mid, ub, (t - 0.5) * 2);
      }
    } else {
      p = slerp2(ua, ub, t, omega, sinO);
    }
    const alt = R * (1 + lift * Math.sin(Math.PI * t));
    pts.push(scale(p, alt));
  }
  return pts;
}
