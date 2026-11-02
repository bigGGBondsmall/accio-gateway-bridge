/* Accio Bridge — 测试视图: POST /api/bridge/test 的流式输出（CONTRACT §5）. */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  var el = AB.el;
  var ui = AB.ui;

  var DEFAULT_PROMPT = '你好，请用一句话介绍你自己，并说明你是本地模型还是云端模型。';

  AB.registerView('test', {
    title: '测试',

    mount: function (root, ctx) {
      var alive = true;
      var models = [];
      var selectedId = '';
      var running = false;
      var controller = null;
      var loadError = null;

      var host = el('div', { class: 'stack' });
      root.appendChild(host);

      var modelSelect = el('select', { class: 'select', 'aria-label': '选择要测试的模型' });
      modelSelect.addEventListener('change', function () { selectedId = modelSelect.value; });
      var modelMeta = el('div', { class: 'field-hint', text: '' });

      var promptInput = el('textarea', {
        class: 'textarea',
        rows: '3',
        placeholder: '输入提示词',
        'aria-label': '提示词'
      });
      promptInput.value = DEFAULT_PROMPT;

      var sendBtn = ui.button('发送', { variant: 'primary', icon: 'play' });
      var abortBtn = ui.button('中止', { icon: 'stop' });
      abortBtn.disabled = true;

      var output = el('div', { class: 'test-output', 'aria-live': 'polite' });
      var metaRow = el('div', { class: 'test-meta' });

      var errorHost = el('div');

      /* ---------- 请求 ---------- */
      ctx.setActions([
        ui.button('刷新模型', { size: 'sm', icon: 'refresh', onClick: function () { load(); } })
      ]);

      ctx.dispose(function () {
        alive = false;
        if (controller) controller.abort();
      });

      function load() {
        host.innerHTML = '';
        host.appendChild(ui.loading('正在读取已启用的模型…'));
        return AB.api.getModels().then(function (res) {
          if (!alive) return;
          models = (res.models || []).filter(function (m) { return m.enabled; });
          loadError = null;
          if (!selectedId || !models.some(function (m) { return m.id === selectedId; })) {
            selectedId = models.length ? models[0].id : '';
          }
          renderForm();
        }, function (err) {
          if (!alive) return;
          models = [];
          loadError = err;
          renderForm();
        });
      }

      function renderForm() {
        host.innerHTML = '';

        if (loadError) {
          host.appendChild(ui.viewError(loadError, function () { load(); }));
          return;
        }

        if (!models.length) {
          host.appendChild(el('section', { class: 'card' }, [
            ui.empty({
              icon: 'test',
              title: '没有已启用的模型',
              desc: '只有已启用的模型才能通过网关转发测试请求。请先在「供应商」或「模型」页面启用一个模型。',
              actions: [
                ui.button('去供应商页面', { variant: 'primary', icon: 'providers', onClick: function () { AB.navigate('providers'); } }),
                ui.button('去模型页面', { icon: 'models', onClick: function () { AB.navigate('models'); } })
              ]
            })
          ]));
          return;
        }

        /* 模型下拉 */
        modelSelect.innerHTML = '';
        models.forEach(function (model) {
          modelSelect.appendChild(el('option', {
            value: model.id,
            text: model.displayName + '（' + model.id + ' · ' + model.provider + '）',
            selected: model.id === selectedId
          }));
        });
        modelSelect.value = selectedId;
        updateModelMeta();

        var card = el('section', { class: 'card' });
        card.appendChild(el('div', { class: 'card-head' }, [
          el('span', { class: 'card-title', text: '模型连通性测试' }),
          el('span', { class: 'card-sub', text: '经由本地网关转发，流式输出按帧追加' })
        ]));

        var body = el('div', { class: 'card-body stack' });
        body.appendChild(el('div', { class: 'row' }, [
          ui.field({ label: '模型（仅已启用）', control: modelSelect }),
          el('div', { class: 'spacer' }),
          el('div', { class: 'stack-sm', style: 'min-width:180px' }, [modelMeta])
        ]));
        body.appendChild(ui.field({ label: '提示词', control: promptInput }));
        body.appendChild(el('div', { class: 'row' }, [
          sendBtn,
          abortBtn,
          el('span', { class: 'muted', text: 'POST /api/bridge/test（SSE 或 JSON）' })
        ]));
        body.appendChild(errorHost);
        card.appendChild(body);

        card.appendChild(el('div', { class: 'card-body is-flush' }, [
          output,
          metaRow
        ]));
        host.appendChild(card);

        setMeta([kv('状态', '未开始')]);
        sendBtn.disabled = false;
        abortBtn.disabled = true;
      }

      function updateModelMeta() {
        var model = null;
        models.forEach(function (m) { if (m.id === selectedId) model = m; });
        if (!model) { modelMeta.textContent = ''; return; }
        modelMeta.textContent = '上下文 ' + AB.fmt.contextWindow(model.contextWindow) +
          ' · ' + (model.multimodal ? '多模态' : '纯文本') +
          ' · ' + model.baseUrl;
        modelMeta.title = model.baseUrl;
      }
      modelSelect.addEventListener('change', updateModelMeta);

      function kv(label, value) {
        return el('span', { class: 'kv' }, [
          el('span', { class: 'muted', text: label + '：' }),
          el('b', { text: value })
        ]);
      }

      function setMeta(items) {
        metaRow.innerHTML = '';
        items.forEach(function (item, index) {
          if (index) metaRow.appendChild(el('span', { class: 'muted', text: '·' }));
          metaRow.appendChild(item);
        });
      }

      function setRunning(next) {
        running = next;
        sendBtn.disabled = next;
        abortBtn.disabled = !next;
        sendBtn.classList.toggle('is-busy', next);
        if (next) sendBtn.setAttribute('aria-busy', 'true');
        else sendBtn.removeAttribute('aria-busy');
      }

      sendBtn.addEventListener('click', function () { send(); });

      abortBtn.addEventListener('click', function () {
        if (controller) controller.abort();
      });

      function send() {
        if (running) return;
        var prompt = promptInput.value.trim();
        if (!prompt) {
          ui.toast('请输入提示词', 'warn');
          promptInput.focus();
          return;
        }
        if (!selectedId) {
          ui.toast('请选择一个已启用的模型', 'warn');
          return;
        }

        errorHost.innerHTML = '';
        output.innerHTML = '';
        output.textContent = '';
        setMeta([kv('状态', '正在连接…'), kv('模型', selectedId)]);
        setRunning(true);

        controller = new AbortController();
        var started = performance.now();
        var ttft = null;
        var lastContentType = '';

        function caret() {
          var node = el('span', { class: 'caret' });
          return node;
        }
        var caretNode = caret();
        output.appendChild(caretNode);

        function onText(chunk) {
          if (ttft === null) ttft = performance.now() - started;
          /* 光标始终停留在文本末尾 */
          output.insertBefore(document.createTextNode(chunk), caretNode);
        }

        AB.api.testStream({
          model: selectedId,
          prompt: prompt,
          signal: controller.signal,
          handlers: {
            onText: onText,
            onMeta: function (meta) { lastContentType = meta.contentType || ''; },
            onError: function (message) {
              errorHost.innerHTML = '';
              errorHost.appendChild(ui.alert({
                tone: 'error',
                title: '上游返回错误',
                message: message,
                mono: true
              }));
            }
          }
        }).then(function (res) {
          if (!alive) return;
          setRunning(false);
          caretNode.remove();
          var seconds = (res.totalMs || 1) / 1000;
          var perSec = res.chars ? Math.round(res.chars / seconds) : 0;
          var items = [
            kv('HTTP 状态', String(res.status)),
            kv('TTFT', ttft === null ? '—' : AB.fmt.ms(ttft)),
            kv('总耗时', AB.fmt.ms(res.totalMs)),
            kv('速率', perSec + ' 字符/秒'),
            kv('输出长度', res.chars + ' 字符'),
            kv('响应类型', lastContentType.indexOf('event-stream') >= 0 ? 'SSE 流式' : (lastContentType || '未知'))
          ];
          if (res.usage && res.usage.total) items.push(kv('tokens', String(res.usage.total)));
          if (res.error) {
            items.unshift(kv('结果', '上游错误'));
            if (!errorHost.childNodes.length) {
              errorHost.appendChild(ui.alert({
                tone: 'error',
                title: '响应帧中包含错误',
                message: res.error,
                mono: true
              }));
            }
          } else if (!res.chars) {
            items.unshift(kv('结果', '未返回文本'));
            errorHost.appendChild(ui.alert({
              tone: 'warn',
              message: '上游没有返回任何文本内容（HTTP ' + res.status + '，content-type: ' + (res.contentType || '未知') + '）。'
            }));
          } else {
            items.unshift(kv('结果', '成功'));
          }
          setMeta(items);
        }, function (err) {
          if (!alive) return;
          setRunning(false);
          caretNode.remove();
          if (err && err.name === 'AbortError') {
            setMeta([
              kv('结果', '已中止'),
              kv('已收到', output.textContent.length + ' 字符'),
              kv('总耗时', AB.fmt.ms(performance.now() - started))
            ]);
            return;
          }
          setMeta([
            kv('结果', '请求失败'),
            kv('HTTP 状态', err.status ? String(err.status) : '—'),
            kv('总耗时', AB.fmt.ms(performance.now() - started))
          ]);
          errorHost.innerHTML = '';
          errorHost.appendChild(ui.alert({
            tone: 'error',
            title: '测试失败',
            message: err.message || '未知错误',
            mono: true
          }));
        });
      }

      load();

      return {
        onGatewayChange: function (prev, next) {
          if (prev !== next) load();
        }
      };
    }
  });
})(window.AB);