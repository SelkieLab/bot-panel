# 改造记录 · 2026-10-23

日期：2026-10-23
部署环境：单机 Docker（2 核 / 2G 内存 / 40G 磁盘），面板由 systemd 托管，前置 HTTPS 反向代理。
（主机地址、域名与口令已在本仓库中隐去。）

---

## 一、11 项任务完成情况

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| P1-① | 镜像固定 digest | ✅ | astrbot/snowluma 改为 `@sha256:...`，不再被 `latest` 偷换版本 |
| P1-② | 市场分页/分类/排序 | ✅ | 2703 个插件分 113 页，支持按星标/下载/名称排序 + 分类筛选 |
| P1-③ | 插件卸载/更新 | ✅ | 走 AstrBot 官方接口，内置插件受保护 |
| P2-④ | 静态资源长缓存 | ✅ | 内容哈希 URL + `immutable` 一年 + ETag/304 |
| P2-⑤ | 日志 SSE 实时流 | ✅ | `docker logs --follow` 逐行推，断线自动重连 |
| P2-⑥ | 改密 + 两步验证 | ✅ | TOTP 用 RFC 6238 官方向量验证过；改密后所有旧会话立即失效 |
| P2-⑦ | 告警通道 | ✅ | QQ 私聊 + webhook，两个渠道都实测收到 |
| P2-⑧ | 知识库接入 AstrBot | ⏸ | 代码全部做好，**等你填 embedding key** 才能建库 |
| P3-⑨ | PWA + Service Worker | ✅ | 离线兜底页，绝不缓存 API |
| P3-⑩ | 测试套件 | ✅ | 逻辑 30 项 + 接口 32 项，可随时重跑 |
| P3-⑪ | 无障碍 | ✅ | aria 标签、Esc 关闭、alt、对比度校验 |

---

## 二、顺带修掉的 3 个隐藏 bug

这三个都是原来就存在、平时看不出来的问题：

### 1. 配置丢失（最严重）
`DEFAULTS` 里没有 `tls` 键，而 `save_config()` 是整体覆盖写盘。
结果：任何一次保存配置的操作，都会把 HTTPS 配置抹掉，面板重启后就退回明文 HTTP。

修复：
- `DEFAULTS` 补上 `tls`
- `save_config()` 改为读盘合并后再写，不允许内存旧视图覆盖磁盘新键

### 2. OneBot token 永远读不到
旧代码读 `/opt/bots/snowluma-onebot.json`，这个文件早就不存在了。
结果：面板的「联系人」「主人选择」功能其实一直是坏的（全部 401）。

修复：改为从 SnowLuma 容器内 `/app/data/config/onebot_*.json` 读，并缓存 10 分钟。

### 3. `/opt/bots/panel` 目录属主是 root
`botpanel` 用户无法在该目录创建临时文件。
结果：所有「写配置」的操作都会静默失败。

修复：`chown botpanel:botpanel /opt/bots/panel`。

---

## 三、知识库：为什么还差一步

你的 AstrBot 只有一个对话模型 `deepseek-v4.1-flash`，它的 API **不提供 embedding 模型**
（拉了 `/v1/models`，11 个模型里没有一个是 embed）。

而 AstrBot 建知识库必须指定 `embedding_provider_id`，所以现在建不了库。

**怎么启用**：面板 → 设置 → 学习知识库 → 「向量模型」卡片
1. 填 Base URL（OpenAI 兼容接口，如 `https://api.openai.com/v1`）
2. 填 API Key
3. 点「获取模型」自动拉列表选，或手填（如 `text-embedding-3-small`）
4. 点「保存并接入 AstrBot」
5. 然后就能「新建知识库」→ 上传文档 → 「检索测试」验证召回

代码路径已经全部打通并做过拦截测试：没配置时会明确提示，不会假成功。

---

## 四、验收数据

```
服务      bot-panel / bot-backup.timer / certbot.timer  全部 active
容器      astrbot a140a326163a、snowluma d1afe0a15ef6   Up
磁盘      45% 已用，剩 21G
面板内存  115.9M / 320M 上限
配置权限  0600 botpanel:botpanel，关键键齐全，tls.enabled=True
备份      下次 04:37 自动跑（每天 04:30 + 随机延迟）
审计日志  88 条
```

测试结果：
- 逻辑回归 `python3 /opt/bots/bin/panel_tests.py` → 30/30
- 接口回归 `python3 /tmp/reg.py` → 32/32

---

## 五、回滚方式

改动前都做了快照，在 `/opt/bots/backups/manual/`：

```bash
# 回滚 server.py
cp /opt/bots/backups/manual/server.py.20261023-225236 /opt/bots/panel/server.py
chown botpanel:botpanel /opt/bots/panel/server.py
rm -rf /opt/bots/panel/__pycache__
systemctl restart bot-panel

# 回滚前端
cp /opt/bots/backups/manual/app.js.20261023-225236 /opt/bots/panel/static/js/app.js
chown botpanel:botpanel /opt/bots/panel/static/js/app.js
```

---

## 六、仍然建议你处理的事

1. **noVNC（:16081）比面板本身危险得多** —— 那是完整远程桌面，8 位密码。建议关掉，或至少限制来源 IP。
2. **16666 端口对全网开放** —— 阿里云安全组里建议只放行你自己的 IP；已经上 HTTPS 了，但端口收窄更稳。
3. **面板口令** —— 不要沿用任何示例口令，并开启两步验证（设置 → 账户安全 → 生成密钥）。这样即使密码泄露也进不来。
