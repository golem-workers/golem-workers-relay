#!/usr/bin/env bash
set -Eeuo pipefail

LOG_DIR="/var/log/golem-workers"
LOG_FILE="${LOG_DIR}/prepare-agent-server.log"
STEP="init"
ROOT_BASHRC="/root/.bashrc"
GO_TARBALL="/tmp/go1.25.6.linux-amd64.tar.gz"
CHROME_DEB="/tmp/google-chrome-stable_current_amd64.deb"
RELAY_REPO_DIR="/root/golem-workers-relay"
RELAY_REPO_URL="https://github.com/golem-workers/golem-workers-relay.git"
RELAY_GIT_REF="${RELAY_GIT_REF:-release}"
NODE_OPTIONS_VALUE="--max-old-space-size=2024 --enable-source-maps"
NODE_COMPILE_CACHE_DIR="/var/tmp/openclaw-compile-cache"
RUN_OPENCLAW_ONBOARD=1

usage() {
  cat <<'EOF'
Usage:
  prepare-agent-server.sh [--skip-openclaw-onboard]

Options:
  --skip-openclaw-onboard  Install OpenClaw, but do not run `openclaw onboard --install-daemon`.
  -h, --help               Show this help.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skip-openclaw-onboard)
        RUN_OPENCLAW_ONBOARD=0
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1"
        usage
        exit 1
        ;;
    esac
    shift
  done
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "Run as root, for example:"
    echo "  curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/release/scripts/prepare-agent-server.sh | sudo bash"
    exit 1
  fi
}

set_step() {
  STEP="$1"
  echo
  echo "==== [${STEP}] $(date -u +"%Y-%m-%dT%H:%M:%SZ") ===="
}

on_error() {
  local exit_code="$?"
  echo
  echo "Prepare agent server failed at step: ${STEP}"
  echo "Exit code: ${exit_code}"
  echo "See log: ${LOG_FILE}"
  exit "${exit_code}"
}

append_line_if_missing() {
  local file="$1"
  local line="$2"
  touch "${file}"
  if ! grep -qxF "${line}" "${file}"; then
    printf '%s\n' "${line}" >>"${file}"
  fi
}

upsert_env_file_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped_value="${value//\\/\\\\}"
  escaped_value="${escaped_value//\"/\\\"}"
  touch "${file}"
  if grep -q "^${key}=" "${file}"; then
    sed -i "s|^${key}=.*|${key}=\"${escaped_value}\"|" "${file}"
  else
    printf '%s=\"%s\"\n' "${key}" "${value}" >>"${file}"
  fi
}

write_file() {
  local path="$1"
  local content="$2"
  mkdir -p "$(dirname "${path}")"
  printf '%s' "${content}" >"${path}"
}

prepare_root_user_systemd() {
  loginctl enable-linger root
  systemctl start user@0.service
  export HOME=/root
  export XDG_RUNTIME_DIR=/run/user/0
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  mkdir -p "${XDG_RUNTIME_DIR}"
  chmod 700 "${XDG_RUNTIME_DIR}"

  local attempt
  for attempt in $(seq 1 30); do
    if [[ -S "${XDG_RUNTIME_DIR}/bus" ]]; then
      return 0
    fi
    sleep 1
  done

  echo "Root user systemd bus did not become available at ${XDG_RUNTIME_DIR}/bus"
  return 1
}

