/* BotPanel Service Worker
   原则：
   - 只缓存静态资源（/assets/ 内容寻址的 css/js/图标），绝不吃缓存 API
   - 导航请求（HTML）永远走网络，保证看到最新界面
   - 离线时给一个礼貌的离线条，而不是浏览器默认报错
*/
var VER = 'bp-sw-1';
var SHELL = [
  '/manifest.webmanifest',
  '/icon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VER).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VER; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API、SSE、鉴权相关一律不碰
  if (url.pathname.indexOf('/api/') === 0 ||
      url.pathname === '/login' ||
      url.pathname === '/healthz' ||
      url.pathname.indexOf('/assetver') === 0) {
    return;
  }

  // HTML 导航：网络优先，失败给离线页
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>离线</title>'
          + '<div style="font:15px system-ui;padding:40px;color:#e8e8ea;background:#131316;min-height:100vh">'
          + '<h2 style="font-weight:600">当前无法连接服务器</h2>'
          + '<p style="color:#9aa0a6">手机可能断网了，或服务器正在重启。恢复网络后刷新即可。</p>'
          + '</div>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      })
    );
    return;
  }

  // 内容寻址的静态资源：缓存优先（URL 变了内容才会变）
  var isImmutable = /^\/assets\/[0-9a-f]{8,64}\//.test(url.pathname) ||
                    url.pathname === '/icon.svg' ||
                    url.pathname === '/manifest.webmanifest';

  if (isImmutable) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            var clone = res.clone();
            caches.open(VER).then(function (c) { c.put(req, clone); });
          }
          return res;
        });
      })
    );
    return;
  }

  // 其它（如 /partials/*.html、/js/app.js）：网络优先，成功就顺手缓存
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && (url.pathname.indexOf('/partials/') === 0 || url.pathname === '/js/app.js')) {
        var clone = res.clone();
        caches.open(VER).then(function (c) { c.put(req, clone); });
      }
      return res;
    }).catch(function () { return caches.match(req); })
  );
});
