export type StatusSubcommand = "status" | "list" | "next-runs";
export declare const STATUS_SUBCOMMANDS: ReadonlySet<string>;
export interface StatusCliDeps {
    now: () => Date;
    out: (s: string) => void;
    err: (s: string) => void;
    env: Record<string, string | undefined>;
}
export declare function runStatusCommand(sub: StatusSubcommand, args: string[], deps: StatusCliDeps): number;
