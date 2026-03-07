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
NODE_OPTIONS_VALUE="--max-old-space-size=2024 --enable-source-maps"
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
    echo "  curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/main/scripts/prepare-agent-server.sh | sudo bash"
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

write_file() {
  local path="$1"
  local content="$2"
  mkdir -p "$(dirname "${path}")"
  printf '%s' "${content}" >"${path}"
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
    unzip \
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
    git fetch --all --prune
    git reset --hard origin/main
  else
    rm -rf "${RELAY_REPO_DIR}"
    git clone "${RELAY_REPO_URL}" "${RELAY_REPO_DIR}"
    cd "${RELAY_REPO_DIR}"
  fi
  npm ci
  npm run build
  cd /root

  set_step "openclaw_install"
  GLOBAL_NPM_ROOT="$(npm root -g)"
  echo "Using global npm root: ${GLOBAL_NPM_ROOT}"
  append_line_if_missing "${ROOT_BASHRC}" "export NODE_OPTIONS=\"${NODE_OPTIONS_VALUE}\""
  append_line_if_missing "${ROOT_BASHRC}" "export NODE_PATH=\"${GLOBAL_NPM_ROOT}\""
  rm -f /etc/systemd/system.conf.d/node-runtime.conf /etc/systemd/user.conf.d/node-runtime.conf
  write_file /etc/systemd/system.conf.d/node-runtime.conf "[Manager]
DefaultEnvironment=\"NODE_OPTIONS=${NODE_OPTIONS_VALUE}\" \"NODE_PATH=${GLOBAL_NPM_ROOT}\"
"
  write_file /etc/systemd/user.conf.d/node-runtime.conf "[Manager]
DefaultEnvironment=\"NODE_OPTIONS=${NODE_OPTIONS_VALUE}\" \"NODE_PATH=${GLOBAL_NPM_ROOT}\"
"
  export NODE_OPTIONS="${NODE_OPTIONS_VALUE}"
  export NODE_PATH="${GLOBAL_NPM_ROOT}"
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --version 2026.3.1 --install-method npm --no-onboard
  test -f "${GLOBAL_NPM_ROOT}/openclaw/package.json"
  npm install -g playwright
  test -f "${GLOBAL_NPM_ROOT}/playwright/package.json"
  if [[ "${RUN_OPENCLAW_ONBOARD}" == "1" ]]; then
    openclaw onboard --install-daemon
  else
    echo "Skipping openclaw onboard --install-daemon by request."
  fi

  set_step "done"
  echo "__GW_PREPARE_DONE__=1"
  echo "Prepare agent server completed successfully."
  echo "Log file: ${LOG_FILE}"
}

main "$@"
