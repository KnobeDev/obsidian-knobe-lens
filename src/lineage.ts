/**
 * lineage.ts — build an adaptation-lineage graph from scanned objects, linking
 * each object to its declared parents[] by payload hash. Pure.
 *
 * Parents that are referenced but not present in the vault become "external"
 * placeholder nodes so the gap is visible rather than silently dropped.
 */

export interface LineageInput {
  hash: string | null;
  title: string;
  state: string;
  contentType: string;
  parents: string[]; // parent payload hashes
}

export interface LineageNode {
  hash: string;
  title: string;
  state: string;
  contentType: string;
  present: boolean;
}

export interface LineageEdge {
  from: string; // parent hash
  to: string; // child hash
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export function buildLineage(items: LineageInput[]): LineageGraph {
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];

  for (const it of items) {
    if (it.hash) {
      nodes.set(it.hash, {
        hash: it.hash,
        title: it.title,
        state: it.state,
        contentType: it.contentType,
        present: true,
      });
    }
  }

  for (const it of items) {
    if (!it.hash) continue;
    for (const parent of it.parents) {
      if (!nodes.has(parent)) {
        nodes.set(parent, {
          hash: parent,
          title: `External source ${parent.slice(0, 8)}…`,
          state: "external",
          contentType: "—",
          present: false,
        });
      }
      edges.push({ from: parent, to: it.hash });
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/** Objects with no relationships at all (no parents, never a parent). */
export function isolatedHashes(graph: LineageGraph): Set<string> {
  const connected = new Set<string>();
  for (const e of graph.edges) { connected.add(e.from); connected.add(e.to); }
  return new Set(graph.nodes.filter((n) => !connected.has(n.hash)).map((n) => n.hash));
}
