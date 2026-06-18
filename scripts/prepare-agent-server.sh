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
RELAY_CHANNEL_PLUGIN_REPO_DIR="/root/golem-workers-openclaw-channel-plugin"
RELAY_CHANNEL_PLUGIN_REPO_URL="https://github.com/golem-workers/golem-workers-openclaw-channel-plugin.git"
if [[ -z "${RELAY_CHANNEL_PLUGIN_GIT_REF:-}" ]]; then
  if [[ "${RELAY_GIT_REF}" == "main" ]]; then
    RELAY_CHANNEL_PLUGIN_GIT_REF="main"
  else
    RELAY_CHANNEL_PLUGIN_GIT_REF="release"
  fi
fi
NODE_OPTIONS_VALUE="--max-old-space-size=2024 --enable-source-maps"
NODE_COMPILE_CACHE_DIR="/var/tmp/openclaw-compile-cache"
PNPM_HOME_DIR="/root/.local/share/pnpm"
OPENCLAW_WHATSAPP_PLUGIN_SPEC="${OPENCLAW_WHATSAPP_PLUGIN_SPEC:-clawhub:@openclaw/whatsapp}"
RUN_OPENCLAW_ONBOARD=1
APT_SOURCES_LIST="/etc/apt/sources.list"
UBUNTU_SUITE="${UBUNTU_SUITE:-noble}"
APT_MIRROR_HINT="${APT_MIRROR_HINT:-}"
OPENAI_PROXY_BASE_URL="http://127.0.0.1:18084/provider-proxy/openai/v1"
CODEX_WRAPPER_PATH="/usr/local/bin/golem-codex-proxy"

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

is_hetzner_host() {
  local dmi_file vendor
  for dmi_file in \
    /sys/class/dmi/id/sys_vendor \
    /sys/class/dmi/id/board_vendor \
    /sys/class/dmi/id/chassis_vendor \
    /sys/class/dmi/id/product_name; do
    if [[ -r "${dmi_file}" ]]; then
      vendor="$(tr '[:upper:]' '[:lower:]' < "${dmi_file}")"
      if [[ "${vendor}" == *hetzner* ]]; then
        return 0
      fi
    fi
  done
  return 1
}

should_use_hetzner_mirror() {
  case "${APT_MIRROR_HINT}" in
    hetzner|Hetzner|HETZNER)
      return 0
      ;;
  esac
  is_hetzner_host
}

prepare_architecture() {
  dpkg --print-architecture 2>/dev/null || uname -m
}

default_prepare_apt_mirror() {
  local arch
  arch="$(prepare_architecture)"

  if should_use_hetzner_mirror; then
    case "${arch}" in
      arm64|aarch64)
        printf '%s' "https://mirror.hetzner.com/ubuntu-ports/packages"
        ;;
      *)
        printf '%s' "https://mirror.hetzner.com/ubuntu/packages"
        ;;
    esac
    return 0
  fi

  case "${arch}" in
    arm64|aarch64)
      printf '%s' "http://ports.ubuntu.com/ubuntu-ports"
      ;;
    *)
      printf '%s' "http://archive.ubuntu.com/ubuntu"
      ;;
  esac
}

default_prepare_apt_security_mirror() {
  local arch
  arch="$(prepare_architecture)"

  if should_use_hetzner_mirror; then
    case "${arch}" in
      arm64|aarch64)
        printf '%s' "https://mirror.hetzner.com/ubuntu-ports/security"
        ;;
      *)
        printf '%s' "https://mirror.hetzner.com/ubuntu/security"
        ;;
    esac
    return 0
  fi

  case "${arch}" in
    arm64|aarch64)
      printf '%s' "http://ports.ubuntu.com/ubuntu-ports"
      ;;
    *)
      printf '%s' "http://security.ubuntu.com/ubuntu"
      ;;
  esac
}

normalize_apt_mirror_url() {
  printf '%s' "$1"
}

configure_ubuntu_sources_list() {
  local mirror security_mirror
  mirror="$(normalize_apt_mirror_url "${APT_MIRROR:-$(default_prepare_apt_mirror)}")"
  security_mirror="$(normalize_apt_mirror_url "${APT_SECURITY_MIRROR:-$(default_prepare_apt_security_mirror)}")"

  cat >"${APT_SOURCES_LIST}" <<EOF
deb ${mirror} ${UBUNTU_SUITE} main restricted universe multiverse
deb ${mirror} ${UBUNTU_SUITE}-updates main restricted universe multiverse
deb ${security_mirror} ${UBUNTU_SUITE}-security main restricted universe multiverse
EOF

  echo "Configured apt sources:"
  printf '  suite=%s\n' "${UBUNTU_SUITE}"
  printf '  mirror=%s\n' "${mirror}"
  printf '  security_mirror=%s\n' "${security_mirror}"
}

prepare_guest_dns_server() {
  ip route show default 2>/dev/null | awk 'NR == 1 { print $3; exit }'
}

pin_guest_dns_to_gateway() {
  local dns_server
  dns_server="$(prepare_guest_dns_server)"
  if [[ -z "${dns_server}" ]]; then
    echo "Default gateway not found; leaving guest DNS unchanged"
    return 0
  fi

  systemctl disable --now systemd-resolved || true
  systemctl mask systemd-resolved || true
  rm -f /etc/resolv.conf
  cat >/etc/resolv.conf <<EOF
nameserver ${dns_server}
options timeout:1 attempts:2
EOF
  chmod 644 /etc/resolv.conf
  echo "Pinned guest DNS to ${dns_server}"
}

