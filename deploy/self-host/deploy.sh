#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/html-workbench}"
DATA_DIR="/var/lib/html-workbench"
BRANCH="${BRANCH:-owncnd_codex/html}"
REPO_URL="${REPO_URL:-https://github.com/wekkizhang-creator/HTMLWorkbench.git}"
ENV_FILE="/etc/html-workbench.env"
ADMIN_SERVICE="html-workbench.service"
CONTENT_SERVICE="html-workbench-content.service"
STOP_WORLD=0
DEPLOY_COMPLETE=0
ADMIN_WAS_ACTIVE=0
CONTENT_WAS_LOADED=0

if [ "$(id -u)" -ne 0 ]; then
  echo "deploy.sh must run as root" >&2
  exit 1
fi

for command in curl git nginx node npm systemctl systemd-run; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required" >&2
    exit 1
  fi
done

if [ "$APP_DIR" != "/opt/html-workbench" ]; then
  echo "APP_DIR must be /opt/html-workbench because the systemd units use that path" >&2
  exit 1
fi

unit_exists() {
  local load_state
  load_state="$(systemctl show --property=LoadState --value "$1" 2>/dev/null || true)"
  [ -n "$load_state" ] && [ "$load_state" != "not-found" ]
}

require_env_value() {
  local name="$1"
  local line
  local value
  line="$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1 || true)"
  value="${line#*=}"
  if [ -z "$line" ] || [ -z "$value" ] || [[ "$value" == change-this-* ]]; then
    echo "Set a non-placeholder ${name} in ${ENV_FILE} before deployment" >&2
    exit 1
  fi
}

require_env_exact() {
  local name="$1"
  local expected="$2"
  if ! grep -Fxq "${name}=${expected}" "$ENV_FILE"; then
    echo "Set ${name}=${expected} in ${ENV_FILE} before deployment" >&2
    exit 1
  fi
}

restore_admin_on_failure() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$STOP_WORLD" -eq 1 ] && [ "$DEPLOY_COMPLETE" -eq 0 ]; then
    echo "Migration failed or deployment verification did not complete; public content will remain stopped." >&2
    systemctl stop html-workbench-content >/dev/null 2>&1 || true
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [ "$ADMIN_WAS_ACTIVE" -eq 1 ]; then
      if systemctl start html-workbench; then
        echo "The admin service was restored. Inspect the migration logs before retrying." >&2
      else
        echo "Admin restart also failed; run: systemctl status html-workbench --no-pager" >&2
      fi
    else
      echo "The admin service was not active before deployment and was not started." >&2
    fi
    echo "Do not start the content service. Use only the documented manual lock-recovery procedure after confirming no migration is active." >&2
  fi
  exit "$status"
}
trap restore_admin_on_failure EXIT

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
npm ci --omit=dev

cp deploy/self-host/html-workbench.service /etc/systemd/system/html-workbench.service
cp deploy/self-host/html-workbench-content.service /etc/systemd/system/html-workbench-content.service
if [ ! -f "$ENV_FILE" ]; then
  cp deploy/self-host/html-workbench.env.example "$ENV_FILE"
fi
chown root:htmlworkbench "$ENV_FILE"
chmod 640 "$ENV_FILE"

require_env_exact HTML_WORKBENCH_DATA_DIR /var/lib/html-workbench
require_env_exact HTML_WORKBENCH_ADMIN_ORIGIN https://ho.wekki.fun
require_env_exact HTML_WORKBENCH_PUBLIC_ORIGIN https://page.wekki.fun
require_env_value HTML_WORKBENCH_PASSWORD
require_env_value HTML_WORKBENCH_AUTH_SECRET
require_env_value HTML_WORKBENCH_DOWNLOAD_PASSWORD
require_env_value HTML_WORKBENCH_CURSOR_SECRET

if systemctl is-active --quiet html-workbench; then
  ADMIN_WAS_ACTIVE=1
fi
if unit_exists "$CONTENT_SERVICE"; then
  CONTENT_WAS_LOADED=1
fi

# Stop-the-world migration gate: no old process may write without leases.
STOP_WORLD=1
if unit_exists "$ADMIN_SERVICE"; then
  systemctl stop html-workbench
fi
if [ "$CONTENT_WAS_LOADED" -eq 1 ]; then
  systemctl stop html-workbench-content
fi

migration_unit="html-workbench-record-index-migration-$(date +%s)-$$"
systemd-run --quiet --wait --collect --pipe \
  --unit="$migration_unit" \
  --property="User=htmlworkbench" \
  --property="Group=htmlworkbench" \
  --property="WorkingDirectory=$APP_DIR" \
  --property="Environment=NODE_ENV=production" \
  --property="EnvironmentFile=$ENV_FILE" \
  /usr/bin/npm run migrate:record-index

systemctl daemon-reload
systemctl enable html-workbench html-workbench-content
systemctl restart html-workbench html-workbench-content

check_health() {
  local service="$1"
  local url="$2"
  local host="$3"
  local ready=0
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error --header "Host: ${host}" "$url" >/dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "${service} readiness check failed at ${url}" >&2
    systemctl status "$service" --no-pager || true
    return 1
  fi
}

check_health html-workbench http://127.0.0.1:3000/healthz ho.wekki.fun
check_health html-workbench-content http://127.0.0.1:3001/healthz page.wekki.fun
nginx -t
systemctl reload nginx

DEPLOY_COMPLETE=1
trap - EXIT
echo "HTMLWorkbench admin and content services deployed successfully."
