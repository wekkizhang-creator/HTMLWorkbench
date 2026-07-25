#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/html-workbench}"
REPO_URL="${REPO_URL:-https://github.com/wekkizhang-creator/HTMLWorkbench.git}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -n env APP_DIR="$APP_DIR" REPO_URL="$REPO_URL" DEPLOY_SHA="$DEPLOY_SHA" bash "$SCRIPT_DIR/deploy.sh"
fi

if [ "$APP_DIR" != "/opt/html-workbench" ]; then
  echo "APP_DIR must be /opt/html-workbench" >&2
  exit 1
fi

if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "DEPLOY_SHA must be a full 40-character Git commit SHA" >&2
  exit 1
fi

for command in curl git nginx node npm systemctl systemd-run; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 1; }
done

exec /usr/bin/node "$SCRIPT_DIR/deploy.mjs"