log_git_checkout_state() {
  local repo_dir="$1"
  local label="$2"
  local requested_ref="$3"
  local head="unknown"
  local branch="unknown"
  local status="missing"

  if [[ -d "${repo_dir}/.git" ]]; then
    status="present"
    head="$(git -C "${repo_dir}" rev-parse HEAD 2>/dev/null || echo unknown)"
    branch="$(git -C "${repo_dir}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  fi

  echo "${label}_requested_ref=${requested_ref}"
  echo "${label}_repo_dir=${repo_dir}"
  echo "${label}_repo_status=${status}"
  echo "${label}_head=${head}"
  echo "${label}_branch=${branch}"
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

wait_for_openclaw_gateway_ready() {
  local attempts="${1:-120}"
  local sleep_seconds="${2:-2}"
  local attempt

  prepare_root_user_systemd

  for attempt in $(seq 1 "${attempts}"); do
    if ss -ltn | awk '$4 == "127.0.0.1:18789" || $4 == "0.0.0.0:18789" || $4 == "[::1]:18789" || $4 == "[::]:18789" { found=1 } END { exit(found ? 0 : 1) }'; then
      return 0
    fi

    local active_state
    local sub_state
    active_state="$(systemctl --user show openclaw-gateway.service -p ActiveState --value 2>/dev/null || true)"
    sub_state="$(systemctl --user show openclaw-gateway.service -p SubState --value 2>/dev/null || true)"
    if [[ "${active_state}" == "failed" ]]; then
      echo "OpenClaw gateway failed while waiting for port 18789 (SubState=${sub_state})"
      systemctl --user status openclaw-gateway.service --no-pager -l || true
      journalctl --user -u openclaw-gateway.service -n 160 --no-pager || true
      return 1
    fi

    sleep "${sleep_seconds}"
  done

  echo "OpenClaw gateway did not start listening on port 18789 in time"
  systemctl --user status openclaw-gateway.service --no-pager -l || true
  journalctl --user -u openclaw-gateway.service -n 160 --no-pager || true
  return 1
}

run_openclaw_onboard_and_verify() {
  local onboard_exit=0

  if openclaw onboard --install-daemon --non-interactive --accept-risk; then
    onboard_exit=0
  else
    onboard_exit=$?
    echo "WARNING: OpenClaw onboard exited with code ${onboard_exit}; running manual gateway readiness recovery."
  fi

  prepare_root_user_systemd
  systemctl --user daemon-reload || true

  if [[ ! -f /root/.config/systemd/user/openclaw-gateway.service ]]; then
    echo "OpenClaw onboard did not install /root/.config/systemd/user/openclaw-gateway.service"
    return 1
  fi

  systemctl --user enable openclaw-gateway.service || true
  systemctl --user restart openclaw-gateway.service
  wait_for_openclaw_gateway_ready

  if [[ "${onboard_exit}" -ne 0 ]]; then
    echo "WARNING: OpenClaw onboard exited with code ${onboard_exit}, but manual gateway restart/readiness verification succeeded."
  fi
}

stop_openclaw_gateway_if_present() {
  prepare_root_user_systemd
  systemctl --user daemon-reload || true

  if [[ ! -f /root/.config/systemd/user/openclaw-gateway.service ]]; then
    return 0
  fi

  systemctl --user stop openclaw-gateway.service || true
  systemctl --user disable openclaw-gateway.service || true
  systemctl --user reset-failed openclaw-gateway.service || true

  local active_state
  active_state="$(systemctl --user is-active openclaw-gateway.service 2>/dev/null || true)"
  if [[ -n "${active_state}" && "${active_state}" != "inactive" && "${active_state}" != "failed" ]]; then
    echo "OpenClaw gateway must be stopped before snapshot mutations, current state: ${active_state}" >&2
    return 1
  fi
}

write_openclaw_snapshot_warmup_config() {
  node --input-type=module - <<'NODE'
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const configDir = path.join(os.homedir(), ".openclaw")
const configPath = path.join(configDir, "openclaw.json")
const warmupTelegramToken = "123456789:GW_SNAPSHOT_WARMUP_TOKEN"

function ensureRecord(parent, key) {
  const current = parent?.[key]
  if (current && typeof current === "object" && !Array.isArray(current)) return current
  const next = {}
  parent[key] = next
  return next
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}

if (!fs.existsSync(configPath)) {
  throw new Error(`Missing canonical OpenClaw config at ${configPath}`)
}

const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"))
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
  throw new Error(`Unexpected OpenClaw config shape in ${configPath}`)
}

const channelsCfg = ensureRecord(parsed, "channels")
channelsCfg.telegram = {
  enabled: true,
  botToken: warmupTelegramToken,
  dmPolicy: "open",
  allowFrom: ["*"],
}
channelsCfg.whatsapp = {
  enabled: true,
  dmPolicy: "allowlist",
  allowFrom: [],
  groupPolicy: "disabled",
  groupAllowFrom: [],
  sendReadReceipts: true,
  selfChatMode: true,
}

const pluginsCfg = ensureRecord(parsed, "plugins")
pluginsCfg.enabled = true
pluginsCfg.allow = Array.from(
  new Set([...normalizeStringArray(pluginsCfg.allow), "telegram", "whatsapp"])
)
const nextDeny = normalizeStringArray(pluginsCfg.deny).filter(
  (item) => item !== "telegram" && item !== "whatsapp"
)
if (nextDeny.length > 0) {
  pluginsCfg.deny = nextDeny
} else {
  delete pluginsCfg.deny
}

fs.mkdirSync(configDir, { recursive: true })
fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`)
console.log(`wrote snapshot warmup config at ${configPath}`)
NODE
}

warm_openclaw_snapshot_channels() {
  prepare_root_user_systemd
  systemctl --user daemon-reload || true
  systemctl --user enable openclaw-gateway.service || true
  systemctl --user restart openclaw-gateway.service
  wait_for_openclaw_gateway_ready
  echo "OpenClaw gateway passed snapshot warmup readiness."
  sleep 5
  echo "Snapshot warmup settle complete."
}

install_openclaw_whatsapp_plugin() {
  if openclaw plugins inspect whatsapp --runtime --json >/dev/null 2>&1; then
    echo "OpenClaw WhatsApp plugin already installed."
  else
    openclaw plugins install "${OPENCLAW_WHATSAPP_PLUGIN_SPEC}"
  fi
  openclaw plugins enable whatsapp
  openclaw plugins inspect whatsapp --runtime --json >/dev/null
}

main() {
  parse_args "$@"
  require_root

  mkdir -p "${LOG_DIR}"
  touch "${LOG_FILE}"
  chmod 0600 "${LOG_FILE}" || true
  exec > >(tee -a "${LOG_FILE}") 2>&1
  trap on_error ERR

  set_step "git_ref_selection"
  log_git_checkout_state "${RELAY_REPO_DIR}" "relay_before_checkout" "${RELAY_GIT_REF}"
  log_git_checkout_state "${RELAY_CHANNEL_PLUGIN_REPO_DIR}" "relay_channel_plugin_before_checkout" "${RELAY_CHANNEL_PLUGIN_GIT_REF}"

  export DEBIAN_FRONTEND=noninteractive

  echo "__GW_PREPARE_STARTED__=1"
  echo "__GW_PREPARE_LOG_FILE__=${LOG_FILE}"

  # Create swap before any apt-heavy work so micro VMs do not crawl or OOM.
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

  set_step "deps"
  pin_guest_dns_to_gateway
  configure_ubuntu_sources_list
  apt-get update
  apt-get install -y ubuntu-keyring
  apt-get update
  apt-get upgrade -y
  apt-get install -y \
    curl \
    gh \
    gnupg \
    lsb-release \
    jq \
    fail2ban \
    build-essential \
    procps \
    file \
    git \
    wget \
    novnc \
    websockify \
    x11vnc \
    xvfb \
    pulseaudio \
    pulseaudio-utils \
    dbus-user-session \
    nano \
    lsof \
    openssl \
    ca-certificates \
    dnsutils \
    iptables \
    ufw \
    python3 \
    python3-pip \
    util-linux \
    unzip \
    ffmpeg \
    ripgrep \
    poppler-utils \
    imagemagick

  set_step "chrome"
  wget -q -O "${CHROME_DEB}" "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
  apt-get install -y "${CHROME_DEB}"
  google-chrome-stable --version

  command -v Xvfb >/dev/null 2>&1 || { echo "Missing Xvfb after dependency install" >&2; exit 1; }
  command -v websockify >/dev/null 2>&1 || { echo "Missing websockify after dependency install" >&2; exit 1; }
  command -v x11vnc >/dev/null 2>&1 || { echo "Missing x11vnc after dependency install" >&2; exit 1; }
  test -d /usr/share/novnc || { echo "Missing /usr/share/novnc after dependency install" >&2; exit 1; }
  command -v pulseaudio >/dev/null 2>&1 || { echo "Missing pulseaudio after dependency install" >&2; exit 1; }
  command -v pactl >/dev/null 2>&1 || { echo "Missing pactl after dependency install" >&2; exit 1; }
  command -v parec >/dev/null 2>&1 || { echo "Missing parec after dependency install" >&2; exit 1; }
  command -v pacat >/dev/null 2>&1 || { echo "Missing pacat after dependency install" >&2; exit 1; }

  set_step "logs"
  sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=100M/' /etc/systemd/journald.conf
  sed -i 's/^SystemMaxUse=.*/SystemMaxUse=100M/' /etc/systemd/journald.conf
  systemctl restart systemd-journald
  journalctl --vacuum-size=100M

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
  log_git_checkout_state "${RELAY_REPO_DIR}" "relay_after_checkout" "${RELAY_GIT_REF}"
  npm ci
  npm run build
  cd /root

  set_step "openclaw_install"
  npm install -g pnpm@10
  hash -r
  mkdir -p "${NODE_COMPILE_CACHE_DIR}" "${PNPM_HOME_DIR}"
  chmod 1777 "${NODE_COMPILE_CACHE_DIR}"
  export PNPM_HOME="${PNPM_HOME_DIR}"
  export PATH="${PNPM_HOME}:${PATH}"
  GLOBAL_PNPM_ROOT="$(pnpm root -g)"
  echo "Using global pnpm root: ${GLOBAL_PNPM_ROOT}"
  append_line_if_missing "${ROOT_BASHRC}" "export NODE_OPTIONS=\"${NODE_OPTIONS_VALUE}\""
  append_line_if_missing "${ROOT_BASHRC}" "export NODE_COMPILE_CACHE=\"${NODE_COMPILE_CACHE_DIR}\""
  append_line_if_missing "${ROOT_BASHRC}" 'export OPENCLAW_NO_RESPAWN=1'
  append_line_if_missing "${ROOT_BASHRC}" "export PNPM_HOME=\"${PNPM_HOME_DIR}\""
  append_line_if_missing "${ROOT_BASHRC}" 'export PATH="$PNPM_HOME:$PATH"'
  append_line_if_missing "${ROOT_BASHRC}" "export NODE_PATH=\"${GLOBAL_PNPM_ROOT}\""
  upsert_env_file_key /etc/environment NODE_OPTIONS "${NODE_OPTIONS_VALUE}"
  upsert_env_file_key /etc/environment NODE_COMPILE_CACHE "${NODE_COMPILE_CACHE_DIR}"
  upsert_env_file_key /etc/environment OPENCLAW_NO_RESPAWN "1"
  upsert_env_file_key /etc/environment PNPM_HOME "${PNPM_HOME_DIR}"
  upsert_env_file_key /etc/environment NODE_PATH "${GLOBAL_PNPM_ROOT}"
  write_file /etc/profile.d/golem-node-runtime.sh "#!/usr/bin/env bash
export NODE_OPTIONS=\"${NODE_OPTIONS_VALUE}\"
export NODE_COMPILE_CACHE=\"${NODE_COMPILE_CACHE_DIR}\"
export OPENCLAW_NO_RESPAWN=1
export PNPM_HOME=\"${PNPM_HOME_DIR}\"
export PATH=\"\$PNPM_HOME:\$PATH\"
export NODE_PATH=\"${GLOBAL_PNPM_ROOT}\"
"
  chmod 0644 /etc/profile.d/golem-node-runtime.sh
  rm -f /etc/systemd/system.conf.d/node-runtime.conf /etc/systemd/user.conf.d/node-runtime.conf
  write_file /etc/systemd/system.conf.d/node-runtime.conf "[Manager]
DefaultEnvironment=\"NODE_OPTIONS=${NODE_OPTIONS_VALUE}\" \"NODE_COMPILE_CACHE=${NODE_COMPILE_CACHE_DIR}\" \"OPENCLAW_NO_RESPAWN=1\" \"PNPM_HOME=${PNPM_HOME_DIR}\" \"NODE_PATH=${GLOBAL_PNPM_ROOT}\"
"
  write_file /etc/systemd/user.conf.d/node-runtime.conf "[Manager]
DefaultEnvironment=\"NODE_OPTIONS=${NODE_OPTIONS_VALUE}\" \"NODE_COMPILE_CACHE=${NODE_COMPILE_CACHE_DIR}\" \"OPENCLAW_NO_RESPAWN=1\" \"PNPM_HOME=${PNPM_HOME_DIR}\" \"NODE_PATH=${GLOBAL_PNPM_ROOT}\"
"
  export NODE_OPTIONS="${NODE_OPTIONS_VALUE}"
  export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE_DIR}"
  export OPENCLAW_NO_RESPAWN=1
  export NODE_PATH="${GLOBAL_PNPM_ROOT}"
  export OPENCLAW_SKIP_CANVAS_HOST=1
  export OPENCLAW_LOG_LEVEL=debug
  prepare_root_user_systemd
  systemctl --user import-environment \
    NODE_OPTIONS \
    NODE_COMPILE_CACHE \
    OPENCLAW_NO_RESPAWN \
    PNPM_HOME \
    NODE_PATH \
    OPENCLAW_SKIP_CANVAS_HOST \
    OPENCLAW_LOG_LEVEL || true
  env SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm --config.node-linker=hoisted add -g @openai/codex@latest openclaw@latest grammy playwright @grammyjs/runner @grammyjs/transformer-throttler @buape/carbon @larksuiteoapi/node-sdk @slack/bolt
  CODEX_PACKAGE_DIR="${GLOBAL_PNPM_ROOT}/@openai/codex"
  OPENCLAW_PACKAGE_DIR="${GLOBAL_PNPM_ROOT}/openclaw"
  test -f "${CODEX_PACKAGE_DIR}/package.json"
  test -f "${OPENCLAW_PACKAGE_DIR}/package.json"
  OPENCLAW_INSTALLED_VERSION="$(node -e "const pkg=require('${OPENCLAW_PACKAGE_DIR}/package.json'); process.stdout.write(String(pkg.version || ''))")"
  if [[ -z "${OPENCLAW_INSTALLED_VERSION}" ]]; then
    echo "Unable to resolve installed OpenClaw version from ${OPENCLAW_PACKAGE_DIR}/package.json" >&2
    exit 1
  fi
  CODEX_PLUGIN_NPM_SPEC="@openclaw/codex@${OPENCLAW_INSTALLED_VERSION}"
  test -x "${GLOBAL_PNPM_ROOT}/.bin/codex"
  test -x "${GLOBAL_PNPM_ROOT}/.bin/openclaw"
  ln -sfn "${GLOBAL_PNPM_ROOT}/.bin/codex" /usr/local/bin/codex
  ln -sfn "${GLOBAL_PNPM_ROOT}/.bin/openclaw" /usr/local/bin/openclaw
  test -x /usr/local/bin/codex
  test -x /usr/local/bin/openclaw
  command -v codex >/dev/null 2>&1
  command -v openclaw >/dev/null 2>&1
  mkdir -p /root/.codex
  write_file /root/.codex/config.toml "openai_base_url = \"${OPENAI_PROXY_BASE_URL}\"
cli_auth_credentials_store = \"file\"
model_provider = \"openai\"
sandbox_mode = \"danger-full-access\"
approval_policy = \"never\"
allow_login_shell = true
web_search = \"live\"

[features]
hooks = false

[hooks]
PreToolUse = []
PostToolUse = []
PermissionRequest = []
Stop = []
"
  write_file /root/.codex/auth.json "{
  \"auth_mode\": \"apikey\",
  \"OPENAI_API_KEY\": \"GOLEM_OPENAI_STUB\"
}
"
  write_file "${CODEX_WRAPPER_PATH}" "#!/usr/bin/env bash
set -euo pipefail
MANAGED_CODEX_HOME=\"\$HOME/.codex\"
CODEX_HOME=\"\${MANAGED_CODEX_HOME}\"
export CODEX_HOME
REAL_CODEX=\"/usr/local/bin/codex\"
if [[ ! -x \"\${REAL_CODEX}\" ]]; then
  echo \"Managed Codex wrapper could not find codex binary at \${REAL_CODEX}\" >&2
  exit 1
fi
mkdir -p \"\${MANAGED_CODEX_HOME}\"
# Agent servers are already externally isolated; keep Codex shell commands
# unsandboxed here so tools like gh can open DNS/TCP sockets normally.
exec \"\${REAL_CODEX}\" --dangerously-bypass-approvals-and-sandbox -c sandbox_mode='\"danger-full-access\"' -c approval_policy='\"never\"' -c allow_login_shell=true -c web_search='\"live\"' -c features.hooks=false -c hooks.PreToolUse=[] -c hooks.PostToolUse=[] -c hooks.PermissionRequest=[] -c hooks.Stop=[] \"\$@\"
"
  chmod 0755 "${CODEX_WRAPPER_PATH}"
  OPENCLAW_GRAMMY_PACKAGE_DIR="${GLOBAL_PNPM_ROOT}/grammy"
  OPENCLAW_GRAMMY_RUNNER_PACKAGE_DIR="${GLOBAL_PNPM_ROOT}/@grammyjs/runner"
  OPENCLAW_GRAMMY_TRANSFORMER_THROTTLER_PACKAGE_DIR="${GLOBAL_PNPM_ROOT}/@grammyjs/transformer-throttler"
  test -f "${OPENCLAW_GRAMMY_PACKAGE_DIR}/package.json"
  test -f "${OPENCLAW_GRAMMY_RUNNER_PACKAGE_DIR}/package.json"
  test -f "${OPENCLAW_GRAMMY_TRANSFORMER_THROTTLER_PACKAGE_DIR}/package.json"
  set_step "openclaw_mutation_guard"
  stop_openclaw_gateway_if_present
  set_step "relay_channel_prepull"
  if [[ -d "${RELAY_CHANNEL_PLUGIN_REPO_DIR}/.git" ]]; then
    cd "${RELAY_CHANNEL_PLUGIN_REPO_DIR}"
    git fetch --prune origin "${RELAY_CHANNEL_PLUGIN_GIT_REF}"
    git checkout "${RELAY_CHANNEL_PLUGIN_GIT_REF}"
    git reset --hard "origin/${RELAY_CHANNEL_PLUGIN_GIT_REF}"
  else
    rm -rf "${RELAY_CHANNEL_PLUGIN_REPO_DIR}"
    git clone --branch "${RELAY_CHANNEL_PLUGIN_GIT_REF}" --single-branch "${RELAY_CHANNEL_PLUGIN_REPO_URL}" "${RELAY_CHANNEL_PLUGIN_REPO_DIR}"
    cd "${RELAY_CHANNEL_PLUGIN_REPO_DIR}"
  fi
  log_git_checkout_state "${RELAY_CHANNEL_PLUGIN_REPO_DIR}" "relay_channel_plugin_after_checkout" "${RELAY_CHANNEL_PLUGIN_GIT_REF}"
  npm ci
  npm run bundle:agent
  RELAY_CHANNEL_BUNDLE_TGZ="${RELAY_CHANNEL_PLUGIN_REPO_DIR}/.artifacts/relay-channel/relay-channel-bundle.tgz"
  test -f "${RELAY_CHANNEL_BUNDLE_TGZ}"

  set_step "relay_channel_install"
  openclaw plugins uninstall relay-channel --force >/dev/null 2>&1 || true
  rm -rf /root/.openclaw/extensions/relay-channel
  node --input-type=module - <<'NODE'
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const pluginId = "relay-channel"
const configDir = path.join(os.homedir(), ".openclaw")
const configPath = path.join(configDir, "openclaw.json")

function ensureRecord(parent, key) {
  const current = parent?.[key]
  if (current && typeof current === "object" && !Array.isArray(current)) return current
  const next = {}
  parent[key] = next
  return next
}

let cfg = {}
if (fs.existsSync(configPath)) {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"))
}
if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
  cfg = {}
}

const pluginsCfg = ensureRecord(cfg, "plugins")
const entriesCfg = ensureRecord(pluginsCfg, "entries")
const existingEntry = entriesCfg[pluginId]
const enabled =
  existingEntry &&
  typeof existingEntry === "object" &&
  !Array.isArray(existingEntry) &&
  typeof existingEntry.enabled === "boolean"
    ? existingEntry.enabled
    : true
entriesCfg[pluginId] = {
  enabled,
  config: {
    accounts: [{ id: "default" }],
  },
}

fs.mkdirSync(configDir, { recursive: true })
fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`)
NODE
  openclaw plugins install "${RELAY_CHANNEL_BUNDLE_TGZ}"
  RELAY_CHANNEL_INSTALL_DIR="$(node --input-type=module - <<'NODE'
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const pluginId = "relay-channel"
const defaultInstallDir = path.join(os.homedir(), ".openclaw", "extensions", pluginId)
const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json")

