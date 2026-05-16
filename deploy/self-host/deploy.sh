#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/html-workbench}"
DATA_DIR="${HTML_WORKBENCH_DATA_DIR:-/var/lib/html-workbench}"
BRANCH="${BRANCH:-owncnd_codex/html}"
REPO_URL="${REPO_URL:-https://github.com/wekkizhang-creator/HTMLWorkbench.git}"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

if ! id htmlworkbench >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin htmlworkbench
fi

mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R htmlworkbench:htmlworkbench "$DATA_DIR"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
npm install --omit=dev

cp deploy/self-host/html-workbench.service /etc/systemd/system/html-workbench.service
if [ ! -f /etc/html-workbench.env ]; then
  cp deploy/self-host/html-workbench.env.example /etc/html-workbench.env
fi

systemctl daemon-reload
systemctl enable html-workbench
systemctl restart html-workbench

echo "HTMLWorkbench deployed. Check status with: systemctl status html-workbench"
