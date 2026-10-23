# 部署手册

从一台干净的 Ubuntu 22.04 开始，到面板能在外网正常打开。

## 0. 前提

* 一台机器，能装 Docker
* Python 3.8+
* 一个能解析到这台机器的域名（没有域名也能用 `sslip.io`，见第 5 节）
* 云厂商安全组能改

## 1. 起上游两个容器

面板只是界面，机器人本体要自己起。`deploy/docker-compose.yml` 是参考配置：

```bash
sudo mkdir -p /opt/bots
sudo cp deploy/docker-compose.yml /opt/bots/
cd /opt/bots && sudo docker compose up -d
```

要点：

* compose 里 `image` 写的是 `@sha256:...`，别改回 `:latest`
* SnowLuma 需要 `CAP_SYS_PTRACE`、`seccomp=unconfined`、1G shm，缺一个都可能让 QQ 崩
* 所有端口只绑 `127.0.0.1`，对外只开面板

## 2. 建服务用户

```bash
sudo useradd -r -m -d /home/botpanel -s /usr/sbin/nologin botpanel
sudo usermod -aG docker botpanel
```

面板需要 `docker` 组才能管容器。这是它最大的权限，别给普通账号。

## 3. 放代码

```bash
sudo mkdir -p /opt/bots/panel
sudo git clone https://github.com/SelkieLab/bot-panel.git /tmp/bp
sudo cp -r /tmp/bp/* /opt/bots/panel/
sudo chown -R botpanel:botpanel /opt/bots/panel
```

`config.json` 会由首次启动生成，权限 0600，属主是服务用户。

## 4. 装 systemd 单元

```bash
sudo cp deploy/systemd/bot-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bot-panel
journalctl -u bot-panel -n 30 --no-pager
```

首次启动日志里有一行 `[init] 面板初始密码：...`，抄下来。

**按自己路径改 `ReadWritePaths`**。`ProtectSystem=strict` 下只有列出的路径可写，
漏了 `/run/docker.sock` 会让所有容器操作失效。

## 5. 上 HTTPS

### 有域名

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d panel.example.com
```

然后把 `config.json` 改成：

```json
"tls": {
  "enabled": true,
  "cert": "/etc/letsencrypt/live/panel.example.com/fullchain.pem",
  "key": "/etc/letsencrypt/live/panel.example.com/privkey.pem"
}
```

私钥要给服务用户读的权限：`sudo chgrp botpanel privkey.pem && sudo chmod 640 privkey.pem`。

### 没有域名

用 `sslip.io`：把 IP 写成子域名就能解析，如 `1-2-3-4.sslip.io`。
开放 80 端口，用 `deploy/acme-web.py` 应答 HTTP-01 挑战：

```bash
sudo PANEL_HOST=1-2-3-4.sslip.io python3 deploy/acme-web.py &
sudo certbot certonly --webroot -w /var/www/acme -d 1-2-3-4.sslip.io
```

挑战目录要长期留着，续期还得用。

## 6. 收尾

- [ ] 安全组只放行自己的 IP 访问面板端口
- [ ] noVNC 端口不要对公网开放
- [ ] 登录面板 → 设置 → 改密码
- [ ] 开两步验证，把密钥存到验证器
- [ ] 填上游账号（AstrBot / SnowLuma）
- [ ] 配告警通道，点「发送测试」确认收到

## 7. 备份

```bash
sudo cp deploy/bin/backup.sh /opt/bots/bin/ && sudo chmod +x /opt/bots/bin/backup.sh
sudo cp deploy/systemd/bot-backup.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now bot-backup.timer
```

只备不可再生数据：AstrBot 库与配置、QQ 登录态、面板自身。
sqlite 用在线 `.backup` 保证 WAL 下也一致。

## 8. 用 Docker 跑面板（可选）

不想装 systemd 单元的话，仓库自带 `Dockerfile`：

```bash
docker build -t bot-panel .

docker run -d --name bot-panel \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/bots/panel-data:/app/data \
  -e PANEL_INIT_PASSWORD='你的密码' \
  -e ASTRBOT_BASE=http://127.0.0.1:6185 \
  -e SNOWLUMA_BASE=http://127.0.0.1:5099 \
  --restart unless-stopped \
  bot-panel
```

三个注意点：

1. **必须挂 `docker.sock`**，否则面板看不到也管不了容器。这等于把宿主的 docker 权限给了容器，自己权衡。
2. **用 `--network host`**，因为面板默认连 `127.0.0.1` 的上游服务；换成 bridge 网络就得把 `ASTRBOT_BASE` 之类改成宿主 IP。
3. **数据要挂出来**：`config.json`、`audit.log`、`knowledge/`、`tls/` 都在 `/app` 下，不挂卷容器一删就没了。

## 排障

| 现象 | 先看什么 |
|---|---|
| 面板打不开 | `systemctl status bot-panel`；端口是否被别的进程占 |
| 登录后立刻掉线 | `config.json` 的 `secret` 是否存在且未变 |
| 容器状态全空 | 服务用户是否在 `docker` 组；`/run/docker.sock` 是否可写 |
| 插件市场空白 | 上游网络；`/api/selfcheck` 看具体项 |
| 改前端不生效 | 跑 `deploy/bin/hash_assets.py`；看 `/assets/` URL 的哈希变了没 |
| 静态资源 401 | `server.py` 的 `static_map` 白名单是否包含该路径 |
