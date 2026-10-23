#!/usr/bin/env python3
"""index.html / login.html 里的静态资源换成内容哈希 URL。
每次改完 css/js 运行本脚本，URL 自动变 → 浏览器必定拉新，同时可长缓存。"""
import hashlib, os, re, io, sys

STATIC = os.environ.get("PANEL_STATIC") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "static")

def h(rel):
    p = os.path.join(STATIC, rel)
    if not os.path.isfile(p):
        return None
    return hashlib.sha256(open(p, "rb").read()).hexdigest()[:12]

def rewrite(fname, mapping):
    p = os.path.join(STATIC, fname)
    src = io.open(p, encoding="utf-8").read()
    orig = src
    for rel, prefix in mapping:
        hv = h(rel)
        if not hv:
            continue
        # 同时兼容 /x.js 与 /x.js?v=old 两种写法
        pat = re.compile(r'(href|src)="' + re.escape(prefix) + r'(\?v=[^"]*)?"')
        src = pat.sub(lambda m: '%s="/assets/%s/%s"' % (m.group(1), hv, rel), src)
    if src != orig:
        io.open(p, "w", encoding="utf-8").write(src)
        print("rewrote", fname)
    else:
        print("unchanged", fname)

rewrite("index.html", [
    ("css/app.css", "/css/app.css"),
    ("js/theme.js", "/js/theme.js"),
    ("js/boot.js", "/js/boot.js"),
    ("manifest.webmanifest", "/manifest.webmanifest"),
])
rewrite("login.html", [
    ("js/theme.js", "/theme.js"),
    ("js/theme.js", "/js/theme.js"),
])
