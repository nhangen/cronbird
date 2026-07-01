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
| `hostname` | `string` | Host identifier. Use `"auto"` to resolve to the short OS hostname (`os.hostname().split(".")[0]`). |
| `registryPath` | `string` | Path to the job registry JSON file. Required. |
| `enabledPath` | `string \| null` | Path to a JSON array of enabled job names. `null` = all jobs enabled (single-host mode). |
| `topologyPath` | `string \| null` | Path to a topology JSON file (`{ hosts, owners }`). `null` = no topology (single-host mode). |
| `heartbeatPath` | `string` | Path for the local heartbeat file (double-fire guard + catch-up state). |
| `syncedHeartbeatDir` | `string \| null` | Directory for a synced per-host heartbeat copy (E2 offline-owner alert). `null` = no synced copy. |
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
      "scope": "single",
      "metadata": {}
    }
  ]
}
```

Fields:
- `name` — unique job identifier.
- `cronSchedule` — 5-field cron expression.
- `isActive` — set `false` to disable without removing.
- `hosts` — `["*"]` matches any host; or list specific host IDs.
- `scope` — `"single"` (one host dispatches) or `"each"` (all matching hosts dispatch).
- `metadata` — arbitrary data passed through to the dispatch env.

### 2. Write a config (`cronbird.config.json`)

```json
{
  "hostname": "auto",
  "registryPath": "~/.cronbird/registry.json",
  "enabledPath": null,
  "topologyPath": null,
  "heartbeatPath": "~/.cronbird/heartbeat.json",
  "syncedHeartbeatDir": null,
  "dispatchCommand": ["./scripts/run-job.sh"],
  "dispatchArgsTemplate": ["{job}", "--scheduled"],
  "maxSleepMs": 60000,
  "catchupLookbackFloorMs": 3600000,
  "catchupLookbackCapMs": 21600000
}
```

### 3. Run

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

For `scope: "each"` jobs, all hosts matching the `hosts` list dispatch independently, regardless of `owners`.

### Synced heartbeat (E2 offline-owner alert)

Set `syncedHeartbeatDir` to a directory shared across hosts (e.g. a synced vault). Each host writes `<syncedHeartbeatDir>/<hostname>.json` atomically. A monitoring script can check all per-host files to detect offline owners.

---

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
