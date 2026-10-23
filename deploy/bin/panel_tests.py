#!/usr/bin/env python3
"""BotPanel 回归测试：把核心纯逻辑单独拉出来验证。
不需要连服务器，直接 python3 tests.py 就能跑。
"""
import base64, hashlib, hmac, json, os, re, sys, tempfile, time

FAIL = []
PASS = []

def chk(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  PASS " if cond else "  FAIL ") + name + (("  " + str(extra)) if extra and not cond else ""))

def section(t):
    print("\n== " + t + " ==")

# ---------- TOTP（RFC 6238 官方向量） ----------
section("TOTP / RFC 6238")
def totp(secret, t, step=30, digits=8):
    key = base64.b32decode(secret.upper() + "=" * ((8 - len(secret) % 8) % 8))
    counter = int(t // step)
    h = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    return str((int.from_bytes(h[o:o + 4], "big") & 0x7FFFFFFF) % (10 ** digits)).zfill(digits)

S = base64.b32encode(b"12345678901234567890").decode()
for t, want in [(59, "94287082"), (1111111109, "07081804"), (1111111111, "14050471"),
                (1234567890, "89005924"), (2000000000, "69279037"), (20000000000, "65353130")]:
    chk("RFC 向量 t=%s" % t, totp(S, t) == want, totp(S, t))

# 6 位码格式
c6 = totp(S, 1234567890, digits=6)
chk("6 位补零", len(c6) == 6 and c6.isdigit(), c6)

# ---------- 密码哈希 ----------
section("密码哈希 / pbkdf2")
def hash_password(pw, salt=None):
    salt = salt or "a" * 32
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 120000)
    return "pbkdf2_sha256$120000$%s$%s" % (salt, dk.hex())

def verify_password(pw, stored):
    try:
        algo, it, salt, digest = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(dk.hex(), digest)
    except Exception:
        return False

h = hash_password("correct-horse")
chk("正确密码通过", verify_password("correct-horse", h))
chk("错误密码拒绝", not verify_password("wrong-horse", h))
chk("空密码拒绝", not verify_password("", h))
chk("损坏哈希不崩溃", not verify_password("x", "garbage"))
chk("同密码不同盐不同哈希", hash_password("a", "b" * 32) != hash_password("a", "c" * 32))

# ---------- 配置合并（本次修的丢失 bug） ----------
section("save_config 合并语义")
def merge_save(disk, mem):
    merged = dict(disk or {})
    merged.update(mem or {})
    return merged

disk = {"tls": {"enabled": True}, "password_hash": "x", "secret": "s", "pwv": 1}
mem_stale = {"password_hash": "y", "secret": "s2", "pwv": 2}   # 内存里没有 tls
out = merge_save(disk, mem_stale)
chk("tls 不会因内存缺键而丢失", out.get("tls", {}).get("enabled") is True, out.get("tls"))
chk("内存的改动会生效", out["pwv"] == 2)
chk("磁盘独有键保留", "secret" in out)

# 内存显式覆盖 tls
mem2 = {"tls": {"enabled": False, "cert": "", "key": ""}}
out2 = merge_save(disk, mem2)
chk("内存显式覆盖生效", out2["tls"]["enabled"] is False, out2["tls"])

# ---------- 市场过滤/排序/分页 ----------
section("市场分页逻辑")
ITEMS = [
    {"name": "a", "display": "Alpha", "desc": "x", "author": "u", "stars": 5,   "downloads": 100, "cat": "工具"},
    {"name": "b", "display": "Beta",  "desc": "y", "author": "u", "stars": 50,  "downloads": 10,  "cat": "娱乐"},
    {"name": "c", "display": "Gamma", "desc": "z", "author": "u", "stars": 1,   "downloads": 999, "cat": "工具"},
]
def market(items, q="", cat="", sort="stars", page=1, n=2):
    lst = items
    if q:
        lst = [x for x in lst if q in (x["name"] + " " + x["display"] + " " + x["desc"] + " " + x["author"]).lower()]
    if cat and cat != "全部":
        lst = [x for x in lst if (x.get("cat") or "其他") == cat]
    keys = {"stars": lambda x: -(x.get("stars") or 0),
            "downloads": lambda x: -(x.get("downloads") or 0),
            "name": lambda x: (x.get("display") or x.get("name") or "")}
    if sort in keys:
        lst = sorted(lst, key=keys[sort])
    total = len(lst)
    start = (page - 1) * n
    return {"total": total, "pages": max(1, (total + n - 1) // n), "items": lst[start:start + n]}

r = market(ITEMS)
chk("按 stars 降序", [i["name"] for i in r["items"]] == ["b", "a"], [i["name"] for i in r["items"]])
chk("pages 计算", r["pages"] == 2, r["pages"])

r = market(ITEMS, sort="downloads")
chk("按 downloads 降序", [i["name"] for i in r["items"]] == ["c", "a"], [i["name"] for i in r["items"]])

r = market(ITEMS, cat="工具")
chk("分类过滤", r["total"] == 2, r["total"])

r = market(ITEMS, q="beta")
chk("搜索大小写不敏感", r["total"] == 1 and r["items"][0]["name"] == "b")

r = market(ITEMS, page=2, n=2)
chk("第二页取到剩余", len(r["items"]) == 1, len(r["items"]))

r = market(ITEMS, page=99, n=2)
chk("越界页返回空而非报错", r["items"] == [], r["items"])

# ---------- RSS 重定向缓存防注入 ----------
section("静态路径校验")
def safe_rel(rel):
    return bool(rel) and ".." not in rel and bool(re.fullmatch(r"[A-Za-z0-9_\-/]+\.(css|js|svg|png|webmanifest)", rel))

chk("正常路径放行", safe_rel("css/app.css"))
chk("拦截 ../ 穿越", not safe_rel("../etc/passwd"))
chk("拦截绝对路径", not safe_rel("/etc/passwd"))
chk("拦截非法后缀", not safe_rel("x.exe"))
chk("拦截空", not safe_rel(""))

# ---------- 告警文本 ----------
section("告警消息构造")
def alert_text(title, when, text):
    return "%s\n%s\n%s" % (title, when, text)
m = alert_text("BotPanel 告警", "10-23 22:00:00", "容器挂了")
chk("三行结构", len(m.split("\n")) == 3)
chk("含标题", "BotPanel 告警" in m)

# ---------- 汇总 ----------
print("\n" + "=" * 44)
print("通过 %d / %d" % (len(PASS), len(PASS) + len(FAIL)))
if FAIL:
    print("失败项：")
    for f in FAIL:
        print("  -", f)
    sys.exit(1)
print("全部通过")
