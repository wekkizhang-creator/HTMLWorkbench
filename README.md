# HTMLWorkbench
HTML 发布台

HTMLWorkbench publishes uploaded `.html`, `.htm`, or ZIP sites and manages their metadata. The trusted management origin and untrusted published content run as separate services in production.

## 本地运行

```bash
npm install
npm run dev
```

默认管理服务从 `http://localhost:3000` 启动。未配置 `BLOB_READ_WRITE_TOKEN` 时，开发数据写入未跟踪的 `data/` 目录。

## Vercel 部署

1. 在 Vercel 导入仓库。
2. 创建并连接 **Private** Vercel Blob Store。
3. 在 Production 和 Preview 环境显式配置下列全部变量：

```text
HTML_WORKBENCH_ADMIN_ORIGIN=https://desk.wekkii.cn
HTML_WORKBENCH_PUBLIC_ORIGIN=https://ho.wekkii.cn
HTML_WORKBENCH_PASSWORD=885688
HTML_WORKBENCH_AUTH_SECRET=<independent high-entropy random secret, at least 32 bytes>
HTML_WORKBENCH_DOWNLOAD_PASSWORD=885688
HTML_WORKBENCH_CURSOR_SECRET=<independent random cursor secret>
BLOB_READ_WRITE_TOKEN=<private Blob read-write token>
```

4. Framework Preset 选择 `Other`。不要覆盖仓库中的 Build Command：
   `node deploy/self-host/validate-env.mjs --profile vercel`。

`/view/:id` 由 `vercel.json` rewrite 到 `/api/view?id=:id`。自托管支持最大 30 MB 的代理请求；Vercel Serverless 的请求体限制不适合相同大小的直传。
`vercel.json` 的构建门禁和运行时门禁都会校验以上变量；缺失、空值、
`change-this-*` 占位值、弱签名密钥，或不精确的正式域名都会 fail closed。
`HTML_WORKBENCH_PASSWORD` 可以显式配置为 `885688`，但
`HTML_WORKBENCH_AUTH_SECRET` 不得与密码相同，必须使用独立强随机值。可用
`openssl rand -base64 48` 生成。

## 校验

```bash
npm run check
```

## HTML 可视化编辑

上传记录中的“编辑”打开三栏工作台：模块树、画布和属性面板。支持文字编辑、常用样式、高级 CSS、删除模块、撤销和重做；手机宽度使用抽屉面板。仅单 HTML 文件提供编辑入口，ZIP 站点暂不支持。

对于固定尺寸的 `.stage > .slide` 演示文稿，工作台自动显示逐页缩略图和等比画布，模块树仅显示当前页内容。支持文字/样式修改、PNG/JPEG/GIF/WebP 图片替换及撤销重做；图片限制为 8 MB、4000 万像素，保存后的 HTML 仍受 30 MB 限制。存在有效 `#notes-data` JSON 字符串数组时，可编辑当前页备注 HTML。保存恢复原稿隐藏状态与播放脚本；不支持新增、删除或重排幻灯片，也不提供图表数据编辑。无法可靠识别的布局回退到普通 HTML 模式。

演示文稿支持适应窗口、10%-200% 缩放和画布平移。撤销/重做会定位到受影响页面；缩略图只在内容变化时刷新，源码缓存最多 8 项、总计 8 MiB。

有效的未保存修改在停止输入 750 ms 后尝试写入当前浏览器的 IndexedDB，每个文档/编辑会话独立保存，草稿保留 7 天、每份最多 30 MiB。草稿是本机备份，不会自动发布，也不跨设备同步；清除浏览器数据会删除草稿。打开文档时可主动恢复同版本草稿，旧版本草稿仅允许导出，仍保留服务器版本冲突保护。存储被禁用或容量不足不会阻止手动导出 HTML 或正常服务器保存；成功发布只清理本会话及对应恢复快照，不删除其他标签页的新修改。

“保存并发布”直接更新原公开链接，同时保留保存前的单个历史版本供列表回滚。源文件被其他操作修改时，保存会提示冲突，不覆盖新版本。未保存的修改在离开页面前会提示。

### 文件链接与域名

