/* =========================================================
   QQ Bot 控制台 · 前端逻辑
   结构：工具函数 → 导航 → 状态渲染 → 日志 → 插件/人格
        → 市场 → 学习 → 设置页 → 主题/开场 → 启动
   ========================================================= */
var $ = function (id) { return document.getElementById(id); };
var state = null, curTab = 'overview';
var logSrc = 'astrbot', logLevel = 'all', logLinesData = [], logPaused = false, logBusy = false, firstLog = true;
var logTheme = JSON.parse(localStorage.getItem('bp_log_pref') || '{}').theme || 'sayori';
var marketLoaded = false, mkTimer = null, curPersona = null;
var IS_LOCAL = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
var IP_HIDDEN = localStorage.getItem('bp_ip_hidden') !== '0';

/* ---------------- 工具 ---------------- */
function api(path, opts) {
  return fetch(path, opts).then(function (r) {
    if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
    return r.json();
  });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function fmtBytes(n) { if (!n && n !== 0) return '-'; var g = n / 1073741824; return g >= 1 ? g.toFixed(1) + ' GB' : (n / 1048576).toFixed(0) + ' MB'; }
function fmtUptime(s) { if (!s) return '-'; var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + ' 天 ' : '') + ((h || d) ? h + ' 小时 ' : '') + m + ' 分'; }
function fmtMs(ms) { if (!ms) return '—'; return (ms / 1000).toFixed(1) + 's'; }
function fmtCount(n) { n = n || 0; if (n >= 10000) return (n / 10000).toFixed(1) + 'w'; if (n >= 1000) return (n / 1000).toFixed(1) + 'k'; return String(n); }
function snack(msg) { var el = $('snack'); el.textContent = msg; el.classList.add('on'); clearTimeout(el._t); el._t = setTimeout(function () { el.classList.remove('on'); }, 1800); }
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { snack('已复制'); });
  else { var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); snack('已复制'); } catch (e) {} document.body.removeChild(ta); }
}
function avatarUrl(uin) { return 'http://q.qlogo.cn/headimg_dl?dst_uin=' + uin + '&spec=640&img_type=jpg'; }
function maskIp(ip) { return IP_HIDDEN ? '••••••••••••' : ip; }

/* 涟漪效果 */
document.addEventListener('pointerdown', function (e) {
  var b = e.target.closest('.ripple, .btn, .rail button, .bottomnav button');
  if (!b) return;
  var r = b.getBoundingClientRect(), d = Math.max(r.width, r.height), s = document.createElement('span');
  s.className = 'rp';
  s.style.width = s.style.height = d + 'px';
  s.style.left = (e.clientX - r.left - d / 2) + 'px';
  s.style.top = (e.clientY - r.top - d / 2) + 'px';
  b.appendChild(s);
  setTimeout(function () { s.remove(); }, 620);
});

/* ---------------- 导航 ---------------- */
function setTab(t) {
  curTab = t;
  document.querySelectorAll('.pane').forEach(function (p) { p.classList.remove('on'); });
  var pane = $('pane-' + t); if (pane) pane.classList.add('on');
  document.querySelectorAll('[data-tab]').forEach(function (b) {
    var on = b.dataset.tab === t;
    b.classList.toggle('on', on);
    // 让屏幕阅读器知道当前在哪一页
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (t === 'market') loadMarket();
  if (t === 'logs') loadLogs(true);
  if (t === 'desktop') initVnc();
  if (t === 'learn') loadKnowledge();
  var de = $('btnDashEdit'); if (de) de.style.display = (t === 'overview') ? '' : 'none';
  if (t !== 'overview' && $('dash')) dashEdit(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { setTab(b.dataset.tab); }); });

/* ---------------- 概览可编辑布局（拖拽 / 宽度 / 添加） ---------------- */
var DASH_CARDS = { bot: '机器人档案', services: '服务', server: '服务器', containers: '容器 / 主人', quick: '快捷操作', tokens: 'Token 用量', latency: '最近回复' };
var DASH_DEFAULT = ['bot', 'services', 'server', 'containers', 'quick', 'tokens', 'latency'];
var DASH_SPAN2 = { tokens: true, latency: true };
function dashState() {
  try { var s = JSON.parse(localStorage.getItem('bp_dash') || 'null'); if (s && s.order) { s.wide = s.wide || {}; return s; } } catch (e) {}
  return { order: DASH_DEFAULT.slice(), hidden: [], wide: {} };
}
function dashSave(s) { localStorage.setItem('bp_dash', JSON.stringify(s)); }
function dashNodes() { var g = $('dash'), m = {}; if (g) g.querySelectorAll('.dash-card').forEach(function (el) { m[el.dataset.card] = el; }); return m; }
function dashWide(id, st) { return st.wide && (st.wide[id] === true || (st.wide[id] === undefined && !!DASH_SPAN2[id])); }
function applyDash() {
  var s = dashState(), map = dashNodes(), g = $('dash');
  if (!g) return;
  var order = s.order.filter(function (k) { return map[k]; });
  DASH_DEFAULT.forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
  order.forEach(function (k) { g.appendChild(map[k]); });
  Object.keys(map).forEach(function (k) {
    map[k].style.display = s.hidden.indexOf(k) >= 0 ? 'none' : '';
    map[k].classList.toggle('span2', !!dashWide(k, s));
  });
}
function dashEdit(on) {
  var g = $('dash'); if (!g) return;
  g.classList.toggle('edit', !!on);
  if ($('btnDashAdd')) $('btnDashAdd').style.display = on ? '' : 'none';
  if ($('btnDashReset')) $('btnDashReset').style.display = on ? '' : 'none';
  if ($('btnDashDone')) $('btnDashDone').style.display = on ? '' : 'none';
  if ($('dashHint')) $('dashHint').textContent = on ? '编辑中：拖动 ⠿ 排序，⤢ 切宽度，X 移除' : '自定义布局：点右上角铅笔编辑';
}
function dashRemove(id) {
  var s = dashState();
  if (s.hidden.indexOf(id) < 0) s.hidden.push(id);
  dashSave(s); applyDash(); snack('已移除，可在「+ 添加组件」里找回');
}
function dashAddDialog() {
  var s = dashState();
  var hidden = DASH_DEFAULT.filter(function (k) { return s.hidden.indexOf(k) >= 0; });
  if (!hidden.length) { snack('所有组件都在面板上了'); return; }
  openDialog('<h3>添加组件</h3><div class="col" style="margin-top:12px">' + hidden.map(function (k) {
    return '<div class="item"><div class="body"><div class="name">' + DASH_CARDS[k] + '</div><div class="desc">之前被移除的卡片</div></div><button class="btn tonal sm" data-add="' + k + '">添加</button></div>';
  }).join('') + '</div>');
  document.querySelectorAll('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () {
      var st = dashState();
      st.hidden = st.hidden.filter(function (x) { return x !== b.dataset.add; });
      dashSave(st); applyDash(); closeDialog(); snack('已添加');
    });
  });
}
function dashReset() {
  localStorage.removeItem('bp_dash');
  applyDash();
  snack('已恢复默认布局');
}
function dashBindDrag() {
  var g = $('dash'); if (!g) return;
  g.querySelectorAll('[data-drag]').forEach(function (h) {
    h.addEventListener('pointerdown', function (e) {
      if (!g.classList.contains('edit')) return;
      e.preventDefault();
      var card = h.closest('.dash-card'); if (!card) return;
      card.classList.add('dragging');
      try { h.setPointerCapture(e.pointerId); } catch (err) {}
      var moved = false;
      function onMove(ev) {
        var el = document.elementFromPoint(ev.clientX, ev.clientY);
        var over = el && el.closest ? el.closest('.dash-card') : null;
        if (!over || over === card || over.parentNode !== g) return;
        var rect = over.getBoundingClientRect();
        var before = ev.clientY < rect.top + rect.height / 2;
        g.insertBefore(card, before ? over : over.nextSibling);
        moved = true;
      }
      function onUp() {
        h.removeEventListener('pointermove', onMove);
        h.removeEventListener('pointerup', onUp);
        h.removeEventListener('pointercancel', onUp);
        card.classList.remove('dragging');
        if (moved) {
          var s = dashState();
          s.order = Array.prototype.slice.call(g.querySelectorAll('.dash-card')).map(function (x) { return x.dataset.card; });
          dashSave(s);
        }
      }
      h.addEventListener('pointermove', onMove);
      h.addEventListener('pointerup', onUp);
      h.addEventListener('pointercancel', onUp);
    });
  });
}
(function bindDash() {
  if (!$('dash')) return;
  applyDash();
  dashBindDrag();
  $('btnDashEdit') && $('btnDashEdit').addEventListener('click', function () { dashEdit(!$('dash').classList.contains('edit')); });
  $('btnDashDone') && $('btnDashDone').addEventListener('click', function () { dashEdit(false); });
  $('btnDashAdd') && $('btnDashAdd').addEventListener('click', dashAddDialog);
  $('btnDashReset') && $('btnDashReset').addEventListener('click', dashReset);
  document.querySelectorAll('[data-rm]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); dashRemove(b.dataset.rm); }); });
  document.querySelectorAll('[data-wide]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var s = dashState(); s.wide = s.wide || {};
      s.wide[b.dataset.wide] = !dashWide(b.dataset.wide, s);
      dashSave(s); applyDash();
    });
  });
  document.querySelectorAll('[data-quick]').forEach(function (b) {
    b.addEventListener('click', function () {
      var a = b.dataset.quick;
      if (a === 'refresh') { tick(true); snack('已刷新'); }
      else if (a === 'restart') { var r = $('btnRestartBot'); if (r) r.click(); }
      else if (a === 'vnc') { setTab('desktop'); }
    });
  });
})();


/* ---------------- 状态渲染 ---------------- */
function svcRow(name, desc, ok, url) {
  return '<div class="row" style="padding:9px 0;border-bottom:1px solid var(--outline-v)">'
    + '<span class="dot ' + (ok ? 'ok' : 'bad') + '"></span>'
    + '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px">' + name + '</div>'
    + '<div class="muted">' + desc + '</div></div>'
    + (ok ? (IS_LOCAL ? '<a class="btn text sm" href="' + url + '" target="_blank" rel="noreferrer">打开</a>' : '<span class="chip ok">在线</span>') : '<span class="chip bad">离线</span>')
    + '</div>';
}

