import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { stripGrapheneBlock } from "./claude-md.js";
import { handleRead } from "./tools/read.js";
import { handleSearch } from "./tools/search.js";
import { handleUpsertNode, normalizeArgs } from "./tools/upsert-node.js";
import { handleLearn } from "./tools/learn.js";
import { handleLink } from "./tools/link.js";
import { handleUnlink } from "./tools/unlink.js";
import { handleStale } from "./tools/stale.js";
import { handleGlobalRead } from "./tools/global-read.js";
import { handleGlobalWrite } from "./tools/global-write.js";
import { handleRemoveObservation } from "./tools/remove-observation.js";
import { handleDeleteNode } from "./tools/delete-node.js";
import { handleGlobalDelete } from "./tools/global-delete.js";
import { handleProjectRead } from "./tools/project-read.js";
import { handleProjectWrite } from "./tools/project-write.js";
import { handleProjectDelete } from "./tools/project-delete.js";
import { handleBatch } from "./tools/batch.js";
import { handleStatus, boundedKeys } from "./tools/status.js";
import { listFacts } from "./store.js";
import { exportGlobals, importGlobals } from "./globals-sync.js";
import type { IndexEntry, NodeDetail, SearchResult } from "./types.js";
import {
  type RepoScope,
  parseNodeRef,
  resolveNodeRef,
  resolveUpsertRef,
  resolveWriteTarget,
  rewriteRepoRelative,
} from "./scope.js";

export interface ServerContext {
  scopes: RepoScope[];
  globalDir: string;
}