管理端使用 `https://desk.wekkii.cn`。只有新上传的 HTML/ZIP 文件获得 `https://ho.wekkii.cn/view/<10 位短码>`，ZIP 地址以 `/` 结尾。短码区分大小写，内部存储、编辑和管理 API 继续使用 UUID。短码与文件身份绑定，编辑、替换和回滚不会重新分配；删除后也不复用，原地址返回 404。

已有文件继续使用 `https://page.wekki.fun/view/<原 UUID>`，不批量转换、不改写原文件。旧管理端 `https://ho.wekki.fun` 的 GET/HEAD 导航跳转到新管理端，旧域名的写请求拒绝执行。切换后需要在新管理域名重新登录。两个公开域名均不能访问管理接口。

兼容地址在生产环境固定为 `HTML_WORKBENCH_LEGACY_ADMIN_ORIGIN=https://ho.wekki.fun` 和 `HTML_WORKBENCH_LEGACY_PUBLIC_ORIGIN=https://page.wekki.fun`（未配置时使用这两个默认值）。本地开发可显式设置兼容地址，不设置则跟随本地管理/公开地址。

编辑画布暂停页面脚本，但发布源码保留脚本。脚本驱动的内容在画布中可能与公开页不同；声明式 Shadow DOM 模板保留为不透明内容，不在画布中展开编辑。编辑接口和页面仅由管理服务提供。

可选浏览器验收需要本机 Chrome 及 Playwright。PowerShell 示例：

```powershell
$env:EDITOR_PLAYWRIGHT_MODULE = 'C:/path/to/node_modules/playwright'
$env:EDITOR_SCREENSHOT_DIR = '.superpowers/sdd/final-qa'
node --test tests/editor-ui.test.mjs tests/editor-workflow.test.mjs
```

浏览器验收覆盖交互、隔离、错误状态，以及桌面和手机的列表入口、发布、公开页和回滚。未设置 `EDITOR_PLAYWRIGHT_MODULE` 时，默认测试不启动浏览器。

## Self-hosted deployment

Production uses two Node processes from the same immutable release:

- Application root: `/opt/html-workbench`
- Immutable releases: `/opt/html-workbench/releases/<full-git-sha>`
- Active release symlink: `/opt/html-workbench/current`
- Legacy checkout: existing files directly under `/opt/html-workbench` are left untouched
- Shared data: `/var/lib/html-workbench`, owned by `htmlworkbench-admin:htmlworkbench-data`, directories `2750`, files `0640`
- Admin: `html-workbench.service`, Unix user/group `htmlworkbench-admin`, `127.0.0.1:3000`, read/write
- Content: `html-workbench-content.service`, Unix user/group `htmlworkbench-content`, `127.0.0.1:3001`, read-only through `htmlworkbench-data`
- Admin environment: `/etc/html-workbench.env`, `root:htmlworkbench-admin`, mode `0640`
- Content environment: `/etc/html-workbench-content.env`, `root:htmlworkbench-content`, mode `0640`, no management secrets

### DNS

Create these A records before requesting the new certificates; keep the existing legacy DNS records:

```text
Zone: wekkii.cn
Host records: desk, ho
Type: A
Value: 163.7.4.158
TTL: 600
```

Both `desk.wekkii.cn` and `ho.wekkii.cn` must resolve to `163.7.4.158`. Keep `ho.wekki.fun` and `page.wekki.fun` pointed at the same host for compatibility.

### Environment

Create `/etc/html-workbench.env` with mode `0640`, owner `root`, and group `htmlworkbench-admin`:

```text
HTML_WORKBENCH_DATA_DIR=/var/lib/html-workbench
HTML_WORKBENCH_ADMIN_ORIGIN=https://desk.wekkii.cn
HTML_WORKBENCH_PUBLIC_ORIGIN=https://ho.wekkii.cn
HTML_WORKBENCH_PASSWORD=<admin password>
HTML_WORKBENCH_AUTH_SECRET=<random authentication secret>
HTML_WORKBENCH_DOWNLOAD_PASSWORD=<separate download password>
HTML_WORKBENCH_CURSOR_SECRET=<random cursor-signing secret>
```

