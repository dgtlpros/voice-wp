Got you—here’s a tight **Fly.io cheat sheet** you’ll actually use for `voice-ws`. (All commands work from your `voice-ws` folder; add `--app voice-ws-purple-leaf-194` if you’re elsewhere.)

## Setup & Deploy

```powershell
flyctl auth login
flyctl launch --no-deploy           # create fly.toml (once)
flyctl deploy                        # build & deploy
flyctl open                          # open https URL
```

## Status, Logs, Metrics

```powershell
flyctl status
flyctl logs                          # live tail logs
flyctl status --json | jq .          # detailed status (if you have jq)
```

## Scale & Sizing

```powershell
flyctl scale count 1                 # number of machines
flyctl scale vm shared-cpu-1x -m 256 # size: cpu & memory (MB). e.g., 256/512
```

## Machines (start/stop/cleanup)

```powershell
flyctl machines list
flyctl machines stop <ID>
flyctl machines start <ID>
flyctl machines destroy <ID> -f
flyctl machines prune -f             # remove old/failed machines
```

## Regions & DNS

```powershell
flyctl regions list
flyctl regions set sjc               # set primary region
flyctl ips list
```

## Secrets (env vars)

```powershell
flyctl secrets set OPENAI_API_KEY=sk-...    # set/update
flyctl secrets list
flyctl secrets unset OPENAI_API_KEY
```

## Releases & Rollbacks

```powershell
flyctl releases                      # recent deploys
flyctl releases info <VERSION>
flyctl releases rollback <VERSION>   # roll back to a prior release
```

## SSH / Debug shell

```powershell
flyctl ssh console                   # get a shell in the machine
```

## Clean teardown (if ever needed)

```powershell
flyctl scale count 0
flyctl apps destroy voice-ws-purple-leaf-194
```

### Notes

- Your service listens on **port 3000** (matches `fly.toml` `internal_port = 3000`).
- Keep `min_machines_running = 1` and `auto_stop_machines = "off"` for always-on WS.
- If deploy hangs or first boot is weird: `machines prune -f` then `deploy` again.

Want a one-liner to **watch logs while you place a call**?
`flyctl logs` in one terminal, then call your Twilio number—you should see `start … ..... … stop`.
