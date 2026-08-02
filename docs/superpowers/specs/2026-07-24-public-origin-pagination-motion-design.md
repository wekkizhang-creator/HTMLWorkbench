# HTMLWorkbench 发布域隔离、记录分页与加载动画设计

日期：2026-07-24

## 目标

本次改造同时解决三个问题：

1. 上传后的 HTML/ZIP 页面不再与管理台共享浏览器同源边界。
2. Vercel Blob 中超过 1000 条记录后仍可稳定分页、搜索和筛选。
3. 页面加载、记录加载和文件上传过程提供与真实状态对应的动画反馈。

管理端继续使用 `https://ho.wekki.fun`，发布端使用
`https://page.wekki.fun`。现有记录 ID、上传文件和下载能力保持兼容。

## 架构

自托管环境运行两个 Node.js 进程，并共享同一只读/读写数据目录：

- 管理进程监听 `127.0.0.1:3000`，角色为 `admin`。
- 发布进程监听 `127.0.0.1:3001`，角色为 `content`。
- Nginx 根据域名把请求转发到对应进程。

管理进程只提供：

- 登录和退出。
- 管理静态页面。
- 上传记录分页、搜索和类型筛选。
- HTML/ZIP 上传、替换、回滚和删除。
- 受密码保护的下载组件和下载接口。
- 管理健康检查。

发布进程只提供：

- `/view/:id`。
- `/view/:id/*` ZIP 站点资源。
- 发布健康检查。

发布进程不注册登录、上传、删除、替换、回滚和管理静态资源路由。
未知 Host 返回 `421`，发布域名的未知路径和 `/api/*` 返回 `404`。

## 域名与旧链接

记录内部继续保存稳定的相对路径 `/view/:id`，避免批量改写历史记录。
对外返回记录时，根据 `HTML_WORKBENCH_PUBLIC_ORIGIN` 动态生成绝对链接：

```text
https://page.wekki.fun/view/:id
```

管理域名收到历史 `/view/*` 请求时，使用临时重定向跳转到发布域名，
完整保留记录 ID、ZIP 子路径、结尾斜杠和查询参数。验证稳定后可由部署配置
把临时重定向改为 `308`。

ZIP HTML 注入的 `<base>` 使用发布域名下的 `/view/:id/` 路径，资源继续按
相对地址加载。

## 下载安全边界

不再把密码输入框和下载逻辑直接注入上传 HTML 的 DOM。上传页面可以运行任意
JavaScript，如果输入框与其同文档，页面脚本能够读取密码。

发布页右下角改为注入一个跨源 iframe：

```text
https://ho.wekki.fun/public-download-widget/:id
```

iframe 由管理进程提供，上传页面只能调整 iframe 外层位置，不能读取 iframe
中的密码、响应内容或 DOM。下载密码使用
`HTML_WORKBENCH_DOWNLOAD_PASSWORD`，默认部署值保持为 `885688`，不复用管理
登录密码。

下载接口仅接受管理域名下载组件发起的请求，并校验请求 Origin。认证 Cookie
保持 Host-only，不设置 `.wekki.fun` Domain；生产 HTTPS 下增加 `Secure`，
并使用 `HttpOnly; SameSite=Strict`。

## Blob 有序索引

原始记录继续保存在：

```text
records/{recordId}.json
```

新增列表索引：

```text
record-index/v1/{reverseTimestamp}-{recordId}.json
```

`reverseTimestamp` 是固定宽度的反向毫秒时间戳，使 Blob 按 pathname
字典序返回时天然保持最新记录优先。索引内容保存列表所需公开字段、原记录路径
和当前索引键，不包含密码、Blob Token 或历史版本内部路径。

上传、替换和回滚时先保存新记录及新索引，再清理旧索引；删除时删除记录和索引。
由于 Blob 不支持跨对象事务，所有索引写入都必须幂等，迁移和修复流程能够处理
重复索引、孤立索引和缺失索引。

本地磁盘模式实现相同的分页接口和排序规则，避免自托管与 Vercel 行为分叉。

## 服务端分页协议

管理端列表请求：

```http
GET /api/uploads?limit=50&cursor=...&q=报告&documentType=分析报告
```

响应：

```json
{
  "records": [],
  "page": {
    "limit": 50,
    "hasMore": true,
    "nextCursor": "opaque-signed-cursor"
  }
}
```

规则：

- `limit` 默认 50，范围为 1 到 100。
- `cursor` 是应用生成的不透明签名值，不直接暴露 Blob cursor。
- 游标绑定索引版本、Blob cursor、搜索词和文档类型筛选。
- 游标篡改、版本不支持或筛选条件不匹配时返回 `400`。
- 没有下一页时返回 `hasMore: false` 和 `nextCursor: null`。
- 前端按记录 ID 去重，刷新、搜索词或类型变化时重置游标。

服务端按索引顺序扫描并收集匹配记录，直到达到 `limit` 或没有下一页。Blob
记录读取使用受控并发，避免一次产生数百个并行 `get()` 请求。

页面不为获取总数而扫描完整 Blob。界面显示当前已加载数量，并以 `hasMore`
决定是否展示“加载更多”。

