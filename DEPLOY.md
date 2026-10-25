# 云端部署方案

## 先说结论：有一个硬约束

微信读书的 Agent API 网关**只允许 `https://weread.qq.com` 这个 Origin** 调用。
实测返回：

```
access-control-allow-origin: https://weread.qq.com     ← 固定值，不回声请求方 Origin
OPTIONS 预检 → HTTP 401
```

这意味着：

1. **浏览器无法直连网关**。`WEREAD_API_KEY` 只能在服务端使用，绝不能下发到前端。
2. 所以 **「纯前端 + 云数据库」的多用户架构走不通** —— WorkBuddy 云服务（数据库 / 认证 /
   存储 / 大模型，SDK 跑在浏览器）没有自定义服务端计算能力，代不了这个调用。
3. 同步逻辑必须跑在一台**你能控制计算过程的机器**上：你的 Mac，或一台自建服务器。

下面三个方案就是在这个约束下的三种取舍。

---

## 方案对比

| | A. 单用户公网自托管 | B. 本机为主 + 云端镜像 | C. 多用户产品 |
|---|---|---|---|
| 谁能用 | 只有你 | 只有你 | 所有读书爱好者 |
| 代码改动 | 几乎为零 | 增加推送脚本 + 一个只读应用 | 重写：服务端 + 用户体系 + 密钥托管 |
| 成本 | 一台轻量服务器（约 ¥60–100/月） | 服务器 + 云服务配额 | 服务器 + 云服务 + 运维 |
| 数据在 | 服务器上的 SQLite 文件 | 本地 SQLite 为主，云端一份镜像 | 云端数据库 |
| Key 在哪 | 服务器环境变量 | 只在你本机 | 每个用户自己的，服务端加密托管 |
| 能否给竞赛提交链接 | ✅ 可以 | ✅ 可以 | ✅ 可以 |
| 工作量 | 半天 | 1–2 天 | 一到两周（且需正式授权） |

**当前阶段建议选 A**：改动最小，能拿到可访问的链接，数据完全可控。

---

## 方案 A：单用户公网自托管（推荐）

### 前提

- 一台 Linux 服务器（1 核 2G 足够；腾讯云轻量 / 阿里云 ECS / Fly.io 均可）
- 一个域名（可选，但 HTTPS 需要）
- 服务器上有 **Node.js ≥ 22.5**（`node:sqlite` 的最低版本）

### 步骤

**1. 上传代码**

```bash
# 在你本机
rsync -av --exclude data --exclude node_modules \
  ~/workspace/ws_workbuddy_common/reading-cards/ user@server:/opt/reading-cards/
```

（`data/` 排除掉，先不带本地库上去；或者带上以便延续已有感悟与收藏——由你决定。）

**2. 配置密钥**

```bash
cd /opt/reading-cards
cp .env.example .env
vi .env         # 填入 WEREAD_API_KEY / SITE_PASSWORD / SESSION_SECRET
chmod 600 .env
```

`.env` 里的三项安全相关变量：

- `WEREAD_API_KEY`：微信读书网关 Key，只在服务端用。
- `SITE_PASSWORD`：管理员站点口令。访客默认就能浏览和使用已配置的书籍，
  但**同步 / 备份 / 导出 / 新增书籍**等管理操作需要点右上角「管理员登录」并输入此口令。
  务必改成 16 位以上随机串。
- `SESSION_SECRET`：管理员 Cookie 的 HMAC 签名密钥，必须随机且保密。
  生成：`openssl rand -hex 32`。泄露会让他人伪造管理员身份。

**3. 进程守护（systemd）**

`/etc/systemd/system/reading-cards.service`：

```ini
[Unit]
Description=流动的书 · 阅读复习助手
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/reading-cards
EnvironmentFile=/opt/reading-cards/.env
ExecStart=/usr/bin/node --experimental-sqlite server.js
Restart=always
RestartSec=3
User=reading

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now reading-cards
journalctl -u reading-cards -f      # 看启动日志，应看到自动备份那一行
```

**4. 反向代理 + HTTPS（无需 basic_auth）**

应用**已内置身份模型**，所以代理层不必再加口令：

- **访客（默认）**：任何人都能直接打开站点，浏览已配置的书籍与卡片，并写下自己的
  感悟 / 收藏 / 复习记录——这些数据按 `guest:<随机UUID>` 隔离，互不干扰，也看不到
  管理员的数据。
- **管理员**：点右上角「管理员登录」、输入 `.env` 里的 `SITE_PASSWORD` 后，才出现
  「同步微信读书 / 备份 / 导出 / 新增书籍」等按钮。

因此 Caddy 只做反向代理 + HTTPS，把口令鉴权下沉到应用内：

```
# 已有服务在 :80，本站点用新端口 8899，互不覆盖
:8899 {
    reverse_proxy 127.0.0.1:4321
}
```

> 如果你用域名（推荐，Caddy 自动签证书）：把 `:8899` 换成 `reading.你的域名.com { … }` 即可。
> 端口 8899 需已在防火墙放行（已为你添加）。

