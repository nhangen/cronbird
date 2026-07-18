export declare class RunQueue {
    private entries;
    private names;
    private seq;
    enqueue(name: string, priority: number): boolean;
    private ordered;
    dequeue(): string | null;
    remove(name: string): boolean;
    has(name: string): boolean;
    size(): number;
    snapshot(): {
        name: string;
        priority: number;
    }[];
}
