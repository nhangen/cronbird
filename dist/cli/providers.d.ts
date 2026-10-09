import type { Job, Topology } from "../core/index";
export declare function parseJobsJson(text: string): {
    jobs: Job[];
    value: Job[];
    warnings: string[];
    ok: boolean;
};
export declare function parseEnabledJson(text: string | null, path?: string): {
    value: Set<string>;
    warnings: string[];
};
export declare function parseTopologyJson(text: string | null, path?: string): {
    value: Topology | null;
    warnings: string[];
};
export declare function fileJobProvider(path: string): () => {
    jobs: Job[];
    value: Job[];
    warnings: string[];
    ok: boolean;
};
export declare function fileEnabledProvider(path: string | null): () => {
    value: Set<string>;
    warnings: string[];
};
export declare function fileTopologyProvider(path: string | null): () => {
    value: Topology | null;
    warnings: string[];
};
