# Offline Evolution Scheduling

How to run `runDailyEvolution` on a schedule — the CLI and deployment recipes for the agent-server daily evolution pipeline (SPEC §4.2 / B3).

## Quickstart

```bash
# One-shot evolution run (from packages/agent-server):
npx tsx src/offline/run-evolution.ts

# Check the last run:
npx tsx src/offline/run-evolution.ts --status

# Sidecar loop mode (container sidecar; single failure does not exit):
AGENT_SERVER_EVOLUTION_INTERVAL_HOURS=24 npx tsx src/offline/run-evolution.ts --loop
```

## Scheduling

### Automated install/uninstall

```bash
# Install a daily trigger (macOS: LaunchAgent plist; Linux: crontab):
npx tsx src/offline/schedule.ts install

# Check whether scheduling is correctly set up:
npx tsx src/offline/schedule.ts doctor

# Preview what install/uninstall would do without touching anything:
npx tsx src/offline/schedule.ts install --dry-run
npx tsx src/offline/schedule.ts doctor --dry-run
npx tsx src/offline/schedule.ts uninstall --dry-run
```

## Deployment Recipes

### macOS — LaunchAgent

The `install` command writes a plist to `~/Library/LaunchAgents/com.agent-server.evolution.plist` that triggers every 86400 seconds (24 h).

Manual equivalent (without the install command):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent-server.evolution</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>cd /path/to/packages/agent-server &amp;&amp; npx tsx src/offline/run-evolution.ts</string>
    </array>
    <key>StartInterval</key>
    <integer>86400</integer>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
```

Load and verify:

```bash
launchctl load ~/Library/LaunchAgents/com.agent-server.evolution.plist
launchctl list | grep agent-server
```

### Linux — Cron

```bash
# The install command adds one line to your crontab (daily at 03:07):
7 3 * * * cd /path/to/packages/agent-server && npx tsx src/offline/run-evolution.ts >> ./var/evolution-cron.log 2>&1
```

### Kubernetes CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: agent-server-evolution
spec:
  schedule: "7 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: evolution
            image: node:22
            command: ["npx", "tsx", "src/offline/run-evolution.ts"]
            workingDir: /app/packages/agent-server
            env:
            - name: EXPERIENCE_STORE_PATH
              value: /data/experience.db
            - name: AGENT_SERVER_BENCHMARK
              value: /data/benchmark.json
            volumeMounts:
            - name: data
              mountPath: /data
          volumes:
          - name: data
            persistentVolumeClaim:
              claimName: agent-server-data
          restartPolicy: OnFailure
```

### Docker Compose Sidecar (--loop)

```yaml
services:
  agent-server:
    image: agent-server:latest
    # ... main server config ...

  evolution-sidecar:
    image: agent-server:latest
    working_dir: /app/packages/agent-server
    command: ["npx", "tsx", "src/offline/run-evolution.ts", "--loop"]
    environment:
      - EXPERIENCE_STORE_PATH=/data/experience.db
      - AGENT_SERVER_BENCHMARK=/data/benchmark.json
      - AGENT_SERVER_EVOLUTION_INTERVAL_HOURS=24
    volumes:
      - data:/data
```

## Monitoring

### CLI

```bash
npx tsx src/offline/run-evolution.ts --status
```

Example output (found):

```json
{
  "id": "ckpt-a1b2c3d4e5f6g7h8",
  "epoch": "2026-07-22T03:07:00.000Z",
  "metric": 42,
  "snapshot": {
    "etlInserted": 200,
    "pipeline": "...",
    "promoted": 42,
    "rescored": 15,
    "promotedFromDormant": 3,
    "removedDormant": 5
  }
}
```

Example output (never run):

```
no evolution checkpoint found — never run
```

### HTTP Endpoint

```
GET /api/evolution/status
```

- **200** `{"status":"found","id":"...","epoch":"...","metric":42,"snapshot":{...}}`
- **404** `{"status":"never_run"}`

## Failure Diagnosis

When a run fails, a failure checkpoint is written with `metric: 0` and `snapshot: {"error": "..."}`. This distinguishes "never run" (404) from "ran but failed" (checkpoint exists with metric=0).

Check the latest checkpoint:

```bash
sqlite3 ./var/experience.db "SELECT id, epoch, metric, snapshot FROM checkpoints WHERE kind='evolution' ORDER BY epoch DESC LIMIT 1;"
```

Common failures:

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| No files in `./var/sessions/` | ETL has nothing to ingest | Normal for fresh install; ETL tolerates empty dirs |
| `AGENT_SERVER_BENCHMARK` not set | Skill training stage skipped | Set env var to a benchmark.json path |
| `EXPERIENCE_STORE_PATH` not writable | Permissions | Ensure the process can write to the directory |

## Design Decisions

- **External triggering only** (P1 decision, not overturned): the server does NOT run evolution on startup or on a timer. Use one of the scheduling recipes above.
- **Failure checkpoint**: a failed run writes `metric:0, snapshot:{"error":"..."}` so that `/api/evolution/status` distinguishes "never run" (404) from "ran and failed" (200 with metric=0).
- **404 vs never_run**: the HTTP endpoint returns `404` with `{status:"never_run"}` when no checkpoint exists, rather than `200 {status:"never_run"}`. This makes it straightforward for monitoring probes to distinguish "no data yet" (404) from "last run succeeded" (200) and "last run failed" (200 with metric=0).
- **--loop interval**: `AGENT_SERVER_EVOLUTION_INTERVAL_HOURS` (default 24). The loop sleeps this many hours between run completions (not between start times). If the previous run takes longer than the interval, the next run starts immediately after it finishes.
