# Prepare Agent Server

Run directly from the public repo:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/main/scripts/prepare-agent-server.sh | sudo bash
```

What it does:

- installs base Ubuntu packages;
- creates swap early so low-memory agents can unpack large packages like Chrome;
- installs Google Chrome Stable;
- configures journald, swap, and DNS;
- installs Go and Linuxbrew;
- installs Node via Homebrew;
- pre-pulls and builds `golem-workers-relay`;
- installs OpenClaw plus full `playwright`;
- runs `openclaw onboard --install-daemon`.

Warm-image note:

- When a provider clones a Firecracker `warm_image`, backend bootstrap is still expected to run on the new server.
- Warm-image cloning replaces SSH access material on the cloned overlay and backend provisioning reapplies relay/OpenClaw runtime config for the new agent identity.

Logs:

- file: `/var/log/golem-workers/prepare-agent-server.log`

Script source:

- `scripts/prepare-agent-server.sh`

