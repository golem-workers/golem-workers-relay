#!/usr/bin/env bash
set -euo pipefail
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../skills/golem-spreadsheets" && pwd)"
DEST="${1:-/opt/golem-spreadsheets}"
SKILLS="${2:-/root/.openclaw/workspace/skills}"
BIN="${3:-/usr/local/bin}"
command -v node >/dev/null
command -v soffice >/dev/null
/usr/bin/python3 -c 'import uno, openpyxl; from PIL import Image'
# Vendored upstream tarball and npm lock protect snapshot builds from mutable registries.
(cd "${SOURCE}" && sha256sum --check manifest.sha256)
if [[ -e "${DEST}" && ! -L "${DEST}" ]]; then
  echo "Refusing to replace non-managed directory: ${DEST}" >&2; exit 1
fi
mkdir -p "$(dirname "${DEST}")" "${SKILLS}" "${BIN}"
stage="$(mktemp -d "$(dirname "${DEST}")/.golem-spreadsheets-XXXXXXXX")"
trap 'rm -rf "${stage}"' EXIT
cp -a "${SOURCE}/package.json" "${SOURCE}/package-lock.json" "${SOURCE}/vendor" "${stage}/"
mkdir "${stage}/scripts"
cp "${SOURCE}/scripts/"*.py "${SOURCE}/scripts/"*.cjs "${stage}/scripts/"
(cd "${stage}" && npm ci --ignore-scripts --no-audit --no-fund)
node "${stage}/scripts/spreadsheet.cjs" capabilities >/dev/null
# Existing generations remain usable until a new fully checked generation is ready.
generation="${DEST}-$(date -u +%Y%m%dT%H%M%S)-$$"
mv "${stage}" "${generation}"
ln -sfn "${generation}" "${DEST}.new"
mv -Tf "${DEST}.new" "${DEST}"
launcher="$(mktemp "${BIN}/.golem-spreadsheet-XXXXXXXX")"
printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "${DEST}/scripts/spreadsheet.cjs" >"${launcher}"
chmod 0755 "${launcher}"
mv -f "${launcher}" "${BIN}/golem-spreadsheet"
mkdir -p "${SKILLS}/golem-spreadsheets/references"
cp "${SOURCE}/SKILL.md" "${SKILLS}/golem-spreadsheets/SKILL.md"
cp "${SOURCE}/references/"*.md "${SKILLS}/golem-spreadsheets/references/"
"${BIN}/golem-spreadsheet" capabilities