install_warm_quiesce_helper() {
  install -D -m 0755 /dev/stdin /usr/local/bin/gw-warm-quiesce-helper.py <<'EOF'
#!/usr/bin/env python3
import json
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 18555


class QuiesceState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.frozen = False
        self.generation = 0
        self.deadline = 0.0

    def freeze(self, ttl_seconds: int) -> dict[str, object]:
        ttl_seconds = max(30, ttl_seconds)
        with self.lock:
            if self.frozen:
                return {
                    "status": "already_frozen",
                    "ttlSeconds": max(0, int(self.deadline - time.monotonic())),
                }
            subprocess.run(["sync"], check=True)
            subprocess.run(["fsfreeze", "-f", "/"], check=True)
            self.frozen = True
            self.generation += 1
            generation = self.generation
            self.deadline = time.monotonic() + ttl_seconds
            thread = threading.Thread(
                target=self._auto_thaw,
                args=(generation, ttl_seconds),
                daemon=True,
            )
            thread.start()
            return {"status": "frozen", "ttlSeconds": ttl_seconds}

    def thaw(self) -> dict[str, object]:
        with self.lock:
            if not self.frozen:
                return {"status": "idle"}
            subprocess.run(["fsfreeze", "-u", "/"], check=True)
            self.frozen = False
            self.generation += 1
            self.deadline = 0.0
            return {"status": "thawed"}

    def _auto_thaw(self, generation: int, ttl_seconds: int) -> None:
        time.sleep(ttl_seconds)
        with self.lock:
            if not self.frozen or self.generation != generation:
                return
            try:
                subprocess.run(["fsfreeze", "-u", "/"], check=True)
            finally:
                self.frozen = False
                self.generation += 1
                self.deadline = 0.0


STATE = QuiesceState()


class Handler(BaseHTTPRequestHandler):
    server_version = "gw-warm-quiesce-helper/1"

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send_json(404, {"error": "not_found"})
            return
        with STATE.lock:
            payload = {
                "status": "frozen" if STATE.frozen else "idle",
                "ttlSeconds": max(0, int(STATE.deadline - time.monotonic())) if STATE.frozen else 0,
            }
        self._send_json(200, payload)

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid_json"})
            return

        try:
            if self.path == "/freeze":
                ttl_seconds = int(payload.get("ttlSeconds", 180))
                result = STATE.freeze(ttl_seconds)
                self._send_json(200, result)
                return
            if self.path == "/thaw":
                result = STATE.thaw()
                self._send_json(200, result)
                return
        except subprocess.CalledProcessError as error:
            self._send_json(
                500,
                {
                    "error": "command_failed",
                    "command": error.cmd,
                    "returncode": error.returncode,
                },
            )
            return

        self._send_json(404, {"error": "not_found"})

    def log_message(self, format: str, *args: object) -> None:
        return

    def _send_json(self, status_code: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
EOF

  install -D -m 0644 /dev/stdin /etc/systemd/system/gw-warm-quiesce-helper.service <<'EOF'
[Unit]
Description=Golem Workers warm-image filesystem quiesce helper
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/gw-warm-quiesce-helper.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
}

main() {
  parse_args "$@"
  require_root

  mkdir -p "${LOG_DIR}"
  touch "${LOG_FILE}"
  chmod 0600 "${LOG_FILE}" || true
  exec > >(tee -a "${LOG_FILE}") 2>&1
  trap on_error ERR

  export DEBIAN_FRONTEND=noninteractive

  echo "__GW_PREPARE_STARTED__=1"
  echo "__GW_PREPARE_LOG_FILE__=${LOG_FILE}"

  set_step "deps"
  append_line_if_missing /etc/apt/sources.list "deb http://archive.ubuntu.com/ubuntu noble universe multiverse"
  append_line_if_missing /etc/apt/sources.list "deb http://archive.ubuntu.com/ubuntu noble-updates universe multiverse"
  append_line_if_missing /etc/apt/sources.list "deb http://security.ubuntu.com/ubuntu noble-security universe multiverse"
  apt-get update
  apt-get install -y ubuntu-keyring
  apt-get update
  apt-get upgrade -y
  apt-get install -y \
    curl \
    gnupg \
    lsb-release \
    jq \
    fail2ban \
    build-essential \
    procps \
    file \
    git \
    wget \
    dbus-user-session \
    nano \
    lsof \
    openssl \
    ca-certificates \
    dnsutils \
    iptables \
    ufw \
    python3 \
    util-linux \
    unzip \
    ffmpeg \
    ripgrep

  set_step "swap"
  if ! swapon --show=NAME | grep -qx "/swapfile"; then
    if [[ ! -f /swapfile ]]; then
      fallocate -l 6G /swapfile
      chmod 600 /swapfile
      mkswap /swapfile
    fi
    swapon /swapfile
  fi
  append_line_if_missing /etc/fstab "/swapfile none swap sw 0 0"
  sysctl vm.swappiness=10
  if grep -q '^vm\.swappiness=' /etc/sysctl.conf; then
    sed -i 's/^vm\.swappiness=.*/vm.swappiness=10/' /etc/sysctl.conf
  else
    printf '%s\n' 'vm.swappiness=10' >>/etc/sysctl.conf
  fi

  set_step "chrome"
  wget -q -O "${CHROME_DEB}" "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
  apt-get install -y "${CHROME_DEB}"
  google-chrome-stable --version

  set_step "logs"
  sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=100M/' /etc/systemd/journald.conf
  sed -i 's/^SystemMaxUse=.*/SystemMaxUse=100M/' /etc/systemd/journald.conf
  systemctl restart systemd-journald
  journalctl --vacuum-size=100M

  set_step "warm_quiesce_helper"
  command -v fsfreeze
  install_warm_quiesce_helper
  systemctl daemon-reload
  systemctl enable --now gw-warm-quiesce-helper.service
  systemctl is-active --quiet gw-warm-quiesce-helper.service

  set_step "dns_boot_speed_fix"
  systemctl disable --now systemd-resolved || true
  systemctl mask systemd-resolved || true
  rm -f /etc/resolv.conf
  cat >/etc/resolv.conf <<'EOF'
nameserver 10.55.0.1
options timeout:1 attempts:2
EOF
  chmod 644 /etc/resolv.conf

  set_step "go"
  wget -q -O "${GO_TARBALL}" "https://go.dev/dl/go1.25.6.linux-amd64.tar.gz"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "${GO_TARBALL}"
  append_line_if_missing "${ROOT_BASHRC}" 'export GOROOT=/usr/local/go'
  append_line_if_missing "${ROOT_BASHRC}" 'export GOPATH=$HOME/go'
  append_line_if_missing "${ROOT_BASHRC}" 'export PATH=$PATH:$GOROOT/bin:$GOPATH/bin'
  export GOROOT=/usr/local/go
  export GOPATH=/root/go
  export PATH="${PATH}:${GOROOT}/bin:${GOPATH}/bin"
  go version

  set_step "brew"
  id -u linuxbrew >/dev/null 2>&1 || useradd -m -s /bin/bash linuxbrew
  mkdir -p /home/linuxbrew/.linuxbrew
  chown -R linuxbrew:linuxbrew /home/linuxbrew
  if [[ ! -x /home/linuxbrew/.linuxbrew/bin/brew ]]; then
    sudo -u linuxbrew -H bash -lc 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  fi
  sudo -u linuxbrew -H bash -lc 'grep -qxF '\''eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"'\'' ~/.bashrc || echo '\''eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"'\'' >> ~/.bashrc'
  cat >/usr/local/bin/brew <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$(id -un)" == "linuxbrew" ]]; then
  exec /home/linuxbrew/.linuxbrew/bin/brew "$@"
fi
exec sudo -u linuxbrew -H bash -lc 'cd / && eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)" && /home/linuxbrew/.linuxbrew/bin/brew "$@"' _ "$@"
EOF
  chmod +x /usr/local/bin/brew
  sed -i '\|export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH"|d' "${ROOT_BASHRC}" || true
  append_line_if_missing "${ROOT_BASHRC}" 'export PATH="$PATH:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin"'
  export PATH="${PATH}:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin"
  sudo -u linuxbrew -H bash -lc 'cd / && eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)" && /home/linuxbrew/.linuxbrew/bin/brew --version'
  sudo -u linuxbrew -H bash -lc 'cd / && eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)" && (/home/linuxbrew/.linuxbrew/bin/brew list node >/dev/null 2>&1 && /home/linuxbrew/.linuxbrew/bin/brew uninstall --force node || true)'

  set_step "nodejs"
  if ! command -v node >/dev/null 2>&1 || ! node --version | grep -q '^v22\.'; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  node --version
  npm --version

  set_step "relay_prepull"
  if [[ -d "${RELAY_REPO_DIR}/.git" ]]; then
    cd "${RELAY_REPO_DIR}"
    git fetch --prune origin "${RELAY_GIT_REF}"
    git checkout "${RELAY_GIT_REF}"
    git reset --hard "origin/${RELAY_GIT_REF}"
  else
    rm -rf "${RELAY_REPO_DIR}"
    git clone --branch "${RELAY_GIT_REF}" --single-branch "${RELAY_REPO_URL}" "${RELAY_REPO_DIR}"
    cd "${RELAY_REPO_DIR}"
  fi
  npm ci
  npm run build
  cd /root

  set_step "openclaw_install"
  GLOBAL_NPM_ROOT="$(npm root -g)"
  echo "Using global npm root: ${GLOBAL_NPM_ROOT}"
  mkdir -p "${NODE_COMPILE_CACHE_DIR}"
  chmod 1777 "${NODE_COMPILE_CACHE_DIR}"
  append_line_if_missing "${ROOT_BASHRC}" "export NODE_OPTIONS=\"${NODE_OPTIONS_VALUE}\""
  append_line_if_missing "${ROOT_BASHRC}" "export NODE_COMPILE_CACHE=\"${NODE_COMPILE_CACHE_DIR}\""
  append_line_if_missing "${ROOT_BASHRC}" 'export OPENCLAW_NO_RESPAWN=1'
  append_line_if_missing "${ROOT_BASHRC}" "export NODE_PATH=\"${GLOBAL_NPM_ROOT}\""
  upsert_env_file_key /etc/environment NODE_OPTIONS "${NODE_OPTIONS_VALUE}"
  upsert_env_file_key /etc/environment NODE_COMPILE_CACHE "${NODE_COMPILE_CACHE_DIR}"
  upsert_env_file_key /etc/environment OPENCLAW_NO_RESPAWN "1"
  upsert_env_file_key /etc/environment NODE_PATH "${GLOBAL_NPM_ROOT}"
  write_file /etc/profile.d/golem-node-runtime.sh "#!/usr/bin/env bash
export NODE_OPTIONS=\"${NODE_OPTIONS_VALUE}\"
export NODE_COMPILE_CACHE=\"${NODE_COMPILE_CACHE_DIR}\"
export OPENCLAW_NO_RESPAWN=1
export NODE_PATH=\"${GLOBAL_NPM_ROOT}\"
"
  chmod 0644 /etc/profile.d/golem-node-runtime.sh
  rm -f /etc/systemd/system.conf.d/node-runtime.conf /etc/systemd/user.conf.d/node-runtime.conf
  write_file /etc/systemd/system.conf.d/node-runtime.conf "[Manager]
DefaultEnvironment=\"NODE_OPTIONS=${NODE_OPTIONS_VALUE}\" \"NODE_COMPILE_CACHE=${NODE_COMPILE_CACHE_DIR}\" \"OPENCLAW_NO_RESPAWN=1\" \"NODE_PATH=${GLOBAL_NPM_ROOT}\"
"
  write_file /etc/systemd/user.conf.d/node-runtime.conf "[Manager]
DefaultEnvironment=\"NODE_OPTIONS=${NODE_OPTIONS_VALUE}\" \"NODE_COMPILE_CACHE=${NODE_COMPILE_CACHE_DIR}\" \"OPENCLAW_NO_RESPAWN=1\" \"NODE_PATH=${GLOBAL_NPM_ROOT}\"
"
  export NODE_OPTIONS="${NODE_OPTIONS_VALUE}"
  export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE_DIR}"
  export OPENCLAW_NO_RESPAWN=1
  export NODE_PATH="${GLOBAL_NPM_ROOT}"
  export OPENCLAW_SKIP_CANVAS_HOST=1
  export OPENCLAW_LOG_LEVEL=debug
  prepare_root_user_systemd
  systemctl --user import-environment \
    NODE_OPTIONS \
    NODE_COMPILE_CACHE \
    OPENCLAW_NO_RESPAWN \
    NODE_PATH \
    OPENCLAW_SKIP_CANVAS_HOST \
    OPENCLAW_LOG_LEVEL || true
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method npm --no-onboard
  test -f "${GLOBAL_NPM_ROOT}/openclaw/package.json"
  npm install -g playwright
  test -f "${GLOBAL_NPM_ROOT}/playwright/package.json"
  if [[ "${RUN_OPENCLAW_ONBOARD}" == "1" ]]; then
    openclaw onboard --install-daemon --non-interactive --accept-risk
  else
    echo "Skipping openclaw onboard --install-daemon by request."
  fi

  set_step "openclaw_snapshot_shutdown"
  prepare_root_user_systemd
  systemctl --user daemon-reload || true
  systemctl --user stop openclaw-gateway.service || true
  systemctl --user disable openclaw-gateway.service || true
  systemctl --user reset-failed openclaw-gateway.service || true

  set_step "done"
  echo "__GW_PREPARE_DONE__=1"
  echo "Prepare agent server completed successfully."
  echo "Log file: ${LOG_FILE}"
}

main "$@"
