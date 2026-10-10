# cronbird

A host-aware cron scheduler daemon. Matches 5-field cron schedules, decides which jobs are due on this host, replays the newest missed slot after an outage, and guarantees at-most-once dispatch via a persisted double-fire guard.

- `cronbird/core` — the engine (zero deps beyond croner).
- `cronbird/cli` — a generic file-config runner: point it at a registry JSON + a dispatch command and run it under launchd/systemd, no code required.

---

## Engine overview

`runForever` is the main loop. On each tick it:

1. Loads the job registry, enabled list, and topology from the configured providers.
2. Selects jobs that are due on this host (`selectRunnable`), respecting host-match rules and single/each scope.
3. For each due job, checks the double-fire guard (persisted `dispatched_minute`) before dispatching.
4. On startup, replays any missed slot from the lookback window (`catchUpFires`).
5. Sleeps until the next due time (`nextWake`), waking early on SIGTERM/SIGINT.

---

## `cronbird.config.json` field reference

All fields are required unless marked optional.

| Field | Type | Description |
|---|---|---|
| `hostname` | `string` | Host identifier. Use `"auto"` to resolve to the short OS hostname (`os.hostname().split(".")[0]`). **Ownership note**: Renaming a host changes `os.hostname()`, silently de-owning single-scope jobs keyed to the old ID in topology `owners`. Pin `hostname` explicitly on owner hosts. |
| `registryPath` | `string` | Path to the job registry JSON file. Required. |
| `enabledPath` | `string \| null` | Path to a JSON array of enabled job names — the gate for `each`-scope jobs on this host. `null` yields an **empty** enabled set, so **no `each`-scope job runs** (it does *not* mean "all enabled"). `single`-scope jobs ignore this; they are gated by topology `owners`. |
| `topologyPath` | `string \| null` | Path to a topology JSON file (`{ hosts, owners }`). `null` = no topology (single-host mode). |
| `heartbeatPath` | `string` | Path for the local heartbeat file (double-fire guard + catch-up state). |
| `syncedHeartbeatDir` | `string \| null` | Directory for a synced per-host heartbeat copy (E2 offline-owner alert). `null` = no synced copy. |
| `lockPath` | `string \| null` (optional) | Path for the single-instance flock file. Defaults to `<heartbeatPath>.lock`. Set to `null` to disable flock. |
| `historyPath` | `string \| null` (optional) | Path to append-only run-history JSONL file. `null` or omitted = disable run history. |
| `maxHistoryRecords` | `number` (optional) | Maximum records retained during history rotation. Default: `1000`. |
| `historyRetentionMs` | `number` (optional) | Maximum age of retained history records (ms). Default: `604800000` (7 days). |
| `dispatchCommand` | `string[]` | Command to run for dispatch (no shell). Example: `["./scripts/run-job.sh"]`. |
| `dispatchArgsTemplate` | `string[]` | Argv template appended after `dispatchCommand`. Use `"{job}"` as a placeholder for the job name. Example: `["{job}", "--scheduled"]`. `["{job}"]` is the minimal valid template — the array must be non-empty and must include `{job}`. |
| `maxSleepMs` | `number` | Maximum sleep between ticks (ms). Default suggestion: `60000` (1 min). |
| `catchupLookbackFloorMs` | `number` | Minimum lookback window for missed-slot catch-up (ms). Default suggestion: `3600000` (1 hour). |
| `catchupLookbackCapMs` | `number` | Maximum lookback window (ms). Default suggestion: `21600000` (6 hours). |

Paths may use `~` — they are expanded against `$HOME`.

---

## Single-host quickstart

### 1. Write a job registry (`registry.json`)

```json
{
  "jobs": [
    {
      "name": "morning-scan",
      "cronSchedule": "0 6 * * *",
      "isActive": true,
      "hosts": ["*"],
      "scope": "each",
      "metadata": {}
    }
  ]
}
```