Do not commit real credentials. All four credentials are required and must be explicitly configured so runtime code cannot silently use fallback values. Public `change-this-*` placeholders are rejected. Management and download passwords may explicitly remain `885688`; `HTML_WORKBENCH_AUTH_SECRET` must be independent from that password, at least 32 bytes, and high entropy. The deploy preflight uses `systemd-run` with `EnvironmentFile=/etc/html-workbench.env`, so systemd quote handling and duplicate-key last-wins behavior are validated before either service is stopped. Both systemd units run the strict validator through `ExecStartPre` on every start.

### Managed Nginx configuration

Deployment owns only these files:

```text
/etc/nginx/conf.d/ho.wekki.fun.conf
/etc/nginx/snippets/html-workbench-admin-routes.conf
/etc/nginx/snippets/html-workbench-content-routes.conf
```

It never reads or writes unrelated `oc`, `material`, or other host files. Managed configuration includes `desk.wekkii.cn`, `ho.wekkii.cn`, `ho.wekki.fun` and `page.wekki.fun`. Migration adds missing host blocks and adopts relevant locations into stable snippet includes while preserving Certbot TLS directives and unrelated blocks. Repeated migration is idempotent. Candidate files are installed atomically, checked with `nginx -t`, and restored if validation or later activation fails. The deployment updates only the two primary origin assignments in an existing admin environment; credentials and unrelated settings remain intact.

Admin hosts proxy to port 3000 with a 32 MiB transport limit (30 MiB file limit). The application redirects safe legacy-manager navigation to the new manager; UUID `/view/...` paths redirect to the legacy public origin and short-code paths to the new public origin. Unsafe legacy-manager methods return 404. Both content hosts proxy only `/view/` and `/healthz` to port 3001; `/api/`, management static files, login paths, and every other route return 404. Both proxies preserve `Host`, `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto`.

Before switching the application, provision HTTP virtual hosts for the two new names alongside the existing hosts, then request certificates with the installed Certbot. Do not overwrite the existing TLS configuration with the example bootstrap file:

```bash
sudo certbot --nginx -d desk.wekkii.cn -d ho.wekkii.cn
sudo nginx -t
sudo systemctl reload nginx
```

Keep these new virtual hosts in the existing managed host file. Certbot's TLS edits are preserved by future deployments. Deployment checks both publicly resolved HTTPS endpoints and local SNI before changing environments or restarting services; a DNS/TLS failure leaves the active application unchanged.

### Immutable live deployment

`DEPLOY_SHA` must be the full 40-character commit to release. The script fetches that exact object into a new staged directory, verifies `HEAD`, runs `npm ci --omit=dev` there, and completes environment/config preflight while the old processes continue using the previous release. It never runs `git reset --hard` and never modifies the legacy live checkout or its dependencies.

```bash
cd /path/to/a/trusted-checkout-at-the-release
DEPLOY_SHA=$(git rev-parse HEAD)
sudo env DEPLOY_SHA="$DEPLOY_SHA" \
  REPO_URL=https://github.com/wekkizhang-creator/HTMLWorkbench.git \
  APP_DIR=/opt/html-workbench \
  bash deploy/self-host/deploy.sh
```

After preparation, deployment records the prior service state, stops both roles, runs the live record-index migration from the staged release, activates `/opt/html-workbench/current`, installs the units and managed Nginx files, validates Nginx, starts both services, verifies both loopback health endpoints, and reloads Nginx.

Record mutations share a single owner-checked writer lease in local and Blob storage. Pagination cursors are signed and bound to the current index generation; if records change between pages or during a page read, the list API returns `409 record_index_changed` so clients refresh instead of silently skipping or duplicating records.

### Migration gate and recovery

The first upgrade from the pre-lease version is strictly **stop-the-world**. The old admin does not use writer leases, so admin and content must both be stopped before every dry-run, live migration, or explicit recovery. Never run these commands while an old admin can accept writes.

Prepare a separate exact-SHA tree for the first dry-run while the old service remains untouched, validate its effective environment, and only then stop the world:

