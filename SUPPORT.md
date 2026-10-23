# 遇到问题先看这里

## 按这个顺序排查

1. **`/api/selfcheck`** —— 面板「设置 → 自检」，或在登录状态下访问这个接口。
   它会逐项报告容器、证书、磁盘、备份的状态，多数问题这里就能定位。
2. **日志** —— `journalctl -u bot-panel -n 100 --no-pager`（systemd）或 `docker logs bot-panel`（容器）。
3. **部署文档** —— [docs/DEPLOY.md](docs/DEPLOY.md) 末尾有排障对照表。
4. **已有 issue** —— 搜一下关键词，可能已经有人问过。

## 还是不行就开 issue

用 [问题模板](https://github.com/SelkieLab/bot-panel/issues/new/choose)，把这几样带上：

* 版本或 commit（`git rev-parse --short HEAD`）
* 部署方式（systemd / 裸跑 / Docker）
* 环境（系统、Python 版本、Docker 版本）
* 复现步骤
* 相关日志（**记得删掉口令、IP、QQ 号**）

信息不全的 issue 只能来回问，处理会慢很多。

## 什么不该开 issue

| 情况 | 去哪 |
|---|---|
| 安全漏洞 | [SECURITY.md](SECURITY.md)，走私密报告，别开公开 issue |
| 想讨论用法 / 提想法 | [Discussions](https://github.com/SelkieLab/bot-panel/discussions) |
| 上游 AstrBot / SnowLuma 自身的问题 | 去它们各自的仓库，这里只管面板 |
