# perch

A host-aware cron scheduler daemon. Matches 5-field cron schedules, decides which jobs are due on this host, replays the newest missed slot after an outage, and guarantees at-most-once dispatch via a persisted double-fire guard.

- `perch/core` — the engine (zero deps beyond croner).
- `perch/cli` — a generic file-config runner: point it at a registry JSON + a dispatch command and run it under launchd/systemd, no code required.

Status: under construction (extracted from claude-ceo's ceo-schedulerd).
