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
2. 创建并连接 Vercel Blob Store。
3. 配置 `BLOB_READ_WRITE_TOKEN`。
4. Framework Preset 选择 `Other`，不需要构建命令。

`/view/:id` 由 `vercel.json` rewrite 到 `/api/view?id=:id`。自托管支持最大 30 MB 的代理请求；Vercel Serverless 的请求体限制不适合相同大小的直传。

## 校验

```bash
npm run check
```

## 自有服务器部署

生产布局固定为：

- 应用：`/opt/html-workbench`
- 数据：`/var/lib/html-workbench`
- 用户/组：`htmlworkbench:htmlworkbench`
- 管理服务：`html-workbench`，`127.0.0.1:3000`，读写数据
- 内容服务：`html-workbench-content`，`127.0.0.1:3001`，只读数据
- 公共配置文件：`/etc/html-workbench.env`
- Nginx 配置：`/etc/nginx/conf.d/ho.wekki.fun.conf`

首次配置前先准备 checkout：

```bash
sudo mkdir -p /opt/html-workbench /var/lib/html-workbench
id htmlworkbench >/dev/null 2>&1 || sudo useradd --system --home /opt/html-workbench --shell /usr/sbin/nologin htmlworkbench
sudo git clone --branch owncnd_codex/html https://github.com/wekkizhang-creator/HTMLWorkbench.git /opt/html-workbench
```

不要修改 `/etc/nginx/conf.d/` 中与 `ho.wekki.fun` 无关的 `oc`、`material` 或其他站点配置。

### DNS

为公共内容域名配置：

```text
Host record: page
Type: A
Value: 163.7.4.158
TTL: 600
```

发布前确认 `page.wekki.fun` 已解析到 `163.7.4.158`。

### 自托管环境变量

首次部署先准备只允许 root 和服务组读取的环境文件：

```bash
sudo cp /opt/html-workbench/deploy/self-host/html-workbench.env.example /etc/html-workbench.env
sudo chown root:htmlworkbench /etc/html-workbench.env
sudo chmod 640 /etc/html-workbench.env
sudoedit /etc/html-workbench.env
```

必须配置：

```text
HTML_WORKBENCH_DATA_DIR=/var/lib/html-workbench
HTML_WORKBENCH_ADMIN_ORIGIN=https://ho.wekki.fun
HTML_WORKBENCH_PUBLIC_ORIGIN=https://page.wekki.fun
HTML_WORKBENCH_PASSWORD=<admin password>
HTML_WORKBENCH_AUTH_SECRET=<random secret>
HTML_WORKBENCH_DOWNLOAD_PASSWORD=<separate download password>
HTML_WORKBENCH_CURSOR_SECRET=<random cursor signing secret>
```

不要把真实密码或 secret 提交到 Git。`HOST`、`PORT` 和 `HTML_WORKBENCH_ROLE` 由各自的 systemd unit 固定，不应放入共享环境文件；unit 的启动命令也会覆盖旧版环境文件中遗留的 `PORT=3000`。

### Nginx 和证书

现有 `ho.wekki.fun` 配置必须先备份。下面只替换该站点文件，不会触碰无关 host：

```bash
sudo cp /etc/nginx/conf.d/ho.wekki.fun.conf /etc/nginx/conf.d/ho.wekki.fun.conf.pre-dual-service
sudo cp /opt/html-workbench/deploy/self-host/nginx.conf /etc/nginx/conf.d/ho.wekki.fun.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d ho.wekki.fun
sudo certbot --nginx -d page.wekki.fun
sudo nginx -t
sudo systemctl reload nginx
```

`ho.wekki.fun` 将管理请求代理到 3000，并以 307 把原始 `/view` request URI 重定向到 `page.wekki.fun`。公共 host 只代理 `/view/` 和 `/healthz`；API、登录、管理静态文件和其他路径都返回 404。

### 首次安装和更新

服务器需要 Node.js 20+、Git、Nginx、systemd、curl 和 Certbot 2.9.0 或兼容版本。

按上一节准备 checkout、配置 `/etc/html-workbench.env` 和 Nginx 后：

```bash
sudo bash /opt/html-workbench/deploy/self-host/deploy.sh
```

更新同样运行 `deploy.sh`。脚本使用 `npm ci --omit=dev`，预检环境变量，停止两个服务，运行 live record-index migration，成功后才 daemon-reload 并重启两个服务。任何失败都会保持内容服务停止；如果管理服务原来在运行，trap 会尝试恢复管理服务。脚本永远不会自动执行显式 lock recovery。

### Migration gate

从 pre-release 版本进行第一次升级时，旧管理进程不认识 writer leases。首次 dry-run、live migration 或 recovery 都必须执行 **stop-the-world**：先停止 admin 和 content，绝不能在旧 admin 仍接受写入时运行 migration。

Dry-run：

```bash
sudo systemctl stop html-workbench
sudo systemctl stop html-workbench-content 2>/dev/null || true
sudo systemd-run --wait --collect --pipe \
  --property=User=htmlworkbench \
  --property=Group=htmlworkbench \
  --property=WorkingDirectory=/opt/html-workbench \
  --property=EnvironmentFile=/etc/html-workbench.env \
  /usr/bin/npm run migrate:record-index:dry-run
sudo systemctl start html-workbench
```