function render(s) {
  if (!s || !s.ts) { snack('状态获取失败，稍后重试'); return; }
  state = s;
  $('sub').textContent = '服务器 · ' + new Date(s.ts).toLocaleTimeString('zh-CN');
  var online = s.bot && s.bot.online;
  $('statusDot').className = 'dot ' + (online ? 'ok' : 'bad');
  $('statusText').textContent = online ? '在线' : '离线';

  var b = s.bot || {};
  $('botAvatar').src = b.uin ? avatarUrl(b.uin) : '';
  $('botAvatar').onerror = function () { this.style.display = 'none'; };
  $('botNick').textContent = b.nickname || '未登录';
  $('botMeta').innerHTML = (b.uin ? '<span>QQ ' + esc(b.uin) + '</span>' : '')
    + '<span class="chip ' + (online ? 'ok' : 'bad') + '">' + (online ? '在线' : '离线') + '</span>'
    + '<span class="chip p">' + esc(s.model || '未配置模型') + '</span>';

  var lat = s.latency || [];
  var last = lat.length ? lat[0].ms : 0;
  var avg = lat.length ? Math.round(lat.reduce(function (a, x) { return a + x.ms; }, 0) / lat.length) : 0;
  $('botStats').innerHTML =
    '<div class="stat"><div class="v">' + fmtMs(last) + '</div><div class="l">最近回复</div></div>'
    + '<div class="stat"><div class="v">' + fmtMs(avg) + '</div><div class="l">平均耗时</div></div>'
    + '<div class="stat"><div class="v">' + (s.todayMsgs || 0) + '</div><div class="l">今日会话</div></div>'
    + '<div class="stat"><div class="v">' + (s.plugins ? s.plugins.length : 0) + '</div><div class="l">插件</div></div>';

  var cs = s.containers || [];
  function running(name) { return !!cs.find(function (c) { return c.name === name; }); }
  $('services').innerHTML = svcRow('AstrBot', '127.0.0.1:16185 · AI 机器人', running('astrbot'), 'http://127.0.0.1:16185')
    + svcRow('SnowLuma', '127.0.0.1:15099 · QQ 网关', running('snowluma'), 'http://127.0.0.1:15099')
    + svcRow('noVNC', '127.0.0.1:16081 · 远程桌面', running('snowluma'), (s.novnc || ''));

  var sv = s.server;
  if (sv) {
    $('serverInfo').innerHTML =
      '<div class="kv">'
      + '<div class="k">主机</div><div class="v">' + esc(sv.host) + '</div>'
      + '<div class="k">系统</div><div class="v">' + esc(sv.os) + '</div>'
      + '<div class="k">CPU</div><div class="v">' + sv.cores + ' 核 · load ' + sv.load1.toFixed(2) + '</div>'
      + '<div class="k">公网 IP</div><div class="v ip-row"><span id="ipPublic">' + maskIp(s.host) + '</span>'
      + '<button class="btn icon ripple ip-eye" id="eyePublic" title="显示/隐藏">' + eyeIcon() + '</button></div>'
      + '<div class="k">内网 IP</div><div class="v ip-row"><span id="ipPrivate">' + maskIp(sv.ip) + '</span>'
      + '<button class="btn icon ripple ip-eye" id="eyePrivate" title="显示/隐藏">' + eyeIcon() + '</button></div>'
      + '<div class="k">运行</div><div class="v">' + fmtUptime(sv.uptime) + '</div>'
      + '</div>';
    $('eyePublic').dataset.ip = s.host;
    $('eyePrivate').dataset.ip = sv.ip;
    document.querySelectorAll('.ip-eye').forEach(function (btn) { btn.addEventListener('click', toggleIp); });
    var memUsed = sv.mem_total - sv.mem_avail, memPct = sv.mem_total ? memUsed / sv.mem_total * 100 : 0;
    var swUsed = sv.swap_total - sv.swap_free, swPct = sv.swap_total ? swUsed / sv.swap_total * 100 : 0;
    var dPct = sv.disk_total ? sv.disk_used / sv.disk_total * 100 : 0;
    function bar(pct, label) { return '<div class="metric"><div class="mr"><span>' + label + '</span><span><b>' + pct.toFixed(0) + '%</b></span></div><div class="bar"><i class="' + (pct > 85 ? 'hot' : '') + '" style="width:' + Math.min(100, pct) + '%"></i></div></div>'; }
    $('serverMetrics').innerHTML = bar(memPct, '内存 ' + fmtBytes(memUsed) + ' / ' + fmtBytes(sv.mem_total)) + bar(swPct, 'SWAP ' + fmtBytes(swUsed) + ' / ' + fmtBytes(sv.swap_total)) + bar(dPct, '磁盘 ' + fmtBytes(sv.disk_used) + ' / ' + fmtBytes(sv.disk_total));
  }
  var tb = $('containers');
  tb.innerHTML = (s.containers || []).map(function (c) {
    return '<tr><td>' + esc(c.name) + '</td><td class="muted">' + esc(c.status) + '</td><td class="num">' + esc(c.cpu) + '</td><td class="num">' + esc(c.mem) + '</td></tr>';
  }).join('') || '<tr><td colspan="4" class="muted">暂无</td></tr>';

  var owners = s.owners || [];
  $('ownerStrip').innerHTML = '<div class="muted" style="margin-bottom:8px">主人</div>' + (owners.length
    ? '<div class="row wrap">' + owners.map(function (o) {
        return '<span class="chip p"><img src="' + avatarUrl(o.id) + '" alt="" style="width:20px;height:20px;border-radius:50%" onerror="this.style.display=\'none\'">' + esc(o.name) + '</span>';
      }).join('') + '</div>'
    : '<div class="muted">未设置（右上角设置 → 主人）</div>');

  if (s.tokens) renderTokens(s.tokens);
  $('latencyList').innerHTML = lat.length ? lat.slice(0, 8).map(function (x) {
    return '<div class="row" style="padding:6px 0"><span class="chip">' + fmtMs(x.ms) + '</span><span class="muted">' + esc(x.model || '') + '</span><div class="spacer"></div><span class="muted">' + (x.out || 0) + ' tokens</span></div>';
  }).join('') : '<div class="empty">暂无数据</div>';

  var qrBox = $('qrBox'), qrImg = $('qrImg');
  if (qrBox && qrImg) {
    if (!online) {
      qrBox.style.display = 'block';
      if (!qrBox._t) {
        qrImg.src = '/api/qq/qr?t=' + Date.now();
        qrBox._t = setInterval(function () { qrImg.src = '/api/qq/qr?t=' + Date.now(); }, 6000);
      }
    } else {
      qrBox.style.display = 'none';
      if (qrBox._t) { clearInterval(qrBox._t); qrBox._t = null; }
    }
  }

  renderPlugins(s.plugins);
  loadPluginSettings(s.plugins);
  renderPersonas(s.personas);
  if (!vncInit && s.novnc) { $('vncFrame').dataset.src = s.novnc; }
}

function eyeIcon() { return '<svg class="ic" style="width:18px;height:18px"><use href="' + (IP_HIDDEN ? '#i-eye-off' : '#i-eye') + '"/></svg>'; }
function toggleIp() {
  IP_HIDDEN = !IP_HIDDEN;
  localStorage.setItem('bp_ip_hidden', IP_HIDDEN ? '1' : '0');
  document.querySelectorAll('.ip-eye').forEach(function (b) { b.innerHTML = eyeIcon(); });
  if (state && state.server) {
    $('ipPublic').textContent = maskIp(state.host);
    $('ipPrivate').textContent = maskIp(state.server.ip);
  }
}

function renderTokens(t) {
  var box = $('tokStats');
  if (!box) return;
  function k(n) { return n >= 1000000 ? (n / 1000000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0); }
  box.innerHTML =
    '<div class="stat"><div class="v">' + k(t.today_in) + '</div><div class="l">今日输入 tokens</div></div>'
    + '<div class="stat"><div class="v">' + k(t.today_out) + '</div><div class="l">今日输出 tokens</div></div>'
    + '<div class="stat"><div class="v">' + k(t.total_in + t.total_out) + '</div><div class="l">累计 tokens</div></div>'
    + '<div class="stat"><div class="v">' + (t.today_calls || 0) + '</div><div class="l">今日调用次数</div></div>';
  $('tokHint').textContent = t.today_calls ? '今日 ' + (t.today_in + t.today_out).toLocaleString() + ' tokens' : '';
  var days = t.days || [];
  var max = 1;
  days.forEach(function (d) { max = Math.max(max, d.in + d.out); });
  $('tokBars').innerHTML = days.map(function (d) {
    var total = d.in + d.out;
    var h = Math.max(2, Math.round(total / max * 90));
    var hi = total ? Math.round(d.in / total * h) : 0;
    return '<div class="tok-bar" title="' + d.day + ' · 输入 ' + d.in + ' / 输出 ' + d.out + '">'
      + '<div class="seg-out" style="height:' + Math.max(1, h - hi) + 'px"></div>'
      + '<div class="seg-in" style="height:' + hi + 'px"></div>'
      + '<span class="d">' + esc(d.day) + '</span></div>';
  }).join('');
  var models = t.models || [];
  $('tokModels').innerHTML = models.length
    ? '<table><thead><tr><th>模型</th><th>调用</th><th>输入</th><th>输出</th></tr></thead><tbody>'
      + models.map(function (m) {
          return '<tr><td>' + esc(m.model) + '</td><td class="num">' + m.calls + '</td><td class="num">' + k(m.in) + '</td><td class="num">' + k(m.out) + '</td></tr>';
        }).join('') + '</tbody></table>'
    : '<div class="empty">暂无模型调用记录</div>';
}

function renderPlugins(list) {
  $('pluginList').innerHTML = (list && list.length) ? list.map(function (p) {
    var init = esc((p.display || p.name || 'P').slice(0, 1).toUpperCase());
    var icon = p.logo
      ? '<img src="/api/plugin/logo?name=' + encodeURIComponent(p.name) + '" alt="" data-letter="' + init + '">'
      : init;
    var acts = '<div class="row wrap" style="margin-top:8px;gap:6px">'
      + '<span class="tag ' + (p.activated ? 'ok' : '') + '">' + (p.activated ? '已启用' : '未启用') + '</span>'
      + '<span class="tag doc">' + (p.reserved ? '内置' : '第三方') + '</span>'
      + '<span class="tag">' + esc(p.author || '—') + '</span>'
      + (p.reserved ? '' :
          '<button class="btn text sm" data-pupdate="' + esc(p.name) + '">更新</button>'
        + '<button class="btn text sm" data-puninstall="' + esc(p.name) + '">卸载</button>')
      + '</div>';
    return '<div class="item"><div class="avatar-box">' + icon + '</div>'
      + '<div class="body"><div class="name">' + esc(p.display || p.name) + ' <span class="muted">v' + esc(p.version) + '</span></div>'
      + '<div class="desc">' + esc(p.desc || '') + '</div>'
      + acts
      + '</div></div>';
  }).join('') : '<div class="empty">暂无插件</div>';
  document.querySelectorAll('#pluginList .avatar-box img').forEach(function (img) {
    function bad() { if (img.parentNode) img.parentNode.textContent = img.dataset.letter || '?'; }
    if (img.complete && img.naturalWidth === 0) bad();
    else img.addEventListener('error', bad);
    setTimeout(function () { if (img.parentNode && (!img.complete || img.naturalWidth === 0)) bad(); }, 5000);
  });

  document.querySelectorAll('[data-puninstall]').forEach(function (b) {
    b.addEventListener('click', function () {
      var name = b.dataset.puninstall;
      openDialog('<h3>卸载 ' + esc(name) + '？</h3><div class="muted" style="margin:8px 0 18px">'
        + '插件目录与其配置将被删除，不可恢复。卸载后需重启 AstrBot 生效。</div>'
        + '<div class="row" style="justify-content:flex-end;gap:10px"><button class="btn text" id="puCancel">取消</button>'
        + '<button class="btn filled" id="puOk">卸载</button></div>');
      $('puCancel').onclick = closeDialog;
      $('puOk').onclick = function () {
        closeDialog(); b.disabled = true;
        api('/api/plugin/uninstall', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugin_id: name }) })
          .then(function (r) {
            snack(r.ok ? '已卸载，建议重启 AstrBot' : '卸载失败：' + (r.error || r.message || ''));
            tick(true);
          }).catch(function () { snack('卸载失败'); b.disabled = false; });
      };
    });
  });

  document.querySelectorAll('[data-pupdate]').forEach(function (b) {
    b.addEventListener('click', function () {
      var name = b.dataset.pupdate;
      b.disabled = true; snack('正在更新 ' + name + '…');
      api('/api/plugin/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plugins: [name] }) })
        .then(function (r) {
          snack(r.ok ? '已更新，建议重启 AstrBot' : '更新失败：' + (r.error || r.message || ''));
          tick(true);
        }).catch(function () { snack('更新失败'); b.disabled = false; });
    });
  });
}

/* ---- 插件设置（按插件自带的 _conf_schema.json 动态生成） ---- */
var pluginSchemas = {};
function loadPluginSettings(list) {
  var box = $('pluginSettings');
  if (!box) return;
  var plugins = (list || []).slice(0, 30);
  if (!plugins.length) { box.innerHTML = '<div class="empty">暂无插件</div>'; return; }
  Promise.all(plugins.map(function (p) {
    if (pluginSchemas[p.name]) return Promise.resolve({ p: p, r: pluginSchemas[p.name] });
    return api('/api/plugin/schema?id=' + encodeURIComponent(p.name))
      .then(function (r) { pluginSchemas[p.name] = r; return { p: p, r: r }; })
      .catch(function () { return { p: p, r: null }; });
  })).then(function (rows) {
    var withCfg = rows.filter(function (x) { return x.r && x.r.ok && x.r.data && x.r.data.metadata; });
    if (!withCfg.length) {
      box.innerHTML = '<div class="empty">当前插件都没有可配置项（插件带 _conf_schema.json 时才会出现）</div>';
      return;
    }
    box.innerHTML = withCfg.map(function (x) {
      var meta = x.r.data.metadata[x.p.name] || {};
      var n = Object.keys(meta.items || {}).length;
      var init = esc((x.p.display || x.p.name || 'P').slice(0, 1).toUpperCase());
      var icon = x.p.logo
        ? '<img src="/api/plugin/logo?name=' + encodeURIComponent(x.p.name) + '" alt="" data-letter="' + init + '">'
        : '<svg class="ic"><use href="#i-plugin"/></svg>';
      return '<div class="item"><div class="avatar-box">' + icon + '</div>'
        + '<div class="body"><div class="name">' + esc(x.p.display || x.p.name) + '</div>'
        + '<div class="desc">' + n + ' 项配置 · ' + esc(meta.description || '') + '</div>'
        + '<div class="row" style="margin-top:8px"><button class="btn tonal sm" data-plug-cfg="' + esc(x.p.name) + '">打开设置</button></div></div></div>';
    }).join('');
    box.querySelectorAll('.avatar-box img').forEach(function (img) {
      function bad() { if (img.parentNode) img.parentNode.innerHTML = '<svg class="ic"><use href="#i-plugin"/></svg>'; }
      if (img.complete && img.naturalWidth === 0) bad();
      else img.addEventListener('error', bad);
      setTimeout(function () { if (img.parentNode && (!img.complete || img.naturalWidth === 0)) bad(); }, 5000);
    });
    box.querySelectorAll('[data-plug-cfg]').forEach(function (b) {
      b.addEventListener('click', function () { openPluginConfig(b.dataset.plugCfg); });
    });
  });
}