function resolveInstallDir(candidate) {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return null
  const resolved = fs.realpathSync(candidate)
  const manifestPath = path.join(resolved, "openclaw.plugin.json")
  if (!fs.existsSync(manifestPath)) return null
  return resolved
}

let installDir = null
if (fs.existsSync(configPath)) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"))
  const installRecord =
    cfg?.plugins &&
    typeof cfg.plugins === "object" &&
    !Array.isArray(cfg.plugins) &&
    cfg.plugins.installs &&
    typeof cfg.plugins.installs === "object" &&
    !Array.isArray(cfg.plugins.installs)
      ? cfg.plugins.installs[pluginId]
      : null
  installDir =
    installRecord && typeof installRecord === "object" && !Array.isArray(installRecord)
      ? resolveInstallDir(installRecord.installPath)
      : null
}

if (!installDir) {
  installDir = resolveInstallDir(defaultInstallDir)
}

if (!installDir) {
  throw new Error(`Unable to resolve relay-channel install dir after install; checked config and ${defaultInstallDir}`)
}

process.stdout.write(installDir)
NODE
)"
  test -n "${RELAY_CHANNEL_INSTALL_DIR}"
  openclaw plugins disable relay-channel
  node --input-type=module - "${RELAY_CHANNEL_INSTALL_DIR}" <<'NODE'
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const expectedInstallDir = fs.realpathSync(process.argv[2])
const pluginId = "relay-channel"
const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json")
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"))