Live migration 使用部署脚本，它实现完整的 stop-the-world gate 和失败 trap：

```bash
sudo bash /opt/html-workbench/deploy/self-host/deploy.sh
```

Explicit recovery 只能由操作员确认没有 migration 正在运行后手工执行。不要在脚本或定时任务中自动调用：

```bash
sudo systemctl stop html-workbench
sudo systemctl stop html-workbench-content 2>/dev/null || true
systemctl list-units 'html-workbench-record-index-migration-*'
sudo systemd-run --wait --collect --pipe \
  --property=User=htmlworkbench \
  --property=Group=htmlworkbench \
  --property=WorkingDirectory=/opt/html-workbench \
  --property=EnvironmentFile=/etc/html-workbench.env \
  /usr/bin/npm run migrate:record-index:recover
# Recovery 后必须重新运行 live migration；成功前不要启动 content。
sudo bash /opt/html-workbench/deploy/self-host/deploy.sh
```

### 状态和健康检查

```bash
sudo systemctl status html-workbench
sudo systemctl status html-workbench-content
curl -fsS -H 'Host: ho.wekki.fun' http://127.0.0.1:3000/healthz
curl -fsS -H 'Host: page.wekki.fun' http://127.0.0.1:3001/healthz
sudo nginx -t
```

### 方式二：Docker Compose

Compose 使用同一镜像和 named volume；admin 读写挂载，content 以 `:ro` 挂载并使用只读容器文件系统。先创建未跟踪的 `.env`：

```bash
cd /opt/html-workbench
umask 077
read -rsp 'Admin password: ' HTML_WORKBENCH_PASSWORD; echo
read -rsp 'Download password: ' HTML_WORKBENCH_DOWNLOAD_PASSWORD; echo
HTML_WORKBENCH_AUTH_SECRET=$(openssl rand -hex 32)
HTML_WORKBENCH_CURSOR_SECRET=$(openssl rand -hex 32)
printf '%s\n' \
  "HTML_WORKBENCH_PASSWORD=$HTML_WORKBENCH_PASSWORD" \
  "HTML_WORKBENCH_AUTH_SECRET=$HTML_WORKBENCH_AUTH_SECRET" \
  "HTML_WORKBENCH_DOWNLOAD_PASSWORD=$HTML_WORKBENCH_DOWNLOAD_PASSWORD" \
  "HTML_WORKBENCH_CURSOR_SECRET=$HTML_WORKBENCH_CURSOR_SECRET" > .env
docker compose build
docker compose run --rm --no-deps admin npm run migrate:record-index
docker compose up -d
```

Admin 和 content 分别只发布到 `127.0.0.1:3000`、`127.0.0.1:3001`。跨版本升级也必须 stop-the-world：

```bash
docker compose stop admin content
docker compose build
docker compose run --rm --no-deps admin npm run migrate:record-index
docker compose up -d admin content
```

不要用只读 content service 运行 migration。显式 recovery 与 systemd 相同，只能在确认没有 migration 后，使用 `docker compose run --rm --no-deps admin npm run migrate:record-index:recover` 手工执行，随后再运行 live migration。

### Rollback

部署前记录 previous Git commit，并保留 Nginx 备份和数据快照。如果代码或服务配置需要回滚：

```bash
cd /opt/html-workbench
PREVIOUS_COMMIT=<previous Git commit SHA>
sudo systemctl stop html-workbench
sudo systemctl stop html-workbench-content 2>/dev/null || true
sudo git checkout --detach "$PREVIOUS_COMMIT"
sudo npm ci --omit=dev
sudo cp deploy/self-host/html-workbench.service /etc/systemd/system/html-workbench.service
sudo systemctl disable html-workbench-content
sudo cp /etc/nginx/conf.d/ho.wekki.fun.conf.pre-dual-service /etc/nginx/conf.d/ho.wekki.fun.conf
sudo systemctl daemon-reload
sudo systemctl restart html-workbench
sudo nginx -t
sudo systemctl reload nginx
```

旧版 admin 不支持 leases；回滚后保持 content 停止，并在再次升级前重新执行 stop-the-world migration。只有在 schema/data 也必须回退时才从部署前快照恢复 `/var/lib/html-workbench`。

### GitHub Actions 自动部署

`.github/workflows/deploy-self-host.yml` 在推送 `owncnd_codex/html` 时通过 SSH bootstrap checkout，然后调用仓库中的同一个 `deploy/self-host/deploy.sh`。需要 Repository secrets：

```text
SERVER_HOST=163.7.4.158
SERVER_USER=root
SERVER_PORT=22
SERVER_SSH_KEY=<private key>
```

可选 Repository variables：

```text
SERVER_APP_DIR=/opt/html-workbench
SERVER_BRANCH=owncnd_codex/html
SERVER_REPO_URL=https://github.com/wekkizhang-creator/HTMLWorkbench.git
```

`SERVER_APP_DIR` 必须保持 `/opt/html-workbench`。非 root 部署用户必须能通过免密 sudo 执行部署脚本所需的 systemctl、systemd-run、文件安装和 Git 操作。