/* ===== 插件配置：按 AstrBot schema 递归渲染（支持嵌套 object / list / select_provider） ===== */
var PC_PROVIDERS = null;
function pcProviders() {
  if (PC_PROVIDERS) return Promise.resolve(PC_PROVIDERS);
  return api('/api/providers').then(function (r) {
    PC_PROVIDERS = (r && r.providers) || [];
    return PC_PROVIDERS;
  }).catch(function () { PC_PROVIDERS = []; return []; });
}
function pcOptList(spec) {
  var o = spec.options || [];
  return o.map(function (x) {
    if (x && typeof x === 'object') return { v: x.value !== undefined ? x.value : String(x), l: x.label || x.text || String(x.value) };
    return { v: x, l: String(x) };
  });
}
function pcField(path, key, spec, val, depth, providerOpts) {
  var t = (spec.type || 'string').toLowerCase();
  var v = val !== undefined && val !== null ? val : spec.default;
  var desc = esc(spec.description || key);
  var hint = spec.hint ? '<div class="cfg-hint">' + esc(spec.hint) + '</div>' : '';
  var sp = spec._special || '';
  var pathAttr = 'data-path="' + esc(path) + '"';

  if (t === 'object' && spec.items && Object.keys(spec.items).length) {
    var inner = Object.keys(spec.items).map(function (k) {
      return pcField(path + '.' + k, k, spec.items[k], (val || {})[k], depth + 1, providerOpts);
    }).join('');
    return '<div class="cfg-group" style="margin-left:' + (depth ? 10 : 0) + 'px">'
      + '<div class="cfg-title">' + desc + '</div>' + hint + inner + '</div>';
  }
  if (sp.indexOf('select_provider') === 0) {
    var opts = '<option value="">（默认 / 不指定）</option>' + providerOpts.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (String(p.id) === String(v) ? ' selected' : '') + '>' + esc(p.id + (p.model && p.model !== p.id ? ' · ' + p.model : '')) + '</option>';
    }).join('');
    return '<div class="cfg-field"><div class="cfg-label">' + desc + '</div>' + hint
      + '<select class="field" ' + pathAttr + ' data-kind="string">' + opts + '</select></div>';
  }
  if (spec.options && spec.options.length) {
    var ol = pcOptList(spec).map(function (o) {
      return '<option value="' + esc(o.v) + '"' + (String(o.v) === String(v) ? ' selected' : '') + '>' + esc(o.l) + '</option>';
    }).join('');
    return '<div class="cfg-field"><div class="cfg-label">' + desc + '</div>' + hint
      + '<select class="field" ' + pathAttr + ' data-kind="' + (t === 'int' || t === 'float' ? 'number' : 'string') + '">' + ol + '</select></div>';
  }
  if (t === 'bool') {
    return '<div class="cfg-row"><div style="min-width:0"><div class="cfg-label">' + desc + '</div>' + hint + '</div>'
      + '<button class="tgl ' + (v ? 'on' : '') + '" ' + pathAttr + ' data-kind="bool"></button></div>';
  }
  if (t === 'int' || t === 'float') {
    var sl = spec.slider || {};
    var min = sl.min !== undefined ? sl.min : '', max = sl.max !== undefined ? sl.max : '', step = sl.step !== undefined ? sl.step : (t === 'int' ? 1 : 0.1);
    return '<div class="cfg-field"><div class="cfg-label">' + desc + '</div>' + hint
      + '<div class="row" style="gap:10px"><input class="field" type="range" style="flex:1" min="' + min + '" max="' + max + '" step="' + step + '" value="' + esc(v === undefined ? 0 : v) + '" ' + pathAttr + ' data-kind="range">'
      + '<input class="field" type="number" style="width:96px" step="' + step + '" value="' + esc(v === undefined ? 0 : v) + '" data-pair="' + esc(path) + '" data-kind="number"></div></div>';
  }
  if (t === 'text') {
    return '<div class="cfg-field"><div class="cfg-label">' + desc + '</div>' + hint
      + '<textarea class="field" style="min-height:90px" ' + pathAttr + ' data-kind="string">' + esc(v === undefined ? '' : v) + '</textarea></div>';
  }
  if (t === 'list') {
    var it = spec.items || {};
    var itType = (it.type || 'string').toLowerCase();
    var arr = Array.isArray(v) ? v : [];
    if (itType === 'string' || itType === 'int' || itType === 'float') {
      var txt = arr.map(function (x) { return typeof x === 'object' ? JSON.stringify(x) : String(x); }).join('\n');
      return '<div class="cfg-field"><div class="cfg-label">' + desc + '</div>' + hint
        + '<div class="cfg-hint">每行一项</div><textarea class="field" style="min-height:90px;font-family:Consolas,monospace" ' + pathAttr + ' data-kind="lines" data-item="' + itType + '">' + esc(txt) + '</textarea></div>';
    }
    return '<div class="cfg-field"><div class="cfg-label">' + desc + '</div>' + hint
      + '<textarea class="field" style="min-height:110px;font-family:Consolas,monospace" ' + pathAttr + ' data-kind="json">' + esc(JSON.stringify(arr, null, 2)) + '</textarea></div>';
  }
  if (t === 'dict' || (t === 'object' && !(spec.items && Object.keys(spec.items).length))) {
    return '<div class="cfg-field"><div class="cfg-label">' + desc + '</div>' + hint
      + '<textarea class="field" style="min-height:100px;font-family:Consolas,monospace" ' + pathAttr + ' data-kind="json">' + esc(JSON.stringify(v === undefined ? {} : v, null, 2)) + '</textarea></div>';
  }
  return '<div class="cfg-field"><div class="cfg-label">' + desc + '</div>' + hint
    + '<input class="field" ' + pathAttr + ' data-kind="string" value="' + esc(v === undefined ? '' : v) + '"></div>';
}

function pcCollect() {
  var out = {};
  function setPath(obj, path, value) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  document.querySelectorAll('#dlgBody [data-kind][data-path]').forEach(function (el) {
    var kind = el.dataset.kind, path = el.dataset.path;
    if (kind === 'bool') setPath(out, path, el.classList.contains('on'));
    else if (kind === 'number') setPath(out, path, el.value === '' ? 0 : Number(el.value));
    else if (kind === 'lines') {
      var lines = el.value.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
      if (el.dataset.item === 'int') lines = lines.map(function (s) { return parseInt(s, 10) || 0; });
      else if (el.dataset.item === 'float') lines = lines.map(function (s) { return parseFloat(s) || 0; });
      setPath(out, path, lines);
    } else if (kind === 'json') setPath(out, path, JSON.parse(el.value || 'null'));
    else setPath(out, path, el.value);
  });
  return out;
}

function openPluginConfig(pid) {
  var r = pluginSchemas[pid];
  if (!r || !r.ok || !r.data) { snack('配置读取失败'); return; }
  var meta = r.data.metadata[pid] || { items: {} };
  var cfg = r.data.config || {};
  var items = meta.items || {};
  var keys = Object.keys(items);
  if (!keys.length) { snack('该插件没有可配置项'); return; }
  pcProviders().then(function (provs) {
    var body = keys.map(function (k) { return pcField(k, k, items[k], cfg[k], 0, provs); }).join('');
    openDialog('<h3>' + esc(pid) + '</h3><div class="muted" style="margin:4px 0 12px">配置来自插件自带的 schema；保存后自动热重载</div>'
      + '<div class="cfg-wrap">' + body + '</div>'
      + '<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn text" id="pcCancel">取消</button>'
      + '<button class="btn filled" id="pcSave">保存</button></div>');
    document.querySelectorAll('#dlgBody [data-kind="bool"]').forEach(function (b) {
      b.addEventListener('click', function () { b.classList.toggle('on'); });
    });
    document.querySelectorAll('#dlgBody [data-kind="range"]').forEach(function (rg) {
      var num = document.querySelector('#dlgBody [data-pair="' + rg.dataset.path + '"]');
      if (!num) return;
      rg.addEventListener('input', function () { num.value = rg.value; });
      num.addEventListener('input', function () { rg.value = num.value; });
    });
    $('pcCancel').onclick = closeDialog;
    $('pcSave').onclick = function () {
      var out;
      try { out = pcCollect(); } catch (e) { snack('JSON 格式不对：' + e.message); return; }
      snack('保存中…');
      api('/api/plugin/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: pid, config: out }) })
        .then(function (res) {
          if (!res.ok) { snack('保存失败：' + (res.error || res.message || '')); return; }
          snack('已保存，正在重载插件…');
          return api('/api/plugin/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: pid }) })
            .then(function () { closeDialog(); pluginSchemas = {}; tick(true); snack('已保存并重载'); });
        })
        .catch(function () { snack('保存失败'); });
    };
  });
}

function renderPersonas(list) {
  var box = $('personaList');
  box.innerHTML = (list && list.length) ? list.map(function (p) {
    return '<div class="item" data-persona="' + esc(p.id) + '" style="cursor:pointer">'
      + '<div class="avatar-box"><svg class="ic"><use href="#i-person"/></svg></div>'
      + '<div class="body"><div class="name">' + esc(p.id) + '</div><div class="desc">' + esc((p.prompt || '').slice(0, 90)) + '</div>'
      + '<div class="row" style="margin-top:8px"><button class="btn tonal sm" data-default="' + esc(p.id) + '">设为默认人格</button></div></div></div>';
  }).join('') : '<div class="empty">暂无</div>';
  document.querySelectorAll('[data-persona]').forEach(function (el) {
    el.addEventListener('click', function () {
      var p = (state.personas || []).find(function (x) { return x.id === el.dataset.persona; });
      if (!p) return;
      curPersona = p; $('personaPrompt').value = p.prompt || ''; $('personaName').textContent = p.id;
      document.querySelectorAll('[data-persona]').forEach(function (x) { x.style.outline = ''; });
      el.style.outline = '1px solid var(--p)';
    });
  });
  document.querySelectorAll('[data-default]').forEach(function (b) {
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var pid = b.dataset.default;
      snack('正在设为默认人格（AstrBot 会重启）…');
      api('/api/persona/default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona_id: pid }) })
        .then(function (r) { snack(r.ok ? '已设为默认：' + pid : '失败：' + (r.error || '')); if (r.ok) tick(true); });
    });
  });
}

function tick(force) {
  if (!force && tick._busy) return;
  tick._busy = true;
  api('/api/status').then(function (s) { render(s); }).catch(function () { }).then(function () { tick._busy = false; });
}

/* ---------------- 日志 ---------------- */
function levelMatch(line) {
  if (logLevel === 'all') return true;
  var L = line.toLowerCase();
  if (logLevel === 'info') return L.indexOf('info') >= 0 || L.indexOf(' ok ') >= 0 || L.indexOf('[ok]') >= 0;
  if (logLevel === 'warn') return L.indexOf('warn') >= 0;
  if (logLevel === 'error') return L.indexOf('error') >= 0 || L.indexOf('traceback') >= 0 || L.indexOf('exception') >= 0 || L.indexOf('critical') >= 0;
  return true;
}
function logClass(line) {
  var L = line.toLowerCase();
  if (L.indexOf('error') >= 0 || L.indexOf('critical') >= 0 || L.indexOf('traceback') >= 0 || L.indexOf('exception') >= 0) return 'lv-err';
  if (L.indexOf('warn') >= 0) return 'lv-warn';
  if (L.indexOf(' ok ') >= 0 || L.indexOf('[ok]') >= 0) return 'lv-ok';
  return '';
}
function loadLogs(force) {
  if (logPaused && !force) return;
  if (logBusy && !force) return;
  logBusy = true;
  var n = parseInt($('logLines').value, 10) || 300;
  api('/api/logs?src=' + logSrc + '&n=' + n).then(function (r) {
    logLinesData = (r.text || '').split('\n');
    paintLogs();
  }).catch(function () { }).then(function () { logBusy = false; });
}
function colorLine(line) {
  var h = esc(line);
  h = h.replace(/^(\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\])/, '<span class="lts">$1</span>');
  h = h.replace(/\[(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL|CRITICAL|OK)\]/g, function (m, lv) {
    var key = lv.toLowerCase().replace('warning', 'warn').replace('critical', 'fatal');
    return '<span class="lv-' + key + '">[' + lv + ']</span>';
  });
  return h;
}
function paintLogs() {
  var pre = $('logBox');
  var kw = $('logFilter').value.trim().toLowerCase();
  var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
  var lines = logLinesData.filter(function (l) {
    if (!levelMatch(l)) return false;
    if (kw && l.toLowerCase().indexOf(kw) < 0) return false;
    return true;
  });
  $('logCount').textContent = lines.length + ' 行';
  pre.dataset.logtheme = logTheme;
  var html = lines.map(colorLine).join('\n');
  pre.innerHTML = html || '(无日志)';
  if (firstLog || (atBottom && !logPaused)) { pre.scrollTop = pre.scrollHeight; firstLog = false; }
}
$('logFilter').addEventListener('input', paintLogs);
document.querySelectorAll('#logSeg button').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('#logSeg button').forEach(function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    var wasLive = !!logES;
    if (wasLive) stopLogStream(true);
    logSrc = b.dataset.src;
    loadLogs(true);
    if (wasLive) setTimeout(startLogStream, 300);
  });
});
document.querySelectorAll('#levelSeg button').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('#levelSeg button').forEach(function (x) { x.classList.remove('on'); });
    b.classList.add('on'); logLevel = b.dataset.level; paintLogs();
  });
});
$('logLines').addEventListener('change', function () { loadLogs(true); });
$('btnLogRefresh').addEventListener('click', function () { loadLogs(true); });