function ensureRecord(parent, key) {
  const current = parent?.[key]
  if (current && typeof current === "object" && !Array.isArray(current)) return current
  const next = {}
  parent[key] = next
  return next
}

if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
  throw new Error(`Unexpected OpenClaw config shape in ${configPath}`)
}

const pluginsCfg = ensureRecord(cfg, "plugins")
const installsCfg = ensureRecord(pluginsCfg, "installs")
const installRecord =
  installsCfg[pluginId] && typeof installsCfg[pluginId] === "object" && !Array.isArray(installsCfg[pluginId])
    ? installsCfg[pluginId]
    : {}
installRecord.installPath = expectedInstallDir
installsCfg[pluginId] = installRecord

const entriesCfg = ensureRecord(pluginsCfg, "entries")
const existingEntry = entriesCfg[pluginId]
if (existingEntry && typeof existingEntry === "object" && !Array.isArray(existingEntry)) {
  existingEntry.enabled = false
}

fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`)

const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"))
const persistedInstallRecord =
  persisted?.plugins &&
  typeof persisted.plugins === "object" &&
  !Array.isArray(persisted.plugins) &&
  persisted.plugins.installs &&
  typeof persisted.plugins.installs === "object" &&
  !Array.isArray(persisted.plugins.installs)
    ? persisted.plugins.installs[pluginId]
    : null
if (!persistedInstallRecord || typeof persistedInstallRecord !== "object" || Array.isArray(persistedInstallRecord)) {
  throw new Error("Missing relay-channel install record in openclaw.json")
}
if (
  typeof persistedInstallRecord.installPath !== "string" ||
  persistedInstallRecord.installPath.trim().length === 0
) {
  throw new Error("relay-channel install record is missing installPath")
}
const installDir = fs.realpathSync(persistedInstallRecord.installPath)
if (installDir !== expectedInstallDir) {
  throw new Error(`relay-channel installPath mismatch: expected ${expectedInstallDir}, got ${installDir}`)
}
const manifestPath = path.join(installDir, "openclaw.plugin.json")
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
if (manifest?.id !== "relay-channel") {
  throw new Error(`Unexpected relay-channel plugin id in ${manifestPath}`)
}
if (!fs.existsSync(path.join(installDir, "dist", "index.js"))) {
  throw new Error(`Missing relay-channel dist/index.js in ${installDir}`)
}
console.log(`relay-channel prepared: ${installDir}`)
NODE

  set_step "openclaw_codex_plugin_install"
  openclaw plugins uninstall codex --force >/dev/null 2>&1 || true
  rm -rf /root/.openclaw/extensions/codex
  openclaw plugins install "${CODEX_PLUGIN_NPM_SPEC}"
  CODEX_PLUGIN_INSTALL_DIR="$(node --input-type=module - <<'NODE'
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const pluginId = "codex"
const defaultInstallDirs = [
  path.join(os.homedir(), ".openclaw", "npm", "node_modules", "@openclaw", "codex"),
  path.join(os.homedir(), ".openclaw", "extensions", pluginId),
]
const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json")
const pluginIndexPath = path.join(os.homedir(), ".openclaw", "plugins", "installs.json")

function resolveInstallDir(candidate) {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return null
  if (!fs.existsSync(candidate)) return null
  const resolved = fs.realpathSync(candidate)
  const manifestPath = path.join(resolved, "openclaw.plugin.json")
  if (!fs.existsSync(manifestPath)) return null
  return resolved
}

let installDir = null
if (fs.existsSync(configPath)) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"))
  const installRecord =
    cfg?.plugins &&
    typeof cfg.plugins === "object" &&
    !Array.isArray(cfg.plugins) &&
    cfg.plugins.installs &&
    typeof cfg.plugins.installs === "object" &&
    !Array.isArray(cfg.plugins.installs)
      ? cfg.plugins.installs[pluginId]
      : null
  installDir =
    installRecord && typeof installRecord === "object" && !Array.isArray(installRecord)
      ? resolveInstallDir(installRecord.installPath)
      : null
}

if (!installDir && fs.existsSync(pluginIndexPath)) {
  const pluginIndex = JSON.parse(fs.readFileSync(pluginIndexPath, "utf8"))
  const installRecord =
    pluginIndex?.installRecords &&
    typeof pluginIndex.installRecords === "object" &&
    !Array.isArray(pluginIndex.installRecords)
      ? pluginIndex.installRecords[pluginId]
      : null
  installDir =
    installRecord && typeof installRecord === "object" && !Array.isArray(installRecord)
      ? resolveInstallDir(installRecord.installPath)
      : null
}

if (!installDir) {
  installDir = defaultInstallDirs.map(resolveInstallDir).find(Boolean) ?? null
}

if (!installDir) {
  const projectRoot = path.join(os.homedir(), ".openclaw", "npm", "projects")
  if (fs.existsSync(projectRoot)) {
    installDir =
      fs.readdirSync(projectRoot)
        .filter((name) => name.startsWith("openclaw-codex-"))
        .flatMap((name) => {
          const projectDir = path.join(projectRoot, name)
          return [
            projectDir,
            path.join(projectDir, "node_modules", "@openclaw", "codex"),
          ]
        })
        .map(resolveInstallDir)
        .find(Boolean) ?? null
  }
}

if (!installDir) {
  throw new Error(
    `Unable to resolve codex install dir after install; checked config, ${pluginIndexPath}, and ${defaultInstallDirs.join(", ")}`
  )
}

process.stdout.write(installDir)
NODE
)"
  test -n "${CODEX_PLUGIN_INSTALL_DIR}"
  openclaw plugins disable codex || true
  node --input-type=module - "${CODEX_PLUGIN_INSTALL_DIR}" <<'NODE'
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const expectedInstallDir = fs.realpathSync(process.argv[2])
const pluginId = "codex"
const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json")
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"))

function ensureRecord(parent, key) {
  const current = parent?.[key]
  if (current && typeof current === "object" && !Array.isArray(current)) return current
  const next = {}
  parent[key] = next
  return next
}

if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
  throw new Error(`Unexpected OpenClaw config shape in ${configPath}`)
}

const pluginsCfg = ensureRecord(cfg, "plugins")
const installsCfg = ensureRecord(pluginsCfg, "installs")
const installRecord =
  installsCfg[pluginId] && typeof installsCfg[pluginId] === "object" && !Array.isArray(installsCfg[pluginId])
    ? installsCfg[pluginId]
    : {}
installRecord.installPath = expectedInstallDir
installsCfg[pluginId] = installRecord

const entriesCfg = ensureRecord(pluginsCfg, "entries")
const existingEntry = entriesCfg[pluginId]
if (existingEntry && typeof existingEntry === "object" && !Array.isArray(existingEntry)) {
  existingEntry.enabled = false
}

fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`)

