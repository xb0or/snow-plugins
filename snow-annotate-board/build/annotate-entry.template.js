/* 批注工作台 —— Snow 面板插件 iframe 入口（由 tools/build-annotate-plugin.cjs 生成，勿手改）
 * 内嵌的第三方前端组件按非商业许可使用，完整条款见插件目录 LICENSES/LICENSE。
 *
 * 宿主环境约束（实测）：
 *  - iframe 面板 entry 由宿主以 <script src="blob:..."> 加载（经典脚本）
 *  - 子文档继承宿主 CSP：script-src 'self' blob:（无 unsafe-inline）→ 内联脚本一律不执行
 *  - <a download> 在插件 iframe 中不产生文件 → hook 后改走 Snow 桥落盘
 *  - iframe 内 navigator.clipboard 报 "Document is not focused" → 覆写为 Snow 剪贴板动作
 */
(function () {
  'use strict';

  var DOC_HTML = __EH_HTML__;
  var SCRIPTS = __EH_SCRIPTS__;
  var OUT_DIR = __EH_OUT_DIR__;
  var LOG_FILE = __EH_LOG_FILE__;
  var STORE_KEY = 'annotate-board.recent-projects';
  var SP = window.SnowPlugin || null;

  // ---------- 事件日志 ----------
  var eventLog = [];
  var logMerged = false;
  function logEvent(kind, detail) {
    eventLog.push({ t: new Date().toISOString(), kind: String(kind), detail: detail });
    if (eventLog.length > 80) eventLog.shift();
  }
  function flushLog() {
    if (!SP || !SP.write) return Promise.resolve();
    var merge = Promise.resolve();
    if (!logMerged) {
      logMerged = true;
      merge = readLocalFile(LOG_FILE).then(function (text) {
        if (!text) return;
        try {
          var old = JSON.parse(text);
          if (Array.isArray(old)) eventLog = old.concat(eventLog).slice(-120);
        } catch (e) {
          /* 忽略损坏的旧日志 */
        }
      });
    }
    return merge
      .then(function () {
        var text;
        try {
          text = JSON.stringify(eventLog, null, 2);
        } catch (e) {
          text = '[log serialize failed] ' + String(e);
        }
        return SP.write.run('filesystem.writeFile', { filePath: LOG_FILE, content: text });
      })
      .catch(function () {
        return undefined;
      });
  }

  // ---------- Snow 桥 ----------
  function notify(title, body) {
    logEvent('notify', { title: String(title), body: String(body) });
    var done = Promise.resolve();
    if (SP && SP.write) {
      done = SP.write.run('system.notify', { title: String(title), body: String(body) }).catch(function () {
        return undefined;
      });
    }
    return done.then(flushLog);
  }

  function writeText(filePath, content) {
    if (!SP || !SP.write) return Promise.reject(new Error('SnowPlugin bridge is unavailable'));
    return SP.write.run('filesystem.writeFile', { filePath: filePath, content: String(content) });
  }

  function writeChunkedText(basePath, text, chunkSize) {
    var size = chunkSize || 600000;
    var parts = Math.ceil(text.length / size);
    var chain = Promise.resolve();
    var writePart = function (idx) {
      return function () {
        return writeText(basePath + '.part' + idx, text.slice(idx * size, (idx + 1) * size));
      };
    };
    for (var i = 0; i < parts; i += 1) chain = chain.then(writePart(i));
    return chain.then(function () {
      return writeText(basePath + '.parts', String(parts) + ';' + String(size));
    });
  }

  function writeAdaptive(filePath, text) {
    return writeText(filePath, text).then(
      function () {
        return filePath;
      },
      function (firstError) {
        logEvent('write.retry.chunked', {
          file: filePath,
          length: String(text).length,
          error: String(firstError && firstError.message ? firstError.message : firstError),
        });
        return writeChunkedText(filePath, String(text)).then(function () {
          return filePath + ' (chunked)';
        });
      },
    );
  }

  function writeClipboardText(text) {
    if (!SP || !SP.write) return Promise.resolve();
    return SP.write.run('system.writeClipboardText', { text: String(text) }).catch(function () {
      return undefined;
    });
  }

  function writeClipboardImage(dataUrl) {
    try {
      var hostSnow = window.parent && window.parent.snow;
      if (!hostSnow || typeof hostSnow.writeImageToClipboard !== 'function') return Promise.resolve('unavailable');
      return Promise.resolve(hostSnow.writeImageToClipboard(dataUrl)).then(
        function () {
          return 'ok';
        },
        function (e) {
          return 'error: ' + String(e && e.message ? e.message : e);
        },
      );
    } catch (e) {
      return Promise.resolve('error: ' + String(e && e.message ? e.message : e));
    }
  }

  // 把文本写回聊天草稿：主路径 chatInput.insertText（无需令牌），失败再试 capture/apply，最后退回剪贴板
  function applyToDraft(text) {
    if (!SP || !SP.write) return Promise.resolve('no-bridge');

    var fallback = function () {
      return SP.write.run('chatInput.captureDraft', {}).then(
        function (captured) {
          var data = captured && captured.data ? captured.data : null;
          var token = data && data.draftToken ? data.draftToken : null;
          logEvent('draft.capture', { hasToken: !!token, dataKeys: data ? Object.keys(data) : null });
          if (!token) {
            return writeClipboardText(text).then(function () {
              return 'clipboard';
            });
          }
          var base = typeof data.text === 'string' ? data.text : '';
          var next = base ? base + '\n\n' + text : text;
          return SP.write.run('chatInput.applyDraft', { draftToken: token, text: next }).then(
            function (r) {
              var ok = !!(r && (r.ok === true || r.success === true));
              logEvent('draft.applyDraft', { ok: ok, base: base.length });
              if (ok) return 'draft-apply';
              return writeClipboardText(text).then(function () {
                return 'clipboard';
              });
            },
            function () {
              return writeClipboardText(text).then(function () {
                return 'clipboard';
              });
            },
          );
        },
        function () {
          return writeClipboardText(text).then(function () {
            return 'clipboard';
          });
        },
      );
    };

    return SP.write.run('chatInput.insertText', { text: '\n\n' + text }).then(
      function (r) {
        var ok = !!(r && (r.ok === true || r.success === true));
        var len = r && r.data && typeof r.data.length === 'number' ? r.data.length : -1;
        logEvent('draft.insertText', { ok: ok, length: len });
        if (!ok) return fallback();
        return writeClipboardText(text).then(function () {
          return 'draft+clipboard';
        });
      },
      function (e) {
        logEvent('draft.insertText.fail', String(e && e.message ? e.message : e));
        return fallback();
      },
    );
  }

  function readLocalFile(filePath) {
    try {
      var hostSnow = window.parent && window.parent.snow;
      if (!hostSnow || typeof hostSnow.readFileContent !== 'function') return Promise.resolve(null);
      return Promise.resolve(hostSnow.readFileContent(filePath)).then(
        function (v) {
          if (typeof v === 'string') return v;
          if (v && typeof v.content === 'string') return v.content;
          return null;
        },
        function () {
          return null;
        },
      );
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // ---------- blob 追踪 ----------
  var blobByUrl = new Map();
  var origCreateObjectURL = window.URL.createObjectURL.bind(window.URL);
  window.URL.createObjectURL = function (obj) {
    var url = origCreateObjectURL(obj);
    try {
      blobByUrl.set(url, obj);
    } catch (e) {
      /* 忽略 */
    }
    return url;
  };

  function readBlob(blob, mode) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(mode === 'buffer' ? reader.result : String(reader.result));
      };
      reader.onerror = function () {
        reject(reader.error || new Error('FileReader failed'));
      };
      if (mode === 'text') reader.readAsText(blob);
      else if (mode === 'buffer') reader.readAsArrayBuffer(blob);
      else reader.readAsDataURL(blob);
    });
  }

  function base64Of(dataUrl) {
    var comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : '';
  }

  // ---------- ZIP 解析（store / deflate）----------
  function readZipEntries(buffer) {
    var view = new DataView(buffer);
    var eocd = -1;
    for (var i = buffer.byteLength - 22; i >= 0 && i >= buffer.byteLength - 70000; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return Promise.reject(new Error('ZIP 结构未找到'));
    var count = view.getUint16(eocd + 10, true);
    var off = view.getUint32(eocd + 16, true);
    var entries = [];
    for (var n = 0; n < count; n += 1) {
      if (view.getUint32(off, true) !== 0x02014b50) break;
      var method = view.getUint16(off + 10, true);
      var compSize = view.getUint32(off + 20, true);
      var nameLen = view.getUint16(off + 28, true);
      var extraLen = view.getUint16(off + 30, true);
      var commentLen = view.getUint16(off + 32, true);
      var localOff = view.getUint32(off + 42, true);
      var name = new TextDecoder().decode(new Uint8Array(buffer, off + 46, nameLen));
      var lnameLen = view.getUint16(localOff + 26, true);
      var lextraLen = view.getUint16(localOff + 28, true);
      entries.push({ name: name, method: method, dataStart: localOff + 30 + lnameLen + lextraLen, compSize: compSize });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return Promise.all(
      entries.map(function (entry) {
        var slice = new Uint8Array(buffer, entry.dataStart, entry.compSize);
        if (entry.method === 0) return Promise.resolve({ name: entry.name, bytes: slice });
        if (typeof DecompressionStream === 'undefined') return Promise.resolve({ name: entry.name, bytes: null });
        var stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream)
          .arrayBuffer()
          .then(function (ab) {
            return { name: entry.name, bytes: new Uint8Array(ab) };
          })
          .catch(function () {
            return { name: entry.name, bytes: null };
          });
      }),
    );
  }

  // ---------- 最近项目 ----------
  function loadRecent() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function saveRecent(list) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 12)));
    } catch (e) {
      logEvent('recent.save.fail', String(e && e.message ? e.message : e));
    }
  }

  function rememberProject(entry) {
    var list = loadRecent().filter(function (it) {
      return it && it.file !== entry.file;
    });
    list.unshift(entry);
    saveRecent(list);
    refreshRecentMenu();
  }

  function importProjectText(text, name) {
    var input = document.getElementById('file-input');
    if (!input) {
      notify('批注工作台：无法打开项目', '页面缺少文件输入节点');
      return;
    }
    try {
      var file = new File([text], name || 'project.annotate-board', { type: 'application/json' });
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      logEvent('recent.import', { name: name, length: text.length });
    } catch (e) {
      logEvent('recent.import.fail', String(e && e.message ? e.message : e));
      notify('批注工作台：项目导入失败', String(e && e.message ? e.message : e));
    }
  }

  function openRecent(item) {
    if (!item) return;
    if (item.text) {
      importProjectText(item.text, item.file);
      return;
    }
    readLocalFile(item.path).then(function (text) {
      if (text) {
        importProjectText(text, item.file);
        return;
      }
      notify('批注工作台：无法读取项目', '找不到 ' + (item.path || item.file) + '，请手动选择文件');
    });
  }

  // ---------- 工具条 ----------
  var ICONS = {
    newFile: 'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z|M14 2v6h6|M12 18v-6|M9 15h6',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5|M12 7v5l4 2',
  };

  function iconSvg(paths) {
    return (
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      paths
        .split('|')
        .map(function (d) {
          return '<path d="' + d + '"/>';
        })
        .join('') +
      '</svg>'
    );
  }

  function buildToolbar() {
    var bar = document.createElement('div');
    bar.id = 'ab-toolbar';
    bar.style.cssText =
      'position:fixed;right:10px;bottom:10px;z-index:2147483000;display:flex;flex-direction:column;gap:6px;' +
      'font:12px/1.2 "Microsoft YaHei",Segoe UI,sans-serif;';

    function mkButton(label, title, paths, onClick) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:7px 10px;border-radius:8px;border:1px solid rgba(120,120,120,.35);' +
        'background:rgba(24,26,30,.82);color:#e8eaed;cursor:pointer;backdrop-filter:blur(6px);';
      btn.innerHTML = iconSvg(paths) + '<span>' + label + '</span>';
      btn.addEventListener('click', onClick);
      return btn;
    }

    bar.appendChild(
      mkButton('新建', '返回空状态并开始新的批注', ICONS.newFile, function () {
        reboot();
      }),
    );
    bar.appendChild(
      mkButton('最近', '选择最近保存的项目', ICONS.history, function () {
        toggleRecentMenu();
      }),
    );
    document.body.appendChild(bar);
    return bar;
  }

  var recentMenu = null;

  function refreshRecentMenu() {
    if (!recentMenu) return;
    var list = loadRecent();
    recentMenu.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('div');
      empty.textContent = '还没有保存过项目';
      empty.style.cssText = 'padding:8px 10px;opacity:.7;';
      recentMenu.appendChild(empty);
      return;
    }
    list.forEach(function (item) {
      var row = document.createElement('button');
      row.type = 'button';
      row.style.cssText =
        'display:block;width:100%;text-align:left;padding:7px 10px;border:0;background:transparent;color:#e8eaed;' +
        'cursor:pointer;border-radius:6px;';
      row.textContent = item.label || item.file;
      row.title = item.path || item.file;
      row.addEventListener('click', function () {
        hideRecentMenu();
        openRecent(item);
      });
      recentMenu.appendChild(row);
    });
  }

  function hideRecentMenu() {
    if (recentMenu && recentMenu.parentNode) recentMenu.parentNode.removeChild(recentMenu);
    recentMenu = null;
  }

  function toggleRecentMenu() {
    if (recentMenu) {
      hideRecentMenu();
      return;
    }
    recentMenu = document.createElement('div');
    recentMenu.style.cssText =
      'position:fixed;right:10px;bottom:96px;z-index:2147483001;min-width:180px;max-width:280px;max-height:240px;' +
      'overflow:auto;padding:4px;border-radius:10px;border:1px solid rgba(120,120,120,.35);' +
      'background:rgba(24,26,30,.95);color:#e8eaed;box-shadow:0 8px 24px rgba(0,0,0,.35);';
    document.body.appendChild(recentMenu);
    refreshRecentMenu();
  }

  function injectToolbar() {
    if (document.getElementById('ab-toolbar')) return;
    try {
      buildToolbar();
      logEvent('toolbar.injected', true);
    } catch (e) {
      logEvent('toolbar.fail', String(e && e.message ? e.message : e));
    }
  }

  function reboot() {
    try {
      hideRecentMenu();
      document.open();
      document.write(buildDocument());
      document.close();
      logEvent('reboot', true);
      window.setTimeout(injectToolbar, 30);
    } catch (e) {
      notify('批注工作台：重置失败', String(e && e.message ? e.message : e));
    }
  }

  // ---------- 导出交付 ----------
  var exportSeq = 0;
  function stamp() {
    exportSeq += 1;
    return new Date().toISOString().replace(/[:.]/g, '-') + '_' + exportSeq;
  }
  function sanitizeName(name) {
    return String(name || 'export.bin').replace(/[\\/:*?"<>|]+/g, '_');
  }
  function isProjectName(fileName) {
    return /\.annotate-board$/i.test(fileName);
  }

  function deliver(name, blob, options) {
    var opts = options || {};
    var fileName = sanitizeName(name);
    var mime = blob.type || '';
    var size = blob.size;
    logEvent('deliver.start', { name: fileName, mime: mime, size: size });

    // 图片：base64 落盘 + 尝试写剪贴板图片
    if (/^image\//i.test(mime)) {
      return readBlob(blob, 'dataurl').then(function (dataUrl) {
        var tasks = [writeAdaptive(OUT_DIR + stamp() + '_' + fileName + '.b64', base64Of(dataUrl))];
        tasks.push(opts.skipClipboard === true ? Promise.resolve('skipped') : writeClipboardImage(dataUrl));
        return Promise.all(tasks).then(function (r) {
          logEvent('deliver.image.ok', { file: fileName, size: size, clipboard: r[1] });
          return flushLog();
        });
      });
    }

    // 项目文件：落盘 + 记住，供"最近项目"恢复
    if (isProjectName(fileName)) {
      return readBlob(blob, 'text').then(function (text) {
        var path = OUT_DIR + stamp() + '_' + fileName;
        return writeAdaptive(path, text).then(function () {
          rememberProject({
            file: fileName,
            label: fileName.replace(/^[^_]*_/, ''),
            path: path,
            ts: new Date().toISOString(),
            text: text.length <= 1200000 ? text : null,
          });
          logEvent('deliver.project.ok', { file: fileName, size: text.length, path: path });
          return flushLog().then(function () {
            notify('批注工作台：项目已保存', fileName + ' 已落盘，可从「最近」重新打开');
          });
        });
      }).catch(function (e) {
        logEvent('deliver.project.fail', String(e && e.message ? e.message : e));
        return flushLog();
      });
    }

    // 文本 / JSON：落盘 + 写回聊天草稿（失败退回剪贴板）
    return readBlob(blob, 'dataurl')
      .then(function (dataUrl) {
        var isJson = /json/i.test(mime) || /\.json$/i.test(fileName);
        if (isJson || /^text\//i.test(mime)) {
          return readBlob(blob, 'text').then(function (text) {
            return writeAdaptive(OUT_DIR + stamp() + '_' + fileName, text).then(function () {
              logEvent('deliver.text.ok', { file: fileName, size: text.length });
              if (opts.skipClipboard === true) return flushLog();
              return applyToDraft(text).then(function (where) {
                logEvent('deliver.text.route', { where: where });
                return notify(
                  '批注工作台：已导出',
                  where.indexOf('draft') === 0 ? 'JSON 已写入聊天草稿，并已复制到剪贴板' : 'JSON 已落盘并复制到剪贴板',
                );
              });
            });
          });
        }

        // ZIP：base64 落盘 + 抽出其中的 JSON 写回草稿
        if (/zip/i.test(mime)) {
          return readBlob(blob, 'buffer').then(function (buffer) {
            return readZipEntries(buffer).then(function (entries) {
              var jsonEntry = null;
              entries.forEach(function (it) {
                if (it.bytes && /\.json$/i.test(it.name)) jsonEntry = it;
              });
              var jsonText = jsonEntry ? new TextDecoder().decode(jsonEntry.bytes) : '';
              return writeAdaptive(OUT_DIR + stamp() + '_' + fileName + '.b64', base64Of(dataUrl)).then(function () {
                logEvent('deliver.zip.ok', { file: fileName, size: size, entries: entries.length, hasJson: !!jsonText });
                if (!jsonText) return flushLog();
                return applyToDraft(jsonText).then(function (where) {
                  logEvent('deliver.zip.route', { where: where });
                  return notify(
                    '批注工作台：已导出',
                    where.indexOf('draft') === 0
                      ? 'JSON 与图片已落盘，JSON 已写入聊天草稿并复制到剪贴板'
                      : 'JSON 与图片已落盘，JSON 已复制到剪贴板',
                  );
                });
              });
            });
          });
        }

        return writeAdaptive(OUT_DIR + stamp() + '_' + fileName + '.b64', base64Of(dataUrl)).then(function () {
          logEvent('deliver.binary.ok', { file: fileName, size: size });
          return flushLog().then(function () {
            notify('批注工作台：已导出（base64）', fileName + ' 以 base64 落盘，可由 AI 解码');
          });
        });
      })
      .catch(function (e) {
        logEvent('deliver.fail', {
          file: fileName,
          mime: mime,
          size: size,
          error: String(e && e.message ? e.message : e),
          stack: String(e && e.stack ? e.stack : '').slice(0, 600),
        });
        return flushLog().then(function () {
          notify('批注工作台：导出失败', fileName + ' — ' + String(e && e.message ? e.message : e));
        });
      });
  }

  // ---------- 拦截 <a download> ----------
  try {
    var anchorProto = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype;
    if (anchorProto) {
      var origClick = anchorProto.click;
      anchorProto.click = function () {
        var href = '';
        try {
          href = this.getAttribute('href') || '';
        } catch (e) {
          href = '';
        }
        var blob = null;
        try {
          blob = blobByUrl.get(href) || null;
        } catch (e) {
          blob = null;
        }
        if (blob && this.hasAttribute('download')) {
          logEvent('anchor.click', { download: this.getAttribute('download'), size: blob.size, type: blob.type });
          deliver(this.getAttribute('download') || 'export.bin', blob);
          return undefined;
        }
        return origClick.apply(this, arguments);
      };
    }
  } catch (e) {
    logEvent('anchor.hook.fail', String(e && e.message ? e.message : e));
  }

  // ---------- 覆写 navigator.clipboard ----------
  try {
    var clipboardShim = {
      writeText: function (text) {
        logEvent('clipboard.writeText', { length: String(text).length });
        return applyToDraft(String(text)).then(function (where) {
          logEvent('clipboard.route', { where: where });
          return undefined;
        });
      },
      readText: function () {
        return Promise.reject(new Error('clipboard.readText is not supported inside the Snow panel'));
      },
    };
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: function () {
        return clipboardShim;
      },
    });
  } catch (e) {
    logEvent('clipboard.hook.fail', String(e && e.message ? e.message : e));
  }

  // ---------- 注入前端 ----------
  function buildDocument() {
    var html = DOC_HTML;
    for (var i = 0; i < SCRIPTS.length; i += 1) {
      var url = window.URL.createObjectURL(new Blob([SCRIPTS[i].code], { type: 'text/javascript' }));
      html = html.replace('<!--EH_SCRIPT_' + i + '-->', '<script src="' + url + '"><\/script>');
    }
    return html;
  }

  try {
    logEvent('boot', { scripts: SCRIPTS.length, docLen: DOC_HTML.length });
    document.open();
    document.write(buildDocument());
    document.close();
    logEvent('boot.injected', { readyState: document.readyState });
    window.setTimeout(injectToolbar, 30);
  } catch (e) {
    logEvent('boot.fail', String(e && e.message ? e.message : e));
    notify('批注工作台：启动失败', String(e && e.message ? e.message : e));
  }

  // ---------- 就绪标记（不做任何写剪贴板 / 触发下载的自检）----------
  writeText(OUT_DIR + '_panel-ready.txt', 'panel-ready ' + new Date().toISOString()).then(
    function () {
      logEvent('selfcheck.write.ok', OUT_DIR + '_panel-ready.txt');
      return flushLog();
    },
    function (e) {
      logEvent('selfcheck.write.fail', String(e && e.message ? e.message : e));
      return flushLog();
    },
  );
})();