/* ---- 实时流（SSE）：docker logs --follow 推到浏览器 ---- */
var logES = null;            // EventSource 句柄
var logLiveCap = 2000;       // 内存里最多保留多少行，防手机内存爆掉

function stopLogStream(silent) {
  if (logES) {
    try { logES.close(); } catch (e) {}
    logES = null;
  }
  var b = $('btnLive');
  if (b) {
    b.classList.remove('on');
    b.innerHTML = '<svg class="ic"><use href="#i-play"/></svg>';
    b.title = '实时流（自动跟随）';
  }
  if (!silent) snack('已停止实时流');
}
function startLogStream() {
  stopLogStream(true);
  var b = $('btnLive');
  b.classList.add('on');
  b.innerHTML = '<svg class="ic"><use href="#i-pause"/></svg>';
  b.title = '停止实时流';
  // 先取一屏历史，再开始跟随
  loadLogs(true);
  try {
    logES = new EventSource('/api/logs/stream?src=' + encodeURIComponent(logSrc) + '&tail=60');
  } catch (e) {
    snack('浏览器不支持实时流'); stopLogStream(true); return;
  }
  logES.onmessage = function (ev) {
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'line') {
      logLinesData.push(m.text);
      if (logLinesData.length > logLiveCap) logLinesData = logLinesData.slice(-logLiveCap);
      if (!logPaused && curTab === 'logs') paintLogs();
    } else if (m.type === 'closed') {
      snack('日志流已结束（容器可能重启了）');
      stopLogStream(true);
    } else if (m.type === 'error') {
      snack('实时流出错：' + (m.message || '')); stopLogStream(true);
    }
  };
  logES.onerror = function () {
    // EventSource 会自动重连；只有关闭状态才真正停掉，避免刷屏
    if (logES && logES.readyState === 2) {
      snack('实时流断开'); stopLogStream(true);
    }
  };
}
$('btnLive') && $('btnLive').addEventListener('click', function () {
  if (logES) { stopLogStream(); } else { startLogStream(); }
});
$('btnPause').addEventListener('click', function () {
  logPaused = !logPaused;
  this.innerHTML = '<svg class="ic"><use href="' + (logPaused ? '#i-play' : '#i-pause') + '"/></svg>';
  snack(logPaused ? '已暂停自动刷新' : '已恢复自动刷新');
});
$('btnLogDownload').addEventListener('click', function () {
  var lines = logLinesData.filter(function (l) { return levelMatch(l); });
  var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = logSrc + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.log';
  a.click(); URL.revokeObjectURL(a.href);
});

/* ---------------- 远程桌面 ---------------- */
var vncInit = false;
function initVnc() {
  var src = (state && state.novnc) || $('vncFrame').dataset.src || '';
  if (!src) return;
  if (!vncInit) { $('vncFrame').src = src; vncInit = true; }
  $('btnVncOpen').onclick = function () { window.open(src, '_blank'); };
  $('btnVncReload').onclick = function () { $('vncFrame').src = src + '&t=' + Date.now(); };
}

/* ---------------- 市场（AstrBot 官方插件市场） ---------------- */
var mkState = { cat: '', sort: 'stars', page: 1, pages: 1, total: 0 };
function loadMarket(force) {
  var q = $('mkQuery').value.trim();
  var url = '/api/market?q=' + encodeURIComponent(q)
    + '&cat=' + encodeURIComponent(mkState.cat)
    + '&sort=' + encodeURIComponent(mkState.sort)
    + '&page=' + mkState.page + '&n=24'
    + (force ? '&force=1' : '');
  api(url).then(function (r) {
    if (!r.ok) { $('mkList').innerHTML = '<div class="empty" style="grid-column:1/-1">' + esc(r.error || '市场加载失败') + '</div>'; return; }
    mkState.pages = r.pages || 1;
    mkState.page = r.page || 1;
    mkState.total = r.total || 0;
    $('mkCount').textContent = '匹配 ' + r.total + ' / 共 ' + r.all + ' 个';
    renderCats(r.cats || []);
    renderMarket(r.items || []);
    renderPager();
  }).catch(function () { $('mkList').innerHTML = '<div class="empty" style="grid-column:1/-1">加载失败</div>'; });
}
function renderCats(cats) {
  var box = $('mkCats');
  if (!box) return;
  var total = cats.reduce(function (a, c) { return a + c.count; }, 0);
  var html = [{ name: '', label: '全部', count: total }].concat(cats.map(function (c) {
    return { name: c.name, label: c.name, count: c.count };
  })).map(function (c) {
    var on = (mkState.cat || '') === (c.name || '');
    return '<button class="chip' + (on ? ' ok' : ' outline') + '" data-cat="' + esc(c.name) + '" style="cursor:pointer;margin:0 6px 6px 0;border:0">'
      + esc(c.label) + ' <span style="opacity:.6">' + c.count + '</span></button>';
  }).join('');
  box.innerHTML = html;
  box.querySelectorAll('[data-cat]').forEach(function (b) {
    b.addEventListener('click', function () {
      mkState.cat = b.dataset.cat || '';
      mkState.page = 1;
      loadMarket(false);
    });
  });
}
function renderPager() {
  var p = $('mkPager');
  if (!p) return;
  if (mkState.pages <= 1) { p.style.display = 'none'; return; }
  p.style.display = '';
  $('mkPageInfo').textContent = '第 ' + mkState.page + ' / ' + mkState.pages + ' 页';
  $('mkPrev').disabled = mkState.page <= 1;
  $('mkNext').disabled = mkState.page >= mkState.pages;
}
$('mkSort') && $('mkSort').addEventListener('change', function () {
  mkState.sort = $('mkSort').value || 'stars';
  mkState.page = 1;
  loadMarket(false);
});
$('mkPrev') && $('mkPrev').addEventListener('click', function () {
  if (mkState.page > 1) { mkState.page--; loadMarket(false); }
});
$('mkNext') && $('mkNext').addEventListener('click', function () {
  if (mkState.page < mkState.pages) { mkState.page++; loadMarket(false); }
});
function restartAstrBot() {
  snack('正在重启 AstrBot…');
  api('/api/service/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'astrbot' }) })
    .then(function (res) { snack(res.ok ? 'AstrBot 已重启' : '失败：' + (res.error || '')); setTimeout(function () { tick(true); }, 5000); });
}
function kbFmt(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round((n || 0) / 1024) + ' KB'; }
function startInstall(p, btn) {
  openDialog('<h3>安装 ' + esc(p.display || p.name) + '</h3>'
    + '<div class="muted" id="ipMsg" style="margin:6px 0 4px">准备下载…</div>'
    + '<div class="bar" style="margin-top:14px"><i id="ipBar" style="width:0%"></i></div>'
    + '<div class="row" style="margin-top:6px"><span class="muted" id="ipPct">0%</span><div class="spacer"></div><span class="muted" id="ipSize"></span></div>'
    + '<div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn text" id="ipClose">关闭</button><button class="btn filled" id="ipRestart" style="display:none">重启 AstrBot</button></div>');
  var timer = null, finished = false;
  function stop(ok) {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    if (ok) { tick(true); setTimeout(loadMarket, 1200); }
  }
  $('ipClose').onclick = function () { if (!finished) snack('安装还在后台继续'); closeDialog(); };
  $('ipRestart').onclick = function () { closeDialog(); restartAstrBot(); };
  api('/api/market/install-start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id }) })
    .then(function (r) {
      if (!r.ok) { $('ipMsg').textContent = '启动安装失败：' + (r.error || ''); if (btn) btn.disabled = false; stop(false); return; }
      var token = r.token;
      timer = setInterval(function () {
        api('/api/market/install-status?token=' + encodeURIComponent(token)).then(function (s) {
          if (!s.ok || !s.job) return;
          var job = s.job, pct = job.percent || 0;
          $('ipBar').style.width = pct + '%';
          $('ipPct').textContent = pct + '%';
          $('ipMsg').textContent = job.msg || '';
          if (job.total) $('ipSize').textContent = kbFmt(job.received || 0) + ' / ' + kbFmt(job.total);
          else if (job.received) $('ipSize').textContent = kbFmt(job.received || 0);
          if (job.state === 'done') {
            $('ipBar').style.width = '100%'; $('ipMsg').textContent = '安装完成';
            $('ipRestart').style.display = ''; $('ipClose').textContent = '完成';
            stop(true);
          } else if (job.state === 'error') {
            $('ipMsg').textContent = '失败：' + (job.msg || '');
            $('ipBar').classList.add('hot');
            if (btn) btn.disabled = false;
            stop(false);
          }
        }).catch(function () {});
      }, 700);
    })
    .catch(function () { $('ipMsg').textContent = '启动安装失败'; stop(false); });
}
function installedNames() {
  return (state && state.plugins || []).map(function (p) { return p.name; });
}
function renderMarket(items) {
  if (!items || !items.length) { $('mkList').innerHTML = '<div class="empty" style="grid-column:1/-1">没有匹配的插件</div>'; return; }
  var have = installedNames();
  $('mkList').innerHTML = items.map(function (p, i) {
    var init = esc((p.display || p.name || 'P').slice(0, 1).toUpperCase());
    var iconHtml = p.icon
      ? '<img src="' + esc(p.icon) + '" loading="lazy" referrerpolicy="no-referrer" alt="" data-letter="' + init + '">'
      : init;
    var isIn = have.indexOf(p.name) >= 0;
    return '<div class="mk" style="animation-delay:' + Math.min(i * 20, 320) + 'ms">'
      + '<div class="head"><div class="icon">' + iconHtml + '</div><div style="min-width:0;flex:1">'
      + '<h3>' + esc(p.display || p.name) + '</h3><div class="pkg">' + esc(p.id) + '</div></div>'
      + (isIn ? '<span class="chip ok">已安装</span>' : '<span class="chip">' + esc(p.version ? 'v' + p.version : '插件') + '</span>')
      + '</div>'
      + '<div class="desc">' + esc(p.desc || '') + '</div>'
      + '<div class="meta-row">'
      + '<span class="chip outline">' + esc(p.author || '未知作者') + '</span>'
      + (p.version ? '<span class="chip outline">v' + esc(p.version) + '</span>' : '')
      + (p.repo ? '<a class="chip outline" href="' + esc(p.repo) + '" target="_blank" rel="noreferrer">GitHub</a>' : '')
      + '</div>'
      + '<div class="acts">'
      + (isIn ? '<button class="btn text sm" disabled>已安装</button>'
              : '<button class="btn filled sm" data-install="' + i + '"><svg class="ic" style="width:16px;height:16px"><use href="#i-download"/></svg>安装</button>')
      + '<button class="btn text sm" data-copyrepo="' + i + '">复制仓库地址</button>'
      + '</div></div>';
  }).join('');
  document.querySelectorAll('[data-install]').forEach(function (b) {
    b.addEventListener('click', function () {
      var p = items[+b.dataset.install];
      openDialog('<h3>安装 ' + esc(p.display || p.name) + '？</h3><div class="muted" style="margin:8px 0 18px">会从 GitHub 拉取并安装到服务器上的 AstrBot，可能需要几十秒。</div>'
        + '<div class="row" style="justify-content:flex-end;gap:10px"><button class="btn text" id="miCancel">取消</button><button class="btn filled" id="miOk">安装</button></div>');
      $('miCancel').onclick = closeDialog;
      $('miOk').onclick = function () { closeDialog(); b.disabled = true; startInstall(p, b); };
    });
  });
  document.querySelectorAll('#mkList .icon img').forEach(function (img) {
    function bad() { if (img.parentNode) img.parentNode.textContent = img.dataset.letter || '?'; }
    if (img.complete && img.naturalWidth === 0) bad();
    else img.addEventListener('error', bad);
    setTimeout(function () { if (img.parentNode && (!img.complete || img.naturalWidth === 0)) bad(); }, 6000);
  });
  document.querySelectorAll('[data-copyrepo]').forEach(function (b) {
    b.addEventListener('click', function () { copyText(items[+b.dataset.copyrepo].repo || ''); });
  });
}
var mkT = null;
$('mkQuery').addEventListener('input', function () { clearTimeout(mkT); mkT = setTimeout(function () { mkState.page = 1; loadMarket(); }, 350); });
$('mkRefresh') && $('mkRefresh').addEventListener('click', function () { snack('刷新市场中…'); mkState.page = 1; loadMarket(true); });


/* ---------------- 学习 / 知识库 ---------------- */
function kbIcon(ext) {
  var map = { '.docx': 'DOC', '.pptx': 'PPT', '.xlsx': 'XLS', '.pdf': 'PDF', '.html': 'HTM', '.htm': 'HTM', '.md': 'MD', '.txt': 'TXT', '.csv': 'CSV', '.json': 'JSON' };
  return map[ext] || 'TXT';
}
var kbState = { id: '', list: [], embeddings: [] };

function loadKnowledge() {
  api('/api/knowledge').then(function (r) {
    var items = r.items || [];
    kbState.list = items;
    kbState.embeddings = r.embeddings || [];
    var sel = $('kbSelect');
    if (sel) {
      sel.innerHTML = items.length
        ? items.map(function (k) {
            return '<option value="' + esc(k.kb_id) + '"' + (kbState.id === k.kb_id ? ' selected' : '') + '>'
              + esc((k.emoji ? k.emoji + ' ' : '') + k.name) + '（' + k.docs + ' 文档 / ' + k.chunks + ' 段）</option>';
          }).join('')
        : '<option value="">还没有知识库</option>';
      if (!kbState.id && items.length) kbState.id = items[0].kb_id;
      if (kbState.id && !items.some(function (k) { return k.kb_id === kbState.id; })) {
        kbState.id = items.length ? items[0].kb_id : '';
      }
      sel.value = kbState.id;
    }
    var hint = $('kbHint');
    if (hint) {
      if (!kbState.embeddings.length) {
        hint.innerHTML = '⚠️ 还没接入向量模型，知识库暂时建不了。请在下面「向量模型」里填好并保存。';
      } else if (!items.length) {
        hint.textContent = '向量模型已就绪（' + kbState.embeddings.join('、') + '），可以新建知识库并上传文档了。';
      } else {
        hint.textContent = '向量模型：' + kbState.embeddings.join('、') + '；当前知识库：' + items.length + ' 个。';
      }
    }
    if (typeof kbRefreshEmbCard === 'function') kbRefreshEmbCard();
    loadKbDocs();
  }).catch(function () {
    if ($('kbList')) $('kbList').innerHTML = '<div class="empty">加载失败</div>';
  });
}

function loadKbDocs() {
  var box = $('kbList');
  if (!box) return;
  if (!kbState.id) {
    box.innerHTML = '<div class="empty">还没有知识库，先在上面点「新建知识库」</div>';
    if ($('kbCount')) $('kbCount').textContent = '';
    return;
  }
  box.innerHTML = '<div class="empty">加载中…</div>';
  api('/api/knowledge/docs?kb_id=' + encodeURIComponent(kbState.id)).then(function (r) {
    var items = r.items || [];
    if ($('kbCount')) $('kbCount').textContent = items.length + ' 份文档';
    box.innerHTML = items.length ? items.map(function (it) {
      var ext = '.' + (it.file_type || 'txt').toLowerCase();
      return '<div class="item"><div class="avatar-box" style="font-size:11px">' + kbIcon(ext) + '</div>'
        + '<div class="body"><div class="name">' + esc(it.doc_name) + '</div>'
        + '<div class="desc">' + (it.chunk_count || 0) + ' 段 · ' + fmtBytes(it.file_size || 0) + '</div>'
        + '<div class="row wrap" style="margin-top:8px">'
        + '<button class="btn text sm" data-doc-del="' + esc(it.doc_id) + '">删除</button>'
        + '</div></div></div>';
    }).join('') : '<div class="empty">这个知识库还没有文档，拖文件到上面试试</div>';
    box.querySelectorAll('[data-doc-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('确定从知识库删除这份文档？')) return;
        b.disabled = true;
        api('/api/knowledge/del-doc', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kb_id: kbState.id, doc_id: b.dataset.docDel })
        }).then(function (x) { snack(x.ok ? '已删除' : '删除失败'); loadKnowledge(); });
      });
    });
  }).catch(function () { box.innerHTML = '<div class="empty">读取文档失败</div>'; });
}