```bash
TARGET_SHA=<full-40-character-target-sha>
DRY_RUN_RELEASE="/opt/html-workbench/releases/.dry-run-$TARGET_SHA"
sudo install -d -m 0755 "$DRY_RUN_RELEASE"
sudo git -C "$DRY_RUN_RELEASE" init
sudo git -C "$DRY_RUN_RELEASE" remote add origin https://github.com/wekkizhang-creator/HTMLWorkbench.git
sudo git -C "$DRY_RUN_RELEASE" fetch --depth=1 origin "$TARGET_SHA"
sudo git -C "$DRY_RUN_RELEASE" checkout --detach FETCH_HEAD
test "$(sudo git -C "$DRY_RUN_RELEASE" rev-parse HEAD)" = "$TARGET_SHA"
sudo npm --prefix "$DRY_RUN_RELEASE" ci --omit=dev
sudo systemd-run --wait --collect --pipe \
  --property=User=htmlworkbench-admin \
  --property=Group=htmlworkbench-admin \
  --property=EnvironmentFile=/etc/html-workbench.env \
  /usr/bin/node "$DRY_RUN_RELEASE/deploy/self-host/validate-env.mjs"
sudo systemctl stop html-workbench
sudo systemctl stop html-workbench-content 2>/dev/null || true
sudo systemd-run --wait --collect --pipe \
  --property=User=htmlworkbench-admin \
  --property=Group=htmlworkbench-admin \
  --property=SupplementaryGroups=htmlworkbench-data \
  --property=UMask=0027 \
  --property=WorkingDirectory="$DRY_RUN_RELEASE" \
  --property=EnvironmentFile=/etc/html-workbench.env \
  /usr/bin/npm run migrate:record-index:dry-run
sudo systemctl start html-workbench
```

Live migration is performed only by `deploy.sh`. If migration fails, deployment restores the previous release, units, managed Nginx files, and previous admin state, but keeps content stopped and disabled regardless of its prior state. It never labels the failed release recovered and never runs lock recovery automatically. The failed release remains under `/opt/html-workbench/releases/<failed-deploy-sha>` for diagnosis.

Explicit recovery is an operator-only action after confirming no migration process is active. Run the recovery implementation from the retained failed release, because the restored pre-release code may not contain it:

```bash
FAILED_SHA=<full-40-character-failed-deploy-sha>
RECOVERY_RELEASE="/opt/html-workbench/releases/$FAILED_SHA"
sudo systemctl stop html-workbench
sudo systemctl stop html-workbench-content 2>/dev/null || true
systemctl list-units 'html-workbench-record-index-migration-*'
sudo test -f "$RECOVERY_RELEASE/.html-workbench-release-ready"
sudo systemd-run --wait --collect --pipe \
  --property=User=htmlworkbench-admin \
  --property=Group=htmlworkbench-admin \
  --property=SupplementaryGroups=htmlworkbench-data \
  --property=UMask=0027 \
  --property=WorkingDirectory="$RECOVERY_RELEASE" \
  --property=EnvironmentFile=/etc/html-workbench.env \
  /usr/bin/npm run migrate:record-index:recover
# Re-run the normal live deployment; do not start content before migration succeeds.
```
Code and configuration rollback cannot reverse records already changed by a successful or partially completed migration. Take a data snapshot before the first cross-version migration. After any failed migration or post-migration activation rollback, inspect migration logs and the data/index state before retrying or restoring a data snapshot.

### Status and health

```bash
sudo systemctl status html-workbench html-workbench-content --no-pager
readlink -f /opt/html-workbench/current
curl -fsS -H 'Host: desk.wekkii.cn' http://127.0.0.1:3000/healthz
curl -fsS -H 'Host: ho.wekkii.cn' http://127.0.0.1:3001/healthz
sudo nginx -t
```

### Docker Compose

Create an untracked `.env` containing all four credentials listed above. Missing, empty, and public `change-this-*` placeholder values are rejected by the image entrypoint before every migration, admin, or content command; explicitly configured `885688` remains valid. Compose retains the root-owned one-shot volume initializer, then runs a read/write `migration` service. Both admin and content depend on `migration: service_completed_successfully`, so neither can start when migration exits unsuccessfully. Admin publishes only `127.0.0.1:3000`; content publishes only `127.0.0.1:3001` and mounts `/data` read-only.

For a cross-version update, preserve the same stop-the-world boundary:

```bash
docker compose stop admin content
docker compose build
docker compose up -d
```

Do not run a separate live migration command: `docker compose up` runs the one-shot gate. Explicit lock recovery remains manual and must be followed by another normal migration gate:

```bash
docker compose stop admin content
docker compose run --rm --no-deps migration npm run migrate:record-index:recover
docker compose up -d
```

### Rollback

Automatic rollback keeps every release directory and repoints `/opt/html-workbench/current` to the prior target. A previous Git commit remains at `/opt/html-workbench/releases/<previous-sha>`; record it as `PREVIOUS_SHA=<previous Git commit SHA>` and repoint `current` to that release for a manual rollback. For a later manual code rollback, stop both roles, repoint the symlink to a known release, reinstall that release's units and managed snippets, run `systemctl daemon-reload` and `nginx -t`, then start only services known to be compatible with the current data. Keep content stopped when migration readiness is uncertain. Restore `/var/lib/html-workbench` only from a deliberate pre-deploy snapshot when data rollback is required.

### GitHub Actions SSH trust

The workflow deploys `${{ github.sha }}` and requires these repository secrets:

```text
SERVER_HOST=163.7.4.158
SERVER_USER=root
SERVER_PORT=22
SERVER_SSH_KEY=<private deployment key>
SERVER_HOST_KEY=163.7.4.158 ssh-ed25519 <server public host key>
```


### Domain security boundary

The production origins are fixed:

```text
HTML_WORKBENCH_ADMIN_ORIGIN=https://desk.wekkii.cn
HTML_WORKBENCH_PUBLIC_ORIGIN=https://ho.wekkii.cn
```

For a single Vercel project, root `middleware.js` applies the Host policy before
filesystem and API routing. Both `ho.wekkii.cn` and `page.wekki.fun` expose only `/healthz` and
`/view/<code-or-uuid>`; login, management static files, and management APIs return 404.
Attach all four hostnames to the project. Safe navigation on `ho.wekki.fun` redirects to `desk.wekkii.cn`, except UUID view paths which keep the legacy public origin. Public short paths use the new public origin. Legacy-manager writes are rejected.

Authenticated admin writes require both the exact admin `Origin` and an
`X-CSRF-Token` bound to the current management session. The management frontend
loads this token from `GET /api/auth` and sends it on upload, replace, rollback,
delete, and logout requests. Login itself has no existing session token, so its
POST is protected by the exact admin Origin check.
Logout persists a hashed session revocation tombstone in local shared storage or
Private Vercel Blob before clearing the cookie. Authorization bypasses Blob cache
for revocation reads, so an old Cookie plus its old CSRF token cannot write after
logout. Expired tombstones are cleaned in bounded batches on later logouts.


Self-hosted content runs with `/etc/html-workbench-content.env`:

```text
HTML_WORKBENCH_DATA_DIR=/var/lib/html-workbench
HTML_WORKBENCH_ADMIN_ORIGIN=https://desk.wekkii.cn
HTML_WORKBENCH_PUBLIC_ORIGIN=https://ho.wekkii.cn
```

Deployment owns this non-secret file and validates it with the `content-host`
profile. It runs content as the independent `htmlworkbench-content` identity;
that identity cannot read the `root:htmlworkbench-admin` mode `0640` admin
environment. Shared data uses a setgid `htmlworkbench-data` group: admin owns
and writes it, while systemd and the read-only mount constrain content to reads.
The content systemd unit and Compose service must not receive
`HTML_WORKBENCH_PASSWORD`, `HTML_WORKBENCH_AUTH_SECRET`,
`HTML_WORKBENCH_DOWNLOAD_PASSWORD`, or `HTML_WORKBENCH_CURSOR_SECRET`. Admin and
migration continue using the strict credential profile on every startup. Both
environment files are captured before deployment changes and restored with
their previous content, mode, and ownership on validation or activation failure.
Obtain the host public key through a trusted server console or hosting control plane, not through the deployment SSH connection. For example, read `/etc/ssh/ssh_host_ed25519_key.pub` locally on the server, construct the `known_hosts` line above, and compare its fingerprint out of band with:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

For a non-default port, the secret's host field must be `[163.7.4.158]:<port>`. The workflow validates the known-hosts line with `ssh-keygen`, uses `StrictHostKeyChecking=yes`, and never calls `ssh-keyscan`. Optional `SERVER_APP_DIR` must remain `/opt/html-workbench`; `SERVER_REPO_URL` may override the HTTPS GitHub repository URL.
