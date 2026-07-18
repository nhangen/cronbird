export type SpawnFn = (argv: string[]) => void;
export declare class ShellDispatcher {
    private command;
    private argsTemplate;
    private log;
    private spawn;
    constructor(command: string[], argsTemplate: string[], log: (msg: string) => void, spawn?: SpawnFn);
    private argv;
    dispatch(jobName: string): void;
}