function kbRefreshEmbCard() {
  if (!$('kbEmbTag')) return;
  api('/api/embedding/config').then(function (r) {
    if ($('embBase')) $('embBase').value = r.base || '';
    if ($('embModel')) $('embModel').value = r.model || '';
    if ($('embKey')) $('embKey').placeholder = r.has_key ? 'API Key（已保存，留空则不修改）' : 'API Key';
    var ready = kbState.embeddings && kbState.embeddings.length;
    $('kbEmbTag').textContent = ready ? '已接入：' + kbState.embeddings.join('、') : '未配置';
    $('kbEmbTag').className = 'tag' + (ready ? ' ok' : '');
  }).catch(function () {});
}

function kbNewDialog() {
  if (!(kbState.embeddings || []).length) {
    return snack('还没有可用的向量模型，请先在「向量模型」里配置');
  }
  openDialog('<h3>新建知识库</h3>'
    + '<div class="muted" style="margin:8px 0 14px">知识库建好后，把文档传进去，机器人就能检索到。</div>'
    + '<input class="field" id="nkbName" placeholder="知识库名称，如：售后规则" style="margin-bottom:10px">'
    + '<input class="field" id="nkbDesc" placeholder="描述（可选）" style="margin-bottom:10px">'
    + '<div class="muted" style="margin-bottom:6px">向量模型</div>'
    + '<select class="field" id="nkbEmb" style="margin-bottom:16px">'
    + kbState.embeddings.map(function (e) { return '<option value="' + esc(e) + '">' + esc(e) + '</option>'; }).join('')
    + '</select>'
    + '<div class="row" style="justify-content:flex-end;gap:10px">'
    + '<button class="btn text" id="nkbCancel">取消</button>'
    + '<button class="btn filled" id="nkbOk">创建</button></div>');
  $('nkbCancel').onclick = closeDialog;
  $('nkbOk').onclick = function () {
    var name = $('nkbName').value.trim();
    if (!name) return snack('请填名称');
    $('nkbOk').disabled = true;
    api('/api/knowledge/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, description: $('nkbDesc').value.trim(), embedding_provider_id: $('nkbEmb').value })
    }).then(function (x) {
      closeDialog();
      if (x.ok) { snack('知识库已创建'); setTimeout(loadKnowledge, 1500); }
      else snack('创建失败：' + (x.error || ''));
    }).catch(function () { snack('创建失败'); $('nkbOk').disabled = false; });
  };
}

function uploadFiles(files) {
  if (!files || !files.length) return;
  if (!kbState.id) return snack('请先选择或新建一个知识库');
  var list = Array.prototype.slice.call(files);
  var done = 0, failed = [];
  list.reduce(function (p, f) {
    return p.then(function () {
      var fd = new FormData();
      fd.append('files', f, f.name);
      snack('上传中：' + f.name);
      return fetch('/api/knowledge/upload-kb?kb_id=' + encodeURIComponent(kbState.id), { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (r) { if (r.ok) done++; else failed.push(f.name + '：' + (r.error || '')); })
        .catch(function () { failed.push(f.name + '：网络错误'); });
    });
  }, Promise.resolve()).then(function () {
    snack('已上传 ' + done + ' 个文件' + (failed.length ? '，失败 ' + failed.length + ' 个' : ''));
    if (failed.length) console.warn('上传失败：', failed);
    loadKnowledge();
  });
}

(function initKnowledgeUI() {
  var dz = $('dropzone'), input = $('fileInput');
  if (dz && input) {
    dz.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { uploadFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); }); });
    dz.addEventListener('drop', function (e) { uploadFiles(e.dataTransfer.files); });
  }
  if ($('kbSelect')) {
    $('kbSelect').addEventListener('change', function () { kbState.id = $('kbSelect').value; loadKbDocs(); });
  }
  if ($('btnKbRefresh')) $('btnKbRefresh').addEventListener('click', function () { loadKnowledge(); });
  if ($('btnKbNew')) $('btnKbNew').addEventListener('click', kbNewDialog);

  if ($('btnEmbFetch')) $('btnEmbFetch').addEventListener('click', function () {
    var base = $('embBase').value.trim(), key = $('embKey').value.trim();
    if (!base || !key) return snack('先填 Base URL 和 Key');
    $('btnEmbFetch').disabled = true;
    if ($('embMsg')) $('embMsg').textContent = '正在拉取模型列表…';
    api('/api/embedding/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: base, key: key })
    }).then(function (r) {
      $('btnEmbFetch').disabled = false;
      if (!r.ok) { if ($('embMsg')) $('embMsg').textContent = '失败：' + (r.error || ''); return snack('拉取失败'); }
      var cands = r.embedding && r.embedding.length ? r.embedding : (r.all || []);
      if (!cands.length) { if ($('embMsg')) $('embMsg').textContent = '这个接口没返回任何模型'; return; }
      openDialog('<h3>选择向量模型</h3><div class="muted" style="margin:8px 0 14px">'
        + (r.embedding && r.embedding.length ? '已筛出带 embed 的模型' : '没有识别到 embed 模型，下面是全部模型，请自行确认')
        + '</div><div class="col" style="max-height:50vh;overflow:auto">'
        + cands.map(function (m, i) {
            return '<button class="btn text" data-pick="' + i + '" style="justify-content:flex-start;text-align:left">' + esc(m) + '</button>';
          }).join('')
        + '</div><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn text" id="pkClose">关闭</button></div>');
      $('pkClose').onclick = closeDialog;
      document.querySelectorAll('[data-pick]').forEach(function (b) {
        b.addEventListener('click', function () {
          $('embModel').value = cands[+b.dataset.pick];
          closeDialog();
          snack('已选择：' + cands[+b.dataset.pick]);
        });
      });
    }).catch(function () { $('btnEmbFetch').disabled = false; snack('拉取失败'); });
  });

  if ($('btnEmbSave')) $('btnEmbSave').addEventListener('click', function () {
    var base = $('embBase').value.trim(), key = $('embKey').value.trim(), model = $('embModel').value.trim();
    if (!base || !model) return snack('Base URL 和模型名都要填');
    $('btnEmbSave').disabled = true;
    api('/api/embedding/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: base, key: key, model: model })
    }).then(function () {
      return api('/api/embedding/apply', { method: 'POST' });
    }).then(function (r) {
      $('btnEmbSave').disabled = false;
      if (r.ok) { snack('已接入 AstrBot'); if ($('embMsg')) $('embMsg').textContent = '已写入 AstrBot provider（panel-embedding），现在可以建库了。'; loadKnowledge(); }
      else { snack('写入 AstrBot 失败'); if ($('embMsg')) $('embMsg').textContent = '写入失败：' + (r.error || ''); }
    }).catch(function () { $('btnEmbSave').disabled = false; snack('保存失败'); });
  });

  if ($('btnEmbTest')) $('btnEmbTest').addEventListener('click', function () {
    $('btnEmbTest').disabled = true;
    if ($('embMsg')) $('embMsg').textContent = '正在测试…';
    api('/api/embedding/test', { method: 'POST' }).then(function (r) {
      $('btnEmbTest').disabled = false;
      if ($('embMsg')) $('embMsg').textContent = r.ok ? ('连通正常，向量维度 ' + r.dim) : ('测试失败：' + (r.error || ''));
      snack(r.ok ? '向量模型可用' : '测试失败');
    }).catch(function () { $('btnEmbTest').disabled = false; snack('测试失败'); });
  });

  if ($('btnKbQuery')) $('btnKbQuery').addEventListener('click', function () {
    if (!kbState.id) return snack('请先选择知识库');
    var q = $('kbQuery').value.trim();
    if (!q) return snack('请输入要检索的内容');
    $('btnKbQuery').disabled = true;
    if ($('kbResult')) $('kbResult').innerHTML = '<div class="muted">检索中…</div>';
    api('/api/knowledge/retrieve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kb_id: kbState.id, query: q, top_k: 5 })
    }).then(function (r) {
      $('btnKbQuery').disabled = false;
      if (!r.ok) { $('kbResult').innerHTML = '<div class="muted">检索失败：' + esc(r.error || '') + '</div>'; return; }
      var d = r.data || {};
      var hits = d.results || d.chunks || d.items || (Array.isArray(d) ? d : []);
      if (!hits.length) { $('kbResult').innerHTML = '<div class="muted">没有召回内容（库里可能还没有文档，或相关度都低于阈值）</div>'; return; }
      $('kbResult').innerHTML = hits.map(function (h, i) {
        var txt = h.text || h.content || h.chunk || JSON.stringify(h).slice(0, 300);
        var sc = h.score != null ? (' · 相关度 ' + (+h.score).toFixed(3)) : '';
        return '<div style="padding:10px 0;border-bottom:1px solid var(--outline-v)">'
          + '<div class="muted" style="margin-bottom:4px">#' + (i + 1) + sc + '</div>'
          + '<div style="white-space:pre-wrap">' + esc(String(txt).slice(0, 600)) + '</div></div>';
      }).join('');
    }).catch(function () { $('btnKbQuery').disabled = false; $('kbResult').innerHTML = '<div class="muted">检索失败</div>'; });
  });
})();

