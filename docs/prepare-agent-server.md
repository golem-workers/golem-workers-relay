# Prepare Agent Server

Run directly from the public repo:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/main/scripts/prepare-agent-server.sh | sudo bash
```

What it does:

- installs base Ubuntu packages;
- installs Google Chrome Stable;
- configures journald, swap, and DNS;
- installs Go and Linuxbrew;
- installs Node via Homebrew;
- pre-pulls and builds `golem-workers-relay`;
- installs OpenClaw plus full `playwright`;
- runs `openclaw onboard --install-daemon`.

Logs:

- file: `/var/log/golem-workers/prepare-agent-server.log`

Script source:

- `scripts/prepare-agent-server.sh`

