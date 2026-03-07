# Prepare Agent Server

Run directly from the public repo:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/main/scripts/prepare-agent-server.sh | sudo bash
```

If you want to skip interactive OpenClaw onboarding during base image preparation:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/main/scripts/prepare-agent-server.sh | sudo bash -s -- --skip-openclaw-onboard
```

What it does:

- installs base Ubuntu packages;
- creates swap early so low-memory agents can unpack large packages like Chrome;
- installs Google Chrome Stable;
- configures journald, swap, and DNS;
- installs Go and Linuxbrew;
- installs Node 22 separately (Linuxbrew is not used to install Node);
- pre-pulls and builds `golem-workers-relay`;
- installs OpenClaw plus full `playwright`;
- configures low-power OpenClaw runtime env (`NODE_COMPILE_CACHE`, `OPENCLAW_NO_RESPAWN`, `NODE_PATH`);
- optionally runs `openclaw onboard --install-daemon`.

Warm-image note:

- When a provider clones a Firecracker `warm_image`, backend bootstrap is still expected to run on the new server.
- Provider-side warm clones now restore inside per-clone Linux network namespaces so multiple clones can coexist with the source VM on one host.
- The clone keeps the guest-internal network identity from snapshot memory; provider/bastion access is exposed through a separate provider-assigned access IP.
- Warm-image cloning replaces SSH access material on the cloned overlay and backend provisioning reapplies relay/OpenClaw runtime config for the new agent identity.

Logs:

- file: `/var/log/golem-workers/prepare-agent-server.log`

Script source:

- `scripts/prepare-agent-server.sh`

After script execution without onboard use 
```
source /root/.bashrc
openclaw onboard --install-daemon
```