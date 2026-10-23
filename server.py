#!/usr/bin/env python3
# QQ Bot 控制台 —— 服务器端（纯标准库）
import base64, hashlib, hmac, json, os, re, secrets, shutil, socket, sqlite3, subprocess, threading, time, urllib.request, urllib.error, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
CONFIG_PATH = os.environ.get("PANEL_CONFIG") or os.path.join(BASE, "config.json")
PERSONAS_PATH = os.environ.get("PANEL_PERSONAS") or os.path.join(BASE, "personas.json")
# AstrBot 数据目录（宿主机侧，即 docker volume 挂载点）
ASTRBOT_DATA = os.environ.get("ASTRBOT_DATA") or "/opt/bots/astrbot/data"
DB_PATH = os.path.join(ASTRBOT_DATA, "data_v4.db")
PORT = int(os.environ.get("PANEL_PORT") or 16666)

# docker 容器名（compose 里改名后可用环境变量覆盖）
ASTRBOT_CONTAINER = os.environ.get("ASTRBOT_CONTAINER") or "astrbot"
SNOWLUMA_CONTAINER = os.environ.get("SNOWLUMA_CONTAINER") or "snowluma"

# 默认值里不含任何真实口令：仓库是公开的，密码只能来自环境变量或
# 首次启动后写入 config.json（0600）。上游服务的账号在「设置」里改。
DEFAULTS = {
    "password_hash": "",
    "owners": [],
    "novnc_url": os.environ.get("NOVNC_URL") or "",
    "astrbot": {"username": os.environ.get("ASTRBOT_USER") or "astrbot",
                "password": os.environ.get("ASTRBOT_PASSWORD") or "",
                "base": os.environ.get("ASTRBOT_BASE") or "http://127.0.0.1:6185"},
    "snowluma": {"username": os.environ.get("SNOWLUMA_USER") or "admin",
                 "password": os.environ.get("SNOWLUMA_PASSWORD") or "",
                 "base": os.environ.get("SNOWLUMA_BASE") or "http://127.0.0.1:5099"},
    "onebot": {"base": os.environ.get("ONEBOT_BASE") or "http://127.0.0.1:3000",
               "token": os.environ.get("ONEBOT_TOKEN") or ""},
    "market_cache": os.path.join(BASE, "cache", "catalog.json"),
    "download_dir": os.path.join(BASE, "downloads"),
    # tls 必须出现在默认值里：否则 save_config 用内存 CFG 覆盖磁盘时会把 tls 段写丢
    "tls": {"enabled": False, "cert": "", "key": ""},
}

AUDIT_PATH = os.path.join(BASE, "audit.log")
AUDIT_LOCK = threading.Lock()

def audit(action, **kv):
    """关键操作审计（登录、重启、改配置）。JSON Lines，由 logrotate 轮转。"""
    try:
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "action": action}
        rec.update({k: v for k, v in kv.items() if v is not None})
        line = json.dumps(rec, ensure_ascii=False) + "\n"
        with AUDIT_LOCK:
            fd = os.open(AUDIT_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                f.write(line)
    except Exception:
        pass

def load_config():
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception:
            pass
    if not cfg.get("password_hash"):
        # 首次启动：优先 PANEL_INIT_PASSWORD，否则随机生成并只打印一次。
        init_pw = os.environ.get("PANEL_INIT_PASSWORD") or secrets.token_urlsafe(12)
        cfg["password_hash"] = hash_password(init_pw)
        cfg["secret"] = secrets.token_hex(32)
        save_config(cfg)
        print("[init] 面板初始密码：%s（登录后请立即修改）" % init_pw, flush=True)
    if not cfg.get("secret"):
        cfg["secret"] = secrets.token_hex(32)
        save_config(cfg)
    os.makedirs(os.path.dirname(cfg["market_cache"]), exist_ok=True)
    os.makedirs(cfg["download_dir"], exist_ok=True)
    return cfg

def save_config(cfg):
    # 合并磁盘上已有的键：内存里的 cfg 可能是较早的视图，
    # 直接整体覆盖会把外部写入的段（比如 TLS 配置）抹掉。
    merged = {}
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, encoding="utf-8") as f:
                merged = json.load(f) or {}
    except Exception:
        merged = {}
    merged.update(cfg or {})
    tmp = CONFIG_PATH + ".tmp"
    # 0600：配置内含 AstrBot/SnowLuma 密码、OneBot token 与 HMAC secret
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:
        pass

def hash_password(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 120000)
    return "pbkdf2_sha256$120000$%s$%s" % (salt, dk.hex())

def verify_password(pw, stored):
    try:
        algo, it, salt, digest = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(dk.hex(), digest)
    except Exception:
        return False