const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"))
const persistedInstallRecord =
  persisted?.plugins &&
  typeof persisted.plugins === "object" &&
  !Array.isArray(persisted.plugins) &&
  persisted.plugins.installs &&
  typeof persisted.plugins.installs === "object" &&
  !Array.isArray(persisted.plugins.installs)
    ? persisted.plugins.installs[pluginId]
    : null
if (!persistedInstallRecord || typeof persistedInstallRecord !== "object" || Array.isArray(persistedInstallRecord)) {
  throw new Error("Missing codex install record in openclaw.json")
}
if (
  typeof persistedInstallRecord.installPath !== "string" ||
  persistedInstallRecord.installPath.trim().length === 0
) {
  throw new Error("codex install record is missing installPath")
}
const installDir = fs.realpathSync(persistedInstallRecord.installPath)
if (installDir !== expectedInstallDir) {
  throw new Error(`codex installPath mismatch: expected ${expectedInstallDir}, got ${installDir}`)
}
const manifestPath = path.join(installDir, "openclaw.plugin.json")
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
if (manifest?.id !== "codex") {
  throw new Error(`Unexpected codex plugin id in ${manifestPath}`)
}
if (!fs.existsSync(path.join(installDir, "dist", "index.js"))) {
  throw new Error(`Missing codex dist/index.js in ${installDir}`)
}

