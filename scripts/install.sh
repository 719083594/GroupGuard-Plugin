#!/usr/bin/env bash
# Run on the Docker HOST, not inside the robot container.
set -euo pipefail
for tool in git python3; do
  command -v "$tool" >/dev/null 2>&1 || { printf '缺少 %s；请先安装，再重试。\n' "$tool" >&2; exit 1; }
done
task_checkout=$(mktemp -d "${TMPDIR:-/tmp}/groupguard-install.XXXXXXXX")
trap 'rm -rf -- "$task_checkout"' EXIT
git clone --quiet --depth 1 --branch main -- https://github.com/719083594/GroupGuard-Plugin.git "$task_checkout/source"
python3 "$task_checkout/source/scripts/install.py" "$@"
