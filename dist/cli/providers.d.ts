import type { Job, Topology } from "../core/index";
export declare function parseJobsJson(text: string): {
    jobs: Job[];
    warnings: string[];
};
export declare function parseEnabledJson(text: string): Set<string>;
export declare function parseTopologyJson(text: string): Topology | null;
export declare function fileJobProvider(path: string): () => {
    jobs: Job[];
    warnings: string[];
};
export declare function fileEnabledProvider(path: string | null): () => Set<string>;
export declare function fileTopologyProvider(path: string | null): () => Topology | null;
