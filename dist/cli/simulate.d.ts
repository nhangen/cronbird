export interface SimulateCliDeps {
    now: () => Date;
    out: (s: string) => void;
    err: (s: string) => void;
    env: Record<string, string | undefined>;
}
export declare function runSimulateCommand(args: string[], deps: SimulateCliDeps): number;
