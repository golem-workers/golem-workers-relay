#!/usr/bin/env bash
set -euo pipefail
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../tools/golem-spreadsheets" && pwd)"
DEST="${1:-/opt/golem-spreadsheets}"
BIN="${2:-/usr/local/bin}"
command -v node >/dev/null
command -v soffice >/dev/null
/usr/bin/python3 -c 'import uno, openpyxl; from PIL import Image'
# Vendored upstream tarball and npm lock protect snapshot builds from mutable registries.
(cd "${SOURCE}" && sha256sum --check manifest.sha256)
if [[ -e "${DEST}" && ! -L "${DEST}" ]]; then
  echo "Refusing to replace non-managed directory: ${DEST}" >&2; exit 1
fi
mkdir -p "$(dirname "${DEST}")" "${BIN}"
stage="$(mktemp -d "$(dirname "${DEST}")/.golem-spreadsheets-XXXXXXXX")"
trap 'rm -rf "${stage}"' EXIT
cp -a "${SOURCE}/package.json" "${SOURCE}/package-lock.json" "${SOURCE}/vendor" "${stage}/"
mkdir "${stage}/scripts"
cp "${SOURCE}/scripts/"*.py "${SOURCE}/scripts/"*.cjs "${stage}/scripts/"
(cd "${stage}" && npm ci --ignore-scripts --no-audit --no-fund)
node "${stage}/scripts/spreadsheet.cjs" self-check >/dev/null
# Existing generations remain usable until a new fully checked generation is ready.
generation="${DEST}-$(date -u +%Y%m%dT%H%M%S)-$$"
mv "${stage}" "${generation}"
ln -sfn "${generation}" "${DEST}.new"
mv -Tf "${DEST}.new" "${DEST}"
launcher="$(mktemp "${BIN}/.golem-spreadsheet-XXXXXXXX")"
printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "${DEST}/scripts/spreadsheet.cjs" >"${launcher}"
chmod 0755 "${launcher}"
mv -f "${launcher}" "${BIN}/golem-spreadsheet"
"${BIN}/golem-spreadsheet" self-check
