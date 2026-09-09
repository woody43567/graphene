import type { SearchResult } from "../types.js";
export declare function handleSearch(repoRoot: string, globalDirPath: string, args: Record<string, unknown>): {
    total: number;
    offset: number;
    has_more: boolean;
    results: SearchResult[];
};
