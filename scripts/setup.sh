#!/usr/bin/env bash
set -euo pipefail

# Installs:
# - systemd service to run relay (as root) via `npm run start`
# - executable bit for update script
# - hourly cron entry for update script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SERVICE_NAME="${SERVICE_NAME:-golem-workers-relay}"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
CRON_PATH="/etc/cron.d/${SERVICE_NAME}-update"

require_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "${BASH_SOURCE[0]}" "$@"
  fi
  echo "This script must be run as root (or with sudo)."
  exit 1
}

resolve_bin() {
  # $1 = binary name (npm/node); prints absolute path or empty.
  local name="$1"
  local p=""
  p="$(command -v "${name}" 2>/dev/null || true)"
  if [[ -n "${p}" ]] && [[ -x "${p}" ]]; then
    echo "${p}"
    return 0
  fi
  return 1
}

require_root "$@"

if [[ ! -f "${ROOT_DIR}/package.json" ]]; then
  echo "package.json not found at: ${ROOT_DIR}"
  exit 1
fi

if [[ ! -f "${ROOT_DIR}/scripts/update-repo.sh" ]]; then
  echo "update-repo.sh not found at: ${ROOT_DIR}/scripts/update-repo.sh"
  exit 1
fi

chmod 0755 "${ROOT_DIR}/scripts/update-repo.sh" "${ROOT_DIR}/scripts/start.sh" 2>/dev/null || true

NPM_BIN="${NPM_BIN:-$(resolve_bin npm || true)}"
NODE_BIN="${NODE_BIN:-$(resolve_bin node || true)}"

if [[ -z "${NPM_BIN}" ]]; then
  echo "npm not found in PATH. Set NPM_BIN=/absolute/path/to/npm and re-run."
  exit 1
fi
if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found in PATH. Set NODE_BIN=/absolute/path/to/node and re-run."
  exit 1
fi

NPM_DIR="$(cd "$(dirname "${NPM_BIN}")" && pwd)"
NODE_DIR="$(cd "$(dirname "${NODE_BIN}")" && pwd)"

# Ensure dependencies and build output exist before starting the service.
cd "${ROOT_DIR}"
echo "Installing npm dependencies..."
if [[ -f "${ROOT_DIR}/package-lock.json" ]]; then
  "${NPM_BIN}" ci
else
  "${NPM_BIN}" install
fi
echo "Building relay..."
"${NPM_BIN}" run build

# systemd service
if command -v systemctl >/dev/null 2>&1; then
  echo "Installing systemd unit: ${UNIT_PATH}"
  cat > "${UNIT_PATH}" <<EOF
[Unit]
Description=Golem Workers Relay
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${ROOT_DIR}
Environment=NODE_ENV=production
Environment=HOME=/root
Environment=PATH=${NPM_DIR}:${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${ROOT_DIR}/scripts/start.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"
  systemctl status "${SERVICE_NAME}" --no-pager || true
else
  echo "systemctl not found; skipping systemd service install."
fi

# Hourly cron entry for updates (root)
if [[ -d "/etc/cron.d" ]]; then
  echo "Installing cron entry: ${CRON_PATH}"
  mkdir -p "/var/log/${SERVICE_NAME}" 2>/dev/null || true

  cat > "${CRON_PATH}" <<EOF
SHELL=/bin/bash
PATH=${NPM_DIR}:${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

0 * * * * root SERVICE_NAME=${SERVICE_NAME} NPM_BIN=${NPM_BIN} ${ROOT_DIR}/scripts/update-repo.sh >> /var/log/${SERVICE_NAME}/cron-update.log 2>&1
EOF

  chmod 0644 "${CRON_PATH}"
else
  echo "/etc/cron.d not found; skipping cron install."
fi

echo "Setup complete."

