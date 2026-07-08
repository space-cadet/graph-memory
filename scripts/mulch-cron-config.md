# Mulch Integration Cron Configuration

## Schedule
```
6 3 * * *
```
Runs at **3:06 AM IST** daily (after existing mulch cron at 3:00 AM).

## Model
```
kimi/k2.7-code
```

## Command
```bash
cd ~/.openclaw/workspace/code/graph-memory && node scripts/mulch-integration.cjs --apply
```

## Flags
- `--apply` — Required to actually write records (default is `--dry-run`)
- `--days 7` — Lookback window (default)
- `--threshold 5` — Minimum mention count (default)

## OpenClaw Cron Config Snippet
```yaml
- id: mulch-integration
  schedule: "6 3 * * *"
  command: "cd ~/.openclaw/workspace/code/graph-memory && node scripts/mulch-integration.cjs --apply"
  model: "kimi/k2.7-code"
  timeout: 300
  mode: isolated
```

## Notes
- The graph DB is at `~/.openclaw/workspace/.openclaw_memory/graph.db`
- Mulch records are written to `~/.openclaw/workspace/.mulch/expertise/`
- The script is safe by default (`--dry-run`); `--apply` is required for writes
- First run should use `--dry-run` to verify candidate count
