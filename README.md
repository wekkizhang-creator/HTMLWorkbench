# HTMLWorkbench
HTML 发布台

一个适配 Vercel 部署的 HTML 上传发布台。上传 `.html` / `.htm` 单文件或包含 `index.html` 的 `.zip` 网页包后，系统会生成稳定的 `/view/:id` 访问链接，并在上传记录中管理文件、标题、大小、上传时间和链接。

当前管理入口带密码验证，默认密码是 `885688`。上传时会自动从 HTML 的 `<title>`、`meta description`、标题和正文中生成文件描述与最多 3 个标签。上传时可选择文档类型，内置 `分析报告`、`原型`、`其他`，也可以新建类型；记录页支持按标题/描述搜索，并可按文档类型和标签筛选。记录操作支持替换 HTML 或 ZIP 文件，替换后原访问链接保持不变，并可回滚到上一次文件版本。访问链接页面右下角提供下载按钮，输入密码通过后可下载当前 HTML 文件或原始 ZIP 包。

## 本地运行

```bash
npm install
npm run dev
```

默认从 `http://localhost:3000` 启动；如果端口被占用，会自动尝试后续端口。

本地开发没有配置 `BLOB_READ_WRITE_TOKEN` 时，会把上传文件写入 `data/` 目录。该目录不会被提交。

## Vercel 部署

1. 在 Vercel 导入这个 GitHub 仓库。
2. 创建并连接一个 Vercel Blob Store。
3. 确认项目环境变量里有 `BLOB_READ_WRITE_TOKEN`。连接 Blob Store 后 Vercel 通常会自动注入。
4. Framework Preset 选择 `Other` 即可，无需构建命令。
5. 部署完成后访问 Vercel 域名，上传记录会保存在 Vercel Blob。

## Vercel 适配说明

- 静态管理界面放在 `public/`。
- Serverless Functions 放在 `api/`。
- `/view/:id` 通过 `vercel.json` rewrite 到 `/api/view?id=:id`。
- 上传文件和记录都使用 Vercel Blob 持久化。
- 自托管部署支持上传文件最大 30 MB；如果部署到 Vercel，需要注意 Serverless Function 请求体限制通常不适合 30 MB 直传。

## 校验

```bash
npm run check
```

## 自有服务器部署

这个分支可以直接部署到自己的云服务器。自托管时不需要 Vercel Blob，上传的 HTML、ZIP 网页包和记录会保存到服务器磁盘。建议把数据目录放在 `/var/lib/html-workbench`，代码目录放在 `/opt/html-workbench`。

### 方式一：Node.js + systemd + Nginx

服务器要求：

- Ubuntu / Debian / CentOS 等 Linux 服务器
- Node.js 20 或更新版本
- Git
- Nginx

首次部署：

```bash
sudo mkdir -p /opt/html-workbench /var/lib/html-workbench
sudo git clone --branch owncnd_codex/html https://github.com/wekkizhang-creator/HTMLWorkbench.git /opt/html-workbench
cd /opt/html-workbench
sudo npm install --omit=dev
sudo useradd --system --home /opt/html-workbench --shell /usr/sbin/nologin htmlworkbench
sudo chown -R htmlworkbench:htmlworkbench /var/lib/html-workbench
sudo cp deploy/self-host/html-workbench.service /etc/systemd/system/html-workbench.service
sudo cp deploy/self-host/html-workbench.env.example /etc/html-workbench.env
sudo systemctl daemon-reload
sudo systemctl enable html-workbench
sudo systemctl start html-workbench
```

检查服务：

```bash
sudo systemctl status html-workbench
curl http://127.0.0.1:3000
```

配置 Nginx：

```bash
sudo cp /opt/html-workbench/deploy/self-host/nginx.conf /etc/nginx/sites-available/html-workbench
sudo ln -s /etc/nginx/sites-available/html-workbench /etc/nginx/sites-enabled/html-workbench
sudo nginx -t
sudo systemctl reload nginx
```

把 `/etc/nginx/sites-available/html-workbench` 里的 `server_name example.com;` 改成你的域名。如果暂时没有域名，可以改成服务器公网 IP。

更新部署：

```bash
cd /opt/html-workbench
sudo git fetch origin owncnd_codex/html
sudo git checkout owncnd_codex/html
sudo git reset --hard origin/owncnd_codex/html
sudo npm install --omit=dev
sudo systemctl restart html-workbench
```

也可以直接使用脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/wekkizhang-creator/HTMLWorkbench/owncnd_codex/html/deploy/self-host/deploy.sh -o deploy.sh
sudo bash deploy.sh
```

### 方式二：Docker Compose

```bash
git clone --branch owncnd_codex/html https://github.com/wekkizhang-creator/HTMLWorkbench.git
cd HTMLWorkbench
docker compose up -d --build
```

服务默认暴露在服务器 `3000` 端口。生产环境仍建议用 Nginx 反代到 `127.0.0.1:3000`，并配置 HTTPS。

### 自托管环境变量

可在 `/etc/html-workbench.env` 中调整：

```bash
PORT=3000
HTML_WORKBENCH_DATA_DIR=/var/lib/html-workbench
```

`HTML_WORKBENCH_DATA_DIR` 是上传文件和记录的持久化目录。升级代码、重启服务、重新拉取 Git 分支都不会影响这个目录。

管理入口密码可在 `/etc/html-workbench.env` 中修改：

```bash
HTML_WORKBENCH_PASSWORD=885688
HTML_WORKBENCH_AUTH_SECRET=换成一串随机字符
```

修改后重启服务：

```bash
sudo systemctl restart html-workbench
```

### GitHub Actions 自动部署

仓库包含 `.github/workflows/deploy-self-host.yml`。配置好 GitHub Secrets 后，每次推送 `owncnd_codex/html` 分支都会自动连接服务器、拉取最新代码并重启 `html-workbench`。

在 GitHub 仓库进入 `Settings` -> `Secrets and variables` -> `Actions`，新增这些 Repository secrets：

```text
SERVER_HOST=163.7.4.158
SERVER_USER=root
SERVER_PORT=22
SERVER_SSH_KEY=你的 SSH 私钥内容
```

`SERVER_PORT` 可选，不填默认 `22`。如果不用 root，请确保 `SERVER_USER` 对应用户可以免密执行 `sudo systemctl restart html-workbench` 等部署命令。

建议单独创建一组部署密钥，把公钥加入服务器用户的 `~/.ssh/authorized_keys`，再把私钥内容放到 `SERVER_SSH_KEY`：

```bash
ssh-keygen -t ed25519 -f htmlworkbench_deploy_key -C github-actions-htmlworkbench
ssh-copy-id -i htmlworkbench_deploy_key.pub root@163.7.4.158
```

工作流也支持这些 Repository variables，可不填：

```text
SERVER_APP_DIR=/opt/html-workbench
SERVER_BRANCH=owncnd_codex/html
SERVER_REPO_URL=https://github.com/wekkizhang-creator/HTMLWorkbench.git
```
