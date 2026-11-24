#!/usr/bin/env bash
# Shared Ubuntu runtime preparation for OpenClaw and Hermes base images.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  libreoffice-calc python3-uno python3-openpyxl python3-pil python3-xlrd \
  fonts-dejavu-core poppler-utils
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-spreadsheet-tools.sh"
