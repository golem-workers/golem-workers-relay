#!/usr/bin/env bash
set -eu

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -d "node_modules" ]; then
  echo "[relay] node_modules missing; running npm ci"
  npm ci
fi

echo "[relay] building"
npm run build

echo "[relay] starting"
exec npm run start

