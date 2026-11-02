/* Accio Bridge — 日志视图: 2 秒轮询、级别筛选、搜索、暂停、跟随、复制.
   仅在页面可见且停留在本视图时轮询；视图切换时由 ctx 清理定时器。 */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  var el = AB.el;
  var ui = AB.ui;

  var LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };
  var MAX_BUFFER = 2000;

  AB.registerView('logs', {
    title: '日志',

    mount: function (root, ctx) {
      var alive = true;
      var buffer = [];            /* 去重后的全部日志行 */
      var seen = {};              /* key -> true */
      var renderedKeys = [];
      var level = '';
      var search = '';
      var paused = false;
      var follow = true;
      var hiddenBefore = 0;   /* 清空视图后隐藏的时间点（ms），0 表示不隐藏 */
      var pollError = null;

      var toolbar = el('div', { class: 'log-toolbar' });
      var list = el('div', {
        class: 'log-list',
        role: 'log',
        'aria-label': '网关日志',
        tabindex: '0'
      });

      var levelSelect = el('select', { class: 'select', 'aria-label': '日志级别筛选' }, [
        el('option', { value: '', text: '全部级别' }),
        el('option', { value: 'debug', text: '调试及以上' }),
        el('option', { value: 'info', text: '信息及以上' }),
        el('option', { value: 'warn', text: '警告及以上' }),
        el('option', { value: 'error', text: '仅错误' })
      ]);
      levelSelect.addEventListener('change', function () {
        level = levelSelect.value;
        fullRender();
      });

      var searchInput = el('input', {
        type: 'search',
        class: 'input log-search',
        placeholder: '搜索日志内容',
        'aria-label': '搜索日志',
        oninput: function () {
          search = searchInput.value.trim().toLowerCase();
          fullRender();
        }
      });

      var pauseBtn = ui.button('暂停', { size: 'sm', icon: 'pause' });
      var followBtn = ui.button('跟随', { size: 'sm', icon: 'arrowDown' });
      var clearBtn = ui.button('清空视图', { size: 'sm', icon: 'trash', title: '隐藏此刻之前的日志行' });
      var restoreBtn = ui.button('恢复显示', { size: 'sm', icon: 'eye', title: '取消隐藏，重新显示全部日志' });
      restoreBtn.hidden = true;
      var copyBtn = ui.copyButton(function () {
        return visibleLines().map(function (line) {
          return AB.fmt.clockTime(line.ts) + '  ' + line.level.toUpperCase() + '  ' + line.msg;
        }).join('\n');
      }, { label: '复制' });
      var countPill = ui.pill('—', null);

      function setPaused(next, silent) {
        paused = next;
        pauseBtn.innerHTML = '';
        pauseBtn.appendChild(AB.icon(next ? 'play' : 'pause', 13));
        pauseBtn.appendChild(el('span', { class: 'btn-label', text: next ? '继续' : '暂停' }));
        pauseBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
        pauseBtn.title = next ? '继续接收新日志' : '暂停接收新日志';
        if (!silent) ui.toast(next ? '已暂停日志刷新（轮询仍在后台进行）' : '已继续日志刷新', 'info');
        if (!next) refresh();
      }
      pauseBtn.addEventListener('click', function () { setPaused(!paused); });

      function setFollow(next) {
        follow = next;
        followBtn.classList.toggle('is-on', next);
        followBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
        followBtn.innerHTML = '';
        followBtn.appendChild(AB.icon(next ? 'pause' : 'arrowDown', 13));
        followBtn.appendChild(el('span', { class: 'btn-label', text: next ? '跟随中' : '已上滚' }));
        followBtn.title = next ? '正在自动滚动到最新日志' : '已停止跟随，点击回到最新';
        if (next) scrollToBottom();
      }
      followBtn.addEventListener('click', function () { setFollow(!follow); });

      /* 清空视图：只隐藏「此刻之前」的行，仍在到达的新日志继续显示；可一键恢复 */
      clearBtn.addEventListener('click', function () {
        var last = buffer.length ? buffer[buffer.length - 1].ts : new Date().toISOString();
        hiddenBefore = new Date(last).getTime() || Date.now();
        renderedKeys = [];
        restoreBtn.hidden = false;
        fullRender();
        ui.toast('已清空视图（隐藏 ' + hiddenBeforeLabel() + '）', 'info');
      });

      restoreBtn.addEventListener('click', function () {
        hiddenBefore = 0;
        restoreBtn.hidden = true;
        renderedKeys = [];
        fullRender();
      });

      toolbar.appendChild(levelSelect);
      toolbar.appendChild(searchInput);
      toolbar.appendChild(pauseBtn);
      toolbar.appendChild(followBtn);
      toolbar.appendChild(el('div', { class: 'spacer' }));
      toolbar.appendChild(countPill);
      toolbar.appendChild(clearBtn);
      toolbar.appendChild(copyBtn);
      toolbar.appendChild(restoreBtn);

      root.appendChild(toolbar);
      root.appendChild(list);

      ctx.dispose(function () { alive = false; });

      /* 用户手动上滚时停止跟随 */
      list.addEventListener('scroll', function () {
        var atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
        if (!atBottom && follow) setFollow(false);
        else if (atBottom && !follow) {
          /* 回到底部时自动恢复跟随 */
          follow = true;
          followBtn.classList.add('is-on');
          followBtn.innerHTML = '';
          followBtn.appendChild(AB.icon('pause', 13));
          followBtn.appendChild(el('span', { class: 'btn-label', text: '跟随中' }));
        }
      });

      function hiddenCount() {
        if (!hiddenBefore) return 0;
        return buffer.filter(function (line) {
          return (new Date(line.ts).getTime() || 0) < hiddenBefore;
        }).length;
      }

      function hiddenBeforeLabel() {
        var count = hiddenCount();
        return count + ' 行更早的日志';
      }

      function visibleLines() {
        var minWeight = level ? (LEVEL_WEIGHT[level] || 0) : 0;
        return buffer.filter(function (line) {
          if (hiddenBefore && (new Date(line.ts).getTime() || 0) < hiddenBefore) return false;
          if ((LEVEL_WEIGHT[line.level] || 0) < minWeight) return false;
          if (search && line.msg.toLowerCase().indexOf(search) < 0 && line.level.indexOf(search) < 0) return false;
          return true;
        });
      }

      function lineKey(line) {
        return line.ts + '|' + line.level + '|' + line.msg;
      }

      function renderLabel() {
        var shown = visibleLines().length;
        var hidden = hiddenCount();
        countPill.textContent = '显示 ' + shown + ' / 缓冲 ' + buffer.length + ' 行' +
          (hidden ? '（已隐藏 ' + hidden + ' 行）' : '') + (paused ? '（已暂停）' : '');
      }

      function renderLine(line) {
        var node = el('div', { class: 'log-line lv-' + (line.level || 'info') }, [
          el('span', { class: 'log-ts', text: AB.fmt.clockTime(line.ts) }),
          el('span', { class: 'log-level', text: line.level || 'info' }),
          el('span', { class: 'log-msg', text: line.msg })
        ]);
        return node;
      }

      function emptyState() {
        if (AB.gatewayDown()) {
          /* 宿主不可用时用宿主级提示，避免把「无法连接宿主」说成「网关未运行」 */
          return AB.state.hostError
            ? ui.downPanel({})
            : ui.downPanel({
              desc: '网关未运行，日志接口（GET /api/bridge/logs）不可用。启动网关后这里会自动开始显示。'
            });
        }
        if (pollError) {
          return ui.alert({ tone: 'error', title: '读取日志失败', message: pollError.message });
        }
        if (hiddenBefore && buffer.length) {
          return ui.empty({
            icon: 'logs',
            title: '已清空视图',
            desc: '早于 ' + AB.fmt.clockTime(new Date(hiddenBefore).toISOString()) + ' 的 ' + hiddenCount() +
              ' 行已隐藏；新产生的日志会继续显示，点击「恢复显示」可重新查看全部。',
            actions: [ui.button('恢复显示', { size: 'sm', icon: 'eye', onClick: function () { restoreBtn.click(); } })]
          });
        }
        return ui.empty({
          icon: 'logs',
          title: '暂无日志',
          desc: '网关进程启动后会写入环形缓冲（容量 1000 行），这里每 2 秒拉取一次。'
        });
      }

      function fullRender() {
        var wasAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
        list.innerHTML = '';
        renderedKeys = [];
        var lines = visibleLines();
        if (!lines.length) {
          list.appendChild(emptyState());
          renderLabel();
          return;
        }
        var frag = document.createDocumentFragment();
        lines.forEach(function (line) {
          frag.appendChild(renderLine(line));
          renderedKeys.push(lineKey(line));
        });
        list.appendChild(frag);
        renderLabel();
        if (follow || wasAtBottom) scrollToBottom();
      }

      function appendNew() {
        var lines = visibleLines();
        if (!lines.length) {
          if (!renderedKeys.length) fullRender();
          renderLabel();
          return;
        }
        /* 过滤器变化或缓冲被裁剪时整体重渲染 */
        var isPrefix = lines.length >= renderedKeys.length;
        if (isPrefix) {
          for (var i = 0; i < renderedKeys.length; i++) {
            if (lineKey(lines[i]) !== renderedKeys[i]) { isPrefix = false; break; }
          }
        }
        if (!isPrefix) { fullRender(); return; }

        var wasAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
        var frag = document.createDocumentFragment();
        for (var j = renderedKeys.length; j < lines.length; j++) {
          frag.appendChild(renderLine(lines[j]));
          renderedKeys.push(lineKey(lines[j]));
        }
        list.appendChild(frag);
        renderLabel();
        if (follow && wasAtBottom) scrollToBottom();
      }

      function scrollToBottom() {
        list.scrollTop = list.scrollHeight;
      }

      /* ---------- polling ---------- */
      function mergeLines(lines) {
        var added = 0;
        lines.forEach(function (line) {
          if (!line || !line.msg) return;
          var key = lineKey(line);
          if (seen[key]) return;
          seen[key] = true;
          buffer.push(line);
          added += 1;
        });
        if (buffer.length > MAX_BUFFER) {
          var dropped = buffer.splice(0, buffer.length - MAX_BUFFER);
          dropped.forEach(function (line) { delete seen[lineKey(line)]; });
          renderedKeys = [];
          fullRender();
        }
        return added;
      }

      function refresh() {
        if (!alive || paused || document.hidden) return Promise.resolve();
        return AB.api.getLogs({ lines: 200 }).then(function (res) {
          pollError = null;
          mergeLines(res.lines || []);
          if (!list.querySelector('.log-line')) fullRender();
          else appendNew();
        }, function (err) {
          pollError = err;
          if (!buffer.length) fullRender();
        });
      }

      ctx.setInterval(function () { refresh(); }, 2000);

      /* 首次进入：给出加载态，随后开始轮询 */
      list.appendChild(ui.loading('正在读取日志…'));
      renderLabel();
      setPaused(false, true);
      setFollow(true);
      refresh().then(function () {
        if (!alive) return;
        if (!buffer.length) fullRender();
      });

      return {
        /* 从停止切回运行后立即补一轮，避免空态停留 2 秒 */
        onGatewayChange: function () {
          pollError = null;
          refresh();
        }
      };
    }
  });
})(window.AB);