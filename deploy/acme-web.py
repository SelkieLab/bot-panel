#!/usr/bin/env python3
"""ACME HTTP-01 挑战应答 + 到 HTTPS 的跳转。

certbot --webroot 需要 80 端口能回 /.well-known/acme-challenge/<token>。
其它路径一律 301 到 HTTPS 面板。

用环境变量配置：
  ACME_ROOT        挑战文件根目录（默认 /var/www/acme）
  PANEL_HOST       跳转目标主机名
  PANEL_PORT       跳转目标端口（默认 16666）
"""
import os, http.server, urllib.parse

ROOT = os.environ.get("ACME_ROOT") or "/var/www/acme"
HOST = os.environ.get("PANEL_HOST") or "localhost"
PORT = os.environ.get("PANEL_PORT") or "16666"


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p.startswith("/.well-known/acme-challenge/"):
            fp = os.path.join(ROOT, p.lstrip("/"))
            if os.path.isfile(fp):
                data = open(fp, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_error(404)
            return
        self.send_response(301)
        self.send_header("Location", "https://%s:%s%s" % (HOST, PORT, self.path))
        self.end_headers()

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(("0.0.0.0", 80), H).serve_forever()
