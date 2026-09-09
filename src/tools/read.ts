import { listNodes, readNode } from "../store.js";
import type { IndexEntry, NodeDetail, EdgeWithNeighbor, ObservationSummary } from "../types.js";
import type { StoredObservation } from "../store.js";

const OBS_PAGE_SIZE = 5;
const OBS_SNIPPET_LIMIT = 300;

function truncateObs(obs: StoredObservation): ObservationSummary {
  const truncated = obs.content.length > OBS_SNIPPET_LIMIT;
  return {
    id: obs.id,
    snippet: truncated ? obs.content.slice(0, OBS_SNIPPET_LIMIT) + "..." : obs.content,
    truncated,
    source: obs.source,
  };
}

export function handleRead(
  repoRoot: string,
  args: Record<string, unknown>
): { nodes: IndexEntry[] } | NodeDetail {
  const name = args.name as string | undefined;

  if (!name) {
    const nodes: IndexEntry[] = listNodes(repoRoot).map((n) => {
      const node = readNode(repoRoot, n)!;
      return { name: node.name, type: node.type, summary: node.summary };
    });
    return { nodes };
  }

  const node = readNode(repoRoot, name);
  if (!node) throw new Error(`Node not found: ${name}`);

  const edges: EdgeWithNeighbor[] = node.edges.map((e) => {
    const neighbor = readNode(repoRoot, e.to);
    return { node: e.to, type: e.type, reason: e.reason, summary: neighbor?.summary ?? null };
  });

  // No reverse index exists on disk: finding dependents means scanning every
  // other node's own outgoing edges for one pointing back at `name`.
  const dependents: EdgeWithNeighbor[] = [];
  for (const otherName of listNodes(repoRoot)) {
    if (otherName === name) continue;
    const other = readNode(repoRoot, otherName);
    if (!other) continue;
    for (const e of other.edges) {
      if (e.to === name) {
        dependents.push({ node: otherName, type: e.type, reason: e.reason, summary: other.summary });
      }
    }
  }

  // Observation pagination and truncation
  const full = args.full === true;
  const obsOffset = Math.max(0, Math.floor(Number(args.obs_offset) || 0));
  const obsLimit = Math.max(1, Math.floor(Number(args.obs_limit) || OBS_PAGE_SIZE));

  const totalObs = node.observations.length;
  const paged = node.observations.slice(obsOffset, obsOffset + obsLimit);
  const has_more = obsOffset + obsLimit < totalObs;

  const observations = full
    ? paged
    : paged.map(truncateObs);

  return {
    name: node.name,
    type: node.type,
    summary: node.summary,
    entry_points: node.entry_points,
    covers: node.covers,
    last_commit: node.last_commit,
    metadata: node.metadata,
    observations,
    total_observations: totalObs,
    has_more_observations: has_more,
    edges,
    dependents,
  };
}
