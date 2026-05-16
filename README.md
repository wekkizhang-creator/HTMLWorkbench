# HTMLWorkbench
HTML 发布台

一个适配 Vercel 部署的 HTML 上传发布台。上传 `.html` / `.htm` 文件后，系统会生成稳定的 `/view/:id` 访问链接，并在上传记录中管理文件、标题、大小、上传时间和链接。

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
- Vercel Function 请求体限制为 4.5 MB，因此页面限制上传文件最大 4 MB。

## 校验

```bash
npm run check
```
