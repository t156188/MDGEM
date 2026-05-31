// Injected before viewer.html scripts run.
// Bridges Tauri Rust ↔ the shared `window.MDViewerAPI` exported by viewer.bundle.js.
(function () {
  function tauri() { return window.__TAURI__; }
  function convertFileSrc(path) {
    var core = tauri() && (tauri().core || tauri());
    if (core && typeof core.convertFileSrc === 'function') {
      return core.convertFileSrc(path);
    }
    return path;
  }

  // Expose a tiny helper surface the shared bundle can call to turn an OS
  // file path into an asset:// URL WebView2 can load (Mac uses file:// URLs
  // directly, so the bundle no-ops there). Keep this stable — viewer.bundle.js
  // feature-detects `window.__mdr`.
  window.__mdr = window.__mdr || {};
  window.__mdr.convertFileSrc = convertFileSrc;

  function decodeFileUrl(url) {
    // file:///C:/path/foo.png → /C:/path/foo.png → C:/path/foo.png
    var stripped = url.replace(/^file:\/\//i, '');
    try { stripped = decodeURI(stripped); } catch (_) {}
    if (/^\/[A-Za-z]:\//.test(stripped)) stripped = stripped.slice(1);
    return stripped;
  }

  function fixImages() {
    var root = document.getElementById('root');
    if (!root) return;
    var imgs = root.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.getAttribute('src') || '';
      if (/^file:\/\//i.test(src)) {
        try { img.src = convertFileSrc(decodeFileUrl(src)); } catch (_) {}
      }
    }
  }

  function installLinkInterceptor() {
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        var ev = tauri() && tauri().event;
        if (ev && typeof ev.emit === 'function') {
          ev.emit('mdreader:open-external', href);
        }
      }
    }, true);
  }

  function wrapRender() {
    // Wait until viewer.bundle.js sets window.MDViewerAPI, then wrap render() so
    // we can post-process images on each render.
    var orig = null;
    function patch() {
      if (window.MDViewerAPI && window.MDViewerAPI.render && !orig) {
        orig = window.MDViewerAPI.render;
        window.MDViewerAPI.render = function (text, base) {
          var p = orig(text, base);
          var done = function () { fixImages(); };
          if (p && typeof p.then === 'function') p.then(done, done);
          else done();
          return p;
        };
      }
    }
    patch();
    if (!orig) {
      var tries = 0;
      var iv = setInterval(function () {
        patch();
        if (orig || ++tries > 200) clearInterval(iv);
      }, 25);
    }
  }

  function attachTauriListeners(cb) {
    var t = tauri();
    if (!t || !t.event || typeof t.event.listen !== 'function') return false;
    t.event.listen('mdreader:render', function (e) {
      var p = (e && e.payload) || {};
      if (window.MDViewerAPI && typeof window.MDViewerAPI.render === 'function') {
        window.MDViewerAPI.render(p.text || '', p.base_dir || '');
      }
    });
    t.event.listen('mdreader:theme', function (e) {
      var p = (e && e.payload) || {};
      if (window.MDViewerAPI && typeof window.MDViewerAPI.setTheme === 'function') {
        window.MDViewerAPI.setTheme(p.name || 'light');
      }
    });
    t.event.listen('mdreader:file-tree', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.setFileTree === 'function') {
        window.MDViewerAPI.setFileTree(p);
      }
    });
    t.event.listen('mdreader:scan-dir-result', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onScanDirResult === 'function') {
        window.MDViewerAPI.onScanDirResult(p.reqId, p);
      }
    });
    t.event.listen('mdreader:recents', function (e) {
      var p = (e && e.payload) || [];
      if (window.MDViewerAPI && typeof window.MDViewerAPI.setRecents === 'function') {
        window.MDViewerAPI.setRecents(Array.isArray(p) ? p : []);
      }
    });
    t.event.listen('mdreader:read-file-result', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onReadFileResult === 'function') {
        window.MDViewerAPI.onReadFileResult(p.reqId, p);
      }
    });
    t.event.listen('mdreader:ai-config', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onAiConfig === 'function') {
        window.MDViewerAPI.onAiConfig(p.reqId, p.config || null);
      }
    });
    t.event.listen('mdreader:ai-config-changed', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onAiConfigChanged === 'function') {
        window.MDViewerAPI.onAiConfigChanged(p);
      }
    });
    t.event.listen('mdreader:settings', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onSettings === 'function') {
        window.MDViewerAPI.onSettings(p.reqId, p.settings || null);
      }
    });
    t.event.listen('mdreader:settings-changed', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onSettingsChanged === 'function') {
        window.MDViewerAPI.onSettingsChanged(p);
      }
    });
    t.event.listen('mdreader:memory', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onMemory === 'function') {
        window.MDViewerAPI.onMemory(p.reqId, p.memory || null);
      }
    });
    t.event.listen('mdreader:history-loaded', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onHistoryLoaded === 'function') {
        window.MDViewerAPI.onHistoryLoaded(p.reqId, p.history || null);
      }
    });
    t.event.listen('mdreader:ai-delta', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onAiDelta === 'function') {
        window.MDViewerAPI.onAiDelta(p.reqId, { text: p.text || '' });
      }
    });
    t.event.listen('mdreader:ai-done', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onAiDone === 'function') {
        window.MDViewerAPI.onAiDone(p.reqId, { full: p.full, toolCalls: p.toolCalls || null });
      }
    });
    t.event.listen('mdreader:ai-error', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onAiError === 'function') {
        window.MDViewerAPI.onAiError(p.reqId, { error: p.error });
      }
    });
    t.event.listen('mdreader:ai-tool-result', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onAiToolResult === 'function') {
        window.MDViewerAPI.onAiToolResult(p.reqId, { ok: !!p.ok, result: p.result || '' });
      }
    });
    t.event.listen('mdreader:write-result', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onWriteResult === 'function') {
        window.MDViewerAPI.onWriteResult(p.reqId, { ok: !!p.ok, error: p.error || null });
      }
    });
    t.event.listen('mdreader:term-data', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onTermData === 'function') {
        window.MDViewerAPI.onTermData(p.id, p.data);
      }
    });
    t.event.listen('mdreader:term-exit', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onTermExit === 'function') {
        window.MDViewerAPI.onTermExit(p.id, p.code);
      }
    });
    if (cb) cb();
    return true;
  }

  function announceReady() {
    var t = tauri();
    if (t && t.event && typeof t.event.emit === 'function') {
      t.event.emit('mdreader:ready', {});
    }
  }

  function boot() {
    installLinkInterceptor();
    wrapRender();
    var tries = 0;
    (function tryListen() {
      if (attachTauriListeners(announceReady)) return;
      if (++tries > 200) return; // give up after ~5s
      setTimeout(tryListen, 25);
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