const TOOLS = [
  {
    name: "status",
    description:
      "Get a bounded snapshot: node index, stale nodes, current HEAD, and project/global fact counts and keys " +
      "(never fact or observation bodies). Automatically injected at session start by the hook, but can be " +
      "called manually to refresh. For observation or fact content, call read(name), project_read(), or global_read().",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "read",
    description:
      "Read the context graph. No arguments returns the full index (all node names, types, summaries). With a name argument, returns the full node including outgoing edges, incoming dependents with neighbor summaries, and observations. In multi-repo sessions, index and node results include a repo field, and name accepts repo:name to disambiguate.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Node name to read. Omit for the full index. Accepts repo:name in multi-repo sessions.",
        },
      },
    },
  },
  {
    name: "search",
    description:
      "Search across nodes, observations, project facts, global facts, and edge reasons. Multi-word queries " +
      "match any word and rank by relevance. Returns at most the top 20 results, each with a truncated snippet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        offset: {
          type: "number",
          description:
            "Skip this many results (for pagination). Default 0. Use the 'total' and 'has_more' fields in the response to know if more results exist.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "upsert_node",
    description:
      "Create a new node or merge-update an existing one. Only provided fields are changed on update. Metadata is shallow-merged. In multi-repo sessions, name accepts repo:name to target a specific repo; a bare name updates the existing node if exactly one repo has it, otherwise the repo is inferred from covers/entry_points paths.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Node identifier (slug). Accepts repo:name in multi-repo sessions." },
        type: {
          type: "string",
          description:
            "Node type (e.g. subsystem, module, library). Required on create.",
        },
        summary: { type: "string", description: "One-line purpose statement" },
        entry_points: {
          type: "array",
          items: { type: "string" },
          description: "Key files to start reading",
        },
        covers: {
          type: "array",
          items: { type: "string" },
          description: "File/directory patterns this node covers",
        },
        last_commit: {
          type: "string",
          description: "Commit hash this node was generated from",
        },
        metadata: {
          type: "object",
          description:
            "Freeform structured data (interfaces, invariants, etc). Shallow-merged on update.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "learn",
    description:
      "Append a learned observation to a node. Observations are append-only and never overwrite existing ones.",
    inputSchema: {
      type: "object" as const,
      properties: {
        node_name: {
          type: "string",
          description: "Node to attach the observation to. Accepts repo:name in multi-repo sessions.",
        },
        content: { type: "string", description: "The learned observation" },
        source: {
          type: "string",
          description: "What triggered this learning (optional)",
        },
      },
      required: ["node_name", "content"],
    },
  },
  {
    name: "link",
    description:
      "Create an edge between two nodes. Bidirectional types (related_to, mirrors) automatically create edges in both directions. Idempotent: re-linking updates the reason. Names accept repo:name in multi-repo sessions; from and to must resolve to the same repo (cross-repo edges are not supported).",
    inputSchema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Source node name" },
        to: { type: "string", description: "Target node name" },
        type: {
          type: "string",
          description:
            "Edge type: related_to, depends_on, mirrors, or extends",
        },
        reason: {
          type: "string",
          description: "Why this relationship exists",
        },
      },
      required: ["from", "to", "type"],
    },
  },
  {
    name: "unlink",
    description:
      "Remove an edge between two nodes. Without type, removes all edges between them. Names accept repo:name in multi-repo sessions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Source node name" },
        to: { type: "string", description: "Target node name" },
        type: {
          type: "string",
          description: "Specific edge type to remove (optional)",
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "stale",
    description:
      "Check which nodes have stale context by comparing their covered files against git changes since their last_commit.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "global_read",
    description:
      "Read user-level facts (preferences, expertise, conventions). No arguments returns all facts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Filter by category (preference, expertise, convention)",
        },
        subject: {
          type: "string",
          description: "Filter by subject (go, testing, communication, etc)",
        },
      },
    },
  },
  {
    name: "global_write",
    description:
      "Write a user-level fact. One fact per category+subject pair; writing to an existing pair replaces the content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Fact category" },
        subject: { type: "string", description: "Fact subject" },
        content: { type: "string", description: "Fact content" },
      },
      required: ["category", "subject", "content"],
    },
  },
  {
    name: "global_delete",
    description:
      "Remove a user-level fact by category and subject.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Fact category" },
        subject: { type: "string", description: "Fact subject" },
      },
      required: ["category", "subject"],
    },
  },
  {
    name: "globals_export",
    description:
      "Export all global facts to a portable markdown bundle at path, for moving user-level facts between machines.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path to write the bundle to. A leading ~/ expands to the home directory.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "globals_import",
    description:
      "Import global facts from a portable markdown bundle at path, merging by category+subject. Facts already " +
      "present locally with different content are left untouched and reported as skipped unless overwrite is set.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path to read the bundle from. A leading ~/ expands to the home directory.",
        },
        overwrite: {
          type: "boolean",
          description: "Overwrite local facts that differ from the bundle instead of skipping them (default false).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "project_read",
    description:
      "Read repo-scoped facts (conventions, context, decisions specific to this project). No arguments returns all project facts. In multi-repo sessions, repo is required.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Filter by category" },
        subject: { type: "string", description: "Filter by subject" },
        repo: {
          type: "string",
          description:
            "Repo name. Optional in single-repo sessions (must match if given); required in multi-repo sessions.",
        },
      },
    },
  },
  {
    name: "project_write",
    description:
      "Write a repo-scoped fact. One fact per category+subject pair; writing to an existing pair replaces the content. Use for project-specific conventions, decisions, and context that don't belong on a node. In multi-repo sessions, repo is required.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Fact category" },
        subject: { type: "string", description: "Fact subject" },
        content: { type: "string", description: "Fact content" },
        repo: {
          type: "string",
          description:
            "Repo name. Optional in single-repo sessions (must match if given); required in multi-repo sessions.",
        },
      },
      required: ["category", "subject", "content"],
    },
  },
  {
    name: "project_delete",
    description:
      "Remove a repo-scoped fact by category and subject. In multi-repo sessions, repo is required.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Fact category" },
        subject: { type: "string", description: "Fact subject" },
        repo: {
          type: "string",
          description:
            "Repo name. Optional in single-repo sessions (must match if given); required in multi-repo sessions.",
        },
      },
      required: ["category", "subject"],
    },
  },
  {
    name: "remove_observation",
    description:
      "Remove a specific observation by ID. Use when a learned fact turns out to be wrong or outdated.",
    inputSchema: {
      type: "object" as const,
      properties: {
        node_name: {
          type: "string",
          description: "Node the observation belongs to. Accepts repo:name in multi-repo sessions.",
        },
        id: {
          type: "string",
          description: "Observation ID (from read response)",
        },
      },
      required: ["node_name", "id"],
    },
  },
  {
    name: "delete_node",
    description:
      "Delete a node and all its edges and observations. Use when a subsystem has been removed from the codebase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Node name to delete. Accepts repo:name in multi-repo sessions." },
      },
      required: ["name"],
    },
  },
  {
    name: "batch",
    description:
      "Create or update multiple nodes, edges, and observations in a single transaction. Pass three top-level arrays: nodes, edges, observations. Each node object uses the same fields as upsert_node (name required, plus summary, covers, entry_points, last_commit). Every node should include summary, covers, entry_points, and last_commit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Node identifier (slug)" },
              type: { type: "string", description: "Node type (e.g. subsystem, module)" },
              summary: { type: "string", description: "One-line purpose statement" },
              entry_points: { type: "array", items: { type: "string" }, description: "Key files" },
              covers: { type: "array", items: { type: "string" }, description: "File/directory patterns" },
              last_commit: { type: "string", description: "Commit hash" },
              metadata: { type: "object", description: "Freeform structured data, shallow-merged on update" },
            },
            required: ["name"],
          },
          description: "Array of node objects to create or update",
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "Source node name" },
              to: { type: "string", description: "Target node name" },
              type: { type: "string", description: "Relationship type (e.g. depends_on, extends)" },
              reason: { type: "string", description: "Why this relationship exists" },
            },
            required: ["from", "to", "type"],
          },
          description: "Array of edge objects to create",
        },
        observations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              node_name: { type: "string", description: "Node to attach observation to" },
              content: { type: "string", description: "What was learned" },
            },
            required: ["node_name", "content"],
          },
          description: "Array of observations to record",
        },
      },
    },
  },
];