# ---------------- 两步验证（TOTP，RFC 6238） ----------------
def totp_now(secret, step=30, digits=6, offset=0):
    """纯标准库 TOTP：base32 secret → 当前 6 位码。offset 用于 ±1 步容错。"""
    key = base64.b32decode(secret.upper() + "=" * ((8 - len(secret) % 8) % 8))
    counter = int(time.time() // step) + offset
    msg = counter.to_bytes(8, "big")
    h = hmac.new(key, msg, hashlib.sha1).digest()
    o = h[-1] & 0x0F
    code = (int.from_bytes(h[o:o + 4], "big") & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)

def totp_verify(secret, code):
    """允许前后各 1 个时间步（±30s），容忍手机时钟偏差。"""
    code = (code or "").strip().replace(" ", "")
    if not secret or not code.isdigit() or len(code) != 6:
        return False
    return any(hmac.compare_digest(totp_now(secret, offset=o), code) for o in (-1, 0, 1))

def totp_new_secret():
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")

def totp_uri(secret, account="panel"):
    return "otpauth://totp/QQBotPanel:%s?secret=%s&issuer=QQBotPanel&algorithm=SHA1&digits=6&period=30" % (account, secret)


CFG = load_config()

# ---------------- helpers ----------------
def http_json(url, method="GET", body=None, token=None, timeout=10, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        raise e

def run(cmd, timeout=20):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.stdout
    except Exception:
        return ""

def read_file(path, enc="utf-8"):
    try:
        with open(path, encoding=enc) as f:
            return f.read()
    except Exception:
        return ""

def fmt_containers():
    out = run(["docker", "ps", "--format", "{{.Names}}|{{.Status}}"])
    stats_raw = run(["docker", "stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}"], timeout=25)
    stats = {}
    for line in stats_raw.splitlines():
        parts = line.split("|")
        if len(parts) >= 4:
            stats[parts[0]] = {"cpu": parts[1], "mem": parts[2], "mem_perc": parts[3]}
    items = []
    for line in out.splitlines():
        if "|" not in line:
            continue
        name, status = line.split("|", 1)
        st = stats.get(name, {})
        items.append({"name": name, "status": status, "cpu": st.get("cpu", "-"), "mem": st.get("mem", "-"), "mem_perc": st.get("mem_perc", "-")})
    return items

def server_info():
    load = read_file("/proc/loadavg").split()
    mem = {}
    for line in read_file("/proc/meminfo").splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            try:
                mem[k.strip()] = int(v.strip().split()[0])
            except Exception:
                pass
    du = shutil.disk_usage("/")
    up = read_file("/proc/uptime").split()
    osr = {}
    for line in read_file("/etc/os-release").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            osr[k] = v.strip().strip('"')
    ip = ""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    return {
        "host": socket.gethostname(),
        "os": osr.get("PRETTY_NAME", ""),
        "kernel": os.uname().release,
        "cores": os.cpu_count(),
        "uptime": int(float(up[0])) if up else 0,
        "load1": float(load[0]) if load else 0,
        "mem_total": mem.get("MemTotal", 0) * 1024,
        "mem_avail": mem.get("MemAvailable", 0) * 1024,
        "swap_total": mem.get("SwapTotal", 0) * 1024,
        "swap_free": mem.get("SwapFree", 0) * 1024,
        "disk_total": du.total,
        "disk_used": du.used,
        "ip": ip,
    }

def bot_stats():
    lat = []
    personas = []
    today = time.strftime("%Y-%m-%d")
    today_msgs = total_msgs = 0
    model = ""
    try:
        j = json.loads(read_file("/opt/bots/astrbot/data/cmd_config.json", "utf-8-sig"))
        provs = j.get("provider") or []
        model = ", ".join([p.get("model", "") for p in provs if p.get("enable")])
    except Exception:
        pass
    try:
        c = sqlite3.connect("file:%s?mode=ro" % DB_PATH, uri=True, timeout=5)
        for row in c.execute("select start_time,end_time,provider_model,token_output from provider_stats where status='completed' order by id desc limit 20"):
            try:
                ms = int((float(row[1]) - float(row[0])) * 1000)
            except Exception:
                continue
            lat.append({"ms": ms, "model": row[2], "out": row[3] or 0})
        today_msgs = c.execute("select count(*) from conversations where created_at like ?", (today + "%",)).fetchone()[0]
        total_msgs = c.execute("select count(*) from conversations").fetchone()[0]
        for row in c.execute("select persona_id, system_prompt from personas order by sort_order"):
            personas.append({"id": row[0], "prompt": row[1] or ""})
        c.close()
    except Exception:
        pass
    return lat, today_msgs, total_msgs, personas, model

def token_stats():
    out = {"today_in": 0, "today_out": 0, "today_calls": 0, "total_in": 0, "total_out": 0, "days": [], "models": []}
    try:
        c = sqlite3.connect("file:%s?mode=ro" % DB_PATH, uri=True, timeout=5)
        today0 = time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d"))
        r = c.execute("select coalesce(sum(token_input_other+token_input_cached),0), coalesce(sum(token_output),0) from provider_stats where status='completed'").fetchone()
        out["total_in"], out["total_out"] = int(r[0]), int(r[1])
        r = c.execute("select coalesce(sum(token_input_other+token_input_cached),0), coalesce(sum(token_output),0), count(*) from provider_stats where status='completed' and start_time>=?", (today0,)).fetchone()
        out["today_in"], out["today_out"], out["today_calls"] = int(r[0]), int(r[1]), int(r[2])
        days = []
        for i in range(6, -1, -1):
            d0 = today0 - i * 86400
            d1 = d0 + 86400
            r = c.execute("select coalesce(sum(token_input_other+token_input_cached),0), coalesce(sum(token_output),0) from provider_stats where status='completed' and start_time>=? and start_time<?", (d0, d1)).fetchone()
            days.append({"day": time.strftime("%m-%d", time.localtime(d0)), "in": int(r[0]), "out": int(r[1])})
        out["days"] = days
        rows = c.execute("select provider_model, count(*), coalesce(sum(token_input_other+token_input_cached),0), coalesce(sum(token_output),0) from provider_stats where status='completed' group by provider_model order by 3 desc limit 6").fetchall()
        out["models"] = [{"model": x[0] or "-", "calls": int(x[1]), "in": int(x[2]), "out": int(x[3])} for x in rows]
        c.close()
    except Exception as e:
        out["error"] = str(e)
    return out

TOKENS = {"astrbot": None, "snowluma": None}
TOKENS_LOCK = threading.Lock()

def ab_login():
    base = CFG["astrbot"]["base"]
    st, j = http_json(base + "/api/auth/login", "POST", {"username": CFG["astrbot"]["username"], "password": CFG["astrbot"]["password"]})
    if st == 200 and j.get("data", {}).get("token"):
        return j["data"]["token"]
    return None

def sl_login():
    base = CFG["snowluma"]["base"]
    st, j = http_json(base + "/api/login", "POST", {"username": CFG["snowluma"]["username"], "password": CFG["snowluma"]["password"]})
    if st == 200 and j.get("token"):
        return j["token"]
    return None

def ab_get(path, timeout=10):
    with TOKENS_LOCK:
        tok = TOKENS["astrbot"] or ab_login()
        TOKENS["astrbot"] = tok
    if not tok:
        return None
    st, j = http_json(CFG["astrbot"]["base"] + path, token=tok, timeout=timeout)
    if st == 401:
        with TOKENS_LOCK:
            TOKENS["astrbot"] = ab_login()
            tok = TOKENS["astrbot"]
        if tok:
            st, j = http_json(CFG["astrbot"]["base"] + path, token=tok, timeout=timeout)
    return j

def ab_post(path, body, timeout=15):
    with TOKENS_LOCK:
        tok = TOKENS["astrbot"] or ab_login()
        TOKENS["astrbot"] = tok
    if not tok:
        return None, {"error": "AstrBot 未登录"}
    st, j = http_json(CFG["astrbot"]["base"] + path, "POST", body, token=tok, timeout=timeout)
    if st == 401:
        with TOKENS_LOCK:
            TOKENS["astrbot"] = ab_login()
            tok = TOKENS["astrbot"]
        if tok:
            st, j = http_json(CFG["astrbot"]["base"] + path, "POST", body, token=tok, timeout=timeout)
    return st, j

def ab_put(path, body, timeout=15):
    with TOKENS_LOCK:
        tok = TOKENS["astrbot"] or ab_login()
        TOKENS["astrbot"] = tok
    if not tok:
        return 0, {"error": "AstrBot 未登录"}
    st, j = http_json(CFG["astrbot"]["base"] + path, "PUT", body, token=tok, timeout=timeout)
    if st == 401:
        with TOKENS_LOCK:
            TOKENS["astrbot"] = ab_login()
            tok = TOKENS["astrbot"]
        if tok:
            st, j = http_json(CFG["astrbot"]["base"] + path, "PUT", body, token=tok, timeout=timeout)
    return st, j

def sl_get(path, timeout=10):
    with TOKENS_LOCK:
        tok = TOKENS["snowluma"] or sl_login()
        TOKENS["snowluma"] = tok
    if not tok:
        return None
    st, j = http_json(CFG["snowluma"]["base"] + path, token=tok, timeout=timeout)
    if st == 401:
        with TOKENS_LOCK:
            TOKENS["snowluma"] = sl_login()
            tok = TOKENS["snowluma"]
        if tok:
            st, j = http_json(CFG["snowluma"]["base"] + path, token=tok, timeout=timeout)
    return j

_ONEBOT_TOK_CACHE = {"tok": "", "ts": 0}

def onebot_token():
    """OneBot HTTP accessToken。
    优先用 config.json 里手工填的；否则从 SnowLuma 容器内的 onebot 配置里读
    （旧实现读 /opt/bots/snowluma-onebot.json，那个文件早已不存在，导致调用全 401）。"""
    tok = (CFG.get("onebot", {}) or {}).get("token") or ""
    if tok:
        return tok
    now = time.time()
    if _ONEBOT_TOK_CACHE["tok"] and now - _ONEBOT_TOK_CACHE["ts"] < 600:
        return _ONEBOT_TOK_CACHE["tok"]
    try:
        out = run(["docker", "exec", SNOWLUMA_CONTAINER, "sh", "-c",
                   "ls /app/data/config/onebot_*.json 2>/dev/null"], timeout=8)
        for path in [p.strip() for p in out.split("\n") if p.strip()]:
            raw = run(["docker", "exec", SNOWLUMA_CONTAINER, "cat", path], timeout=8)
            try:
                j = json.loads(raw or "{}")
            except Exception:
                continue
            for srv in ((j.get("networks") or {}).get("httpServers") or []):
                at = srv.get("accessToken") or ""
                if at and int(srv.get("port") or 0) == 3000:
                    _ONEBOT_TOK_CACHE["tok"] = at
                    _ONEBOT_TOK_CACHE["ts"] = now
                    return at
    except Exception:
        pass
    return ""

def onebot_call(action, params=None):
    tok = onebot_token()
    base = CFG["onebot"]["base"]
    body = json.dumps(params or {}).encode()
    req = urllib.request.Request(base + "/" + action, data=body, method="POST", headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode() or "{}")
    except Exception as e:
        return {"error": str(e)}

def alert_send(text, title="BotPanel 告警"):
    """按配置把告警推给 QQ 主人或自定义 webhook。返回投递结果列表。"""
    cfg = CFG.get("alert") or {}
    if not cfg.get("enabled"):
        return [{"channel": "none", "ok": False, "msg": "告警未开启"}]
    out = []
    msg = "%s\n%s\n%s" % (title, time.strftime("%m-%d %H:%M:%S"), text)

    # 渠道 1：QQ（走 OneBot，私聊发给 owners 里的第一个号）
    if cfg.get("via_qq"):
        owners = CFG.get("owners") or []
        if not owners:
            out.append({"channel": "qq", "ok": False, "msg": "没有配置主人 QQ"})
        else:
            target = str(owners[0])
            r = onebot_call("send_private_msg", {"user_id": int(target), "message": msg})
            ok = (r or {}).get("status") in ("ok", "async") or (r or {}).get("retcode") == 0
            out.append({"channel": "qq", "ok": ok, "msg": (r or {}).get("error") or ""})

    # 渠道 2：webhook（GET/POST 通用，文本按 JSON 或纯文本发）
    hook = (cfg.get("webhook") or "").strip()
    if hook:
        try:
            if hook.startswith("https://") or hook.startswith("http://"):
                data = json.dumps({"text": msg, "title": title, "ts": int(time.time())}).encode()
                req = urllib.request.Request(hook, data=data, method="POST",
                                             headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=8) as r:
                    out.append({"channel": "webhook", "ok": 200 <= r.status < 300, "msg": "HTTP %s" % r.status})
            else:
                out.append({"channel": "webhook", "ok": False, "msg": "URL 必须以 http(s):// 开头"})
        except Exception as e:
            out.append({"channel": "webhook", "ok": False, "msg": str(e)[:120]})
    return out

def bot_info():
    j = sl_get("/api/connections")
    if not j or not j.get("list"):
        return {"online": False}
    q = j["list"][0]
    adapters = q.get("adapters") or []
    return {
        "uin": q.get("uin", ""),
        "nickname": q.get("nickname", ""),
        "online": q.get("uin") is not None,
        "adapters": [{"name": a.get("name"), "kind": a.get("kind"), "status": a.get("status"), "detail": a.get("detail")} for a in adapters],
    }

# ---------------- market ----------------
MARKET_LOCK = threading.Lock()

MARKET_REFRESHING = [False]
STATUS_CACHE = {"ts": 0, "data": None}

def _market_refresh():
    if MARKET_REFRESHING[0]:
        return
    MARKET_REFRESHING[0] = True
    try:
        with urllib.request.urlopen("https://awesome-dsh-plugin.com/plugins.json", timeout=180) as r:
            raw = json.loads(r.read().decode())
        items = []
        for p in raw.get("plugins", []):
            desc = p.get("description") or {}
            owner = p.get("owner") or ""
            shots = [s for s in (p.get("screenshots") or []) if isinstance(s, str) and s.startswith("https://")][:3]
            items.append({
                "name": p.get("npm") or p.get("name"),
                "title": p.get("name"),
                "owner": owner,
                "npm": p.get("npm", ""),
                "zh": desc.get("zh", ""),
                "en": desc.get("en", ""),
                "cat": p.get("category", "") if isinstance(p.get("category"), str) else "",
                "ver": p.get("version", ""),
                "stars": p.get("stars") or 0,
                "downloads": p.get("downloads") or 0,
                "repo": p.get("url", ""),
                "home": p.get("page", ""),
                "icon": ("https://avatars.githubusercontent.com/%s?size=96" % urllib.parse.quote(owner)) if owner else "",
                "preview": shots[0] if shots else "",
                "shots": shots,
            })
        with open(CFG["market_cache"], "w", encoding="utf-8") as f:
            json.dump({"ts": int(time.time()), "items": items}, f, ensure_ascii=False)
    except Exception as e:
        try:
            with open(os.path.join(BASE, "cache", "market.err"), "w", encoding="utf-8") as f:
                f.write("%s %s" % (time.strftime("%F %T"), e))
        except Exception:
            pass
    finally:
        MARKET_REFRESHING[0] = False

def _market_fallback():
    fp = os.path.join(BASE, "cache", "fallback.json")
    if os.path.exists(fp) and time.time() - os.path.getmtime(fp) < 1800:
        try:
            with open(fp, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    try:
        with urllib.request.urlopen("https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json", timeout=20) as r:
            raw = json.loads(r.read().decode())
        items = []
        for p in raw.get("plugins", []):
            title = p.get("title") or p.get("name") or ""
            owner = title.split("/")[0] if "/" in title else ""
            desc = p.get("description") or {}
            items.append({
                "name": p.get("name"),
                "title": title,
                "owner": owner,
                "npm": p.get("name"),
                "zh": desc.get("zh", ""),
                "en": desc.get("en", ""),
                "cat": (p.get("metadata") or {}).get("category", "") or "",
                "ver": ((p.get("versions") or [{}])[0] or {}).get("version", ""),
                "stars": 0,
                "downloads": 0,
                "repo": (p.get("repository") or {}).get("url", ""),
                "home": p.get("homepage", ""),
                "icon": ("https://avatars.githubusercontent.com/%s?size=96" % urllib.parse.quote(owner)) if owner else "",
                "preview": "",
                "shots": [],
            })
        with open(fp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)
        return items
    except Exception:
        return []

def market_items(force=False):
    path = CFG["market_cache"]
    data = None
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = None
    if isinstance(data, list):
        data = {"ts": 0, "items": data}
    stale = (not data) or (time.time() - data.get("ts", 0) > 6 * 3600)
    if stale and not MARKET_REFRESHING[0]:
        threading.Thread(target=_market_refresh, daemon=True).start()
    items = (data or {}).get("items", [])
    if not items:
        items = _market_fallback()
    return items


# ---------------- handlers ----------------
# ---------------- 学习 / 知识库 ----------------
KNOWLEDGE_DIR = os.path.join(BASE, "knowledge")
ALLOWED_EXT = {".txt", ".md", ".html", ".htm", ".docx", ".pptx", ".xlsx", ".csv", ".json", ".log", ".xml", ".pdf"}

def load_knowledge_index():
    try:
        raw = read_file(os.path.join(KNOWLEDGE_DIR, "index.json"))
        return json.loads(raw or "[]")
    except Exception:
        return []

def save_knowledge_index(items):
    os.makedirs(KNOWLEDGE_DIR, exist_ok=True)
    tmp = os.path.join(KNOWLEDGE_DIR, "index.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    os.replace(tmp, os.path.join(KNOWLEDGE_DIR, "index.json"))

def parse_multipart(body, ctype):
    m = re.search(r"boundary=([^;]+)", ctype or "")
    if not m:
        return None, b""
    boundary = m.group(1).strip().strip('"').encode()
    for part in body.split(b"--" + boundary):
        if b"\r\n\r\n" not in part:
            continue
        head, data = part.split(b"\r\n\r\n", 1)
        if b'name="file"' not in head:
            continue
        data = data[:-2] if data.endswith(b"\r\n") else data
        fm = re.search(rb'filename="([^"]*)"', head)
        if fm:
            try:
                name = fm.group(1).decode("utf-8")
            except Exception:
                name = fm.group(1).decode("gb18030", "ignore")
        else:
            name = "upload.bin"
        return name, data
    return None, b""

def _xml_text(xml):
    parts = re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>|<a:t(?:\s[^>]*)?>(.*?)</a:t>|<t(?:\s[^>]*)?>(.*?)</t>", xml, re.S)
    out = []
    for a, b, c in parts:
        out.append(a or b or c or "")
    txt = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", txt).strip()

def extract_text(path, ext):
    ext = ext.lower()
    if ext in (".txt", ".md", ".csv", ".json", ".log", ".xml", ".html", ".htm"):
        raw = open(path, "rb").read()
        text = ""
        for enc in ("utf-8-sig", "utf-8", "gb18030"):
            try:
                text = raw.decode(enc)
                break
            except Exception:
                continue
        if not text:
            text = raw.decode("utf-8", "ignore")
        if ext in (".html", ".htm"):
            text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", text, flags=re.I)
            text = re.sub(r"<[^>]+>", "\n", text)
            import html as _html
            text = _html.unescape(text)
        return re.sub(r"\n{3,}", "\n\n", text).strip()
    if ext in (".docx", ".pptx", ".xlsx"):
        import zipfile
        try:
            with zipfile.ZipFile(path) as z:
                names = z.namelist()
                if ext == ".docx":
                    targets = [n for n in names if n.startswith("word/") and n.endswith(".xml") and ("document" in n or "header" in n or "footer" in n)]
                    targets.sort()
                elif ext == ".pptx":
                    targets = [n for n in names if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
                    targets.sort(key=lambda n: int(re.sub(r"\D", "", n.split("/")[-1]) or 0))
                else:
                    targets = [n for n in names if n in ("xl/sharedStrings.xml",)]
                chunks = []
                for n in targets:
                    try:
                        chunks.append(_xml_text(z.read(n).decode("utf-8", "ignore")))
                    except Exception:
                        pass
                return ("\n\n".join([c for c in chunks if c])).strip()
        except Exception as e:
            return "[解析失败] " + str(e)
    if ext == ".pdf":
        return "[PDF] 服务器未安装 pdf 解析器，暂不能自动提取文本；可先转成 docx/txt 再上传。"
    return ""

INSTALL_JOBS = {}
INSTALL_LOCK = threading.Lock()
PLUGIN_DL_DIR = os.path.join(BASE, "cache", "plugin-dl")

def ab_upload_plugin(filename, content, timeout=300):
    boundary = "----dsh" + secrets.token_hex(10)
    head = ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\nContent-Type: application/octet-stream\r\n\r\n" % (boundary, filename)).encode()
    tail = ("\r\n--%s--\r\n" % boundary).encode()
    data = head + content + tail
    with TOKENS_LOCK:
        tok = TOKENS["astrbot"] or ab_login()
        TOKENS["astrbot"] = tok
    if not tok:
        return 0, {"error": "AstrBot 未登录"}
    req = urllib.request.Request(
        CFG["astrbot"]["base"] + "/api/v1/plugins/install/upload",
        data=data, method="POST",
        headers={"Authorization": "Bearer " + tok,
                 "Content-Type": "multipart/form-data; boundary=" + boundary,
                 "Content-Length": str(len(data))})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "ignore") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "ignore") or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}

class Handler(BaseHTTPRequestHandler):
    server_version = "BotPanel"
    protocol_version = "HTTP/1.1"

    # 所有响应统一注入的安全头（见 end_headers）
    SEC_HEADERS = (
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "no-referrer"),
        ("Permissions-Policy", "geolocation=(), microphone=(), camera=()"),
        ("Cross-Origin-Opener-Policy", "same-origin"),
        ("Content-Security-Policy",
         "default-src 'self'; img-src 'self' data: https:; "
         "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; "
         "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
         "form-action 'self'; object-src 'none'"),
    )

    def version_string(self):
        # 不在响应头里暴露实现与版本，减少指纹
        return self.server_version

    def end_headers(self):
        for k, v in self.SEC_HEADERS:
            self.send_header(k, v)
        # 仅 TLS 连接发 HSTS，避免把纯 HTTP 端口锁死
        try:
            import ssl as _ssl
            if isinstance(getattr(self, "connection", None), _ssl.SSLSocket):
                self.send_header("Strict-Transport-Security",
                                 "max-age=31536000; includeSubDomains")
        except Exception:
            pass
        BaseHTTPRequestHandler.end_headers(self)

    def setup(self):
        BaseHTTPRequestHandler.setup(self)
        # 单连接读写超时：防止半开连接把工作线程占死
        try:
            self.connection.settimeout(30)
        except Exception:
            pass

    def log_message(self, fmt, *args):
        pass

    def cookie_token(self):
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == "bp_session":
                return v
        return ""

    def authed(self):
        tok = self.cookie_token()
        if not tok:
            return False
        try:
            payload, sig = tok.split(".", 1)
            expect = hmac.new(CFG["secret"].encode(), payload.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(sig, expect):
                return False
            data = json.loads(base64.urlsafe_b64decode(payload.encode()).decode())
            if data.get("exp", 0) <= time.time():
                return False
            # 改密/改 2FA 后 pwv 递增 → 所有旧会话立即失效
            return int(data.get("pwv", 0)) == int(CFG.get("pwv", 0))
        except Exception:
            return False

    def send_json(self, obj, code=200, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, name, ctype="text/html; charset=utf-8", immutable=False):
        path = os.path.join(STATIC, name)
        if not os.path.isfile(path):
            self.send_error(404)
            return
        data = open(path, "rb").read()
        etag = '"%s"' % hashlib.sha256(data).hexdigest()[:16]
        # 命中 ETag 直接 304，省掉整包传输
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            if immutable:
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            else:
                self.send_header("Cache-Control", "no-cache")
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        if immutable:
            # 带内容哈希的 URL：内容变则 URL 变，可放心长缓存
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.send_header("ETag", etag)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body_json(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(n).decode() or "{}")
        except Exception:
            return {}

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        qs = urllib.parse.parse_qs(u.query)
        if p in ("/", "/index.html"):
            if not self.authed():
                self.send_response(302)
                self.send_header("Location", "/login")
                self.end_headers()
                return
            return self.serve_static("index.html")
        if p.startswith("/partials/") and p.endswith(".html"):
            rel = p[len("/partials/"):]
            if rel and ".." not in rel and re.fullmatch(r"[A-Za-z0-9_\-/]+\.html", rel):
                return self.serve_static(os.path.join("partials", rel), "text/html; charset=utf-8")
        if p == "/js/boot.js":
            return self.serve_static("js/boot.js", "text/javascript; charset=utf-8")
        if p == "/ca.crt":
            path_ = os.path.join(BASE, "tls", "ca.crt")
            if os.path.isfile(path_):
                data_ = open(path_, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-x509-ca-cert")
                self.send_header("Content-Disposition", 'attachment; filename="qqbot-panel-ca.crt"')
                self.send_header("Content-Length", str(len(data_)))
                self.end_headers()
                self.wfile.write(data_)
                return
            return self.send_error(404)
        static_map = {
            "/login": ("login.html", "text/html; charset=utf-8"),
            "/css/app.css": ("css/app.css", "text/css; charset=utf-8"),
            "/js/app.js": ("js/app.js", "text/javascript; charset=utf-8"),
            "/js/theme.js": ("js/theme.js", "text/javascript; charset=utf-8"),
            # 兼容旧路径（避免 cached 页面 404）
            "/app.js": ("js/app.js", "text/javascript; charset=utf-8"),
            "/theme.js": ("js/theme.js", "text/javascript; charset=utf-8"),
            "/style.css": ("css/app.css", "text/css; charset=utf-8"),
            "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
            "/icon.svg": ("icon.svg", "image/svg+xml"),
            "/js/sw.js": ("js/sw.js", "text/javascript; charset=utf-8"),
            "/sw.js": ("js/sw.js", "text/javascript; charset=utf-8"),
        }
        if p in static_map:
            name, ctype = static_map[p]
            # 带 ?v=<hash> 视为内容寻址，可长缓存；否则走 ETag + no-cache
            return self.serve_static(name, ctype, immutable=bool(qs.get("v")))
        # /assets/<hash>/<path>：内容寻址形式，供 HTML 引用
        if p.startswith("/assets/"):
            parts = p[len("/assets/"):].split("/", 1)
            if len(parts) == 2 and re.fullmatch(r"[0-9a-f]{8,64}", parts[0]):
                rel = parts[1]
                if rel and ".." not in rel and re.fullmatch(r"[A-Za-z0-9_\-/]+\.(css|js|svg|png|webmanifest)", rel):
                    ctype = ("text/css; charset=utf-8" if rel.endswith(".css")
                             else "text/javascript; charset=utf-8" if rel.endswith(".js")
                             else "image/svg+xml" if rel.endswith(".svg")
                             else "image/png" if rel.endswith(".png")
                             else "application/manifest+json")
                    return self.serve_static(rel, ctype, immutable=True)
        if p == "/assetver":
            # 返回某个静态文件的当前内容哈希，供 boot.js 拼出正确的 /assets/<hash>/ 路径。
            # 必须让 app.js 的 URL 跟着 app.js 自己变，而不是跟着 boot.js 变。
            rel = (qs.get("f", [""])[0] or "").strip()
            if not rel or ".." in rel or not re.fullmatch(r"[A-Za-z0-9_\-/]+\.(css|js|webmanifest)", rel):
                return self.send_json({"error": "bad file"}, 400)
            fp = os.path.join(STATIC, rel)
            if not os.path.isfile(fp):
                return self.send_json({"error": "not found"}, 404)
            hv = hashlib.sha256(open(fp, "rb").read()).hexdigest()[:12]
            return self.send_json({"f": rel, "hash": hv, "url": "/assets/%s/%s" % (hv, rel)})
        if p == "/healthz":
            # 无鉴权的极简探活：不返回任何配置/环境信息
            return self.send_json({"ok": True, "ts": int(time.time())})
        if not self.authed():
            return self.send_json({"error": "unauthorized"}, 401)
        try:
            if p == "/api/status":
                return self.api_status()
            if p == "/api/2fa/status":
                return self.api_2fa_status()
            if p == "/api/selfcheck":
                return self.api_selfcheck()
            if p == "/api/alert/config":
                return self.send_json({"ok": True, "alert": CFG.get("alert") or {}})
            if p == "/api/logs":
                return self.api_logs(qs)
            if p == "/api/logs/stream":
                return self.api_logs_stream(qs)
            if p == "/api/contacts":
                return self.api_contacts()
            if p == "/api/owners":
                return self.send_json({"owners": CFG.get("owners", [])})
            if p == "/api/market":
                return self.api_market(qs)
            if p == "/api/personas":
                return self.api_personas()
            if p == "/api/persona/templates":
                try:
                    with open(PERSONAS_PATH, encoding="utf-8") as f:
                        return self.send_json({"ok": True, "items": json.load(f)})
                except Exception:
                    return self.send_json({"ok": True, "items": []})
            if p == "/api/plugins":
                j = ab_get("/api/v1/plugins") or {}
                return self.send_json(j)
            if p == "/api/providers":
                j = ab_get("/api/v1/providers") or {}
                data = j.get("data") or {}
                provs = [{"id": p_.get("id"), "model": p_.get("model"), "type": p_.get("provider_type") or p_.get("type"), "enable": bool(p_.get("enable"))} for p_ in (data.get("providers") or [])]
                return self.send_json({"ok": True, "providers": provs})
            if p == "/api/plugin/logo":
                return self.api_plugin_logo(qs)
            if p == "/api/plugin/schema":
                return self.api_plugin_schema(qs)
            if p == "/api/plugin/updates":
                return self.api_plugin_updates()
            if p == "/api/market/install-status":
                return self.api_market_install_status(qs)
            if p == "/api/qq/qr":
                return self.api_qq_qr()
            if p == "/api/knowledge":
                return self.api_knowledge_list()
            if p == "/api/knowledge/docs":
                return self.api_knowledge_docs(qs)
            if p == "/api/embedding/config":
                return self.api_emb_config()
            if p == "/api/knowledge/text":
                return self.api_knowledge_text(qs)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)
        self.send_error(404)

    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        if p == "/api/embedding/config":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_emb_config()
        if p == "/api/embedding/models":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_emb_models()
        if p == "/api/embedding/test":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_emb_test()
        if p == "/api/embedding/apply":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_emb_apply()
        if p == "/api/knowledge/create":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_knowledge_create()
        if p == "/api/knowledge/upload-kb":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_knowledge_upload_kb()
        if p == "/api/knowledge/del-doc":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_knowledge_del_doc()
        if p == "/api/knowledge/del-kb":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_knowledge_del_kb()
        if p == "/api/knowledge/retrieve":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_knowledge_retrieve()
        if p == "/api/knowledge/upload":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_knowledge_upload()
        if p == "/api/knowledge/delete":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_knowledge_delete()
        if p == "/api/login":
            return self.api_login()
        if p == "/api/password/change":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_change_password()
        if p == "/api/2fa/setup":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_2fa_setup()
        if p == "/api/2fa/enable":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_2fa_enable()
        if p == "/api/2fa/disable":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_2fa_disable()
        if p == "/api/alert/config":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_alert_config()
        if p == "/api/alert/test":
            if not self.authed():
                return self.send_json({"error": "unauthorized"}, 401)
            return self.api_alert_test()
        if p == "/api/logout":
            audit("logout", ip=self.client_address[0])
            return self.send_json({"ok": True}, extra={"Set-Cookie": "bp_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"})
        if not self.authed():
            return self.send_json({"error": "unauthorized"}, 401)
        if p == "/api/owners":
            b = self.body_json()
            owners = (b.get("owners") or [])[:2]
            audit("owners.update", count=len(owners), ip=self.client_address[0])
            CFG["owners"] = owners
            save_config(CFG)
            return self.send_json({"ok": True, "owners": owners})
        if p == "/api/market/install":
            return self.api_market_install()
        if p == "/api/market/install-start":
            return self.api_market_install_start()
        if p == "/api/persona/save":
            return self.api_persona_save()
        if p == "/api/persona/create":
            b = self.body_json()
            pid = (b.get("persona_id") or "").strip()
            prompt = b.get("system_prompt") or ""
            if not pid or not prompt:
                return self.send_json({"ok": False, "error": "缺少 persona_id 或提示词"})
            st, j = ab_post("/api/v1/personas", {"persona_id": pid, "system_prompt": prompt})
            ok = st in (200, 201) and (j or {}).get("status") == "ok"
            return self.send_json({"ok": ok, "result": j or {}})
        if p == "/api/persona/default":
            return self.api_persona_default()
        if p == "/api/persona/update":
            return self.api_persona_update()
        if p == "/api/service/restart":
            return self.api_service_restart()
        if p == "/api/qq/refresh":
            return self.api_qq_refresh()
        if p == "/api/plugin/save":
            return self.api_plugin_save()
        if p == "/api/plugin/reload":
            return self.api_plugin_reload()
        if p == "/api/plugin/uninstall":
            return self.api_plugin_uninstall()
        if p == "/api/plugin/update":
            return self.api_plugin_update()
        self.send_error(404)

    # ---- api impl ----
    def api_persona_default(self):
        b = self.body_json()
        pid = (b.get("persona_id") or "").strip()
        if not pid:
            return self.send_json({"ok": False, "error": "缺少 persona_id"})
        path = "/opt/bots/astrbot/data/cmd_config.json"
        try:
            with open(path, encoding="utf-8-sig") as f:
                j = json.load(f)
            ar = j.setdefault("agent_runner", {})
            cfg = ar.setdefault("config", {})
            persona = cfg.setdefault("persona", {})
            persona["persona_id"] = pid
            persona["safety_mode"] = False
            with open(path, "w", encoding="utf-8-sig") as f:
                json.dump(j, f, ensure_ascii=False, indent=2)
            audit("persona.set_default", persona_id=pid, ip=self.client_address[0])
            run(["docker", "restart", ASTRBOT_CONTAINER], timeout=60)
            return self.send_json({"ok": True, "persona_id": pid})
        except Exception as e:
            return self.send_json({"ok": False, "error": str(e)})

    def api_persona_update(self):
        b = self.body_json()
        pid = (b.get("persona_id") or "").strip()
        prompt = b.get("system_prompt")
        if not pid or prompt is None:
            return self.send_json({"ok": False, "error": "缺少 persona_id 或 system_prompt"})
        audit("persona.update", persona_id=pid, ip=self.client_address[0])
        st, j = ab_put("/api/v1/personas/by-id", {"persona_id": pid, "system_prompt": prompt})
        ok = st in (200, 201) and (j or {}).get("status") == "ok"
        return self.send_json({"ok": ok, "message": (j or {}).get("message"), "result": j or {}})

    def api_service_restart(self):
        b = self.body_json()
        name = (b.get("name") or "").strip()
        if name not in (ASTRBOT_CONTAINER, SNOWLUMA_CONTAINER):
            return self.send_json({"ok": False, "error": "只允许重启 %s / %s" % (ASTRBOT_CONTAINER, SNOWLUMA_CONTAINER)}, 403)
        audit("service.restart", name=name, ip=self.client_address[0])
        run(["docker", "restart", name], timeout=120)
        return self.send_json({"ok": True, "name": name})

    def _capture_qr(self, cache):
        cmd = ("DISPLAY=:1 xwd -root -silent > /tmp/s.xwd && "
               "ffmpeg -y -loglevel error -i /tmp/s.xwd "
               "-vf crop=280:280:820:410,scale=560:560 /tmp/qr.png")
        run(["docker", "exec", SNOWLUMA_CONTAINER, "sh", "-c", cmd], timeout=20)
        run(["docker", "cp", SNOWLUMA_CONTAINER + ":/tmp/qr.png", cache], timeout=15)

    def _qr_expired(self):
        try:
            out = run(["docker", "exec", SNOWLUMA_CONTAINER, "sh", "-c",
                       "ffmpeg -i /tmp/qr.png -vf "
                       "'crop=260:260:150:150,format=gray,signalstats,metadata=print:file=-' "
                       "-frames:v 1 -f null - 2>&1"], timeout=15)
        except Exception:
            return False
        m = re.search(r"YAVG=([0-9.]+)", out or "")
        return bool(m) and float(m.group(1)) > 225

    def _click_refresh(self):
        try:
            run(["docker", "cp", os.path.join(BASE, "qqrefresh.py"), SNOWLUMA_CONTAINER + ":/tmp/qqrefresh.py"], timeout=10)
            run(["docker", "exec", SNOWLUMA_CONTAINER, "sh", "-c", "DISPLAY=:1 python3 /tmp/qqrefresh.py"], timeout=15)
            time.sleep(3.5)
        except Exception:
            pass

    def api_plugin_logo(self, qs):
        name = (qs.get("name", [""])[0] or "").strip()
        if not name:
            return self.send_json({"ok": False, "error": "缺少插件名"}, 400)
        cache_dir = os.path.join(BASE, "cache", "plugin-logos")
        os.makedirs(cache_dir, exist_ok=True)
        cache = os.path.join(cache_dir, name + ".img")
        try:
            if os.path.exists(cache) and time.time() - os.path.getmtime(cache) < 3600:
                with open(cache, "rb") as f:
                    data = f.read()
                ctype = read_file(cache + ".type") or "image/png"
            else:
                j = ab_get("/api/v1/plugins")
                plug = next((x for x in ((j or {}).get("data") or []) if x.get("name") == name), None)
                logo = (plug or {}).get("logo") or ""
                if not logo:
                    return self.send_json({"ok": False, "error": "没有 logo"}, 404)
                if logo.startswith("http"):
                    req = urllib.request.Request(logo, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=15) as r:
                        data = r.read()
                        ctype = r.headers.get("Content-Type") or "image/png"
                else:
                    with TOKENS_LOCK:
                        tok = TOKENS["astrbot"] or ab_login()
                        TOKENS["astrbot"] = tok
                    req = urllib.request.Request(CFG["astrbot"]["base"] + logo, headers={"Authorization": "Bearer " + (tok or "")})
                    with urllib.request.urlopen(req, timeout=15) as r:
                        data = r.read()
                        ctype = r.headers.get("Content-Type") or "image/png"
                with open(cache, "wb") as f:
                    f.write(data)
                with open(cache + ".type", "w") as f:
                    f.write(ctype)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "public, max-age=3600")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_json({"ok": False, "error": str(e)}, 404)

    def api_plugin_schema(self, qs):
        pid = (qs.get("id", [""])[0] or "").strip()
        if not pid:
            return self.send_json({"ok": False, "error": "缺少插件名"}, 400)
        j = ab_get("/api/v1/plugins/%s/config/schema" % urllib.parse.quote(pid, safe=""))
        if not j:
            return self.send_json({"ok": False, "error": "读取失败"})
        return self.send_json({"ok": True, "data": j.get("data") or {}})

    def api_plugin_save(self):
        b = self.body_json()
        pid = (b.get("id") or "").strip()
        cfg = b.get("config")
        if not pid or not isinstance(cfg, dict):
            return self.send_json({"ok": False, "error": "参数不完整"})
        st, j = ab_put("/api/v1/plugins/%s/config" % urllib.parse.quote(pid, safe=""), {"config": cfg})
        ok = st in (200, 201) and (j or {}).get("status") == "ok"
        return self.send_json({"ok": ok, "message": (j or {}).get("message")})

    def api_plugin_reload(self):
        b = self.body_json()
        pid = (b.get("id") or "").strip()
        if not pid:
            return self.send_json({"ok": False, "error": "缺少插件名"})
        st, j = ab_post("/api/v1/plugins/%s/reload" % urllib.parse.quote(pid, safe=""), {})
        return self.send_json({"ok": st in (200, 201), "result": j or {}})

    def api_qq_refresh(self):
        cache = os.path.join(BASE, "cache", "qq_qr.png")
        self._click_refresh()
        try:
            if os.path.exists(cache):
                os.remove(cache)
        except Exception:
            pass
        self.send_json({"ok": True})

    def api_qq_qr(self):
        cache = os.path.join(BASE, "cache", "qq_qr.png")
        force = "force=1" in (self.path or "")
        try:
            fresh = os.path.exists(cache) and time.time() - os.path.getmtime(cache) < 3
            if force or not fresh:
                self._capture_qr(cache)
                if not force and self._qr_expired():
                    self._click_refresh()
                    self._capture_qr(cache)
            with open(cache, "rb") as f:
                data = f.read()
            if not data:
                return self.send_json({"ok": False, "error": "截图失败"}, 500)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_json({"ok": False, "error": str(e)}, 500)

    def api_knowledge_text(self, qs):
        kid = (qs.get("id", [""])[0] or "").strip()
        item = next((x for x in load_knowledge_index() if x.get("id") == kid), None)
        if not item:
            return self.send_json({"ok": False, "error": "not found"}, 404)
        text = read_file(os.path.join(KNOWLEDGE_DIR, kid + ".txt"))
        self.send_json({"ok": True, "name": item.get("name"), "text": text})

    def api_knowledge_upload(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n <= 0 or n > 25 * 1024 * 1024:
            return self.send_json({"ok": False, "error": "文件为空或超过 25MB"})
        body = self.rfile.read(n)
        name, data = parse_multipart(body, self.headers.get("Content-Type", ""))
        if not name or not data:
            return self.send_json({"ok": False, "error": "没有解析到文件"})
        ext = os.path.splitext(name)[1].lower()
        if ext not in ALLOWED_EXT:
            return self.send_json({"ok": False, "error": "不支持的类型 " + ext})
        os.makedirs(KNOWLEDGE_DIR, exist_ok=True)
        kid = time.strftime("%Y%m%d%H%M%S") + "-" + secrets.token_hex(3)
        raw_path = os.path.join(KNOWLEDGE_DIR, kid + ext)
        with open(raw_path, "wb") as f:
            f.write(data)
        text = (extract_text(raw_path, ext) or "")[:400000]
        with open(os.path.join(KNOWLEDGE_DIR, kid + ".txt"), "w", encoding="utf-8") as f:
            f.write(text)
        item = {"id": kid, "name": name, "size": len(data), "ext": ext, "chars": len(text),
                "chunks": max(1, (len(text) + 1499) // 1500), "added": int(time.time()),
                "preview": text[:140].replace("\n", " ")}
        idx = load_knowledge_index()
        idx.insert(0, item)
        save_knowledge_index(idx)
        self.send_json({"ok": True, "item": item})

    def api_knowledge_delete(self):
        b = self.body_json()
        kid = str(b.get("id", ""))
        idx = [x for x in load_knowledge_index() if x.get("id") != kid]
        save_knowledge_index(idx)
        if os.path.isdir(KNOWLEDGE_DIR):
            for f in os.listdir(KNOWLEDGE_DIR):
                if f.startswith(kid + "."):
                    try:
                        os.remove(os.path.join(KNOWLEDGE_DIR, f))
                    except Exception:
                        pass
        self.send_json({"ok": True})


    def api_emb_config(self):
        """读取/保存 embedding 配置（URL + Key + 模型名）。"""
        b = self.body_json()
        if b:
            cur = dict(CFG.get("embedding") or {})
            for k in ("base", "key", "model"):
                if k in b:
                    cur[k] = str(b.get(k) or "").strip()
            CFG["embedding"] = cur
            save_config(CFG)
            audit("embedding.config", model=cur.get("model"), ip=self.client_address[0])
        cur = CFG.get("embedding") or {}
        return self.send_json({"ok": True, "base": cur.get("base") or "", "model": cur.get("model") or "",
                               "has_key": bool(cur.get("key"))})

    def api_emb_models(self):
        """用填的 URL+Key 拉 /models，供前端下拉选择。"""
        b = self.body_json()
        base = (b.get("base") or (CFG.get("embedding") or {}).get("base") or "").strip().rstrip("/")
        key = (b.get("key") or (CFG.get("embedding") or {}).get("key") or "").strip()
        if not base or not key:
            return self.send_json({"ok": False, "error": "请先填写 Base URL 和 Key"})
        if not base.startswith(("http://", "https://")):
            return self.send_json({"ok": False, "error": "Base URL 必须以 http(s):// 开头"})
        req = urllib.request.Request(base + "/models", headers={"Authorization": "Bearer " + key})
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                j = json.loads(r.read().decode("utf-8", "ignore") or "{}")
            ids = [m.get("id") for m in (j.get("data") or []) if m.get("id")]
            emb = [i for i in ids if "embed" in i.lower()]
            return self.send_json({"ok": True, "all": ids, "embedding": emb})
        except Exception as e:
            return self.send_json({"ok": False, "error": str(e)[:200]})

    def api_emb_test(self):
        """真实调一次 embeddings，确认模型能用、维度多少。"""
        c = CFG.get("embedding") or {}
        base, key, model = (c.get("base") or "").rstrip("/"), c.get("key") or "", c.get("model") or ""
        if not (base and key and model):
            return self.send_json({"ok": False, "error": "配置不完整"})
        body = json.dumps({"model": model, "input": ["连通性测试"]}).encode()
        req = urllib.request.Request(base + "/embeddings", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.loads(r.read().decode("utf-8", "ignore") or "{}")
            vec = ((j.get("data") or [{}])[0] or {}).get("embedding") or []
            return self.send_json({"ok": bool(vec), "dim": len(vec),
                                   "error": None if vec else "接口没返回向量"})
        except urllib.error.HTTPError as e:
            return self.send_json({"ok": False, "error": "HTTP %s: %s" % (e.code, e.read()[:200].decode("utf-8", "ignore"))})
        except Exception as e:
            return self.send_json({"ok": False, "error": str(e)[:200]})

    def api_emb_apply(self):
        """把 embedding 配置写成 AstrBot 的 provider。"""
        c = CFG.get("embedding") or {}
        base, key, model = (c.get("base") or "").rstrip("/"), c.get("key") or "", c.get("model") or ""
        if not (base and key and model):
            return self.send_json({"ok": False, "error": "请先保存 Base URL / Key / 模型名"})
        pid = "panel-embedding"
        body = {
            "id": pid,
            "provider_source_id": "openai_custom_source",
            "provider_config": {
                "id": pid, "type": "openai_embedding", "provider": "openai",
                "provider_type": "embedding", "enable": True,
                "api_base": base, "key": [key], "model": model, "timeout": 60,
            },
            "enabled": True,
        }
        st, j = ab_post("/api/v1/providers", body, timeout=60)
        ok = (j or {}).get("status") in ("ok", "success")
        audit("embedding.apply", model=model, ok=ok, ip=self.client_address[0])
        if ok:
            return self.send_json({"ok": True, "provider_id": pid})
        return self.send_json({"ok": False, "error": (j or {}).get("message") or ("HTTP %s" % st)})

    def api_knowledge_list(self):
        """列出 AstrBot 真正的知识库（不是面板本地目录）。"""
        j = ab_get("/api/v1/knowledge-bases")
        items = ((j or {}).get("data") or {}).get("items") or []
        out = [{"kb_id": k.get("kb_id"), "name": k.get("kb_name"), "desc": k.get("description") or "",
                "emoji": k.get("emoji") or "", "docs": k.get("doc_count") or 0,
                "chunks": k.get("chunk_count") or 0, "embedding": k.get("embedding_provider_id") or ""}
               for k in items]
        # 顺带告诉前端有没有可用的 embedding provider
        provs = ((ab_get("/api/v1/providers") or {}).get("data") or {}).get("providers") or []
        embs = [p.get("id") for p in provs if (p.get("provider_type") or "") == "embedding"]
        return self.send_json({"ok": True, "items": out, "embeddings": embs})

    def api_knowledge_create(self):
        b = self.body_json()
        name = (b.get("name") or "").strip()
        emb = (b.get("embedding_provider_id") or "").strip()
        if not name:
            return self.send_json({"ok": False, "error": "知识库名称不能为空"})
        if not emb:
            return self.send_json({"ok": False, "error": "还没有 embedding 模型，无法创建知识库（见页面提示）"})
        body = {"name": name, "description": b.get("description") or "", "emoji": b.get("emoji") or "📚",
                "embedding_provider_id": emb}
        st, j = ab_post("/api/v1/knowledge-bases", body, timeout=60)
        ok = (j or {}).get("status") in ("ok", "success")
        audit("kb.create", name=name, ok=ok, ip=self.client_address[0])
        if ok:
            d = (j or {}).get("data") or {}
            return self.send_json({"ok": True, "kb": d, "task_id": d.get("task_id")})
        return self.send_json({"ok": False, "error": (j or {}).get("message") or ("HTTP %s" % st)})

    def api_knowledge_upload_kb(self):
        """把知识库文档真正传进 AstrBot（multipart）。字段名 files，走 /documents。"""
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        kb_id = (qs.get("kb_id", [""])[0] or "").strip()
        if not kb_id:
            return self.send_json({"ok": False, "error": "缺少 kb_id"})
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n <= 0 or n > 40 * 1024 * 1024:
            return self.send_json({"ok": False, "error": "文件为空或超过 40MB"})
        raw = self.rfile.read(n)
        ctype = self.headers.get("Content-Type", "")
        if "boundary=" not in ctype:
            return self.send_json({"ok": False, "error": "需要 multipart/form-data"})
        # 直接转发原始 multipart 体，避免自己重新编码
        url = "%s/api/v1/knowledge-bases/%s/documents" % (CFG["astrbot"]["base"], urllib.parse.quote(kb_id))
        req = urllib.request.Request(url, data=raw, method="POST",
                                     headers={"Content-Type": ctype,
                                              "Authorization": "Bearer " + ab_login()})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                j = json.loads(r.read().decode("utf-8", "ignore") or "{}")
            ok = (j or {}).get("status") in ("ok", "success")
            audit("kb.upload", kb_id=kb_id, ok=ok, ip=self.client_address[0])
            return self.send_json({"ok": ok, "data": (j or {}).get("data"),
                                   "error": None if ok else (j or {}).get("message")})
        except urllib.error.HTTPError as e:
            return self.send_json({"ok": False, "error": "HTTP %s: %s" % (e.code, e.read()[:200].decode("utf-8", "ignore"))}, 502)
        except Exception as e:
            return self.send_json({"ok": False, "error": str(e)[:200]}, 500)

    def api_knowledge_docs(self, qs):
        kb_id = (qs.get("kb_id", [""])[0] or "").strip()
        if not kb_id:
            return self.send_json({"ok": False, "error": "缺少 kb_id"})
        j = ab_get("/api/v1/knowledge-bases/%s/documents" % urllib.parse.quote(kb_id))
        items = ((j or {}).get("data") or {}).get("items") or []
        return self.send_json({"ok": True, "items": items,
                               "total": ((j or {}).get("data") or {}).get("total", len(items))})

    def api_knowledge_del_doc(self):
        b = self.body_json()
        kb_id, doc_id = (b.get("kb_id") or "").strip(), (b.get("doc_id") or "").strip()
        if not kb_id or not doc_id:
            return self.send_json({"ok": False, "error": "缺少 kb_id 或 doc_id"})
        url = "%s/api/v1/knowledge-bases/%s/documents/%s" % (
            CFG["astrbot"]["base"], urllib.parse.quote(kb_id), urllib.parse.quote(doc_id))
        req = urllib.request.Request(url, method="DELETE", headers={"Authorization": "Bearer " + ab_login()})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read().decode("utf-8", "ignore") or "{}")
            ok = (j or {}).get("status") in ("ok", "success")
            audit("kb.del_doc", kb_id=kb_id, doc_id=doc_id, ok=ok, ip=self.client_address[0])
            return self.send_json({"ok": ok})
        except Exception as e:
            return self.send_json({"ok": False, "error": str(e)[:200]}, 502)

    def api_knowledge_del_kb(self):
        b = self.body_json()
        kb_id = (b.get("kb_id") or "").strip()
        if not kb_id:
            return self.send_json({"ok": False, "error": "缺少 kb_id"})
        url = "%s/api/v1/knowledge-bases/%s" % (CFG["astrbot"]["base"], urllib.parse.quote(kb_id))
        req = urllib.request.Request(url, method="DELETE", headers={"Authorization": "Bearer " + ab_login()})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read().decode("utf-8", "ignore") or "{}")
            ok = (j or {}).get("status") in ("ok", "success")
            audit("kb.delete", kb_id=kb_id, ok=ok, ip=self.client_address[0])
            return self.send_json({"ok": ok})
        except Exception as e:
            return self.send_json({"ok": False, "error": str(e)[:200]}, 502)

    def api_knowledge_retrieve(self):
        """检索测试：验证知识库确实能被用起来。"""
        b = self.body_json()
        kb_id = (b.get("kb_id") or "").strip()
        q = (b.get("query") or "").strip()
        if not kb_id or not q:
            return self.send_json({"ok": False, "error": "缺少 kb_id 或 query"})
        st, j = ab_post("/api/v1/knowledge-bases/%s/retrieve" % urllib.parse.quote(kb_id),
                        {"query": q, "top_k": int(b.get("top_k") or 5)}, timeout=120)
        ok = (j or {}).get("status") in ("ok", "success")
        return self.send_json({"ok": ok, "data": (j or {}).get("data"),
                               "error": None if ok else (j or {}).get("message")})

    def api_change_password(self):
        b = self.body_json()
        old = b.get("old") or ""
        new = b.get("new") or ""
        if not verify_password(old, CFG["password_hash"]):
            audit("password.change.denied", ip=self.client_address[0])
            return self.send_json({"ok": False, "error": "当前密码不正确"}, 401)
        if len(new) < 8:
            return self.send_json({"ok": False, "error": "新密码至少 8 位"})
        if new == old:
            return self.send_json({"ok": False, "error": "新密码不能与当前密码相同"})
        CFG["password_hash"] = hash_password(new)
        CFG["pwv"] = int(CFG.get("pwv", 0)) + 1
        save_config(CFG)
        audit("password.change", ip=self.client_address[0])
        # 改密后所有旧会话立即失效（pwv 递增），需重新登录
        return self.send_json({"ok": True})

    def api_2fa_status(self):
        t = CFG.get("totp") or {}
        return self.send_json({"ok": True, "enabled": bool(t.get("enabled")), "has_secret": bool(t.get("secret"))})

    def api_alert_config(self):
        b = self.body_json()
        if "enabled" in b or "via_qq" in b or "webhook" in b:
            cur = dict(CFG.get("alert") or {})
            for k in ("enabled", "via_qq"):
                if k in b:
                    cur[k] = bool(b[k])
            if "webhook" in b:
                cur["webhook"] = str(b.get("webhook") or "").strip()
            CFG["alert"] = cur
            save_config(CFG)
            audit("alert.config", ip=self.client_address[0])
        return self.send_json({"ok": True, "alert": CFG.get("alert") or {}})

    def api_alert_test(self):
        res = alert_send("这是一条测试告警，收到说明通道正常。", title="BotPanel 测试告警")
        audit("alert.test", result=json.dumps(res, ensure_ascii=False)[:200], ip=self.client_address[0])
        ok = any(r.get("ok") for r in res)
        return self.send_json({"ok": ok, "results": res})

    def api_selfcheck(self):
        return self.send_json(run_selfcheck())

    def api_2fa_setup(self):
        """生成新 secret（未启用），返回 otpauth URI 供扫码。"""
        sec = totp_new_secret()
        CFG["totp_pending"] = sec
        save_config(CFG)
        audit("2fa.setup", ip=self.client_address[0])
        return self.send_json({"ok": True, "secret": sec, "uri": totp_uri(sec),
                               "note": "用验证器 App 扫码或手输密钥，然后输入 6 位验证码完成启用"})

    def api_2fa_enable(self):
        b = self.body_json()
        code = b.get("code") or ""
        sec = CFG.get("totp_pending") or ""
        if not sec:
            return self.send_json({"ok": False, "error": "请先生成密钥"})
        if not totp_verify(sec, code):
            audit("2fa.enable.denied", ip=self.client_address[0])
            return self.send_json({"ok": False, "error": "验证码不正确"}, 401)
        CFG["totp"] = {"enabled": True, "secret": sec}
        CFG.pop("totp_pending", None)
        # 不递增 pwv：当前会话是刚验证过密码的，踢下线体验太差；
        # 下次登录起就必须带验证码了。
        save_config(CFG)
        audit("2fa.enable", ip=self.client_address[0])
        return self.send_json({"ok": True})

    def api_2fa_disable(self):
        b = self.body_json()
        pw = b.get("password") or ""
        code = b.get("code") or ""
        t = CFG.get("totp") or {}
        if not t.get("enabled"):
            return self.send_json({"ok": False, "error": "两步验证未启用"})
        if not verify_password(pw, CFG["password_hash"]):
            return self.send_json({"ok": False, "error": "密码不正确"}, 401)
        if not totp_verify(t.get("secret"), code):
            return self.send_json({"ok": False, "error": "验证码不正确"}, 401)
        CFG.pop("totp", None)
        save_config(CFG)
        audit("2fa.disable", ip=self.client_address[0])
        return self.send_json({"ok": True})

    def api_login(self):
        b = self.body_json()
        pw = b.get("password", "")
        ip = self.client_address[0]
        now = time.time()
        bucket = LOGIN_FAIL.setdefault(ip, [])
        bucket[:] = [t for t in bucket if now - t < 300]
        # 全局兜底：防止换 IP 绕过单 IP 限速
        LOGIN_FAIL_GLOBAL[:] = [t for t in LOGIN_FAIL_GLOBAL if now - t < 300]
        if len(bucket) >= 8 or len(LOGIN_FAIL_GLOBAL) >= 40:
            audit("login.ratelimited", ip=ip)
            return self.send_json({"ok": False, "error": "尝试过于频繁，请 5 分钟后再试"}, 429)
        if not verify_password(pw, CFG["password_hash"]):
            bucket.append(now)
            LOGIN_FAIL_GLOBAL.append(now)
            audit("login.fail", ip=ip)
            return self.send_json({"ok": False, "error": "密码不正确"}, 401)
        # 密码正确后，若启用了 2FA 再校验动态码
        t = CFG.get("totp") or {}
        if t.get("enabled"):
            code = (b.get("code") or "").strip()
            if not totp_verify(t.get("secret"), code):
                bucket.append(now)
                LOGIN_FAIL_GLOBAL.append(now)
                audit("login.2fa.fail", ip=ip)
                # 不透露"密码对了但码错了"以外的东西，提示足够用户自查
                return self.send_json({"ok": False, "need2fa": True, "error": "验证码不正确"}, 401)
        audit("login.ok", ip=ip)
        bucket.clear()
        exp = int(now + 7 * 86400)
        payload = base64.urlsafe_b64encode(json.dumps({"exp": exp, "pwv": int(CFG.get("pwv", 0))}).encode()).decode()
        sig = hmac.new(CFG["secret"].encode(), payload.encode(), hashlib.sha256).hexdigest()
        cookie = ("bp_session=%s.%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Lax"
                  % (payload, sig, 7 * 86400))
        self.send_json({"ok": True}, extra={"Set-Cookie": cookie})

    def api_status(self):
        now = time.time()
        if STATUS_CACHE["data"] and now - STATUS_CACHE["ts"] < 8:
            return self.send_json(STATUS_CACHE["data"])
        lat, today_msgs, total_msgs, personas_db, model = bot_stats()
        plugins, personas, stats = [], [], None
        j = ab_get("/api/v1/plugins")
        if j and isinstance(j.get("data"), list):
            plugins = [{"name": p.get("name"), "display": p.get("display_name") or p.get("name"), "author": p.get("author", ""), "desc": p.get("desc", ""), "version": p.get("version", ""), "activated": bool(p.get("activated")), "reserved": bool(p.get("reserved")), "logo": p.get("logo") or ""} for p in j["data"]]
        j = ab_get("/api/v1/personas")
        if j and isinstance(j.get("data"), list):
            personas = [{"id": p.get("persona_id"), "prompt": p.get("system_prompt", "")} for p in j["data"]]
        elif personas_db:
            personas = personas_db
        j = ab_get("/api/v1/stats")
        if j:
            stats = j.get("data")
        bot = bot_info()
        owners = CFG.get("owners", [])
        payload = {
            "ts": int(time.time() * 1000),
            "host": PUBLIC_HOST,
            "server": server_info(),
            "containers": fmt_containers(),
            "bot": bot,
            "model": model,
            "latency": lat,
            "tokens": token_stats(),
            "todayMsgs": today_msgs,
            "totalMsgs": total_msgs,
            "plugins": plugins,
            "personas": personas,
            "stats": stats,
            "owners": owners,
            "novnc": CFG.get("novnc_url", ""),
        }
        STATUS_CACHE["ts"] = time.time()
        STATUS_CACHE["data"] = payload
        self.send_json(payload)

    def api_logs(self, qs):
        src = (qs.get("src", ["astrbot"])[0] or "astrbot")
        if src not in ("astrbot", "snowluma"):
            src = "astrbot"
        n = max(20, min(1000, int(qs.get("n", ["300"])[0] or 300)))
        out = run(["docker", "logs", "--tail", str(n), src], timeout=20)
        out = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", out)
        self.send_json({"src": src, "text": out, "ts": int(time.time() * 1000)})

    def api_logs_stream(self, qs):
        """SSE 实时日志：docker logs --follow 逐行推送。
        用独立的 subprocess 而非 run()，因为我们边读边写、需要能中途终止。"""
        src = (qs.get("src", ["astrbot"])[0] or "astrbot")
        if src not in ("astrbot", "snowluma"):
            src = "astrbot"
        try:
            tail = max(0, min(500, int(qs.get("tail", ["80"])[0] or 80)))
        except Exception:
            tail = 80

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        proc = None
        try:
            cmd = ["docker", "logs", "--follow", "--tail", str(tail), src]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1, errors="replace")
            # 首包：告诉前端已连接
            self._sse_send({"type": "open", "src": src})
            last_ping = time.time()
            while True:
                line = proc.stdout.readline()
                if line == "":
                    # 进程结束（容器重启/停止）
                    if proc.poll() is not None:
                        self._sse_send({"type": "closed", "src": src})
                        break
                    time.sleep(0.2)
                    continue
                line = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", line.rstrip("\n"))
                if not line:
                    continue
                self._sse_send({"type": "line", "text": line})
                # 每 15 秒补一个注释心跳，防代理/手机断流
                if time.time() - last_ping > 15:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.time()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self._sse_send({"type": "error", "message": str(e)})
            except Exception:
                pass
        finally:
            if proc is not None:
                try:
                    proc.terminate()
                    proc.wait(timeout=3)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass

    def _sse_send(self, obj):
        payload = "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"
        self.wfile.write(payload.encode("utf-8"))
        self.wfile.flush()

    def api_contacts(self):
        friends = onebot_call("get_friend_list").get("data") or []
        groups = onebot_call("get_group_list").get("data") or []
        self.send_json({
            "friends": [{"id": str(f.get("user_id")), "name": f.get("remark") or f.get("nickname") or str(f.get("user_id")), "nick": f.get("nickname", "")} for f in friends],
            "groups": [{"id": str(g.get("group_id")), "name": g.get("group_name", ""), "count": g.get("member_count", 0)} for g in groups],
        })

    def _astrbot_market(self, force=False):
        cache = os.path.join(BASE, "cache", "astrbot-market.json")
        if not force and os.path.exists(cache) and time.time() - os.path.getmtime(cache) < 600:
            try:
                with open(cache, encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        j = ab_get("/api/v1/plugins/market" + ("?force_refresh=true" if force else ""), timeout=90)
        data = (j or {}).get("data") or {}
        items = []
        for key, p in data.items():
            if key.startswith("$") or not isinstance(p, dict):
                continue
            owner_m = re.search(r"github\.com/([^/]+)/", p.get("repo") or "")
            owner = owner_m.group(1) if owner_m else (key.split("/")[0] if "/" in key else "")
            items.append({
                "id": key,
                "icon": p.get("logo") or "",
                "stars": p.get("stars") or 0,
                "downloads": p.get("download_count") or 0,
                "name": p.get("name") or key,
                "display": p.get("display_name") or p.get("name") or key,
                "author": p.get("author", ""),
                "desc": p.get("desc", ""),
                "version": p.get("version", ""),
                "repo": p.get("repo") or p.get("homepage") or "",
                "download": p.get("download_url", ""),
                "home": p.get("homepage") or p.get("repo") or "",
                "cat": p.get("category", "") if isinstance(p.get("category"), str) else "",
            })
        payload = {"ts": int(time.time()), "items": items, "meta": data.get("$meta", {})}
        try:
            with open(cache, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except Exception:
            pass
        return payload

    def api_market(self, qs):
        try:
            data = self._astrbot_market(force=("force" in qs))
        except Exception as e:
            return self.send_json({"ok": False, "error": "市场读取失败：%s" % e})
        items = data.get("items") or []
        for it_ in items:
            if not it_.get("icon"):
                it_["icon"] = it_.get("logo") or ""

        q = (qs.get("q", [""])[0] or "").lower().strip()
        cat = (qs.get("cat", [""])[0] or "").strip()
        sort = (qs.get("sort", ["stars"])[0] or "stars").strip()
        try:
            page = int(qs.get("page", ["1"])[0] or 1)
        except Exception:
            page = 1
        try:
            n = int(qs.get("n", ["24"])[0] or 24)
        except Exception:
            n = 24
        page = max(1, page)
        n = max(1, min(60, n))

        lst = items
        if q:
            lst = [x for x in lst if q in (x["name"] + " " + x["display"] + " " + x["desc"] + " " + x["author"]).lower()]
        if cat and cat != "全部":
            lst = [x for x in lst if (x.get("cat") or "其他") == cat]

        keys = {
            "stars": lambda x: -(x.get("stars") or 0),
            "downloads": lambda x: -(x.get("downloads") or 0),
            "name": lambda x: (x.get("display") or x.get("name") or ""),
        }
        if sort in keys:
            lst = sorted(lst, key=keys[sort])

        total = len(lst)
        start = (page - 1) * n
        page_items = lst[start:start + n]

        # 分类统计（按当前搜索词过滤后的全集算，便于前端显示计数）
        cat_counts = {}
        base = items
        if q:
            base = [x for x in items if q in (x["name"] + " " + x["display"] + " " + x["desc"] + " " + x["author"]).lower()]
        for x in base:
            k = x.get("cat") or "其他"
            cat_counts[k] = cat_counts.get(k, 0) + 1
        cats = sorted(cat_counts.items(), key=lambda kv: -kv[1])

        self.send_json({
            "ok": True,
            "total": total,
            "all": len(items),
            "page": page,
            "pages": max(1, (total + n - 1) // n),
            "n": n,
            "items": page_items,
            "cats": [{"name": k, "count": v} for k, v in cats],
            "meta": data.get("meta", {}),
        })

    def api_plugin_uninstall(self):
        """卸载插件：DELETE /api/v1/plugins/by-id?plugin_id=xxx"""
        b = self.body_json()
        pid = (b.get("plugin_id") or "").strip()
        if not pid:
            return self.send_json({"ok": False, "error": "缺少 plugin_id"})
        if pid in ("astrbot", "builtin_commands", "webchat"):
            return self.send_json({"ok": False, "error": "内置插件不可卸载"}, 403)
        audit("plugin.uninstall", plugin_id=pid, ip=self.client_address[0])
        url = "%s/api/v1/plugins/by-id?plugin_id=%s" % (CFG["astrbot"]["base"], urllib.parse.quote(pid))
        req = urllib.request.Request(url, method="DELETE", headers={"Authorization": "Bearer " + ab_login()})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read().decode("utf-8", "ignore") or "{}")
            ok = (j or {}).get("status") in ("ok", "success")
            return self.send_json({"ok": ok, "message": (j or {}).get("message") or ""})
        except urllib.error.HTTPError as e:
            return self.send_json({"ok": False, "error": "HTTP %s: %s" % (e.code, e.read()[:160].decode("utf-8", "ignore"))}, 502)
        except Exception as e:
            return self.send_json({"ok": False, "error": str(e)}, 500)

    def api_plugin_update(self):
        """更新插件：POST /api/v1/plugins/update  body {"plugin_list": [...]}"""
        b = self.body_json()
        names = b.get("plugins") or []
        if not isinstance(names, list) or not names:
            return self.send_json({"ok": False, "error": "缺少要更新的插件列表"})
        audit("plugin.update", plugins=",".join(names), ip=self.client_address[0])
        st, j = ab_post("/api/v1/plugins/update", {"plugin_list": names}, timeout=300)
        ok = (j or {}).get("status") in ("ok", "success")
        return self.send_json({"ok": ok, "status": st,
                               "message": (j or {}).get("message") or "", "data": (j or {}).get("data")})

    def api_plugin_updates(self):
        """查询可更新插件：逐个别查 AstrBot 的 /api/v1/plugins/updates?plugin_name="""
        j = ab_get("/api/v1/plugins")
        names = [p.get("name") for p in ((j or {}).get("data") or []) if p.get("name")]
        out = []
        for n in names:
            try:
                st, u = ab_get("/api/v1/plugins/updates?plugin_name=" + urllib.parse.quote(n), timeout=8) or (0, {})
                d = (u or {}).get("data") or {}
                if isinstance(d, dict) and d.get("has_update"):
                    out.append({"name": n, "current": d.get("current_version"), "latest": d.get("latest_version")})
            except Exception:
                continue
        return self.send_json({"ok": True, "items": out, "checked": len(names)})

    def api_market_install_start(self):
        b = self.body_json()
        pid = (b.get("id") or "").strip()
        data = self._astrbot_market()
        it = next((x for x in (data.get("items") or []) if x["id"] == pid), None)
        if not it:
            return self.send_json({"ok": False, "error": "找不到插件"})
        now = time.time()
        with INSTALL_LOCK:
            for k in [k for k, v in INSTALL_JOBS.items() if now - v.get("ts", 0) > 900]:
                INSTALL_JOBS.pop(k, None)
        token = secrets.token_hex(8)
        INSTALL_JOBS[token] = {"state": "queued", "percent": 0, "received": 0, "total": 0,
                               "msg": "准备下载", "name": it.get("name"), "ts": now}
        threading.Thread(target=self._install_worker, args=(token, it), daemon=True).start()
        self.send_json({"ok": True, "token": token})

    def _install_worker(self, token, it):
        job = INSTALL_JOBS.get(token)
        if not job:
            return
        fn = ""
        try:
            url = it.get("download") or ""
            if not url:
                raise RuntimeError("该插件没有下载地址")
            os.makedirs(PLUGIN_DL_DIR, exist_ok=True)
            fn = os.path.join(PLUGIN_DL_DIR, "%s-%s.zip" % (it.get("name", "plugin"), secrets.token_hex(4)))
            job.update(state="downloading", msg="正在下载插件包")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=90) as r:
                total = int(r.headers.get("Content-Length") or 0)
                job["total"] = total
                with open(fn, "wb") as f:
                    while True:
                        chunk = r.read(65536)
                        if not chunk:
                            break
                        f.write(chunk)
                        job["received"] += len(chunk)
                        job["percent"] = min(95, int(job["received"] * 100 / total)) if total else min(60, job["percent"] + 2)
            with open(fn, "rb") as f:
                content = f.read()
            job.update(state="uploading", msg="上传到 AstrBot 安装", percent=max(90, job["percent"]))
            st, j = ab_upload_plugin(it.get("name", "plugin") + ".zip", content)
            ok = st in (200, 201) and (j or {}).get("status") == "ok"
            if not ok:
                raise RuntimeError((j or {}).get("message") or ("安装失败 HTTP %s" % st))
            job.update(state="done", percent=100, msg="安装成功", result=(j or {}).get("message") or "安装成功")
        except Exception as e:
            job.update(state="error", msg=str(e))
        finally:
            try:
                if fn and os.path.exists(fn):
                    os.remove(fn)
            except Exception:
                pass

    def api_market_install_status(self, qs):
        token = (qs.get("token", [""])[0] or "").strip()
        with INSTALL_LOCK:
            job = INSTALL_JOBS.get(token)
        if not job:
            return self.send_json({"ok": False, "error": "任务不存在"}, 404)
        self.send_json({"ok": True, "job": job})

    def api_market_install(self):
        b = self.body_json()
        pid = (b.get("id") or "").strip()
        data = self._astrbot_market()
        it = next((x for x in (data.get("items") or []) if x["id"] == pid), None)
        if not it:
            return self.send_json({"ok": False, "error": "找不到插件"})
        body = {"url": it.get("repo") or it.get("home"), "market_plugin_id": it.get("name")}
        if it.get("download"):
            body["download_url"] = it["download"]
        if b.get("force"):
            body["ignore_version_check"] = True
        st, j = ab_post("/api/v1/plugins/install/url", body, timeout=240)
        ok = st in (200, 201) and (j or {}).get("status") == "ok"
        return self.send_json({"ok": ok, "status": st, "message": (j or {}).get("message") or (j or {}).get("data") or ""})

    def api_personas(self):
        j = ab_get("/api/v1/personas")
        if j and isinstance(j.get("data"), list):
            return self.send_json({"ok": True, "items": j["data"]})
        return self.send_json({"ok": False, "items": []})

    def api_persona_save(self):
        return self.send_json({"ok": False, "error": "persona 编辑请到 AstrBot WebUI（数据保存在其数据库中）"}, 501)

class PanelServer(ThreadingHTTPServer):
    """握手在 worker 线程里做（不在 accept 主循环），并带超时。
    否则一个连上却不发 ClientHello 的客户端会卡死整个服务。"""
    daemon_threads = True
    request_queue_size = 128
    ssl_ctx = None

    def finish_request(self, request, client_address):
        if self.ssl_ctx is None:
            return ThreadingHTTPServer.finish_request(self, request, client_address)
        conn = None
        try:
            request.settimeout(10)
            conn = self.ssl_ctx.wrap_socket(request, server_side=True)
            conn.settimeout(30)
        except Exception:
            try:
                request.close()
            except Exception:
                pass
            return
        try:
            self.RequestHandlerClass(conn, client_address, self)
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

LOGIN_FAIL = {}
LOGIN_FAIL_GLOBAL = []
PUBLIC_HOST = ""

def run_selfcheck():
    """自检核心逻辑（模块级，HTTP handler 与后台巡检线程共用）。"""
    checks = []

    def add(name, ok, detail, level="error"):
        checks.append({"name": name, "ok": bool(ok), "detail": detail, "level": level})

    # 1) 容器
    try:
        out = run(["docker", "ps", "--format", "{{.Names}}\t{{.State}}"], timeout=10)
        running = [l.split("\t")[0] for l in out.strip().split("\n") if l.strip()]
        for want in (ASTRBOT_CONTAINER, SNOWLUMA_CONTAINER):
            add("容器 " + want, want in running,
                "运行中" if want in running else "未运行（当前：%s）" % (", ".join(running) or "无"))
    except Exception as e:
        add("Docker", False, str(e)[:100])

    # 2) HTTPS 证书剩余天数
    try:
        cert = (CFG.get("tls") or {}).get("cert") or ""
        if cert and os.path.isfile(cert):
            raw = subprocess.run(["openssl", "x509", "-enddate", "-noout", "-in", cert],
                                 capture_output=True, text=True, timeout=8).stdout.strip()
            end = raw.split("=", 1)[1] if "=" in raw else ""
            exp = time.mktime(time.strptime(end, "%b %d %H:%M:%S %Y %Z")) if end else 0
            days = int((exp - time.time()) // 86400)
            add("HTTPS 证书", days > 7, "剩余 %d 天" % days, level="warn" if days <= 30 else "error")
        else:
            add("HTTPS 证书", True, "未启用 HTTPS", level="warn")
    except Exception as e:
        add("HTTPS 证书", False, str(e)[:100], level="warn")

    # 3) 磁盘
    try:
        st = os.statvfs("/")
        free_gb = st.f_bavail * st.f_frsize / (1024 ** 3)
        used_pct = 100 - (st.f_bavail * 100.0 / st.f_blocks)
        add("磁盘空间", free_gb > 3, "剩余 %.1f GB，已用 %.0f%%" % (free_gb, used_pct),
            level="warn" if free_gb <= 8 else "error")
    except Exception as e:
        add("磁盘空间", False, str(e)[:100], level="warn")

    # 4) 备份新鲜度
    try:
        bdir = "/opt/bots/backups"
        newest = 0
        for root, _, files in os.walk(bdir):
            for f in files:
                if f.endswith((".tar.gz", ".tgz")) or f.startswith("data_v4.db"):
                    newest = max(newest, os.path.getmtime(os.path.join(root, f)))
        hours = (time.time() - newest) / 3600 if newest else 9999
        add("备份新鲜度", hours < 30, ("最近备份 %.1f 小时前" % hours) if newest else "找不到备份文件",
            level="warn" if hours < 48 else "error")
    except Exception as e:
        add("备份新鲜度", False, str(e)[:100], level="warn")

    # 5) AstrBot 接口
    try:
        j = ab_get("/api/v1/plugins", timeout=10)
        n = len((j or {}).get("data") or [])
        add("AstrBot 接口", (j or {}).get("status") in ("ok", "success"), "已加载 %d 个插件" % n)
    except Exception as e:
        add("AstrBot 接口", False, str(e)[:100])

    bad = [c for c in checks if not c["ok"]]
    return {"ok": not bad, "checks": checks, "ts": int(time.time())}

def watchdog_loop():
    """后台巡检：每 10 分钟自检一次，异常且告警开启时推送；同一问题 6 小时内不重复报。"""
    time.sleep(120)  # 等 AstrBot 冷启动稳定
    sent = {}
    while True:
        try:
            res = run_selfcheck()
            if not res["ok"]:
                bad = [c for c in res["checks"] if not c["ok"]]
                key = "|".join(sorted(c["name"] for c in bad))
                now = time.time()
                if now - sent.get(key, 0) > 6 * 3600:
                    lines = "\n".join("- %s：%s" % (c["name"], c["detail"]) for c in bad)
                    alert_send("自检发现问题：\n" + lines)
                    audit("selfcheck.alert", problems=key[:200])
                    sent[key] = now
        except Exception:
            pass
        time.sleep(600)

def main():
    global PUBLIC_HOST
    PUBLIC_HOST = os.environ.get("PANEL_PUBLIC_HOST", "")
    if not PUBLIC_HOST:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("8.8.8.8", 80)); PUBLIC_HOST = s.getsockname()[0]; s.close()
        except Exception:
            PUBLIC_HOST = "127.0.0.1"
    threading.Thread(target=market_items, daemon=True).start()
    threading.Thread(target=watchdog_loop, daemon=True).start()
    tls = CFG.get("tls") or {}
    use_tls = bool(tls.get("enabled")) and os.path.exists(tls.get("cert", "")) and os.path.exists(tls.get("key", ""))
    srv = PanelServer(("0.0.0.0", PORT), Handler)
    if use_tls:
        import ssl
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(tls["cert"], tls["key"])
        srv.ssl_ctx = ctx
        print("panel listening on https://0.0.0.0:%d" % PORT)
    else:
        print("panel listening on http://0.0.0.0:%d" % PORT)
    srv.serve_forever()

if __name__ == "__main__":
    main()
