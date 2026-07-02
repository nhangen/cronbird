/**
 * Usage text + help-token detection for the cronbird CLI. Kept in its own
 * module (not main.ts) so it's importable/testable — main.ts runs `main()` at
 * load and can't be imported without side effects.
 */
export const HELP_TOKENS: ReadonlySet<string> = new Set(["help", "--help", "-h"]);

export function usageText(): string {
  return [
    "cronbird — host-aware cron scheduler daemon",
    "",
    "Usage:",
    "  cronbird <config.json>                         start the scheduler daemon",
    "  cronbird list <config.json> [--json]           list every job (schedule, scope, runnable-here)",
    "  cronbird next-runs <config.json> [--json] [--within <dur>]",
    "                                                 runnable jobs sorted by next fire time",
    "  cronbird status <config.json> [--json]         per-job health + daemon heartbeat age",
    "  cronbird help                                  show this help",
    "",
    "  <dur> is Nd / Nh / Nm / Ns (e.g. 30m, 2h, 1d).",
    "",
  ].join("\n");
}
