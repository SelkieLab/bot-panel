# 架构

一个进程、一个文件、一个 SQLite 之外不连任何数据库。

```
浏览器  ──HTTPS──▶  server.py  ──HTTP──▶  AstrBot  (127.0.0.1:6185)
                        │      ──HTTP──▶  SnowLuma (127.0.0.1:5099)
                        │      ──HTTP──▶  OneBot   (127.0.0.1:3000)
                        │
                        └──docker CLI──▶  docker daemon（读写 socket）
```

## 为什么是单文件

面板的职责是"把已有的东西翻译成网页"，本身不该是一套新系统。
拆成模块就要处理导入、配置分发、循环依赖，而这些复杂度换不来任何功能。
现在的 `server.py` 约 2000 行，用注释分成若干区段，从上往下读得完。

## 请求怎么走

1. `do_GET` / `do_POST` 收请求，先走静态资源判断（`/assets/<hash>/`、`/partials/`、`/login`）
2. 需要鉴权的路径先查会话 cookie，未登录返回 401
3. `/api/*` 分派到对应 `api_*` 方法
4. `api_*` 里通过 `ab_get` / `sl_get` / `onebot_call` 代理到上游，自动带 token，401 时重登一次

## 上游鉴权

| 上游 | 方式 | 缓存 |
|---|---|---|
| AstrBot | `POST /api/auth/login` 换 Bearer | 内存 `TOKENS`，401 自动重登 |
| SnowLuma | `POST /api/login` 换 Bearer | 同上 |
| OneBot | 容器内 onebot 配置里的 accessToken | 10 分钟 |

## 前端

分成三层，各管一件事：

| 文件 | 职责 |
|---|---|
| `index.html` | 只有 head 与 slot 占位符，没有实际内容 |
| `js/boot.js` | 先 fetch 所有 partials 拼进 slot，再动态加载 app.js |
| `js/app.js` | 全部交互逻辑，按面板分区 |

这么切是因为 `app.js` 太大（1700 行），改一处会动整个文件；
拆成 partials 后改某个面板只动对应那一个 HTML 片段。

代价是首屏多几个请求。用内容哈希 URL + `immutable` 长缓存抵掉，
二次访问不会再取。

## 缓存策略

| 资源 | 策略 |
|---|---|
| `/assets/<hash>/*` | `immutable`, 一年。内容变则 URL 变 |
| `/partials/*`, `/js/boot.js` | `no-cache` + ETag，靠 304 省流量 |
| `/api/*` | `no-store`，绝不缓存 |

改了 css/js 要跑 `deploy/bin/hash_assets.py` 重算 index.html 里的哈希，
否则浏览器会一直用旧文件。

## 数据放在哪

| 数据 | 位置 | 进仓库？ |
|---|---|---|
| 配置（含上游口令） | `config.json` 0600 | 否 |
| 人格模板 | `personas.json` | 只提交 `personas.example.json` |
| 审计 | `audit.log` 0600，JSON Lines | 否 |
| 知识库文档 | `knowledge/` | 否 |
| 证书 | `tls/` | 否 |
| 插件下载缓存 | `cache/` | 否 |

## 刻意没做的事

* 没做多用户 / 权限分级 —— 单人面板，多一层角色只是多一个绕过点
* 没做 API 版本化 —— 前后端同仓库同提交，不需要
* 没做 ORM —— 只读一个库，写 `sqlite3` 查询更直接
* 没做插件化后端 —— 需求还没多到那个程度