/* ---------------- 设置页（FlClash 风格） ---------------- */
function openSettings() {
  $('settingsPage').classList.add('on');
  settingsMenu();
}
function closeSettings() { $('settingsPage').classList.remove('on'); }
function settingsHeader(title, sub) {
  $('settingsTitle').textContent = title;
  return '<div class="sbar-sub">' + (sub || '') + '</div>';
}
function settingsRow(icon, title, sub, page) {
  return '<button class="srow" data-page="' + page + '">'
    + '<span class="srow-ic"><svg class="ic"><use href="#' + icon + '"/></svg></span>'
    + '<span class="srow-txt"><span class="srow-title">' + title + '</span><span class="srow-sub">' + sub + '</span></span>'
    + '<svg class="ic srow-chev"><use href="#i-chevron"/></svg></button>';
}
function settingsMenu() {
  $('settingsTitle').textContent = '设置';
  $('settingsBody').innerHTML =
    '<div class="sgroup">更多</div>'
    + settingsRow('i-learn', '学习知识库', '上传文档让它学习', 'learn')
    + settingsRow('i-plugin', '服务与资源', '查看服务器和模型信息', 'about')
    + '<div class="sgroup">设置</div>'
    + settingsRow('i-person', '账户安全', '修改密码、两步验证', 'security')
    + settingsRow('i-eye', '主题', '设置深浅模式、调整色彩', 'theme')
    + settingsRow('i-person', '主人', '选择最多 2 个联系人', 'owners')
    + settingsRow('i-logs', '日志', '行数与自动刷新', 'logs')
    + settingsRow('i-refresh', '服务控制', '重启 AstrBot / SnowLuma', 'service')
    + settingsRow('i-plugin', '插件设置', '只显示插件自带的配置项', 'plugincfg')
    + settingsRow('i-backup', '备份与恢复', '导出控制台配置', 'backup')
    + settingsRow('i-lang', '语言', '默认：中文简体', 'lang')
    + '<div class="sgroup">其他</div>'
    + settingsRow('i-info', '关于', '版本与运行环境', 'about2');
  document.querySelectorAll('.srow[data-page]').forEach(function (b) { b.addEventListener('click', function () { settingsPage(b.dataset.page); }); });
}
function settingsPage(page) {
  if (page === 'learn') { closeSettings(); setTab('learn'); return; }
  if (page === 'theme') return themePage();
  if (page === 'security') return securityPage();
  if (page === 'owners') return ownersPage();
  if (page === 'logs') return logsPage();
  if (page === 'service') return servicePage();
  if (page === 'plugincfg') {
    closeSettings();
    setTab('plugins');
    setTimeout(function () { var el = $('pluginSettingsCard'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 350);
    return;
  }
  if (page === 'backup') return backupPage();
  if (page === 'lang') return langPage();
  if (page === 'about' || page === 'about2') return aboutPage();
}
function backBar() { return '<button class="sback" id="sback"><svg class="ic"><use href="#i-back"/></svg>返回</button>'; }
function bindBack() { var b = $('sback'); if (b) b.onclick = settingsMenu; }

function securityPage() {
  $('settingsTitle').textContent = '账户安全';
  api('/api/2fa/status').then(function (s) {
    var on = !!s.enabled;
    $('settingsBody').innerHTML = backBar()
      + '<div class="sgroup">修改密码</div>'
      + '<div style="padding:0 4px 4px">'
      + '<input class="field" id="pwOld" type="password" placeholder="当前密码" autocomplete="current-password" style="margin-bottom:10px">'
      + '<input class="field" id="pwNew" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password" style="margin-bottom:10px">'
      + '<input class="field" id="pwNew2" type="password" placeholder="再输一次新密码" autocomplete="new-password" style="margin-bottom:12px">'
      + '<button class="btn filled" id="btnPwSave" style="border-radius:24px;height:44px">保存新密码</button>'
      + '<div class="muted" style="margin-top:8px">改完立即生效，当前登录会自动失效需要重新登录。</div>'
      + '</div>'
      + '<div class="sgroup">两步验证</div>'
      + '<div style="padding:0 4px 4px">'
      + '<div class="muted" style="margin-bottom:10px">状态：<b>' + (on ? '已启用' : '未启用') + '</b>'
      + (on ? '（登录时需要输入验证器 App 的 6 位码）' : '（建议开启，密码泄露也进不来）') + '</div>'
      + (on
          ? '<input class="field" id="tfaPw" type="password" placeholder="当前密码" style="margin-bottom:10px">'
            + '<input class="field" id="tfaCodeOff" inputmode="numeric" maxlength="6" placeholder="6 位验证码" style="margin-bottom:12px">'
            + '<button class="btn tonal" id="btn2faOff" style="border-radius:24px;height:44px">关闭两步验证</button>'
          : '<button class="btn filled" id="btn2faSetup" style="border-radius:24px;height:44px">生成密钥并开启</button>')
      + '<div id="tfaBox" style="margin-top:14px"></div>'
      + '</div>'
      + '<div class="sgroup">告警推送</div>'
      + '<div style="padding:0 4px 4px">'
      + '<div class="muted" style="margin-bottom:10px">开启后，面板每 10 分钟自检一次；容器挂了、磁盘快满、证书快过期、备份太久没出，会自动推给你。</div>'
      + '<label class="row" style="gap:10px;align-items:center;margin-bottom:10px;cursor:pointer">'
      + '<input type="checkbox" id="alOn"><span>启用告警</span></label>'
      + '<label class="row" style="gap:10px;align-items:center;margin-bottom:10px;cursor:pointer">'
      + '<input type="checkbox" id="alQq"><span>推送到 QQ 主人（用第一个主人号私聊）</span></label>'
      + '<input class="field" id="alHook" placeholder="Webhook URL（可选，POST JSON）" style="margin-bottom:12px">'
      + '<div class="row" style="gap:10px">'
      + '<button class="btn filled" id="btnAlSave" style="border-radius:24px;height:44px;flex:1">保存告警设置</button>'
      + '<button class="btn tonal" id="btnAlTest" style="border-radius:24px;height:44px">发送测试</button>'
      + '</div>'
      + '<div class="muted" id="alMsg" style="margin-top:8px"></div>'
      + '</div>'
      + '<div class="sgroup">运行自检</div>'
      + '<div style="padding:0 4px 4px">'
      + '<button class="btn tonal" id="btnSelfCheck" style="border-radius:24px;height:44px">立即自检</button>'
      + '<div id="chkBox" style="margin-top:12px"></div>'
      + '</div>';
    bindBack();

    $('btnPwSave').onclick = function () {
      var o = $('pwOld').value, n = $('pwNew').value, n2 = $('pwNew2').value;
      if (!o || !n) return snack('请填写完整');
      if (n !== n2) return snack('两次输入的新密码不一致');
      if (n.length < 8) return snack('新密码至少 8 位');
      $('btnPwSave').disabled = true;
      api('/api/password/change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old: o, new: n }) })
        .then(function (r) {
          if (r.ok) { snack('密码已修改，即将重新登录'); setTimeout(function () { location.href = '/login'; }, 1200); }
          else { snack('修改失败：' + (r.error || '')); $('btnPwSave').disabled = false; }
        }).catch(function () { snack('修改失败'); $('btnPwSave').disabled = false; });
    };

    if (!on && $('btn2faSetup')) {
      $('btn2faSetup').onclick = function () {
        $('btn2faSetup').disabled = true;
        api('/api/2fa/setup', { method: 'POST' }).then(function (r) {
          if (!r.ok) { snack('生成失败：' + (r.error || '')); $('btn2faSetup').disabled = false; return; }
          $('tfaBox').innerHTML =
            '<div class="muted" style="margin-bottom:8px">1) 用验证器 App（Google Authenticator / 微软 Authenticator / 1Password 等）扫码或手输密钥：</div>'
            + '<div class="row" style="gap:10px;align-items:center;margin-bottom:10px">'
            + '<code style="flex:1;font-size:13px;word-break:break-all;background:var(--s-c3);padding:10px;border-radius:12px">' + esc(r.secret) + '</code>'
            + '<button class="btn text sm" id="btnCopySec">复制</button></div>'
            + '<div class="muted" style="margin-bottom:8px">2) 输入 App 上显示的 6 位码完成启用：</div>'
            + '<input class="field" id="tfaCode" inputmode="numeric" maxlength="6" placeholder="6 位验证码" style="margin-bottom:12px">'
            + '<button class="btn filled" id="btn2faOn" style="border-radius:24px;height:44px">完成启用</button>';
          $('btnCopySec').onclick = function () { copyText(r.secret); };
          $('btn2faOn').onclick = function () {
            var code = $('tfaCode').value.trim();
            if (!/^\d{6}$/.test(code)) return snack('请输入 6 位数字');
            $('btn2faOn').disabled = true;
            api('/api/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) })
              .then(function (x) {
                if (x.ok) { snack('两步验证已启用'); securityPage(); }
                else { snack('启用失败：' + (x.error || '')); $('btn2faOn').disabled = false; }
              }).catch(function () { snack('启用失败'); $('btn2faOn').disabled = false; });
          };
        }).catch(function () { snack('生成失败'); $('btn2faSetup').disabled = false; });
      };
    }

    if (on && $('btn2faOff')) {
      $('btn2faOff').onclick = function () {
        var pw = $('tfaPw').value, code = $('tfaCodeOff').value.trim();
        if (!pw || !/^\d{6}$/.test(code)) return snack('请填写密码和 6 位验证码');
        $('btn2faOff').disabled = true;
        api('/api/2fa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw, code: code }) })
          .then(function (x) {
            if (x.ok) { snack('两步验证已关闭'); securityPage(); }
            else { snack('关闭失败：' + (x.error || '')); $('btn2faOff').disabled = false; }
          }).catch(function () { snack('关闭失败'); $('btn2faOff').disabled = false; });
      };
    }
    bindAlert();
  }).catch(function () {
    $('settingsBody').innerHTML = backBar() + '<div class="empty">读取安全设置失败</div>';
    bindBack();
  });
}

/* 告警设置 + 自检（在 securityPage 里调用） */
function bindAlert() {
  api('/api/alert/config').then(function (r) {
    var a = r.alert || {};
    if ($('alOn')) $('alOn').checked = !!a.enabled;
    if ($('alQq')) $('alQq').checked = !!a.via_qq;
    if ($('alHook')) $('alHook').value = a.webhook || '';
  }).catch(function () {});

  if ($('btnAlSave')) $('btnAlSave').onclick = function () {
    $('btnAlSave').disabled = true;
    api('/api/alert/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: $('alOn').checked, via_qq: $('alQq').checked, webhook: $('alHook').value.trim() })
    }).then(function (x) {
      snack(x.ok ? '告警设置已保存' : '保存失败');
      $('btnAlSave').disabled = false;
    }).catch(function () { snack('保存失败'); $('btnAlSave').disabled = false; });
  };

  if ($('btnAlTest')) $('btnAlTest').onclick = function () {
    $('btnAlTest').disabled = true;
    if ($('alMsg')) $('alMsg').textContent = '正在发送…';
    api('/api/alert/test', { method: 'POST' }).then(function (x) {
      var txt = (x.results || []).map(function (r) {
        return (r.channel === 'qq' ? 'QQ' : r.channel === 'webhook' ? 'Webhook' : r.channel) + '：' + (r.ok ? '成功' : '失败 ' + (r.msg || ''));
      }).join('；') || '无可用渠道';
      if ($('alMsg')) $('alMsg').textContent = txt;
      snack(x.ok ? '测试告警已发出' : '发送失败：' + txt);
      $('btnAlTest').disabled = false;
    }).catch(function () { if ($('alMsg')) $('alMsg').textContent = '发送失败'; $('btnAlTest').disabled = false; });
  };

  if ($('btnSelfCheck')) $('btnSelfCheck').onclick = function () {
    $('btnSelfCheck').disabled = true;
    if ($('chkBox')) $('chkBox').innerHTML = '<div class="muted">检查中…</div>';
    api('/api/selfcheck').then(function (r) {
      var rows = (r.checks || []).map(function (c) {
        return '<div class="row" style="gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--outline-v)">'
          + '<span class="tag ' + (c.ok ? 'ok' : '') + '" style="flex:0 0 auto">' + (c.ok ? '正常' : '异常') + '</span>'
          + '<span style="flex:1"><b>' + esc(c.name) + '</b><br><span class="muted">' + esc(c.detail) + '</span></span></div>';
      }).join('');
      if ($('chkBox')) $('chkBox').innerHTML = rows || '<div class="muted">无检查项</div>';
      snack(r.ok ? '自检通过' : '自检发现问题');
      $('btnSelfCheck').disabled = false;
    }).catch(function () {
      if ($('chkBox')) $('chkBox').innerHTML = '<div class="muted">自检失败</div>';
      $('btnSelfCheck').disabled = false;
    });
  };
}

function themePage() {
  var t = Theme.get();
  var modes = [['auto', '自动'], ['light', '浅色'], ['dark', '深色']];
  var styles = [['md3', 'MD3'], ['glass', 'Liquid Glass']];
  $('settingsTitle').textContent = '主题';
  $('settingsBody').innerHTML = backBar()
    + '<div class="sgroup">界面风格</div><div class="seg-row" id="rowStyle">'
    + styles.map(function (s) { return '<button class="opt ' + (t.style === s[0] ? 'on' : '') + '" data-style="' + s[0] + '">' + s[1] + '</button>'; }).join('')
    + '</div><div class="sgroup">主题模式</div><div class="seg-row" id="rowMode">'
    + modes.map(function (m) { return '<button class="opt ' + (t.mode === m[0] ? 'on' : '') + '" data-mode="' + m[0] + '">' + m[1] + '</button>'; }).join('')
    + '</div><div class="sgroup">主题色彩</div><div class="swatches" id="rowSwatch">'
    + Object.keys(Theme.seeds).map(function (k) {
        var c = Theme.seeds[k];
        return '<button class="swatch ' + (t.palette === k ? 'on' : '') + '" data-pal="' + k + '" style="background:' + c + '">'
          + '<i style="background:' + c + '"></i><i style="background:color-mix(in srgb,' + c + ' 55%, #fff)"></i>'
          + '<i style="background:color-mix(in srgb,' + c + ' 55%, #000)"></i><i style="background:color-mix(in srgb,' + c + ' 35%, #fff)"></i></button>';
      }).join('')
    + '</div>'
    + '<div class="trow"><span class="lbl">纯黑模式</span><button class="tgl ' + (t.pure ? 'on' : '') + '" id="tglPure"></button></div>'
    + '<div class="trow"><span class="lbl">文本缩放</span><span class="muted" id="scaleVal">' + t.scale + '%</span></div>'
    + '<input class="range" id="scaleRange" type="range" min="85" max="120" step="5" value="' + t.scale + '">';
  bindBack();
  document.querySelectorAll('#rowStyle .opt').forEach(function (b) {
    b.addEventListener('click', function () { Theme.set({ style: b.dataset.style }); document.querySelectorAll('#rowStyle .opt').forEach(function (x) { x.classList.toggle('on', x === b); }); });
  });
  document.querySelectorAll('#rowMode .opt').forEach(function (b) {
    b.addEventListener('click', function () { Theme.set({ mode: b.dataset.mode }); document.querySelectorAll('#rowMode .opt').forEach(function (x) { x.classList.toggle('on', x === b); }); });
  });
  document.querySelectorAll('#rowSwatch .swatch').forEach(function (b) {
    b.addEventListener('click', function () { Theme.set({ palette: b.dataset.pal }); document.querySelectorAll('#rowSwatch .swatch').forEach(function (x) { x.classList.toggle('on', x === b); }); });
  });
  $('tglPure').addEventListener('click', function () { var on = !Theme.get().pure; Theme.set({ pure: on }); this.classList.toggle('on', on); });
  $('scaleRange').addEventListener('input', function () { var v = parseInt(this.value, 10); $('scaleVal').textContent = v + '%'; Theme.set({ scale: v }); });
}

function ownersPage() {
  $('settingsTitle').textContent = '主人';
  $('settingsBody').innerHTML = backBar() + '<div class="muted" style="padding:4px 16px 12px">选择最多 2 个联系人作为「主人」，概览页会显示徽章。</div><div id="pickList" class="col" style="padding:0 16px"></div>'
    + '<div class="row" style="justify-content:flex-end;padding:16px"><button class="btn filled" id="ownerSave">保存</button></div>';
  bindBack();
  var selected = (state && state.owners ? state.owners : []).map(function (o) { return String(o.id); });
  api('/api/contacts').then(function (c) {
    var friends = (c.friends || []).filter(function (f) { return f.id !== (state.bot && state.bot.uin); });
    $('pickList').innerHTML = friends.map(function (f) {
      var sel = selected.indexOf(f.id) >= 0;
      return '<div class="pick ' + (sel ? 'sel' : '') + '" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '">'
        + '<img class="avatar xs" src="' + avatarUrl(f.id) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        + '<div style="flex:1"><div style="font-size:13px">' + esc(f.name) + '</div><div class="muted">' + esc(f.id) + '</div></div>'
        + '<span class="ck"><svg class="ic" style="width:14px;height:14px"><use href="#i-check"/></svg></span></div>';
    }).join('') || '<div class="empty">未获取到联系人</div>';
    document.querySelectorAll('.pick').forEach(function (el) {
      el.addEventListener('click', function () {
        var on = el.classList.toggle('sel');
        if (on) selected.push(el.dataset.id);
        else selected = selected.filter(function (x) { return x !== el.dataset.id; });
        if (selected.length > 2) { selected = selected.filter(function (x) { return x !== el.dataset.id; }); el.classList.remove('sel'); snack('最多只能设置 2 个主人'); }
      });
    });
    $('ownerSave').onclick = function () {
      var owners = selected.slice(0, 2).map(function (id) {
        var el = document.querySelector('.pick[data-id="' + id + '"]');
        return { id: id, name: el ? el.dataset.name : id };
      });
      api('/api/owners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owners: owners }) })
        .then(function (r) { if (r.ok) { snack('已保存主人'); tick(true); settingsMenu(); } else snack(r.error || '保存失败'); });
    };
  }).catch(function () { snack('联系人加载失败'); });
}

function saveLogPref(patch) {
  var t = JSON.parse(localStorage.getItem('bp_log_pref') || '{}');
  for (var k in patch) t[k] = patch[k];
  localStorage.setItem('bp_log_pref', JSON.stringify(t));
}
function logsPage() {
  var t = JSON.parse(localStorage.getItem('bp_log_pref') || '{}');
  $('settingsTitle').textContent = '日志';
  $('settingsBody').innerHTML = backBar()
    + '<div class="trow" style="padding:14px 16px"><span class="lbl">默认行数</span>'
    + '<select class="field mini" id="prefLines" style="width:120px"><option ' + ((t.lines || 300) === 200 ? 'selected' : '') + '>200</option><option ' + ((t.lines || 300) === 300 ? 'selected' : '') + '>300</option><option ' + ((t.lines || 300) === 500 ? 'selected' : '') + '>500</option><option ' + ((t.lines || 300) === 1000 ? 'selected' : '') + '>1000</option></select></div>'
    + '<div class="trow" style="padding:14px 16px"><span class="lbl">自动刷新</span><button class="tgl ' + ((t.auto === undefined || t.auto) ? 'on' : '') + '" id="prefAuto"></button></div>'
    + '<div class="sgroup">配色主题（参考 log4j2）</div>'
    + '<div class="logtheme-row" id="logThemeRow">'
    + '<div class="logtheme-opt ' + (logTheme === 'sayori' ? 'on' : '') + '" data-lt="sayori"><div class="t">明亮</div><div class="logtheme-sample"><span style="color:#5aa9ff">[17:10:01]</span> <span style="color:#7ee2b8">[INFO]</span> <span style="color:#ffd666">[WARN]</span> <span style="color:#ff8a8a">[ERROR]</span></div></div>'
    + '<div class="logtheme-opt ' + (logTheme === 'xylitol' ? 'on' : '') + '" data-lt="xylitol"><div class="t">柔和</div><div class="logtheme-sample"><span style="color:#7aa2ff">[17:10:01]</span> <span style="color:#57ab5a">[INFO]</span> <span style="color:#e8c026">[WARN]</span> <span style="color:#e5534b">[ERROR]</span></div></div>'
    + '</div>'
    + '<div class="muted" style="padding:8px 16px">日志支持：级别筛选、关键字搜索、暂停、下载。</div>';
  bindBack();
  $('prefLines').onchange = function () {
    var v = parseInt(this.value, 10);
    localStorage.setItem('bp_log_pref', JSON.stringify({ lines: v, auto: (t.auto === undefined ? true : t.auto) }));
    $('logLines').value = String(v);
    snack('已设置默认行数');
  };
  $('prefAuto').addEventListener('click', function () {
    var on = !this.classList.contains('on');
    this.classList.toggle('on', on);
    saveLogPref({ auto: on });
    logPaused = !on;
    $('btnPause').innerHTML = '<svg class="ic"><use href="' + (logPaused ? '#i-play' : '#i-pause') + '"/></svg>';
  });
  document.querySelectorAll('#logThemeRow .logtheme-opt').forEach(function (el) {
    el.addEventListener('click', function () {
      logTheme = el.dataset.lt;
      document.querySelectorAll('#logThemeRow .logtheme-opt').forEach(function (x) { x.classList.toggle('on', x === el); });
      saveLogPref({ theme: logTheme });
      paintLogs();
      snack('日志配色：' + (logTheme === 'sayori' ? '明亮' : '柔和'));
    });
  });
}

function servicePage() {
  var cs = (state && state.containers) || [];
  function row(name, desc) {
    var c = cs.find(function (x) { return x.name === name; }) || {};
    return '<div class="item"><div class="avatar-box">' + name.slice(0, 1).toUpperCase() + '</div>'
      + '<div class="body"><div class="name">' + name + ' <span class="tag ' + (c.status ? 'ok' : 'bad') + '">' + esc(c.status || '未运行') + '</span></div>'
      + '<div class="desc">' + desc + '</div>'
      + '<div class="row wrap" style="margin-top:8px"><button class="btn tonal sm" data-restart="' + name + '">重启</button></div></div></div>';
  }
  $('settingsTitle').textContent = '服务控制';
  $('settingsBody').innerHTML = backBar()
    + '<div class="muted" style="padding:6px 16px 12px">只允许重启 astrbot / snowluma 两个白名单容器。SnowLuma 重启后可能需要重新扫码登录 QQ。</div>'
    + '<div class="col" style="padding:0 16px">'
    + row('astrbot', 'AI 机器人本体，重启约 10 秒，OneBot 会自动重连')
    + row('snowluma', 'QQ 网关（QQ 客户端），重启后可能需要在 noVNC 里重新扫码')
    + '</div>';
  bindBack();
  document.querySelectorAll('[data-restart]').forEach(function (b) {
    b.addEventListener('click', function () {
      var name = b.dataset.restart;
      openDialog('<h3>重启 ' + name + '？</h3><div class="muted" style="margin:8px 0 18px">' + (name === 'snowluma' ? 'SnowLuma 重启后 QQ 可能会掉线，需要重新扫码。' : 'AstrBot 重启期间机器人会短暂离线。') + '</div>'
        + '<div class="row" style="justify-content:flex-end;gap:10px"><button class="btn text" id="rsCancel">取消</button><button class="btn filled" id="rsOk">重启</button></div>');
      $('rsCancel').onclick = closeDialog;
      $('rsOk').onclick = function () {
        closeDialog();
        snack('正在重启 ' + name + '…');
        api('/api/service/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })
          .then(function (r) { snack(r.ok ? name + ' 已重启' : '失败：' + (r.error || '')); setTimeout(function () { tick(true); }, 4000); });
      };
    });
  });
}

function backupPage() {
  $('settingsTitle').textContent = '备份与恢复';
  $('settingsBody').innerHTML = backBar()
    + '<div class="muted" style="padding:8px 16px 16px">导出一份轻量配置（主人、主题、面板设置）。机器人数据请直接备份服务器上的 data_v4.db。</div>'
    + '<div class="row" style="padding:0 16px"><button class="btn tonal" id="btnExport">导出配置 JSON</button></div>';
  bindBack();
  $('btnExport').onclick = function () {
    api('/api/status').then(function (s) {
      var data = { exportedAt: new Date().toISOString(), owners: s.owners || [], theme: Theme.get(), logPref: JSON.parse(localStorage.getItem('bp_log_pref') || '{}') };
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'bot-panel-config-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click(); URL.revokeObjectURL(a.href);
    });
  };
}

function langPage() {
  $('settingsTitle').textContent = '语言';
  $('settingsBody').innerHTML = backBar()
    + '<div class="col" style="padding:8px 16px">'
    + '<div class="pick sel"><div style="flex:1">中文简体</div><span class="ck"><svg class="ic" style="width:14px;height:14px"><use href="#i-check"/></svg></span></div>'
    + '<div class="pick"><div style="flex:1">English（暂未实现）</div></div>'
    + '</div>';
  bindBack();
}

function aboutPage() {
  $('settingsTitle').textContent = '关于';
  var sv = state && state.server;
  $('settingsBody').innerHTML = backBar()
    + '<div style="padding:20px 16px;text-align:center"><div class="intro-mark" style="width:72px;height:72px;font-size:32px;border-radius:22px;background:var(--p);color:var(--on-p);display:grid;place-items:center;margin:0 auto 12px">Q</div>'
    + '<div style="font-size:20px;font-weight:600">QQ Bot 控制台</div>'
    + '<div class="muted" style="margin-top:4px">v3.2 · AstrBot × SnowLuma</div></div>'
    + '<div class="sgroup">运行环境</div>'
    + '<div class="kv" style="padding:0 16px">'
    + '<div class="k">服务器</div><div class="v">' + esc((sv && sv.host) || '-') + '</div>'
    + '<div class="k">系统</div><div class="v">' + esc((sv && sv.os) || '-') + '</div>'
    + '<div class="k">模型</div><div class="v">' + esc((state && state.model) || '-') + '</div>'
    + '<div class="k">面板</div><div class="v">Python 标准库 · systemd</div>'
    + '</div>';
  bindBack();
}

/* ---------------- 对话框 ---------------- */
function openDialog(html) {
  $('dlgBody').innerHTML = html;
  $('dlgBackdrop').classList.add('on');
  $('dlgBackdrop').setAttribute('aria-hidden', 'false');
  // 焦点移进对话框，方便键盘用户
  var f = $('dlgBody').querySelector('input,button,select,textarea');
  if (f) setTimeout(function () { try { f.focus(); } catch (e) {} }, 60);
}
function closeDialog() {
  $('dlgBackdrop').classList.remove('on');
  $('dlgBackdrop').setAttribute('aria-hidden', 'true');
}
$('dlgBackdrop').addEventListener('click', function (e) { if (e.target === $('dlgBackdrop')) closeDialog(); });
// Esc 关闭对话框 / 退出设置子页
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  var dlg = $('dlgBackdrop');
  if (dlg && dlg.classList.contains('on')) { closeDialog(); return; }
  var sp = $('settingsPage');
  if (sp && sp.classList.contains('on')) {
    // 与左上角返回按钮行为一致：子页回菜单，主菜单则关闭
    if ($('settingsTitle').textContent === '设置') closeSettings(); else settingsMenu();
  }
});

/* ---------------- 主题 / 开场 / iOS ---------------- */
function maybeIOSGlassPrompt() {
  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var m = ua.match(/OS (\d+)[._]/);
  var ver = m ? parseInt(m[1], 10) : 0;
  if (!isIOS || ver < 26) return;
  if (localStorage.getItem('bp_style_choice')) return;
  openDialog('<h3>检测到 iOS 26</h3><div class="muted" style="margin:8px 0 18px">这个系统支持 Liquid Glass 设计。要把控制台切换成玻璃质感风格吗？</div>'
    + '<div class="row" style="justify-content:flex-end;gap:10px">'
    + '<button class="btn text" id="iosKeep">保持 MD3</button>'
    + '<button class="btn filled" id="iosGlass">使用 Liquid Glass</button></div>');
  $('iosGlass').onclick = function () { localStorage.setItem('bp_style_choice', 'glass'); Theme.set({ style: 'glass' }); closeDialog(); snack('已切换 Liquid Glass'); };
  $('iosKeep').onclick = function () { localStorage.setItem('bp_style_choice', 'md3'); closeDialog(); };
}
function playIntro() {
  var title = $('introTitle'), intro = $('intro');
  if (!intro || !title) return;
  var text = 'QQ Bot 控制台';
  title.innerHTML = text.split('').map(function (ch, i) {
    return '<span style="animation-delay:' + (180 + i * 42) + 'ms">' + (ch === ' ' ? '&nbsp;' : ch) + '</span>';
  }).join('');
  setTimeout(function () { intro.classList.add('hide'); }, 1500);
  setTimeout(function () { if (intro.parentNode) intro.parentNode.removeChild(intro); }, 2100);
}
document.querySelector('.appbar') && window.addEventListener('scroll', function () {
  var bar = document.querySelector('.appbar');
  if (bar) bar.classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });

/* ---------------- 启动 ---------------- */
$('btnRefresh').addEventListener('click', function () { tick(true); snack('已刷新'); });
$('fabRefresh').addEventListener('click', function () { tick(true); snack('已刷新'); });
$('btnPersonaCopy').addEventListener('click', function () { copyText($('personaPrompt').value); });
$('btnPersonaSave').addEventListener('click', function () {
  if (!curPersona) return snack('先选一个人格');
  var prompt = $('personaPrompt').value;
  if (!prompt.trim()) return snack('提示词不能为空');
  snack('保存中…');
  api('/api/persona/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona_id: curPersona.id, system_prompt: prompt }) })
    .then(function (r) { if (r.ok) { snack('已保存，热更新生效'); tick(true); } else snack('保存失败：' + (r.error || r.message || '')); })
    .catch(function () { snack('保存失败'); });
});
$('btnPersonaRefresh').addEventListener('click', function () { tick(true); });
$('btnRestartBot') && $('btnRestartBot').addEventListener('click', function () {
  openDialog('<h3>重启 AstrBot？</h3><div class="muted" style="margin:8px 0 18px">重启约 10 秒，期间机器人短暂离线；刚装的插件会全部重新加载。</div>'
    + '<div class="row" style="justify-content:flex-end;gap:10px"><button class="btn text" id="rbCancel">取消</button><button class="btn filled" id="rbOk">重启</button></div>');
  $('rbCancel').onclick = closeDialog;
  $('rbOk').onclick = function () {
    closeDialog(); snack('正在重启 AstrBot…');
    api('/api/service/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'astrbot' }) })
      .then(function (r) { snack(r.ok ? 'AstrBot 已重启' : '失败：' + (r.error || '')); setTimeout(function () { tick(true); }, 5000); });
  };
});
$('btnQrRefresh') && $('btnQrRefresh').addEventListener('click', function () {
  snack('正在刷新二维码…');
  api('/api/qq/refresh', { method: 'POST' }).then(function () {
    $('qrImg').src = '/api/qq/qr?force=1&t=' + Date.now();
    snack('已刷新');
  }).catch(function () { snack('刷新失败'); });
});
$('btnSettings').addEventListener('click', openSettings);
$('railSettings').addEventListener('click', openSettings);
$('settingsBack').addEventListener('click', function () {
  if ($('settingsTitle').textContent === '设置') closeSettings(); else settingsMenu();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'))) {
    e.preventDefault();
    if (curTab === 'logs') loadLogs(true);
    else if (curTab === 'market') loadMarket();
    tick(true);
    snack('已刷新');
    return;
  }
  if (e.key === 'Escape') { if ($('dlgBackdrop').classList.contains('on')) closeDialog(); else if ($('settingsPage').classList.contains('on')) closeSettings(); } });

/* 读取日志偏好 */
(function () {
  var t = JSON.parse(localStorage.getItem('bp_log_pref') || '{}');
  if (t.lines) $('logLines').value = String(t.lines);
  if (t.auto === false) { logPaused = true; $('btnPause').innerHTML = '<svg class="ic"><use href="#i-play"/></svg>'; }
})();

playIntro();
setTimeout(maybeIOSGlassPrompt, 2200);
setTab('overview');
tick(true);
loadTemplates();
setInterval(function () { tick(); }, 15000);
setInterval(function () { if (curTab === 'logs' && !logPaused) loadLogs(); }, 5000);

/* ---------------- 人格模板 ---------------- */
function loadTemplates() {
  api('/api/persona/templates').then(function (r) {
    var items = (r && r.items) || [];
    if (!items.length) { $('tplList').innerHTML = '<div class="empty">暂无模板</div>'; return; }
    $('tplList').innerHTML = items.map(function (t, i) {
      return '<div class="item"><div class="avatar-box"><svg class="ic"><use href="#i-person"/></svg></div>'
        + '<div class="body"><div class="name">' + esc(t.name) + ' <span class="muted">' + (t.words || (t.prompt || '').length) + ' 字</span></div>'
        + '<div class="desc">' + esc((t.prompt || '').slice(0, 80)) + '…</div>'
        + '<div class="row wrap" style="margin-top:8px">'
        + '<button class="btn text sm" data-tpl-view="' + i + '">查看</button>'
        + '<button class="btn tonal sm" data-tpl-apply="' + i + '">建成 AstrBot 人格</button>'
        + '</div></div></div>';
    }).join('');
    document.querySelectorAll('[data-tpl-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = items[+b.dataset.tplView];
        $('personaPrompt').value = t.prompt; $('personaName').textContent = t.name;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        snack('已载入到右侧提示词框');
      });
    });
    document.querySelectorAll('[data-tpl-apply]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = items[+b.dataset.tplApply];
        snack('正在创建人格…');
        api('/api/persona/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona_id: t.id, system_prompt: t.prompt }) })
          .then(function (res) { snack(res.ok ? '已创建人格：' + t.id : '失败：' + (res.error || '可能已存在同名人格')); tick(true); });
      });
    });
  }).catch(function () { $('tplList').innerHTML = '<div class="empty">模板加载失败</div>'; });
}

/* ---------------- PWA：Service Worker ---------------- */
(function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // 只在 HTTPS（或 localhost）下注册，http 明文会静默失败
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (reg) {
      // 有新版本就提示一次，避免用户长期停在旧界面
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', function () {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            if (typeof snack === 'function') snack('新版本已就绪，刷新后生效');
          }
        });
      });
    }).catch(function () { /* 注册失败不影响正常使用 */ });
  });
})();
