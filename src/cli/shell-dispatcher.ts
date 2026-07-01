export type SpawnFn = (argv: string[]) => void;

const defaultSpawn: SpawnFn = (argv) => {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  proc.unref();
};

export class ShellDispatcher {
  constructor(
    private command: string[],
    private argsTemplate: string[],
    private log: (msg: string) => void,
    private spawn: SpawnFn = defaultSpawn,
  ) {}

  private argv(jobName: string): string[] {
    return [...this.command, ...this.argsTemplate.map((a) => (a === "{job}" ? jobName : a))];
  }

  dispatch(jobName: string): void {
    try {
      this.spawn(this.argv(jobName));
      this.log(`dispatched ${jobName}`);
    } catch (err) {
      this.log(`dispatch failed for ${jobName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
