(function () {
  'use strict';

  var sidebar = document.getElementById('oc-sidebar');
  var toggle = document.getElementById('sidebar-toggle');
  var backdrop = document.getElementById('oc-sidebar-backdrop');
  var more = document.getElementById('bottom-more');
  var desktopQuery = window.matchMedia('(min-width: 768px)');

  function setOpen(open) {
    if (!sidebar) return;
    sidebar.classList.toggle('is-open', open);
    document.body.classList.toggle('oc-menu-open', open && !desktopQuery.matches);
    if (backdrop) backdrop.hidden = !open || desktopQuery.matches;
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function applyCollapsedPref() {
    if (!sidebar || !desktopQuery.matches) return;
    var collapsed = localStorage.getItem('overclaw-sidebar-collapsed') === 'true';
    sidebar.classList.toggle('collapsed', collapsed);
    setOpen(false);
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      if (desktopQuery.matches) {
        var collapsed = !sidebar.classList.contains('collapsed');
        sidebar.classList.toggle('collapsed', collapsed);
        localStorage.setItem('overclaw-sidebar-collapsed', collapsed ? 'true' : 'false');
        return;
      }
      setOpen(!sidebar.classList.contains('is-open'));
    });
  }
  if (more) more.addEventListener('click', function () { setOpen(true); });
  if (backdrop) backdrop.addEventListener('click', function () { setOpen(false); });
  desktopQuery.addEventListener('change', applyCollapsedPref);
  applyCollapsedPref();

  document.querySelectorAll('.kb-board, .kanban-board').forEach(function (board) {
    var host = board.parentElement && board.parentElement.querySelector('.tb-topbar, .kanban-header');
    if (!host || host.querySelector('.kb-lane-toggle')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary kb-lane-toggle';
    btn.textContent = 'Stack lanes';
    btn.addEventListener('click', function () {
      var stacked = board.classList.toggle('kb-stacked');
      btn.textContent = stacked ? 'Swipe lanes' : 'Stack lanes';
      if (stacked) {
        var first = board.querySelector('.kb-col, .swimlane');
        board.querySelectorAll('.kb-col, .swimlane').forEach(function (col, i) {
          col.classList.toggle('is-open', i === 0);
        });
      }
    });
    host.appendChild(btn);
    board.querySelectorAll('.kb-col-header, .swimlane-header').forEach(function (header) {
      header.addEventListener('click', function () {
        if (!board.classList.contains('kb-stacked')) return;
        var col = header.parentElement;
        var open = col.classList.contains('is-open');
        board.querySelectorAll('.kb-col, .swimlane').forEach(function (c) { c.classList.remove('is-open'); });
        if (!open) col.classList.add('is-open');
      });
    });
  });

  function cachePack(pack) {
    try {
      localStorage.setItem('overclaw-theme-pack', JSON.stringify({
        id: pack.id,
        css: pack.css,
        themeColor: pack.themeColor,
        effects: pack.effects || [],
        fontStylesheet: pack.fonts && pack.fonts.stylesheet || ''
      }));
    } catch (e) { /* private mode */ }
  }

  window.ocApplyThemePack = function (pack) {
    if (!pack || !pack.css) return;
    var style = document.getElementById('oc-theme-server');
    if (!style) {
      style = document.createElement('style');
      style.id = 'oc-theme-server';
      document.head.appendChild(style);
    }
    style.textContent = pack.css;
    document.documentElement.setAttribute('data-theme', pack.id || 'matrix');
    document.documentElement.setAttribute('data-effects', (pack.effects || []).join(' '));
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && pack.themeColor) meta.setAttribute('content', pack.themeColor);
    cachePack(pack);
    ensureFont(pack.fonts && pack.fonts.stylesheet);
    startRain();
  };

  function ensureFont(href) {
    if (!href) return;
    var existing = document.querySelector('link[data-oc-font]');
    if (existing && existing.getAttribute('href') === href) return;
    if (existing) existing.remove();
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-oc-font', '1');
    document.head.appendChild(link);
  }

  var rainState = { raf: 0, stopped: true, drops: [], sized: false };

  function rainWanted() {
    var effects = (document.documentElement.getAttribute('data-effects') || '').split(/\s+/);
    return effects.indexOf('digital-rain') !== -1;
  }

  function reducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function setRainLabel(btn, text, state) {
    if (!btn) return;
    btn.setAttribute('data-rain', state || '');
    var label = btn.querySelector('.ctrl-label');
    if (label) label.textContent = text;
    else btn.textContent = text;
    if (text === 'Pause') btn.setAttribute('aria-label', 'Pause digital rain');
    else if (text === 'Rain') btn.setAttribute('aria-label', 'Play digital rain');
    else btn.setAttribute('aria-label', text);
  }

  function stopRain() {
    rainState.stopped = true;
    if (rainState.raf) cancelAnimationFrame(rainState.raf);
    rainState.raf = 0;
    var canvas = document.getElementById('oc-rain');
    if (canvas) {
      canvas.hidden = true;
      var ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function startRain() {
    var canvas = document.getElementById('oc-rain');
    var btn = document.getElementById('rain-toggle');
    stopRain();
    if (!canvas || !rainWanted()) {
      if (btn) btn.hidden = true;
      return;
    }
    if (btn) btn.hidden = false;
    if (reducedMotion()) {
      setRainLabel(btn, 'Rain off', 'off');
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    var paused = localStorage.getItem('overclaw-rain-paused') === '1';
    setRainLabel(btn, paused ? 'Rain' : 'Pause', paused ? 'paused' : 'playing');
    if (paused) return;

    var ctx = canvas.getContext('2d');
    rainState.ctx = ctx;
    rainState.stopped = false;
    var glyphs = '01ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ';
    var drops = [];

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var cols = Math.max(8, Math.min(36, Math.floor(window.innerWidth / 22)));
      drops = [];
      for (var i = 0; i < cols; i++) {
        drops.push({
          x: (i + 0.5) * (window.innerWidth / cols),
          y: Math.random() * window.innerHeight,
          speed: 28 + Math.random() * 48
        });
      }
    }
    resize();
    canvas.hidden = false;
    if (!rainState.sized) {
      rainState.sized = true;
      window.addEventListener('resize', function () {
        if (!rainState.stopped) resize();
      });
    }

    var last = 0;
    function frame(ts) {
      if (rainState.stopped) return;
      var dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
      last = ts;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      var color = (getComputedStyle(document.documentElement).getPropertyValue('--oc-accent') || '#00ff41').trim();
      ctx.fillStyle = color;
      ctx.font = '14px ui-monospace, monospace';
      for (var i = 0; i < drops.length; i++) {
        var d = drops[i];
        d.y += d.speed * dt;
        if (d.y > window.innerHeight + 20) d.y = -20;
        ctx.globalAlpha = 0.35 + (i % 5) * 0.08;
        ctx.fillText(glyphs.charAt((i + Math.floor(ts / 120)) % glyphs.length), d.x, d.y);
      }
      ctx.globalAlpha = 1;
      rainState.raf = requestAnimationFrame(frame);
    }
    rainState.raf = requestAnimationFrame(frame);
  }

  var rainBtn = document.getElementById('rain-toggle');
  if (rainBtn) {
    rainBtn.addEventListener('click', function () {
      if (rainBtn.disabled) return;
      var paused = localStorage.getItem('overclaw-rain-paused') === '1';
      localStorage.setItem('overclaw-rain-paused', paused ? '0' : '1');
      startRain();
    });
  }

  function considerBattery() {
    if (!navigator.getBattery || !rainWanted()) return;
    navigator.getBattery().then(function (battery) {
      function apply() {
        if (!battery.charging && battery.level < 0.2) {
          rainState.batteryHold = true;
          stopRain();
          var btn = document.getElementById('rain-toggle');
          if (btn) {
            btn.hidden = false;
            setRainLabel(btn, 'Rain off', 'off');
          }
        } else if (rainState.batteryHold) {
          rainState.batteryHold = false;
          startRain();
        }
      }
      apply();
      battery.addEventListener('levelchange', apply);
      battery.addEventListener('chargingchange', apply);
    }).catch(function () {});
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopRain();
    else startRain();
  });

  function tagTable(table) {
    var heads = Array.prototype.map.call(table.querySelectorAll('thead th'), function (th) {
      return (th.textContent || '').replace(/\s+/g, ' ').trim();
    });
    if (!heads.length) return;
    Array.prototype.forEach.call(table.querySelectorAll('tbody tr'), function (tr) {
      Array.prototype.forEach.call(tr.children, function (td, i) {
        if (!td || td.tagName !== 'TD' || td.hasAttribute('colspan')) return;
        if (!td.getAttribute('data-label') && heads[i]) td.setAttribute('data-label', heads[i]);
      });
    });
  }

  function labelDataTables() {
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    document.querySelectorAll('table').forEach(tagTable);
  }

  var labelTimer = 0;
  function scheduleLabel() {
    clearTimeout(labelTimer);
    labelTimer = setTimeout(labelDataTables, 40);
  }

  labelDataTables();
  if (typeof MutationObserver === 'function' && document.body) {
    new MutationObserver(scheduleLabel).observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener('resize', scheduleLabel);

  startRain();
  considerBattery();

  fetch('/api/themes/active', { headers: { 'Accept': 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (pack) {
      if (!pack || !pack.id) return;
      var current = document.documentElement.getAttribute('data-theme');
      var pending = localStorage.getItem('overclaw-theme-pending');
      if (pending && pending === current) return;
      if (pack.id !== current) window.ocApplyThemePack(pack);
      else cachePack(pack);
    })
    .catch(function () {});
})();