const patchedFiles = []
function patchCodexNativeHookRelayDefaults(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      patchCodexNativeHookRelayDefaults(fullPath)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue
    let source = fs.readFileSync(fullPath, "utf8")
    const original = source
    source = source
      .replace(/nativeHookRelay:\s*\{\s*enabled:\s*true\s*\}/g, "nativeHookRelay: { enabled: false }")
      .replace(/nativeHookRelay:\{enabled:true\}/g, "nativeHookRelay:{enabled:false}")
    if (source !== original) {
      fs.writeFileSync(fullPath, source)
      patchedFiles.push(path.relative(installDir, fullPath))
    }
  }
}

patchCodexNativeHookRelayDefaults(installDir)
function hasEnabledCodexNativeHookRelayDefault(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      if (hasEnabledCodexNativeHookRelayDefault(fullPath)) return true
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue
    const source = fs.readFileSync(fullPath, "utf8")
    if (/nativeHookRelay:\s*\{\s*enabled:\s*true\s*\}/.test(source) || /nativeHookRelay:\{enabled:true\}/.test(source)) {
      return true
    }
  }
  return false
}

if (hasEnabledCodexNativeHookRelayDefault(installDir)) {
  throw new Error(`Failed to disable Codex native hook relay in ${installDir}; enabled harness defaults remain`)
}
console.log(`codex prepared: ${installDir}`)
console.log(patchedFiles.length > 0 ? `codex native hook relay disabled in: ${patchedFiles.join(", ")}` : "codex native hook relay already disabled")
NODE

  test -f "${GLOBAL_PNPM_ROOT}/playwright/package.json"
  if [[ "${RUN_OPENCLAW_ONBOARD}" == "1" ]]; then
    set_step "openclaw_onboard"
    run_openclaw_onboard_and_verify
  else
    echo "Skipping openclaw onboard --install-daemon by request."
  fi

  set_step "openclaw_snapshot_channels_warmup_config"
  write_openclaw_snapshot_warmup_config

  set_step "openclaw_whatsapp_plugin_install"
  install_openclaw_whatsapp_plugin

  set_step "openclaw_snapshot_channels_warmup_start"
  warm_openclaw_snapshot_channels

  set_step "openclaw_snapshot_channels_warmup_status"
  openclaw channels status --json || true

  set_step "openclaw_snapshot_shutdown"
  prepare_root_user_systemd
  systemctl --user daemon-reload || true
  systemctl --user stop openclaw-gateway.service || true
  systemctl --user disable openclaw-gateway.service || true
  systemctl --user reset-failed openclaw-gateway.service || true

  set_step "openclaw_snapshot_config_seal"
  node --input-type=module - <<'NODE'
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const configDir = path.join(os.homedir(), ".openclaw")
const configPath = path.join(configDir, "openclaw.json")
const requiredPluginIds = ["relay-channel", "codex", "whatsapp"]
const installedButDisabledPluginIds = ["relay-channel", "codex", "telegram"]
const stalePluginIds = ["memory-lancedb-pro", "memory-lancedb"]
const defaultExtensionsDir = path.join(configDir, "extensions")
const pluginIndexPath = path.join(configDir, "plugins", "installs.json")

