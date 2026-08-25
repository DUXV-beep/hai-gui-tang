# 🍜 迷雾汤 · 多人联机 AI 主持海龟汤游戏网站

> 「只有面对奇怪的现象，真相才肯露头 —— 夜色已深，推理开场。」
>
> 一款基于 **LLM 做 AI 主持人**的多人联机海龟汤（情境推理）游戏网站，无需真人主持，随时随地 2-4 人开黑。支持玩家投稿 AI 初审、举报内容治理、管理后台审核。已完成生产部署，公网可玩。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#)
[![Stack](https://img.shields.io/badge/Stack-Next.js%2015%20%7C%20React%2019%20%7C%20Socket.io%20%7C%20SQLite-2ea44f)](#)
[![Deploy](https://img.shields.io/badge/Deployed-TencentCloud%20Lighthouse%20HK-blue)](#)

---

## 🌐 在线体验

| 场景 | 地址 |
|------|------|
| 🎮 游戏首页 | `http://43.128.14.39`（域名备案/解析后将切换到 HTTPS 自定义域名） |
| 🛡️ 管理后台 | `http://43.128.14.39/admin`（口令登录，处理待复核汤 & 举报下架队列） |

> 💡 提示：测试联机请用两部设备（或手机 4G + 电脑）分别打开首页 → 公开房列表即可看到对方创建的房间。

---

## ✨ 核心特性

### 🎮 多人联机 & AI 主持人
- **三通道聊天架构**：自由聊天（无 AI）、玩家提问（AI 回答是/否/无关）、玩家推理（AI 裁决成功/失败）三通道分离；提问与推理消息自动带 `[提问同步]` / `[推理同步]` 标签同步回公聊
- **基于 DeepSeek-V4-Flash 的 AI 主持人**：结合汤面、玩家历史提问、提示索引生成上下文感知的 AI 小提示，避免重复提示
- **推理裁决不剧透**：AI 拒绝推理时从白名单通用反馈模板生成回复，绝不泄露汤底细节
- **Socket.io 实时通信**：自带房间机制 + 断线重连 + playerId 稳定身份（localStorage 持久化），刷新页面玩家身份与房间状态不丢失

### 🏠 房间机制（最多 4 人）
- **公开房 / 密码房**：密码使用 `sha256(salt + pwd)` 哈希入库，不落明文
- **房主 60s 可回收顺延机制**：房主掉线后 60s 内可凭 hostToken 回收房主；超时自动顺延最长在线玩家为新房主，防止假房主踢人
- **公开房列表 30 上限 + 实时广播**：服务端过滤满房，返回 `{ list, total }`，前端 440px 容器内滚动并显示「还有 N 间未显示」提示
- **游戏中锁定房间配置**：对局开始后禁止房主修改最大人数、换汤（换汤需二次确认防止误触）、改上限；汤底揭晓后锁定提问/推理通道

### 📝 玩家投稿 + AI 初审闭环
- 投稿字段（标题 / 汤面 / 汤底）做长度限制，防止数据库溢出与 AI token 滥用
- **AI 初审**：玩家投稿的汤直接送入 LLM 做逻辑一致性校验
  - ✅ 通过 → 状态 `approved` 直接入汤池，可被随机抽到
  - ⚠️ 未通过 → 状态 `review` 进入管理后台「待人工复核」队列（管理员可手动 approve / reject）

### 🛡️ 举报 & 内容治理
- **9 分类多选 + 补充说明**：涉黄、涉暴血腥、政治敏感、歧视辱骂、逻辑不通、答案歧义、质量过低、抄袭搬运、广告引流
- **举报全局去重**：同一玩家（按 playerId）对同一汤全局只计 1 次
- **双阈值自动下架**：单房间 ≥3 个不同玩家举报 **或** 全局累计 ≥5 个不同玩家举报 → 汤状态自动变为 `flagged`（下架）
- **下架汤永不复用**：正在进行的对局不受影响（逻辑汤已在内存里），后续新开局不再抽到下架汤；作者需改稿重新投稿（无申诉恢复通道）

### 🔒 管理后台安全
- `/admin` 基于 **DB 持久化 Session + httpOnly Cookie** 登录（不通过 query 串传密码），POST `/api/admin/login` 提交
- **IP 失败锁定**：同一 IP 连续 5 次口令错误即锁定 15 分钟（`ADMIN_MAX_FAIL=5`、`ADMIN_LOCK_MINUTES=15` 可调）
- 所有写操作（approve / reject / delete / restore）**需二次确认**，并全量写入 `admin_logs` 审计表
- 手动备份数据库 + 备份文件列表查询功能内置

### ⚔️ 纵深防线（防滥用 / 安全）
- **消息频率限制**：3s 内 max 3 条消息，第 4 条触发 2s 冷却；顶部居中 Toast 系统提示（3-5s 自动消失）
- **连接级 + IP 级建/加房限流**：建房 ≤5/60s·连接、加入 ≤20/60s·连接；叠加按 IP 总量（建房 20/min、加入 60/min，30s 清理窗口）
- **AI 请求限流**：per-socket 8/30s、per-room 40/60s、投稿 3/60s；**AI 调用 20s AbortController 超时**防止挂起
- **CORS 收窄**：服务端仅放行 `PUBLIC_ORIGIN` 配置的域名/IP（生产不开放 origin:*）
- 公网 Origin 可切换：`.env.local` 改 `PUBLIC_ORIGIN` 后 `pm2 restart` 自动生效（Socket.io 跨域与 cookie 域同步变化）

### 💾 可靠性 & 生产部署
- **Node.js 22 内置 SQLite (`node:sqlite`)**：零外部依赖；6 张核心表（汤池 sips、房间 rooms、举报 reports、管理会话 admin_sessions、操作日志 admin_logs、登录失败 admin_login_failures）
- **房间持久化**：`chat_history` / `ask_history` / `surrender_open` / `surrender_votes` 全部落库，服务器进程重启或物理机重启后，进行中的对局可以继续（玩家身份、聊天历史、弃权状态不丢）
- **自动备份**：每 6 小时 gzip 压缩 `turtleSoup.db`，计算 SHA256 写入校验文件，**自动清理超过最近 30 份**的旧备份
- **进程守护**：PM2 托管 Node 进程（自动重启崩溃进程 + `pm2 startup systemd` 开机自启 + `pm2 save` 快照）
- **反向代理 + 自动 HTTPS**：Caddy systemd 托管，自动申请 / 续期 Let's Encrypt 免费证书，WebSocket（Socket.io）零配置透传
- **部署方案**：腾讯云轻量应用服务器（中国香港 2C2G，免备案）+ Node.js 24 LTS 兼容运行环境 + Swap 2G（防止 Next build 爆内存）+ 全端口放通 80/443/3000
- **升级流程**：服务器打 snapshot tar.gz → 带 `--keep-old-files --exclude data / .env.local` 安全解压 → `npm ci` → `NODE_OPTIONS='--experimental-sqlite' npm run build` → `pm2 restart`；失败可秒级回滚 snapshot

### 🎨 UI / UX（悬疑非恐怖美术风格）
- 全站「卷宗面板」设计：深蓝夜空（#0B1026 为主色）+ 牛皮纸色文本（#F4E9CF）+ 金色边线 + 四角装饰
- OKLCH 设计系统调色板 + 清晰的字号层级（H1/H2/H3/Body/Caption）
- 语义化动画：背景星光漂移、卡片入场 rise、金色描边 glow，克制不恐怖
- 三个主功能 Tab 切换（开局 / 投稿 / 战绩），无关功能分离避免 AI 前端味
- 关键信息醒目：提问剩余次数 ≤3 自动变红警告；`开启 AI 提示` 开关用 iOS 风格卡片 + 状态徽章；系统消息顶部居中 Toast
- 移动端适配：≤520px viewports 响应式调整内边距 / 字号 / 元素尺寸；公开房列表 max-height 440px 内部滚动

---

## 🧱 技术栈

| 分类 | 技术 | 用途 |
|------|------|------|
| **前端** | Next.js 15 App Router / React 19 | SSR + 客户端路由、页面结构 |
| **前端样式** | 纯 CSS / OKLCH 颜色空间 / CSS 动画 | 悬疑美术风格设计系统、动画 |
| **实时通信** | Socket.io 4.x（服务端 + 客户端） | 三通道聊天、房间事件广播 |
| **后端** | Node.js 自定义 Next Server（Express 风格中间件） | HTTP API + Socket 握手 + CORS + 限流 |
| **数据库** | Node.js 22 内置 `node:sqlite`（DatabaseSync） | 零运维本地持久化存储 |
| **AI 能力** | DeepSeek-V4-Flash HTTP API | AI 主持人裁决、投稿初审、AI 提示 |
| **进程守护** | PM2 5.x | 崩溃自动重启、开机自启、日志管理 |
| **反向代理 & HTTPS** | Caddy 2.x | 80/443 监听、自动证书、WebSocket 透传 |
| **部署** | Tencent Cloud Lighthouse（HK，2C2G）+ OpenCloudOS | 免备案公网节点 |
| **认证** | 自建 Session（SQLite admin_sessions + httpOnly Cookie）| 管理后台登录安全 |
| **构建** | Next.js Production Build（`next build`） | 独立页面级 Code Splitting + chunk 压缩 |

---

## 📁 目录结构

```
hai-gui-tang/
├── app/                          # Next.js App Router 页面
│   ├── admin/page.js             # 管理后台页面（口令登录+队列处理）
│   ├── api/admin/
│   │   ├── act/route.js          # approve/reject/delete/restore 操作接口
│   │   ├── login/route.js        # 登录 + 失败锁定检查
│   │   ├── logout/route.js       # 登出 + 清 session
│   │   └── queue/route.js        # 拉取待复核/举报下架队列
│   ├── room/[id]/page.js         # 游戏房间页（三通道聊天 + 操作面板）
│   ├── Brand.js                  # Logo 组件（悬疑卷宗风）
│   ├── globals.css               # 全局设计系统（颜色/字体/动画/组件样式）
│   ├── icon.svg                  # 站点图标
│   ├── layout.js                 # 全局布局
│   └── page.js                   # 首页（开局/投稿/战绩 三 Tab + 公开房列表）
├── lib/                          # 后端共享逻辑
│   ├── adminSession.js           # 管理后台 session 登录/锁定/审计
│   ├── aiHost.js                 # AI 主持人（提问/推理/投稿/提示 LLM 封装 + 超时）
│   └── db.js                     # SQLite 初始化、六张表建表 + 15 道内置汤 seed
├── server.js                     # Node 自定义 Next Server + Socket.io 房间逻辑 + 限流
├── backup.js                     # 6 小时自动备份（gzip + sha256 + 保留最近 30 份）
├── next.config.mjs               # Next.js 配置
├── package.json                  # 脚本 & 依赖
├── .gitignore                    # 数据库/密钥/构建产物全量忽略
└── data/                         # 运行时生成（不入库）：turtleSoup.db + backups/
```

---

## 🚀 本地开发 / 部署

### 本地开发
```bash
# 1. 安装依赖
npm install

# 2. 新建 .env.local（填入你自己的配置）
DEEPSEEK_API_KEY=sk-xxx
ADMIN_PASSWORD=你的管理口令
PUBLIC_ORIGIN=http://localhost:3000
NODE_ENV=development
PORT=3000

# 3. 启动开发服务器（默认 http://localhost:3000）
node server.js
# 或：npm run dev
```

### 生产部署
详见项目 memory/会话记录的「腾讯云轻量 2C2G 香港节点部署全流程」，核心命令摘录：
```bash
# 构建
NODE_OPTIONS='--experimental-sqlite' npm run build
# PM2 启动（必须带 --experimental-sqlite 启用 Node 22 SQLite）
pm2 start server.js --name turtle-soup --node-args="--experimental-sqlite"
# Caddy 反代（示例，域名启用后可直接换 HTTPS）
http://43.128.14.39 {
    reverse_proxy 127.0.0.1:3000
}
```

---

## 📊 可观测性 & 运维

| 操作 | 命令 |
|------|------|
| 应用实时日志 | `pm2 logs turtle-soup` |
| 重启应用（改完 .env.local 后） | `pm2 restart turtle-soup` |
| Caddy 状态 / 日志 | `systemctl status caddy` / `journalctl -u caddy -f` |
| 服务器资源 | `free -h`、`df -h`、`top` |
| 备份数据库（下载到本地） | `scp root@<ip>:/opt/turtle-soup/data/turtleSoup.db .` |

---

## 🎯 Roadmap（后续规划）
- [ ] 自定义域名 + HTTPS（Caddy 自动证书，域名审核通过后上线）
- [ ] 玩家战绩体系个人中心 / 胜率统计
- [ ] 汤池分类标签（恐怖/温情/脑洞/硬核/短平快）筛选题池偏好
- [ ] 举报后作者邮箱/站内信通知（如果接入邮件服务）
- [ ] 微信小程序端 / PWA 离线缓存

---

## 📜 License
项目源码仅供学习与个人部署使用，内置 15 道海龟汤版权归原作者所有，如涉及侵权请联系仓库所有者删除。

---

> 如果你觉得这个项目有意思，欢迎点个 Star ⭐，它会成为我简历上闪闪发光的一笔 ✨
