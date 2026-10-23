/* 主题引擎：MD3 动态色 + Liquid Glass + 模式/纯黑/字号 */
(function (global) {
  var KEY = 'bp_theme_v1';
  var seeds = {
    purple: '#cfbcff', blue: '#9ecaff', teal: '#7fd8d0', green: '#a6d99a',
    yellow: '#e8d98a', orange: '#ffb68a', pink: '#ffb1c8', rose: '#f2b8c0'
  };

  function hexToHsl(hex) {
    var r = parseInt(hex.slice(1, 3), 16) / 255;
    var g = parseInt(hex.slice(3, 5), 16) / 255;
    var b = parseInt(hex.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s * 100, l: l * 100 };
  }
  function hsl(h, s, l) { return 'hsl(' + Math.round(h) + ' ' + Math.max(0, Math.min(100, s)).toFixed(1) + '% ' + l + '%)'; }

  function apply(mode, palette, pure, scale, style) {
    var root = document.documentElement;
    var seed = seeds[palette] || seeds.purple;
    var base = hexToHsl(seed);
    var h = base.h;
    var dark = mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    var v = {};
    var pl = dark ? 80 : 40, pcs = dark ? 32 : 90;
    v['--p'] = hsl(h, base.s * 0.9, pl);
    v['--on-p'] = hsl(h, base.s * 0.9, dark ? 18 : 99);
    v['--p-c'] = hsl(h, base.s * 0.75, pcs);
    v['--on-p-c'] = hsl(h, base.s * 0.7, dark ? 92 : 14);
    v['--s'] = hsl(h + 8, 24, dark ? 78 : 38);
    v['--on-s'] = hsl(h + 8, 24, dark ? 20 : 99);
    v['--s-c'] = hsl(h + 8, 20, dark ? 30 : 90);
    v['--on-s-c'] = hsl(h + 8, 20, dark ? 90 : 12);
    v['--t'] = hsl(h + 55, 42, dark ? 78 : 40);
    v['--on-t'] = hsl(h + 55, 42, dark ? 18 : 99);
    v['--t-c'] = hsl(h + 55, 30, dark ? 30 : 90);
    v['--on-t-c'] = hsl(h + 55, 30, dark ? 92 : 12);
    v['--err'] = dark ? '#ffb4ab' : '#ba1a1a';
    v['--on-err'] = dark ? '#690005' : '#ffffff';
    v['--err-c'] = dark ? '#93000a' : '#ffdad6';
    v['--on-err-c'] = dark ? '#ffdad6' : '#410002';
    var neutralS = 7;
    if (dark) {
      var l0 = pure ? 0 : 5, l1 = pure ? 2 : 9, l2 = pure ? 3 : 12, l3 = pure ? 5 : 16, l4 = pure ? 7 : 21, l5 = pure ? 9 : 25;
      v['--bg'] = pure ? '#000000' : hsl(h, neutralS, l0);
      v['--bg-dim'] = pure ? '#000000' : hsl(h, neutralS, l1);
      v['--s-lowest'] = pure ? '#000000' : hsl(h, neutralS, l1);
      v['--s-low'] = hsl(h, neutralS, l2);
      v['--s-c1'] = hsl(h, neutralS, l3);
      v['--s-c2'] = hsl(h, neutralS, l3 + 3);
      v['--s-c3'] = hsl(h, neutralS, l4);
      v['--s-c4'] = hsl(h, neutralS, l5);
      v['--on'] = hsl(h, 8, 91);
      v['--on-v'] = hsl(h, 8, 78);
      v['--outline'] = hsl(h, 8, 58);
      v['--outline-v'] = hsl(h, 8, 32);
    } else {
      v['--bg'] = hsl(h, 12, 97);
      v['--bg-dim'] = hsl(h, 12, 95);
      v['--s-lowest'] = hsl(h, 12, 99);
      v['--s-low'] = hsl(h, 12, 99);
      v['--s-c1'] = hsl(h, 12, 96);
      v['--s-c2'] = hsl(h, 12, 94);
      v['--s-c3'] = hsl(h, 12, 91);
      v['--s-c4'] = hsl(h, 12, 87);
      v['--on'] = hsl(h, 10, 12);
      v['--on-v'] = hsl(h, 10, 32);
      v['--outline'] = hsl(h, 8, 48);
      v['--outline-v'] = hsl(h, 8, 76);
    }
    for (var k in v) root.style.setProperty(k, v[k]);
    root.setAttribute('data-mode', dark ? 'dark' : 'light');
    root.setAttribute('data-style', style || 'md3');
    root.setAttribute('data-palette', palette);
    document.documentElement.style.setProperty('--text-zoom', (scale || 100) / 100);
    if (document.body) document.body.style.zoom = (scale || 100) / 100;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', v['--bg']);
  }

  var state = JSON.parse(localStorage.getItem(KEY) || '{}');
  state.mode = state.mode || 'dark';
  state.palette = state.palette || 'purple';
  state.pure = !!state.pure;
  state.scale = state.scale || 100;
  state.style = state.style || 'md3';

  function save() { localStorage.setItem(KEY, JSON.stringify(state)); apply(state.mode, state.palette, state.pure, state.scale, state.style); }
  function set(patch) { for (var k in patch) state[k] = patch[k]; save(); }
  function get() { return JSON.parse(JSON.stringify(state)); }

  global.Theme = { get: get, set: set, apply: function () { apply(state.mode, state.palette, state.pure, state.scale, state.style); }, seeds: seeds };
  // 尽早应用，避免闪烁
  apply(state.mode, state.palette, state.pure, state.scale, state.style);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (state.mode === 'auto') apply(state.mode, state.palette, state.pure, state.scale, state.style);
  });
})(window);