## 搜索与筛选

搜索和文档类型筛选从前端本地数组迁移到服务端，确保可以命中第 1000 条以后的
记录。搜索覆盖：

- 标题。
- 描述。
- 原始文件名。
- 文档类型。

搜索词做大小写无关匹配。搜索输入保留短防抖；每次查询变化取消或忽略旧请求，
重置结果集和游标，避免较慢的旧响应覆盖新结果。

## 索引迁移

迁移脚本按以下顺序运行：

1. 新版本先开始对所有新增和修改操作双写记录与索引。
2. 脚本使用 Blob cursor 遍历全部 `records/`，不受 1000 条限制。
3. 为每条记录幂等创建正确的 v1 索引。
4. 校验重复 ID、损坏 JSON、孤立索引和缺失索引。
5. 输出已扫描、已创建、已修复、已跳过和失败数量。
6. 失败后可使用同一命令安全重跑。

列表 API 在索引未准备好时返回明确的维护错误，不静默退回到不完整的前 1000
条结果。自托管服务器部署时，在切换新 API 前执行迁移脚本。

## 加载与上传动画

动画只表达真实应用状态：

- 首次打开管理台：顶部和记录区域显示骨架屏，数据完成后短淡入。
- 刷新、搜索和类型切换：保留页面布局，记录区显示局部加载状态。
- 加载下一页：按钮显示加载状态，只对新追加行做短促淡入和轻微位移。
- 上传传输阶段：使用浏览器上传进度事件显示真实字节进度。
- 服务端处理阶段：传输达到 100% 后切换为“不确定进度”的解析发布状态。
- 上传成功：新记录进入列表，并短暂高亮。
- 上传失败：停止动画，保留用户选择和标题，显示可重试错误。

动画不改变固定布局尺寸，避免页面跳动。系统启用
`prefers-reduced-motion: reduce` 时禁用位移、脉冲和非必要过渡，仅保留文本和
进度值变化。

## 环境变量

```env
HTML_WORKBENCH_ADMIN_ORIGIN=https://ho.wekki.fun
HTML_WORKBENCH_PUBLIC_ORIGIN=https://page.wekki.fun
HTML_WORKBENCH_DATA_DIR=/var/lib/html-workbench
HTML_WORKBENCH_PASSWORD=885688
HTML_WORKBENCH_DOWNLOAD_PASSWORD=885688
HTML_WORKBENCH_AUTH_SECRET=<random-secret>
HTML_WORKBENCH_CURSOR_SECRET=<different-random-secret>
```

管理进程：

```env
HTML_WORKBENCH_ROLE=admin
HOST=127.0.0.1
PORT=3000
```

发布进程：

```env
HTML_WORKBENCH_ROLE=content
HOST=127.0.0.1
PORT=3001
```

## DNS、Nginx 与证书

火山引擎 DNS 新增：

```text
主机记录: page
记录类型: A
记录值: 163.7.4.158
TTL: 600
```

Nginx 为 `ho.wekki.fun` 和 `page.wekki.fun` 建立独立 server block。管理域名
代理到 3000，发布域名只把 `/view/*` 和健康检查代理到 3001，其余返回 404。
两个 Node 端口只监听回环地址，不直接暴露到公网。

HTTPS 证书必须包含 `page.wekki.fun`。可以为两个域名分别签发证书，也可以使用
同一张包含两个 SAN 的证书。

## 错误处理

- 非法或过期游标：`400`，前端清空游标并允许刷新第一页。
- 发布域名访问管理接口：`404`。
- 未知 Host：`421`。
- 索引尚未完成迁移：`503`，不返回不完整列表。
- 索引对应记录被并发删除：跳过该项并继续补足当前页。
- 上传或索引写入失败：不向前端返回发布成功；记录修复工具可检测半成品。
- 下载密码错误：`401`，不泄露记录或存储路径。

## 测试与验收

自动化测试覆盖：

- 管理域名和发布域名的路由白名单。
- 旧 `/view/*` 链接跳转并保留路径和查询参数。
- 发布域名无法访问管理 API、登录页和管理静态资源。
- 跨源 iframe 下载组件不把密码输入框注入上传 HTML。
- 管理 Cookie 的生产安全属性。
- 1200 条以上记录分页无遗漏、无重复且保持全局最新优先。
- 搜索和文档类型筛选命中第 1000 条以后的记录。
- 游标签名、版本和筛选条件绑定。
- 索引迁移可重复执行并修复缺失或孤立索引。
- HTML、ZIP 资源、替换、回滚和下载保持兼容。
- 页面骨架、真实上传进度、服务端处理状态和减少动画模式。

部署验收覆盖：

- `https://ho.wekki.fun/healthz` 返回管理进程健康状态。
- `https://page.wekki.fun/healthz` 返回发布进程健康状态。
- `https://ho.wekki.fun/view/:id` 跳转到发布域名。
- `https://page.wekki.fun/api/uploads` 返回 404。
- 新上传的 HTML/ZIP 能从发布域名访问。
- GitHub、服务器代码和运行提交 SHA 一致。