Nginx 等价写法就是 `location / { proxy_pass http://127.0.0.1:4321; }` + certbot，
同样**不要**加 `auth_basic`（鉴权在应用里）。

**5. 验证**

```bash
# 公开接口，访客即可访问
curl https://你的站点:8899/api/stats
# 应返回 {"books":...,"keyConfigured":true,...}

# 管理员登录（成功才出现管理按钮）
curl -s -X POST https://你的站点:8899/api/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"你的SITE_PASSWORD"}'
# 应返回 {"ok":true,"role":"owner"}，并在响应头 Set-Cookie 里下发 owner_session
```

> 注意：管理操作（如 `/api/sync`）需要携带登录后的 `owner_session` Cookie。
> 浏览器登录后自动带；命令行自测可 `curl -c cookies.txt -b cookies.txt …`。

### 两个必须处理的运维点

**① 备份要出机器**

`data/backups/` 跟着服务器一起挂就白备份了。加一条定时任务把备份拉到本机或对象存储：

```bash
# 你本机 crontab：每天 22:10 从服务器拉备份
10 22 * * * rsync -az user@server:/opt/reading-cards/data/backups/ ~/Backups/reading-cards/
```

**② 服务器上的 SQLite 只适合单进程**

不要开多个实例指向同一个库文件。当前设计就是一个进程，正好匹配；如果将来要扩，
必须换成真正的数据库（见方案 C）。

---

## 方案 B：本机为主 + 云端镜像

适合「人在外面想翻两页、想记两笔」，但不想把 Key 放上服务器。

- **本机**：照旧跑同步、复习、写感悟（Key 只在本机）
- **推送**：定时把 `GET /api/export` 的 JSON 推到云服务的 Database 表
- **云端**：一个用 `@tencent-ai/workbuddy-cloud-sdk` 的前端应用，只读展示卡片；如需写感悟，
  记录在云端并在下次本机启动时反向拉回（**单向覆盖会丢数据，必须做合并**）

代价：数据两份、要处理一致性与冲突。除非确有移动端需求，否则不如方案 A 直接。

`/api/export` 已经实现了，导出的结构带 `format: liudongdeshu.userdata.v1` 版本号，
迁移时按版本判断。

---

## 方案 C：面向所有读书爱好者（为什么现在做不了）

你的原始目标是「面向所有读书爱好者」。这个目标需要：

| 需要的能力 | 现状 |
|---|---|
| 用户注册 / 登录 / 数据隔离 | 云服务 Auth ✅ 可提供 |
| 云端数据库 | 云服务 Database ✅ 可提供 |
| **代用户调用微信读书网关** | ❌ **没有**。云服务不含自定义服务端计算，且网关拒绝浏览器直连 |
| 每个用户的 Key 安全托管 | 需要自建服务端 + 加密存储 |

所以做多用户，必须自建一个 Node 服务端来承接同步：

```
浏览器 ──登录──▶ 你的服务端（Auth + 同步代理 + 每用户 Key 加密存储）
                     │
                     ├─▶ i.weread.qq.com（用该用户的 Key）
                     └─▶ 云数据库（卡片、感悟、收藏，按 user_id 隔离）
```

关键设计点：

1. **Key 加密存储**：AES-256-GCM，主密钥放 KMS 或环境变量，不落库；只存密文。
2. **每用户限流**：网关有频率限制，同步要排队，不能一个用户把配额打满。
3. **首次同步很重**：单用户全量约 4000 条划线 / 14 秒；100 个用户就是 100 次全量拉取，
   必须异步任务化 + 进度条。
4. **正式授权**：如果微信读书有官方开放平台授权渠道，走授权比让用户交 Key 更合规。
   我**没有验证过**这条渠道是否存在、门槛如何 —— 需要你自己去官方文档确认，
   我不能替你承诺。

---

## 部署前安全清单

- [ ] `.env` 权限 600，且不在版本库（`.gitignore` 已包含）
- [ ] 访客可公开浏览，但管理操作（同步/备份/导出/新增书籍）受应用内 `SITE_PASSWORD` 保护
- [ ] `SESSION_SECRET` 随机且保密，未写死默认值上线
- [ ] 全站 HTTPS（Caddy 自动签，或 certbot）
- [ ] `data/backups/` 有异地副本
- [ ] 确认 `WEREAD_API_KEY` 没有出现在任何前端文件、日志、导出的 JSON 里
- [ ] 如果换域名：云服务的 Origin 校验是精确匹配，换域名会打断同步

---

## 迁移路径建议

1. 现在 → **方案 A**：半天，拿到可用链接，数据仍在你手里
2. 给评委/朋友看 → 方案 A **已内置访客模式**：默认访客、数据按 UUID 隔离、管理员口令登录，
   直接把链接发出去即可，无需另建只读账号
3. 真要面向所有人 → 方案 C，独立立项，不要和竞赛交付混在一起
