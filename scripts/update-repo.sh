#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Relative paths (stored inside the repo).
LOG_DIR="${ROOT_DIR}/logs"
PID_DIR="${ROOT_DIR}/pids"
LOG_FILE="${LOG_DIR}/git-update.log"
LOCK_FILE="${PID_DIR}/relay-update.pid.lock"

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

mkdir -p "${LOG_DIR}" "${PID_DIR}"

exec > >(tee -a "${LOG_FILE}") 2>&1

echo "---- $(date -u +"%Y-%m-%dT%H:%M:%SZ") ----"

acquire_lock() {
  # Prefer flock when available (common on Linux).
  if command -v flock >/dev/null 2>&1; then
    exec 200>"${LOCK_FILE}"
    if ! flock -n 200; then
      echo "Another instance is running. Exiting."
      exit 0
    fi
    return 0
  fi

  # Fallback lock: atomic mkdir (works on macOS and Linux).
  local lock_dir="${LOCK_FILE}.d"
  if ! mkdir "${lock_dir}" 2>/dev/null; then
    echo "Another instance is running. Exiting."
    exit 0
  fi
  trap 'rmdir "${lock_dir}" 2>/dev/null || true' EXIT
}

acquire_lock

if ! command -v git >/dev/null 2>&1; then
  echo "git not found in PATH; cannot update repo."
  exit 1
fi

resolve_npm() {
  if [[ -n "${NPM_BIN:-}" ]] && [[ -x "${NPM_BIN}" ]]; then
    echo "${NPM_BIN}"
    return 0
  fi
  local npm_path=""
  npm_path="$(command -v npm 2>/dev/null || true)"
  if [[ -n "${npm_path}" ]] && [[ -x "${npm_path}" ]]; then
    echo "${npm_path}"
    return 0
  fi
  for candidate in /usr/local/bin/npm /usr/bin/npm /opt/homebrew/bin/npm; do
    if [[ -x "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

NPM_BIN="$(resolve_npm || true)"
if [[ -z "${NPM_BIN}" ]]; then
  echo "npm not found; set NPM_BIN=/path/to/npm or adjust PATH."
  exit 1
fi

cd "${ROOT_DIR}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository: ${ROOT_DIR}"
  exit 1
fi

REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
REF="${REMOTE}/${BRANCH}"

OLD_HEAD="$(git rev-parse HEAD)"
git fetch "${REMOTE}" "${BRANCH}"
git reset --hard "${REF}"
git pull --ff-only "${REMOTE}" "${BRANCH}"
NEW_HEAD="$(git rev-parse HEAD)"

# Keep scripts executable even if checkout resets modes.
chmod 0777 "${ROOT_DIR}/scripts/update-repo.sh" "${ROOT_DIR}/scripts/start.sh" 2>/dev/null || true

if [[ "${OLD_HEAD}" != "${NEW_HEAD}" ]]; then
  echo "Changes detected. Rebuilding..."
  "${NPM_BIN}" ci
  "${NPM_BIN}" run build

  # Optional systemd restart (set SERVICE_NAME in env when using on a server).
  if [[ -n "${SERVICE_NAME:-}" ]]; then
    if command -v systemctl >/dev/null 2>&1; then
      echo "Restarting service: ${SERVICE_NAME}"
      if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
        systemctl restart "${SERVICE_NAME}"
      else
        if command -v sudo >/dev/null 2>&1; then
          sudo systemctl restart "${SERVICE_NAME}"
        else
          echo "sudo not available and not running as root; cannot restart service."
          exit 1
        fi
      fi
      echo "Service restarted."
    else
      echo "systemctl not available; skipping service restart."
    fi
  else
    echo "SERVICE_NAME not set; skipping service restart."
  fi
else
  echo "No changes detected. Nothing to do."
fi

