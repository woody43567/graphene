import { listNodes, readNode, listFacts, factsDir } from "../store.js";
const MAX_RESULTS = 20;
const SNIPPET_LIMIT = 200;
function scoreMatch(text, words) {
    const lower = text.toLowerCase();
    return words.filter((w) => lower.includes(w.toLowerCase())).length;
}
function truncate(text) {
    if (text.length <= SNIPPET_LIMIT)
        return text;
    return text.slice(0, SNIPPET_LIMIT) + "...";
}
export function handleSearch(repoRoot, globalDirPath, args) {
    const query = args.query;
    if (!query)
        throw new Error("query is required");
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length === 0)
        throw new Error("query is required");
    const nodes = listNodes(repoRoot)
        .map((name) => readNode(repoRoot, name))
        .filter((n) => n !== null);
    const results = [];
    for (const node of nodes) {
        const score = scoreMatch(`${node.name} ${node.summary ?? ""}`, words);
        if (score > 0) {
            results.push({
                type: "node",
                node_name: node.name,
                snippet: truncate(node.summary ?? node.name),
                score,
            });
        }
    }
    for (const node of nodes) {
        for (const obs of node.observations) {
            const score = scoreMatch(obs.content, words);
            if (score > 0) {
                results.push({ type: "observation", node_name: node.name, snippet: truncate(obs.content), score });
            }
        }
    }
    for (const fact of listFacts(factsDir(repoRoot))) {
        const score = scoreMatch(`${fact.category} ${fact.subject} ${fact.content}`, words);
        if (score > 0) {
            results.push({
                type: "project_fact",
                node_name: `${fact.category}/${fact.subject}`,
                snippet: truncate(fact.content),
                score,
            });
        }
    }
    for (const fact of listFacts(globalDirPath)) {
        const score = scoreMatch(`${fact.category} ${fact.subject} ${fact.content}`, words);
        if (score > 0) {
            results.push({
                type: "global_fact",
                node_name: `${fact.category}/${fact.subject}`,
                snippet: truncate(fact.content),
                score,
            });
        }
    }
    for (const node of nodes) {
        for (const edge of node.edges) {
            if (edge.reason === null)
                continue;
            const score = scoreMatch(edge.reason, words);
            if (score > 0) {
                results.push({
                    type: "edge",
                    node_name: `${node.name} -> ${edge.to}`,
                    snippet: truncate(`[${edge.type}] ${edge.reason}`),
                    score,
                });
            }
        }
    }
    results.sort((a, b) => b.score - a.score);
    const total = results.length;
    const paged = results.slice(offset, offset + MAX_RESULTS);
    const has_more = offset + MAX_RESULTS < total;
    return { total, offset, has_more, results: paged };
}
//# sourceMappingURL=search.js.map