if (!fs.existsSync(configPath)) {
  throw new Error(`Missing canonical OpenClaw config at ${configPath}`)
}

const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"))
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
  throw new Error(`Unexpected OpenClaw config shape in ${configPath}`)
}

function ensureRecord(parent, key) {
  const current = parent?.[key]
  if (current && typeof current === "object" && !Array.isArray(current)) return current
  const next = {}
  parent[key] = next
  return next
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}

function resolvePluginInstallDir(pluginId, installRecord) {
  function validatePluginDir(candidate) {
    if (!fs.existsSync(candidate)) {
      return null
    }
    const resolved = fs.realpathSync(candidate)
    const manifestPath = path.join(resolved, "openclaw.plugin.json")
    if (!fs.existsSync(manifestPath)) {
      return null
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (manifest?.id !== pluginId) {
      throw new Error(`Unexpected plugin id in ${manifestPath}`)
    }
    if (!fs.existsSync(path.join(resolved, "dist", "index.js"))) {
      throw new Error(`Missing plugin dist/index.js in ${resolved}`)
    }
    return resolved
  }

  const directCandidates = []
  if (
    installRecord &&
    typeof installRecord === "object" &&
    !Array.isArray(installRecord) &&
    typeof installRecord.installPath === "string" &&
    installRecord.installPath.trim().length > 0
  ) {
    directCandidates.push(installRecord.installPath)
  }
  if (fs.existsSync(pluginIndexPath)) {
    const pluginIndex = JSON.parse(fs.readFileSync(pluginIndexPath, "utf8"))
    const indexedInstallRecord =
      pluginIndex?.installRecords &&
      typeof pluginIndex.installRecords === "object" &&
      !Array.isArray(pluginIndex.installRecords)
        ? pluginIndex.installRecords[pluginId]
        : null
    if (
      indexedInstallRecord &&
      typeof indexedInstallRecord === "object" &&
      !Array.isArray(indexedInstallRecord) &&
      typeof indexedInstallRecord.installPath === "string" &&
      indexedInstallRecord.installPath.trim().length > 0
    ) {
      directCandidates.push(indexedInstallRecord.installPath)
    }
  }
  if (pluginId === "codex") {
    directCandidates.push(path.join(configDir, "npm", "node_modules", "@openclaw", "codex"))
  }
  directCandidates.push(path.join(defaultExtensionsDir, pluginId))

  for (const directCandidate of directCandidates) {
    const resolved = validatePluginDir(directCandidate)
    if (resolved) return resolved
  }
  if (pluginId === "codex") {
    const projectRoot = path.join(configDir, "npm", "projects")
    if (fs.existsSync(projectRoot)) {
      for (const projectName of fs.readdirSync(projectRoot)) {
        if (!projectName.startsWith("openclaw-codex-")) continue
        const resolved = validatePluginDir(path.join(projectRoot, projectName, "node_modules", "@openclaw", "codex"))
        if (resolved) return resolved
      }
    }
  }
  return null
}

const installs =
  parsed.plugins &&
  typeof parsed.plugins === "object" &&
  !Array.isArray(parsed.plugins) &&
  parsed.plugins.installs &&
  typeof parsed.plugins.installs === "object" &&
  !Array.isArray(parsed.plugins.installs)
    ? parsed.plugins.installs
    : {}

for (const pluginId of requiredPluginIds) {
  const installDir = resolvePluginInstallDir(pluginId, installs[pluginId])
  if (!installDir) {
    throw new Error(`Unable to resolve installed plugin directory for ${pluginId} in ${configPath}`)
  }
  installs[pluginId] = {
    ...(installs[pluginId] && typeof installs[pluginId] === "object" && !Array.isArray(installs[pluginId])
      ? installs[pluginId]
      : {}),
    installPath: installDir,
  }
}

const pluginsCfg = ensureRecord(parsed, "plugins")
pluginsCfg.installs = installs
const entriesCfg = ensureRecord(pluginsCfg, "entries")
for (const pluginId of stalePluginIds) {
  delete entriesCfg[pluginId]
}
for (const pluginId of installedButDisabledPluginIds) {
  delete entriesCfg[pluginId]
}

if (pluginsCfg.installs && typeof pluginsCfg.installs === "object" && !Array.isArray(pluginsCfg.installs)) {
  for (const pluginId of stalePluginIds) {
    delete pluginsCfg.installs[pluginId]
  }
  if (Object.keys(pluginsCfg.installs).length === 0) {
    delete pluginsCfg.installs
  }
}

const slotsCfg = ensureRecord(pluginsCfg, "slots")
delete slotsCfg.memory
if (Object.keys(slotsCfg).length === 0) {
  delete pluginsCfg.slots
}

const pluginAllow = Array.from(
  new Set(normalizeStringArray(pluginsCfg.allow).filter((item) => !stalePluginIds.includes(item)))
)
pluginsCfg.allow = pluginAllow
pluginsCfg.deny = Array.from(
  new Set([
    ...normalizeStringArray(pluginsCfg.deny).filter((item) => !pluginAllow.includes(item)),
    ...installedButDisabledPluginIds,
  ])
)

if (parsed.channels && typeof parsed.channels === "object" && !Array.isArray(parsed.channels)) {
  for (const pluginId of installedButDisabledPluginIds) {
    delete parsed.channels[pluginId]
  }
  if (Object.keys(parsed.channels).length === 0) {
    delete parsed.channels
  }
}

const normalizedJson = `${JSON.stringify(parsed, null, 2)}\n`
fs.mkdirSync(configDir, { recursive: true })
const tmpPath = `${configPath}.gwtmp-${Date.now()}-${Math.random().toString(16).slice(2)}`

try {
  const fd = fs.openSync(tmpPath, "w")
  try {
    fs.writeFileSync(fd, normalizedJson, "utf8")
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, configPath)
  const dirFd = fs.openSync(configDir, "r")
  try {
    fs.fsyncSync(dirFd)
  } finally {
    fs.closeSync(dirFd)
  }
} finally {
  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath)
  }
}

console.log(`sealed canonical openclaw config at ${configPath}`)
NODE
  test -f /root/.openclaw/openclaw.json

  set_step "done"
  echo "__GW_PREPARE_DONE__=1"
  echo "Prepare agent server completed successfully."
  echo "Log file: ${LOG_FILE}"
}

main "$@"