Fields:
- `name` — unique job identifier.
- `cronSchedule` — 5-field cron expression.
- `isActive` — set `false` to disable without removing.
- `hosts` — declarative host-intent metadata (default `["*"]`). **Not a runtime gate** — cronbird's scheduler never reads it; where a job runs is decided by `scope` (+ the enabled set / topology owners, below). Kept for the generating layer's own bookkeeping.
- `scope` — `"single"` (fires only on its topology `owners` host) or `"each"` (fires on every host that has it in that host's enabled set, via `enabledPath`).
- `metadata` — arbitrary data passed through to the dispatch env.

### 2. Enable the job (`enabled.json`)

An `each`-scope job runs on a host only if it's listed in that host's enabled set. Without this, the daemon runs but dispatches nothing.

```json
["morning-scan"]
```

> Single-host note: there is no "all jobs enabled" shortcut. `enabledPath: null` gives an **empty** enabled set, so no `each`-scope job runs — you must list them here. (For a `scope: "single"` job instead, skip `enabled.json` and give it an owner via a topology file — see [Multi-host / topology mode](#multi-host--topology-mode).)

### 3. Write a config (`cronbird.config.json`)

```json
{
  "hostname": "auto",
  "registryPath": "~/.cronbird/registry.json",
  "enabledPath": "~/.cronbird/enabled.json",
  "topologyPath": null,
  "heartbeatPath": "~/.cronbird/heartbeat.json",
  "syncedHeartbeatDir": null,
  "historyPath": "~/.cronbird/history.jsonl",
  "dispatchCommand": ["./scripts/run-job.sh"],
  "dispatchArgsTemplate": ["{job}", "--scheduled"],
  "maxSleepMs": 60000,
  "catchupLookbackFloorMs": 3600000,
  "catchupLookbackCapMs": 21600000
}
```

### 4. Run

```bash
bun run src/cli/main.ts cronbird.config.json
# or: CRONBIRD_CONFIG=cronbird.config.json bun run src/cli/main.ts
```

---

## Multi-host / topology mode

When you have multiple hosts and want only one to dispatch a `scope: "single"` job, use a topology file.

### `topology.json`

```json
{
  "hosts": ["host-a", "host-b"],
  "owners": {
    "morning-scan": "host-a",
    "nightly-report": "host-b"
  }
}
```

Set `topologyPath` in your config to point at this file.

> [!WARNING]
> **Pin `hostname` explicitly on owner hosts (avoid `"auto"`).**
> Setting `"hostname": "auto"` resolves to `os.hostname().split(".")[0]`. If an owner machine is renamed, DHCP alters its hostname, or a cloud instance boots with a new default name, `os.hostname()` changes. Any `scope: "single"` jobs mapped to the old hostname in `owners` will be silently de-owned and run nowhere. Pin `hostname` explicitly on owner hosts to match the exact identifier in `owners` (e.g. `"hostname": "host-a"`).

For `scope: "each"` jobs, `owners` is irrelevant: each host dispatches the job independently **iff the job is in that host's enabled set** (`enabledPath` → a JSON array of job names). The `hosts` field does **not** gate this — enablement is per-host. Note `enabledPath: null` yields an *empty* enabled set, so no `each`-scope job runs until you populate it.

### Synced heartbeat (E2 offline-owner alert)

Set `syncedHeartbeatDir` to a directory shared across hosts (e.g. a synced vault). Each host writes `<syncedHeartbeatDir>/<hostname>.json` atomically. A monitoring script can check all per-host files to detect offline owners.

---

## Status & inspection

Read-only subcommands report what is scheduled, when jobs fire, and their health — reading the same config, registry, and heartbeat the daemon uses. They never dispatch or write.

```bash
cronbird list      <config.json>              # every job: schedule, scope, active, runnable-here
cronbird next-runs <config.json> [--within 2h] # runnable jobs sorted by next fire (optional window)
cronbird status    <config.json>              # per-job health + daemon heartbeat age
cronbird history   <config.json> [options]    # query execution run history (job, since, until, limit)
cronbird simulate  <config.json> --from <T0> --to <T1> # dry-run / fast-forward the schedule
```

All five accept `--json` for machine-readable output. `cronbird help` (or `--help` / `-h`) prints this list; running `cronbird <config.json>` with no subcommand starts the daemon as before.

`status` classifies each job's `HEALTH`:

| Health | Meaning |
|---|---|
| `inactive` | `isActive: false` — the daemon never fires it. |
| `not-runnable` | Active, but not gated to this host (scope / enabled / owner). |
| `invalid-schedule` | Runnable, but the `cronSchedule` cannot be parsed — the daemon can never fire it. Dominates fire history. |
| `never-fired` | Runnable, valid schedule, but the heartbeat records no prior fire. |
| `ok` | Runnable, fired, no scheduled slot missed. |
| `stale` | Runnable and fired, but a slot scheduled after the last fire is overdue past the grace window (`2 × maxSleepMs`) — the daemon likely missed it (outage / clock skew). |

Example:

```
$ cronbird status ./cronbird.config.json
host=ml-1  daemon: heartbeat <1m ago

NAME          SCOPE   RUNNABLE  LAST FIRE  NEXT FIRE   HEALTH
disabled-job  each    no        -          -           inactive
hourly-ping   each    yes       1m ago     in 42m      ok
morning-scan  single  yes       -          in 14h 42m  never-fired
```

The projection is built by `computeStatus` in `cronbird/core` (pure, clock-injected) — any consumer can render its own view over the same data. When `historyPath` is configured, `computeStatus` incorporates the most recent run record (`lastRun`) into each job status.

### Run history

`cronbird history <config.json>` queries the structured run log (requires `historyPath` configured):

> **Outcomes stay `running` for now.** The daemon records every dispatch, but the dispatch wrapper that reports exit codes and durations is not wired yet ([#32](https://github.com/nhangen/cronbird/issues/32)). Until it lands, a run shows `running` unless the spawn itself failed. The `success` rows in the example below show what the wrapper will produce.

```bash
cronbird history ./cronbird.config.json
cronbird history ./cronbird.config.json --job morning-scan
cronbird history ./cronbird.config.json --since 24h --limit 50
cronbird history ./cronbird.config.json --since 2026-10-08T00:00:00Z --until 2026-10-09T00:00:00Z
cronbird history ./cronbird.config.json --json
```

Filtering options:
- `--job <name>` — filter records to a specific job name.
- `--since <dur|iso>` — only records on or after timestamp / relative duration (e.g. `30m`, `2h`, `7d`, or ISO 8601).
- `--until <dur|iso>` — only records on or before timestamp / relative duration.
- `--limit <N>` — return at most `N` records (sorted most recent first).
- `--json` — output JSON array of run records (`job`, `scheduledFor`, `startedAt`, `finishedAt`, `exitCode`, `outcome`, `durationMs`).

Example:

```
$ cronbird history ./cronbird.config.json --limit 5
JOB           SCHEDULED                 STARTED  DURATION  OUTCOME  EXIT
morning-scan  2026-10-09T06:00:00.000Z  1m ago   12.4s     success  0
hourly-ping   2026-10-09T06:00:00.000Z  1m ago   0.2s      success  0
hourly-ping   2026-10-09T05:00:00.000Z  1h ago   0.2s      success  0
hourly-ping   2026-10-09T04:00:00.000Z  2h ago   0.2s      success  0
nightly-sync  2026-10-09T02:00:00.000Z  4h ago   45.1s     failure  1
```

### Schedule simulation (dry-run)

`cronbird simulate <config.json> --from <time> --to <time>` fast-forwards the schedule across `[T0, T1]` without wall-clock wait:

- Dispatches nothing and persists no state.
- Wires the real file providers (`enabledPath`, `topologyPath`, `registryPath`), answering "what will this configuration actually do?" and exposing configuration issues (such as `enabledPath: null`) immediately.
- Prints the would-dispatch schedule in order of fire time.
- Warns on stderr about each active job it skips: not runnable on this host, an unparseable cron, or a schedule that never fires.
- Exits 1 with `config error:` when the registry can't be loaded, or when an enabled/topology file is present but unreadable.
- Starts with no heartbeat, so it doesn't show the catch-up fires a daemon restarting at T0 would run.

```bash
cronbird simulate ./cronbird.config.json --from 2026-07-01T00:00:00Z --to 2026-07-02T00:00:00Z
cronbird simulate ./cronbird.config.json --from now --to +24h
cronbird simulate ./cronbird.config.json --from 2026-07-01T00:00:00Z --to 2026-07-01T12:00:00Z --json
```

Example:

```
$ cronbird simulate ./cronbird.config.json --from 2026-07-01T00:00:00Z --to 2026-07-01T03:00:00Z
TIME                      JOB
2026-07-01T00:00:00.000Z  hourly-ping
2026-07-01T01:00:00.000Z  hourly-ping
2026-07-01T02:00:00.000Z  hourly-ping
2026-07-01T03:00:00.000Z  hourly-ping
```

## Deploy

Templates for both macOS launchd and Linux/WSL systemd are in `deploy/`.

### macOS (launchd)

```bash
( cd /path/to/cronbird && bun install )   # install croner dependency
cp deploy/cronbird.plist.template ~/Library/LaunchAgents/com.example.cronbird.plist
# edit: replace __LABEL__, __BUN__, __MAIN__, __WORKDIR__, __CONFIG__
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.cronbird.plist
launchctl kickstart -p gui/$(id -u)/com.example.cronbird
```

Logs: `/tmp/__LABEL__.out.log` and `/tmp/__LABEL__.err.log`.

### Linux / WSL (systemd)

```bash
( cd /path/to/cronbird && bun install )   # install croner dependency
mkdir -p ~/.config/systemd/user
cp deploy/cronbird.service.template ~/.config/systemd/user/cronbird.service
# edit: replace __LABEL__, __BUN__, __MAIN__, __WORKDIR__, __CONFIG__
systemctl --user daemon-reload
systemctl --user enable --now cronbird.service
loginctl enable-linger "$USER"         # keep running when logged out
journalctl --user -u cronbird -f
```

Both templates keep the daemon alive on crash (non-zero exit) but allow a clean SIGTERM shutdown without respawning.
