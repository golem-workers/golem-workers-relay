#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

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
exec "${NPM_BIN}" run start