export function createServer(ctx: ServerContext): Server {
  const server = new Server(
    { name: "graphene", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: [
        "Graph status is automatically injected at session start. You do not need to call `status` manually unless you want to refresh.",
        "You MUST call `read(name)` on relevant nodes before working on any subsystem. Do not start reading files, grepping, or exploring until you have checked the graph.",
        "If the graph is empty, you MUST explore the codebase and populate with `batch()` before doing anything else.",
        "Record immediately, do not defer: after changing code, update affected nodes with `learn()`, summary, entry_points, and `last_commit`. When you discover an architectural boundary, constraint, gotcha, or workaround, record it with `learn()` or `project_write()`. When the user corrects your approach or gives a preference, record it with `project_write()` or `global_write()`. Updating `last_commit` alone is not sufficient.",
        "Recording is triggered by what you learned, not by whether a node already covers the file. If no node covers what you changed or discovered, that is a gap to fill, never a reason to skip: create a node if it is a real subsystem, otherwise `project_write()` the convention. 'No node covers this' must never be your stopping point.",
        "Tool scope: `learn(node, content)` for code knowledge on a node. `project_write(category, subject, content)` for repo-specific conventions and preferences. `global_write(category, subject, content)` for user preferences across repos. If unsure about scope, ask the user.",
        "Graphene replaces auto-memory. Do NOT write to memory files when graphene is installed. All facts, preferences, conventions, and workflow rules go into graphene via `project_write`, `global_write`, or `learn`. Two persistence systems means future sessions must check both places, which defeats the purpose.",
      ].join("\n\n"),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.oninitialized = () => {
    // Migration: earlier versions wrote the rules into the repo's CLAUDE.md.
    // The rules now come from the SessionStart hook, so strip any committed
    // block. No-op once stripped. Only meaningful for a single unambiguous
    // repo root; skipped entirely outside a repo or across multiple scopes.
    if (ctx.scopes.length === 1) stripGrapheneBlock(ctx.scopes[0].root);
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = dispatch(ctx, name, args ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

function requireScopes(ctx: ServerContext): RepoScope[] {
  if (ctx.scopes.length === 0) {
    throw new Error("Not in a git repository. Repo-specific tools are unavailable.");
  }
  return ctx.scopes;
}

// A path guaranteed not to exist on disk. listNodes/listFacts treat a
// missing directory as an empty store, so this suppresses a store (globals
// in a per-scope call, or the repo side of the globals-only call) with zero
// filesystem IO -- no temp directory is ever created or needs cleanup.
function emptyStoreDir(): string {
  return join(tmpdir(), `graphene-empty-${randomBytes(8).toString("hex")}`);
}

function scopeNames(scopes: RepoScope[]): string {
  return scopes.map((s) => s.name).join(", ");
}

// project_read/project_write/project_delete take an optional `repo` arg in
// every session shape: in a single-repo session it must match the session's
// repo if given at all; in a multi-repo session it is required and selects
// the scope.
function resolveProjectRoot(tool: string, scopes: RepoScope[], args: Record<string, unknown>): string {
  const repo = args.repo as string | undefined;

  if (scopes.length === 1) {
    if (repo !== undefined && repo !== scopes[0].name) {
      throw new Error(`${tool}: repo "${repo}" does not match this session's repo "${scopes[0].name}".`);
    }
    return scopes[0].root;
  }

  if (repo === undefined) {
    throw new Error(
      `${tool} requires a "repo" argument in a multi-repo session. In scope: ${scopeNames(scopes)}.`
    );
  }
  const scope = scopes.find((s) => s.name === repo);
  if (!scope) {
    throw new Error(`Unknown repo "${repo}" for ${tool}. In scope: ${scopeNames(scopes)}.`);
  }
  return scope.root;
}

// link/unlink (and batch edges) require both endpoints to resolve to the
// same repo: edges are not allowed to cross scopes, since scope names are
// session-relative and must never be written into a committed node file.
function checkSameScope(
  fromRef: string,
  toRef: string,
  scopes: RepoScope[]
): { scope: RepoScope; from: string; to: string } {
  const fromR = resolveNodeRef(fromRef, scopes);
  const toR = resolveNodeRef(toRef, scopes);
  if (fromR.scope.root !== toR.scope.root) {
    throw new Error(
      `Cross-repo edges are not supported: "${fromRef}" is in ${fromR.scope.name}, ` +
        `"${toRef}" is in ${toR.scope.name}.`
    );
  }
  return { scope: fromR.scope, from: fromR.name, to: toR.name };
}

// globals_export/globals_import take a plain `path` (plus `overwrite` for
// import) rather than the `{repo}`-shaped args above, so their arg handling
// is inlined here rather than split into src/tools/ handlers.
function dispatchGlobalsExport(globalDir: string, args: Record<string, unknown>): { path: string; count: number } {
  const path = args.path as string | undefined;
  if (!path) throw new Error("path is required");
  return exportGlobals(globalDir, path);
}

function dispatchGlobalsImport(
  globalDir: string,
  args: Record<string, unknown>
): { imported: number; unchanged: number; skipped: string[]; overwritten: number } {
  const path = args.path as string | undefined;
  if (!path) throw new Error("path is required");
  const overwrite = args.overwrite === true;
  return importGlobals(globalDir, path, overwrite);
}

export function dispatch(ctx: ServerContext, tool: string, args: Record<string, unknown>): unknown {
  switch (tool) {
    case "global_read":
      return handleGlobalRead(ctx.globalDir, args);
    case "global_write":
      return handleGlobalWrite(ctx.globalDir, args);
    case "global_delete":
      return handleGlobalDelete(ctx.globalDir, args);
    // globals_export/globals_import work on the whole global fact store, so
    // (like global_*) they dispatch here, before requireScopes -- they must
    // work outside any repo and identically in single- and multi-repo
    // sessions, since global facts are not scoped to a repo at all.
    case "globals_export":
      return dispatchGlobalsExport(ctx.globalDir, args);
    case "globals_import":
      return dispatchGlobalsImport(ctx.globalDir, args);
    // project_* take the same optional `repo` arg regardless of how many
    // scopes are in play, so they are resolved uniformly here rather than
    // split across the single/multi dispatch below.
    case "project_read":
      return handleProjectRead(resolveProjectRoot("project_read", requireScopes(ctx), args), args);
    case "project_write":
      return handleProjectWrite(resolveProjectRoot("project_write", requireScopes(ctx), args), args);
    case "project_delete":
      return handleProjectDelete(resolveProjectRoot("project_delete", requireScopes(ctx), args), args);
    default: {
      const scopes = requireScopes(ctx);
      if (scopes.length === 1) return dispatchSingle(scopes[0].root, ctx.globalDir, tool, args);
      return dispatchMulti(scopes, ctx.globalDir, tool, args);
    }
  }
}

// Byte-compat path: identical to tool dispatch before multi-repo support,
// so a single-repo session behaves exactly as it did before this feature.
function dispatchSingle(
  repoRoot: string,
  globalDir: string,
  tool: string,
  args: Record<string, unknown>
): unknown {
  switch (tool) {
    case "status":
      return handleStatus(repoRoot, globalDir, args);
    case "read":
      return handleRead(repoRoot, args);
    case "search":
      return handleSearch(repoRoot, globalDir, args);
    case "upsert_node":
      return handleUpsertNode(repoRoot, args);
    case "learn":
      return handleLearn(repoRoot, args);
    case "link":
      return handleLink(repoRoot, args);
    case "unlink":
      return handleUnlink(repoRoot, args);
    case "stale":
      return handleStale(repoRoot, args);
    case "remove_observation":
      return handleRemoveObservation(repoRoot, args);
    case "delete_node":
      return handleDeleteNode(repoRoot, args);
    case "batch":
      return handleBatch(repoRoot, args);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

function dispatchMulti(
  scopes: RepoScope[],
  globalDir: string,
  tool: string,
  args: Record<string, unknown>
): unknown {
  switch (tool) {
    case "status":
      return routeStatus(scopes, globalDir);
    case "read":
      return routeRead(scopes, args);
    case "search":
      return routeSearch(scopes, globalDir, args);
    case "upsert_node":
      return routeUpsertNode(scopes, args);
    case "learn":
      return routeLearn(scopes, args);
    case "link":
      return routeLink(scopes, args);
    case "unlink":
      return routeUnlink(scopes, args);
    case "stale":
      return routeStale(scopes);
    case "remove_observation":
      return routeRemoveObservation(scopes, args);
    case "delete_node":
      return routeDeleteNode(scopes, args);
    case "batch":
      return routeBatch(scopes, args);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

function routeStatus(scopes: RepoScope[], globalDir: string): unknown {
  const emptyDir = emptyStoreDir();
  // One broken scope (e.g. a freshly `git init`ed sibling with no commits,
  // where getHead throws) must degrade to an error entry for that repo, not
  // take down status for the whole session.
  const repos = scopes.map((scope) => {
    try {
      const { global_facts, ...rest } = handleStatus(scope.root, emptyDir, {});
      return { repo: scope.name, ...rest };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { repo: scope.name, error: message };
    }
  });
  // Computed once directly, with the same capping handleStatus itself uses,
  // rather than once per scope: otherwise global facts would be counted
  // once per repo instead of once per session.
  const globalFacts = listFacts(globalDir);
  return {
    repos,
    global_facts: {
      count: globalFacts.length,
      keys: boundedKeys(globalFacts.map((f) => `${f.category}/${f.subject}`)),
    },
  };
}

function routeStale(scopes: RepoScope[]): unknown {
  const repos = scopes.map((scope) => {
    try {
      return { repo: scope.name, ...handleStale(scope.root, {}) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { repo: scope.name, error: message };
    }
  });
  return { repos };
}

function routeRead(scopes: RepoScope[], args: Record<string, unknown>): unknown {
  const name = args.name as string | undefined;

  if (!name) {
    const nodes = scopes.flatMap((scope) => {
      const result = handleRead(scope.root, {}) as { nodes: IndexEntry[] };
      return result.nodes.map((n) => ({ repo: scope.name, ...n }));
    });
    nodes.sort((a, b) => {
      if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return { nodes };
  }

  const resolved = resolveNodeRef(name, scopes);
  const result = handleRead(resolved.scope.root, { ...args, name: resolved.name }) as NodeDetail;
  return { repo: resolved.scope.name, ...result };
}

function routeSearch(scopes: RepoScope[], globalDir: string, args: Record<string, unknown>): unknown {
  const emptyDir = emptyStoreDir();
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const merged: Array<SearchResult & { repo?: string }> = [];

  // Collect all results without pagination from each scope
  for (const scope of scopes) {
    const res = handleSearch(scope.root, emptyDir, { ...args, offset: 0 });
    for (const r of res.results) merged.push({ ...r, repo: scope.name });
  }

  const globalRes = handleSearch(emptyDir, globalDir, { ...args, offset: 0 });
  for (const r of globalRes.results) merged.push({ ...r });

  merged.sort((a, b) => b.score - a.score);

  const total = merged.length;
  const paged = merged.slice(offset, offset + 20);
  const has_more = offset + 20 < total;

  return { total, offset, has_more, results: paged };
}

function routeLearn(scopes: RepoScope[], args: Record<string, unknown>): unknown {
  const nodeName = args.node_name as string;
  if (!nodeName) throw new Error("node_name is required");
  const { scope, name } = resolveNodeRef(nodeName, scopes);
  return handleLearn(scope.root, { ...args, node_name: name });
}

function routeRemoveObservation(scopes: RepoScope[], args: Record<string, unknown>): unknown {
  const nodeName = args.node_name as string;
  if (!nodeName) throw new Error("node_name is required");
  const { scope, name } = resolveNodeRef(nodeName, scopes);
  return handleRemoveObservation(scope.root, { ...args, node_name: name });
}

function routeDeleteNode(scopes: RepoScope[], args: Record<string, unknown>): unknown {
  const name = args.name as string;
  if (!name) throw new Error("name is required");
  const resolved = resolveNodeRef(name, scopes);
  return handleDeleteNode(resolved.scope.root, { ...args, name: resolved.name });
}

function routeLink(scopes: RepoScope[], args: Record<string, unknown>): unknown {
  const from = args.from as string;
  const to = args.to as string;
  const type = args.type as string;
  if (!from || !to || !type) throw new Error("from, to, and type are required");
  const resolved = checkSameScope(from, to, scopes);
  return handleLink(resolved.scope.root, { ...args, from: resolved.from, to: resolved.to });
}

function routeUnlink(scopes: RepoScope[], args: Record<string, unknown>): unknown {
  const from = args.from as string;
  const to = args.to as string;
  if (!from || !to) throw new Error("from and to are required");
  const resolved = checkSameScope(from, to, scopes);
  return handleUnlink(resolved.scope.root, { ...args, from: resolved.from, to: resolved.to });
}

function routeUpsertNode(scopes: RepoScope[], args: Record<string, unknown>): unknown {
  const normalized = normalizeArgs(args);
  const rawName = normalized.name as string;
  if (!rawName) throw new Error("name is required");

  const routed = resolveUpsertRef(rawName, scopes);
  if ("scope" in routed) {
    return handleUpsertNode(routed.scope.root, { ...normalized, name: routed.name });
  }

  const cwd = process.cwd();
  const covers = Array.isArray(normalized.covers) ? (normalized.covers as string[]) : [];
  const entryPoints = Array.isArray(normalized.entry_points) ? (normalized.entry_points as string[]) : [];
  const scope = resolveWriteTarget(scopes, routed.name, cwd, [...covers, ...entryPoints]);

  const rewritten: Record<string, unknown> = { ...normalized, name: routed.name };
  if (covers.length > 0) rewritten.covers = rewriteRepoRelative(scope, cwd, covers);
  if (entryPoints.length > 0) rewritten.entry_points = rewriteRepoRelative(scope, cwd, entryPoints);

  return handleUpsertNode(scope.root, rewritten);
}

const BATCH_KEYS = new Set(["nodes", "edges", "observations"]);

interface BatchBucket {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
}

// Resolves every node/edge/observation in the batch to a scope up front
// (nothing is written until every item resolves cleanly), then runs the
// existing per-repo handleBatch once per scope. Node creates placed earlier
// in this same batch are visible to later edges/observations that reference
// them by bare name, even though nothing has hit disk yet.
function routeBatch(scopes: RepoScope[], args: Record<string, unknown>): unknown {
  const unknownKeys = Object.keys(args).filter((k) => !BATCH_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Unknown keys: ${unknownKeys.join(", ")}. batch accepts three top-level arrays: nodes, edges, observations.`
    );
  }

  const params = args as {
    nodes?: Array<Record<string, unknown>>;
    edges?: Array<Record<string, unknown>>;
    observations?: Array<Record<string, unknown>>;
  };
  if (!params.nodes?.length && !params.edges?.length && !params.observations?.length) {
    throw new Error("batch requires at least one non-empty array: nodes, edges, or observations.");
  }

  const cwd = process.cwd();
  const placed = new Map<string, RepoScope>();
  const byScope = new Map<RepoScope, BatchBucket>();

  function bucket(scope: RepoScope): BatchBucket {
    let b = byScope.get(scope);
    if (!b) {
      b = { nodes: [], edges: [], observations: [] };
      byScope.set(scope, b);
    }
    return b;
  }

  function resolveItemRef(ref: string): { scope: RepoScope; name: string } {
    const parsed = parseNodeRef(ref, scopes);
    if ("scope" in parsed) return parsed;
    const placedScope = placed.get(parsed.name);
    if (placedScope) return { scope: placedScope, name: parsed.name };
    return resolveNodeRef(ref, scopes);
  }

  for (const rawNode of params.nodes ?? []) {
    const node = normalizeArgs(rawNode);
    const rawName = node.name as string;
    if (!rawName) throw new Error("name is required");

    // A bare name already placed earlier in this same batch (e.g. two node
    // entries folding onto the same node, as handleBatch's own in-memory
    // working set does within one repo) must land in that same scope rather
    // than being independently re-resolved -- resolveUpsertRef alone only
    // ever sees disk, so it cannot know about a same-batch, not-yet-written
    // placement.
    const parsed = parseNodeRef(rawName, scopes);
    let scope: RepoScope;
    if ("scope" in parsed) {
      scope = parsed.scope;
    } else if (placed.has(parsed.name)) {
      scope = placed.get(parsed.name)!;
    } else {
      const routed = resolveUpsertRef(rawName, scopes);
      if ("scope" in routed) {
        scope = routed.scope;
      } else {
        const covers = Array.isArray(node.covers) ? (node.covers as string[]) : [];
        const entryPoints = Array.isArray(node.entry_points) ? (node.entry_points as string[]) : [];
        scope = resolveWriteTarget(scopes, routed.name, cwd, [...covers, ...entryPoints]);
        if (covers.length > 0) node.covers = rewriteRepoRelative(scope, cwd, covers);
        if (entryPoints.length > 0) node.entry_points = rewriteRepoRelative(scope, cwd, entryPoints);
      }
    }

    placed.set(parsed.name, scope);
    bucket(scope).nodes.push({ ...node, name: parsed.name });
  }

  for (const edge of params.edges ?? []) {
    const from = edge.from as string;
    const to = edge.to as string;
    if (!from || !to) throw new Error("from, to, and type are required");

    const fromR = resolveItemRef(from);
    const toR = resolveItemRef(to);
    if (fromR.scope.root !== toR.scope.root) {
      throw new Error(
        `Cross-repo edges are not supported: "${from}" is in ${fromR.scope.name}, ` +
          `"${to}" is in ${toR.scope.name}.`
      );
    }
    bucket(fromR.scope).edges.push({ ...edge, from: fromR.name, to: toR.name });
  }

  for (const obs of params.observations ?? []) {
    const nodeName = obs.node_name as string;
    if (!nodeName) throw new Error("node_name is required");

    const r = resolveItemRef(nodeName);
    bucket(r.scope).observations.push({ ...obs, node_name: r.name });
  }

  const combined = { nodes_created: 0, nodes_updated: 0, edges_created: 0, observations_added: 0 };
  for (const [scope, items] of byScope) {
    const result = handleBatch(scope.root, {
      ...(items.nodes.length > 0 ? { nodes: items.nodes } : {}),
      ...(items.edges.length > 0 ? { edges: items.edges } : {}),
      ...(items.observations.length > 0 ? { observations: items.observations } : {}),
    });
    combined.nodes_created += result.nodes_created;
    combined.nodes_updated += result.nodes_updated;
    combined.edges_created += result.edges_created;
    combined.observations_added += result.observations_added;
  }
  return combined;
}
