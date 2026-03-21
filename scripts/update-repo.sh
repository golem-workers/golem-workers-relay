#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

FORCE_RESTART=0
for arg in "$@"; do
  case "${arg}" in
    force|--force|-f)
      FORCE_RESTART=1
      ;;
    *)
      echo "Unknown argument: ${arg}"
      echo "Usage: $0 [force|--force|-f]"
      exit 1
      ;;
  esac
done

# Default service name for systemd restart. If the caller explicitly sets
# SERVICE_NAME="" we treat that as "do not restart".
if [[ -z "${SERVICE_NAME+x}" ]]; then
  SERVICE_NAME="golem-workers-relay"
fi

trim_spaces() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "${s}"
}

normalize_runtime_env() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "${value}" in
    production|prod)
      echo "production"
      ;;
    development|dev|test|local)
      echo "development"
      ;;
    *)
      echo ""
      ;;
  esac
}

read_env_value() {
  local env_file="$1"
  local key="$2"

  [[ -f "${env_file}" ]] || return 1

  awk -F '=' -v key="${key}" '
    $0 ~ ("^[[:space:]]*" key "[[:space:]]*=") {
      sub("^[[:space:]]*" key "[[:space:]]*=", "", $0)
      print $0
      exit
    }
  ' "${env_file}"
}

detect_runtime_env() {
  local candidate=""
  local systemd_env=""

  for candidate in "${DEPLOY_ENV:-}" "${APP_ENV:-}" "${NODE_ENV:-}"; do
    candidate="$(normalize_runtime_env "$(trim_spaces "${candidate}")")"
    if [[ -n "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done

  candidate="$(read_env_value "${ROOT_DIR}/.env" NODE_ENV 2>/dev/null || true)"
  candidate="$(normalize_runtime_env "$(trim_spaces "${candidate}" | tr -d '"' | tr -d "'")")"
  if [[ -n "${candidate}" ]]; then
    echo "${candidate}"
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemd_env="$(systemctl cat "${SERVICE_NAME}" 2>/dev/null | sed -n \
      -e 's/^[[:space:]]*Environment=NODE_ENV=//p' \
      -e 's/^[[:space:]]*Environment="NODE_ENV=\([^"]*\)".*/\1/p' \
      | sed -n '1p')"
    candidate="$(normalize_runtime_env "$(trim_spaces "${systemd_env}")")"
    if [[ -n "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  fi

  echo "NODE_ENV is not set; defaulting runtime environment to production-safe mode."
  echo "production"
}

resolve_branch() {
  local runtime_env="$1"
  local explicit_branch="${BRANCH:-}"

  if [[ "${runtime_env}" == "production" ]]; then
    if [[ -n "${explicit_branch}" && "${explicit_branch}" != "release" ]]; then
      echo "Ignoring BRANCH=${explicit_branch} because runtime environment is production; forcing release."
    fi
    echo "release"
    return 0
  fi

  if [[ "${runtime_env}" == "development" ]]; then
    if [[ -n "${explicit_branch}" && "${explicit_branch}" != "main" ]]; then
      echo "Ignoring BRANCH=${explicit_branch} because runtime environment is development; forcing main."
    fi
    echo "main"
    return 0
  fi

  if [[ -n "${explicit_branch}" ]]; then
    echo "${explicit_branch}"
    return 0
  fi

  echo "release"
}

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

RUNTIME_ENV="$(detect_runtime_env)"
REMOTE="${REMOTE:-origin}"
BRANCH="$(resolve_branch "${RUNTIME_ENV}")"

echo "Runtime environment: ${RUNTIME_ENV}"
echo "Git branch: ${BRANCH}"

OLD_HEAD="$(git rev-parse HEAD)"
git fetch "${REMOTE}" "${BRANCH}"
git reset --hard FETCH_HEAD
NEW_HEAD="$(git rev-parse HEAD)"

# Keep scripts executable even if checkout resets modes.
chmod 0777 "${ROOT_DIR}/scripts/update-repo.sh" "${ROOT_DIR}/scripts/start.sh" 2>/dev/null || true

HAS_CHANGES=0
if [[ "${OLD_HEAD}" != "${NEW_HEAD}" ]]; then
  HAS_CHANGES=1
fi

if [[ "${HAS_CHANGES}" -eq 1 || "${FORCE_RESTART}" -eq 1 ]]; then
  if [[ "${HAS_CHANGES}" -eq 1 ]]; then
    echo "Changes detected. Rebuilding..."
  else
    echo "No changes detected, but force mode requested. Running full rebuild..."
  fi
  "${NPM_BIN}" ci
  "${NPM_BIN}" run build
fi

if [[ "${HAS_CHANGES}" -eq 1 || "${FORCE_RESTART}" -eq 1 ]]; then
  if [[ "${HAS_CHANGES}" -eq 0 ]]; then
    echo "No changes detected, but force restart requested."
  fi

  # Optional systemd restart (defaults to "golem-workers-relay").
  # Best-effort: missing systemd/sudo/unit should not fail the update.
  if [[ -n "${SERVICE_NAME}" ]]; then
    if command -v systemctl >/dev/null 2>&1; then
      if systemctl cat "${SERVICE_NAME}" >/dev/null 2>&1; then
        echo "Restarting service: ${SERVICE_NAME}"
        if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
          systemctl restart "${SERVICE_NAME}" || echo "Service restart failed (non-fatal)."
        else
          if command -v sudo >/dev/null 2>&1; then
            sudo systemctl restart "${SERVICE_NAME}" || echo "Service restart failed (non-fatal)."
          else
            echo "sudo not available and not running as root; skipping service restart."
          fi
        fi
      else
        echo "systemd unit '${SERVICE_NAME}' not found; skipping service restart."
      fi
    else
      echo "systemctl not available; skipping service restart."
    fi
  else
    echo "SERVICE_NAME is empty; skipping service restart."
  fi
else
  echo "No changes detected. Nothing to do."
fi

