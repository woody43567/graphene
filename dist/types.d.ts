import type { StoredObservation } from "./store.js";
export interface EdgeWithNeighbor {
    node: string;
    type: string;
    reason: string | null;
    summary: string | null;
}
export interface ObservationSummary {
    id: string;
    snippet: string;
    truncated: boolean;
    source: string | null;
}
export interface NodeDetail {
    name: string;
    type: string;
    summary: string | null;
    entry_points: string[];
    covers: string[];
    last_commit: string | null;
    metadata: Record<string, unknown>;
    observations: (StoredObservation | ObservationSummary)[];
    total_observations: number;
    has_more_observations: boolean;
    edges: EdgeWithNeighbor[];
    dependents: EdgeWithNeighbor[];
}
export interface IndexEntry {
    name: string;
    type: string;
    summary: string | null;
}
export interface SearchResult {
    type: "node" | "observation" | "project_fact" | "global_fact" | "edge";
    node_name: string;
    snippet: string;
    score: number;
}
export interface StaleNode {
    name: string;
    reason: "untracked" | "changed";
    changed_files: string[];
}
export declare const BIDIRECTIONAL_EDGE_TYPES: Set<string>;
