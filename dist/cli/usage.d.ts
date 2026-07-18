/**
 * Usage text + help-token detection for the cronbird CLI. Kept in its own
 * module (not main.ts) so it's importable/testable — main.ts runs `main()` at
 * load and can't be imported without side effects.
 */
export declare const HELP_TOKENS: ReadonlySet<string>;
export declare function usageText(): string;
