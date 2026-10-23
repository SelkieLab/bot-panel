/* 分层加载：先拼装 partials，再启动 app.js */
(function () {
  var PARTS = [
    ["slot-sprite", "sprite"],
    ["slot-intro", "intro"],
    ["slot-rail", "rail"],
    ["slot-appbar", "appbar"],
    ["slot-bottomnav", "bottomnav"],
    ["slot-overlays", "overlays"]
  ];
  var PANES = ["overview", "desktop", "logs", "plugins", "personas", "market", "learn"];
  // app.js 的 URL 必须跟着 app.js 自己的内容哈希走：
  // 若沿用 boot.js 的 hash，改了 app.js 但 boot.js 没变，浏览器会一直用旧缓存。
  var APP_SRC = "/js/app.js";
  function load(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " -> " + r.status);
      return r.text();
    });
  }
  var jobs = PARTS.map(function (p) {
    return load("/partials/" + p[1] + ".html").then(function (h) { document.getElementById(p[0]).innerHTML = h; });
  });
  PANES.forEach(function (n) {
    jobs.push(load("/partials/panes/" + n + ".html").then(function (h) {
      document.getElementById("slot-panes").insertAdjacentHTML("beforeend", h);
    }));
  });
  Promise.all(jobs).then(function () {
    // 先问服务端 app.js 的当前哈希，再加载 /assets/<hash>/js/app.js
    return fetch("/assetver?f=js/app.js", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }).then(function (v) {
    var s = document.createElement("script");
    s.src = (v && v.url) || APP_SRC;
    s.onload = function () { document.body.classList.add("ready"); };
    s.onerror = function () { document.body.classList.add("ready"); };
    document.body.appendChild(s);
  }).catch(function (e) {
    document.body.innerHTML = '<div style="padding:40px;color:#ff9b9b;font:14px system-ui">界面加载失败：' + e.message + '</div>';
  });
})();
