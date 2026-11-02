/* Accio Bridge — 供应商视图: 列表 + 编辑抽屉 + 添加供应商对话框. */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  var el = AB.el;
  var ui = AB.ui;

  /* 预设：全部使用官方 OpenAI 兼容地址 */
  var PRESETS = [
    { id: 'ollama', label: 'Ollama（本地）', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
    { id: 'lmstudio', label: 'LM Studio（本地）', provider: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' },
    { id: 'deepseek', label: 'DeepSeek', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
    { id: 'openai', label: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
    { id: 'openrouter', label: 'OpenRouter', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
    { id: 'siliconflow', label: '硅基流动 SiliconFlow', provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' },
    { id: 'dashscope', label: '通义千问 DashScope', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { id: 'moonshot', label: 'Moonshot Kimi', provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
    { id: 'zhipu', label: '智谱 GLM', provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    { id: 'custom', label: '自定义 OpenAI 兼容', provider: 'openai', baseUrl: '' }
  ];

  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return PRESETS[PRESETS.length - 1];
  }

  function modelMetaLine(model) {
    var parts = ['id ' + model.id];
    if (model.upstreamModel && model.upstreamModel !== model.id) parts.push('上游 ' + model.upstreamModel);
    parts.push('上下文 ' + AB.fmt.contextWindow(model.contextWindow));
    if (model.multimodal) parts.push('多模态');
    return parts.join(' · ');
  }

  AB.registerView('providers', {
    title: '供应商',

    mount: function (root, ctx) {
      var alive = true;
      var data = { providers: null, error: null };
      var drawerId = null;
      var drawerHandle = null;
      var inlineTests = {};

      var listHost = el('div', { class: 'stack' });
      root.appendChild(listHost);

      ctx.dispose(function () {
        alive = false;
        Object.keys(inlineTests).forEach(function (key) {
          if (inlineTests[key]) inlineTests[key].abort();
        });
        inlineTests = {};
      });

      var refreshBtn = ui.button('刷新', {
        size: 'sm', icon: 'refresh', title: '重新读取供应商列表',
        onClick: function () { load(); }
      });
      var addBtn = ui.button('添加供应商', {
        variant: 'primary', icon: 'plus',
        onClick: function () { openAddDialog(); }
      });
      ctx.setActions([refreshBtn, addBtn]);

      /* ---------- load + render list ---------- */
      function load() {
        listHost.innerHTML = '';
        listHost.appendChild(ui.loading('正在读取供应商…'));
        return AB.api.getProviders().then(function (res) {
          if (!alive) return;
          data.providers = res.providers || [];
          data.error = null;
          renderList();
        }, function (err) {
          if (!alive) return;
          data.providers = null;
          data.error = err;
          renderList();
        });
      }

      function renderList() {
        listHost.innerHTML = '';
        if (data.error) {
          listHost.appendChild(ui.viewError(data.error, function () { load(); }));
          return;
        }

        var providers = data.providers || [];
        var totalModels = providers.reduce(function (sum, p) { return sum + p.modelCount; }, 0);

        if (!providers.length) {
          var emptyCard = el('section', { class: 'card' }, [
            ui.empty({
              icon: 'providers',
              title: '还没有配置供应商',
              desc: '先检测本机推理服务（Ollama / LM Studio 等），或选择云端厂商填入 API Key。',
              actions: [
                ui.button('添加供应商', { variant: 'primary', icon: 'plus', onClick: function () { openAddDialog(); } }),
                ui.button('检测本机服务', { icon: 'search', onClick: function () { openAddDialog({ autoScan: true }); } })
              ]
            })
          ]);
          listHost.appendChild(emptyCard);
          return;
        }

        var card = el('section', { class: 'card' });
        card.appendChild(el('div', { class: 'card-head' }, [
          el('span', { class: 'card-title', text: '模型供应商' }),
          el('span', { class: 'card-sub', text: '共 ' + providers.length + ' 个供应商 · ' + totalModels + ' 个模型' })
        ]));
        card.appendChild(el('div', { class: 'prov-head' }, [
          el('span', { text: '' }),
          el('span', { text: '名称' }),
          el('span', { text: 'Base URL' }),
          el('span', { text: 'API Key' }),
          el('span', { text: '模型' }),
          el('span', { text: '类型' }),
          el('span', { text: '启用' })
        ]));

        var list = el('div', { class: 'prov-list' });
        providers.forEach(function (provider) {
          list.appendChild(providerRow(provider));
        });
        card.appendChild(list);
        listHost.appendChild(card);
      }

      function providerRow(provider) {
        var row = el('div', {
          class: 'prov-row' + (drawerId === provider.id ? ' is-open' : ''),
          dataset: { id: provider.id },
          onclick: function (event) {
            if (event.target.closest && event.target.closest('.prov-switch')) return;
            openDrawer(provider.id);
          }
        });

        row.appendChild(ui.dot(provider.enabled ? 'ok' : 'muted'));

        row.appendChild(el('button', {
          type: 'button',
          class: 'prov-name',
          title: '编辑 ' + provider.name,
          onclick: function (event) {
            event.stopPropagation();
            openDrawer(provider.id);
          }
        }, [
          el('span', { class: 'p-name', text: provider.name }),
          el('span', { class: 'p-provider', text: provider.provider })
        ]));

        row.appendChild(el('span', {
          class: 'prov-cell mono', title: provider.baseUrl, text: provider.baseUrl
        }));
        row.appendChild(el('span', {
          class: 'prov-cell mono',
          title: provider.hasKey ? '已配置 API Key（' + provider.apiKeyMasked + '）' : '未配置 API Key',
          text: provider.apiKeyMasked || '未配置'
        }));
        row.appendChild(el('span', {
          class: 'prov-cell is-count',
          title: provider.enabledCount + ' 个模型已启用，共 ' + provider.modelCount + ' 个',
          text: provider.enabledCount + '/' + provider.modelCount
        }));
        row.appendChild(el('span', {}, [
          ui.tag(provider.local ? '本地' : '云端', provider.local ? 'tag-local' : 'tag-cloud')
        ]));

        var sw = ui.switchControl({
          checked: provider.enabled,
          label: (provider.enabled ? '停用' : '启用') + ' ' + provider.name,
          title: '启用 / 停用该供应商下的全部模型',
          onChange: function (next, node) {
            node.setSwitchBusy(true);
            AB.api.patchProvider(provider.id, { enabled: next }).then(function (res) {
              if (!alive) return;
              node.setSwitchBusy(false);
              applyProviders(res.providers);
              ui.toast((next ? '已启用 ' : '已停用 ') + provider.name + (next ? '' : '（组内全部模型）'), next ? 'ok' : 'info');
            }, function (err) {
              node.setSwitchBusy(false);
              node.setChecked(!next);
              ui.toast(err.message || '更新失败', 'error');
            });
          }
        });
        sw.classList.add('prov-switch');
        row.appendChild(sw);
        return row;
      }

      function applyProviders(providers) {
        if (!providers) { load(); return; }
        data.providers = providers;
        data.error = null;
        renderList();
        if (drawerId && drawerHandle) {
          var exists = null;
          providers.forEach(function (p) { if (p.id === drawerId) exists = p; });
          if (!exists) { drawerHandle.close(); }
        }
      }

      function findProvider(id) {
        var found = null;
        (data.providers || []).forEach(function (p) { if (p.id === id) found = p; });
        return found;
      }

      /* ---------- drawer ---------- */
      function openDrawer(id) {
        var provider = findProvider(id);
        if (!provider) return;
        drawerId = id;

        var apiKeyField = ui.passwordField({
          placeholder: provider.hasKey ? '留空表示不修改' : '未配置（本地服务可留空）',
          label: 'API Key'
        });
        var baseUrlInput = el('input', {
          type: 'text', class: 'input mono', value: provider.baseUrl,
          spellcheck: 'false', 'aria-label': 'Base URL'
        });
        var saveBtn = ui.button('保存修改', { icon: 'check', onClick: function () { saveSettings(); } });
        var feedback = el('div');

        function saveSettings() {
          var baseUrl = baseUrlInput.value.trim();
          baseUrlInput.classList.remove('is-invalid');
          if (!/^https?:\/\//i.test(baseUrl)) {
            baseUrlInput.classList.add('is-invalid');
            showError('Base URL 必须以 http:// 或 https:// 开头');
            baseUrlInput.focus();
            return;
          }
          var patch = {};
          if (baseUrl !== provider.baseUrl) patch.baseUrl = baseUrl;
          if (apiKeyField.input.value) patch.apiKey = apiKeyField.input.value;
          if (!Object.keys(patch).length) {
            ui.toast('没有需要保存的修改', 'info');
            return;
          }
          ui.setBusy(saveBtn, true);
          AB.api.patchProvider(provider.id, patch).then(function (res) {
            ui.setBusy(saveBtn, false);
            if (!alive) return;
            apiKeyField.input.value = '';
            /* 分组名可能随 baseUrl 变化，提示里用响应里的名字 */
            ui.toast('已更新供应商 ' + ((res.provider && res.provider.name) || provider.name), 'ok');
            /* baseUrl/apiKey 变化会让分组 id 变化：先切到新 id，再按新 id 重建抽屉 */
            var nextId = (res.provider && res.provider.id) ? res.provider.id : provider.id;
            drawerId = nextId;
            applyProviders(res.providers);
            rebuildDrawer(nextId);
          }, function (err) {
            ui.setBusy(saveBtn, false);
            showError(err.message || '保存失败');
          });
        }

        function showError(message) {
          feedback.innerHTML = '';
          feedback.appendChild(ui.alert({ tone: 'error', message: message }));
        }

        var body = [];
        body.push(el('div', { class: 'stack-sm' }, [
          ui.field({ label: 'Base URL', control: baseUrlInput, hint: '服务地址，修改后会作用于该组全部模型' }),
          ui.field({
            label: 'API Key',
            control: apiKeyField.control,
            hint: '留空表示不修改；留空时不会发送 apiKey 字段'
          }),
          el('div', { class: 'row' }, [saveBtn]),
          feedback
        ]));

        /* 模型列表 */
        var modelSection = buildModelSection(provider);
        body.push(modelSection);

        var deleteBtn = ui.button('删除供应商', {
          variant: 'danger', icon: 'trash',
          onClick: function () {
            ui.confirm({
              title: '删除供应商',
              message: '将删除「' + provider.name + '」及其下的 ' + provider.modelCount + ' 个模型。',
              detail: provider.baseUrl,
              confirmText: '删除',
              danger: true
            }).then(function (ok) {
              if (!ok) return;
              return AB.api.deleteProvider(provider.id).then(function (res) {
                ui.toast('已删除供应商 ' + provider.name + '（' + (res.deleted || []).length + ' 个模型）', 'ok');
                drawerId = null;
                if (drawerHandle) drawerHandle.close();
                load();
              }, function (err) {
                ui.toast(err.message || '删除失败', 'error');
              });
            });
          }
        });

        drawerHandle = ui.openLayer({
          kind: 'drawer',
          title: provider.name,
          subtitle: provider.baseUrl + ' · ' + (provider.local ? '本地服务' : '云端服务') + ' · ' + provider.provider,
          body: body,
          footer: [deleteBtn, el('div', { class: 'spacer' }), ui.button('关闭', { onClick: function () { drawerHandle.close(); } })],
          onClose: function () {
            drawerHandle = null;
            drawerId = null;
            abortInlineTests();
            renderList();
          }
        });
      }

      function rebuildDrawer(id) {
        var provider = findProvider(id);
        if (!provider) return;
        /* 旧抽屉可能因为分组 id 变化已被 applyProviders 关掉，这里允许没句柄时直接重开 */
        if (drawerHandle) drawerHandle.close();
        drawerId = id;
        openDrawer(id);
      }

      function buildModelSection(provider) {
        var section = el('div', { class: 'stack-sm' });
        var pullHost = el('div');

        var pullBtn = ui.button('拉取模型', {
          size: 'sm', icon: 'download',
          title: 'POST /api/bridge/discover/models',
          onClick: function () { pullModels(provider, pullHost, pullBtn); }
        });

        section.appendChild(el('div', { class: 'section-head' }, [
          el('span', { class: 'section-title', text: '模型（' + provider.modelCount + '）' }),
          el('div', { class: 'spacer' }),
          pullBtn
        ]));
        section.appendChild(pullHost);

        if (!provider.models.length) {
          section.appendChild(ui.empty({
            icon: 'models',
            title: '该供应商下没有模型',
            desc: '使用「拉取模型」从上游获取，或在添加供应商时手动填写。'
          }));
        }

        provider.models.forEach(function (model) {
          section.appendChild(modelItem(provider, model));
        });

        return section;
      }

      function modelItem(provider, model) {
        var node = el('div', { class: 'model-item' });

        var head = el('div', { class: 'model-item-head' });
        head.appendChild(ui.switchControl({
          checked: model.enabled,
          small: true,
          label: (model.enabled ? '停用' : '启用') + ' ' + model.displayName,
          onChange: function (next, sw) {
            sw.setSwitchBusy(true);
            AB.api.patchModel(model.id, { enabled: next }).then(function (res) {
              sw.setSwitchBusy(false);
              applyProviders(res.providers);
            }, function (err) {
              sw.setSwitchBusy(false);
              sw.setChecked(!next);
              ui.toast(err.message || '更新失败', 'error');
            });
          }
        }));
        head.appendChild(el('span', { class: 'model-item-name ellipsis', title: model.displayName, text: model.displayName }));

        var star = el('button', {
          type: 'button',
          class: 'star' + (model.isDefault ? ' is-on' : ''),
          'aria-label': model.isDefault ? '当前默认模型' : '设为默认模型',
          'aria-pressed': model.isDefault ? 'true' : 'false',
          title: model.isDefault ? '默认模型' : '设为默认',
          onclick: function () {
            AB.api.patchModel(model.id, { isDefault: true }).then(function (res) {
              ui.toast('默认模型已切换为 ' + model.displayName, 'ok');
              applyProviders(res.providers);
            }, function (err) {
              ui.toast(err.message || '设置默认失败', 'error');
            });
          }
        }, [AB.icon('star', 15)]);

        var editBtn = ui.button('编辑', { size: 'sm', icon: 'edit' });
        var testBtn = ui.button('测试', { size: 'sm', icon: 'play' });
        var removeBtn = ui.button('删除', { size: 'sm', icon: 'trash' });

        head.appendChild(el('div', { class: 'model-item-actions' }, [
          star,
          editBtn,
          testBtn,
          removeBtn
        ]));
        node.appendChild(head);
        node.appendChild(el('div', { class: 'model-item-meta', text: modelMetaLine(model) }));

        /* 编辑表单 */
        var form = el('div', { class: 'model-edit' });
        var nameInput = el('input', { type: 'text', class: 'input', value: model.displayName, 'aria-label': '显示名' });
        var upstreamInput = el('input', { type: 'text', class: 'input mono', value: model.upstreamModel, 'aria-label': '上游模型 id' });
        var contextInput = el('input', {
          type: 'number', class: 'input', value: model.contextWindow || '', min: '0', step: '1000',
          'aria-label': '上下文窗口'
        });
        var multimodal = el('input', { type: 'checkbox' });
        multimodal.checked = !!model.multimodal;
        var saveModelBtn = ui.button('保存', { size: 'sm', variant: 'primary', icon: 'check' });
        var cancelModelBtn = ui.button('取消', { size: 'sm' });

        form.appendChild(ui.field({ label: '显示名', control: nameInput }));
        form.appendChild(ui.field({ label: '上游模型 id', control: upstreamInput }));
        form.appendChild(ui.field({ label: '上下文窗口', control: contextInput, hint: '单位 tokens，例如 64000' }));
        form.appendChild(ui.field({
          label: '多模态',
          control: el('label', { class: 'check' }, [multimodal, el('span', { text: '支持图片输入' })])
        }));
        form.appendChild(el('div', { class: 'row field-span' }, [saveModelBtn, cancelModelBtn]));

        editBtn.addEventListener('click', function () {
          form.classList.toggle('is-open');
        });
        cancelModelBtn.addEventListener('click', function () {
          nameInput.value = model.displayName;
          upstreamInput.value = model.upstreamModel;
          contextInput.value = model.contextWindow || '';
          multimodal.checked = !!model.multimodal;
          form.classList.remove('is-open');
        });
        saveModelBtn.addEventListener('click', function () {
          var patch = {
            displayName: nameInput.value.trim() || model.id,
            upstreamModel: upstreamInput.value.trim() || model.id,
            multimodal: multimodal.checked
          };
          var cw = Number(contextInput.value);
          if (!isNaN(cw) && cw > 0) patch.contextWindow = Math.round(cw);
          ui.setBusy(saveModelBtn, true);
          AB.api.patchModel(model.id, patch).then(function (res) {
            ui.setBusy(saveModelBtn, false);
            ui.toast('已保存模型 ' + patch.displayName, 'ok');
            applyProviders(res.providers);
            rebuildDrawer(provider.id);
          }, function (err) {
            ui.setBusy(saveModelBtn, false);
            ui.toast(err.message || '保存失败', 'error');
          });
        });

        node.appendChild(form);

        /* 行内测试 */
        var testHost = el('div', { class: 'inline-test' });
        node.appendChild(testHost);

        var activeTest = null;
        testBtn.addEventListener('click', function () {
          if (activeTest) {
            activeTest.abort();
            return;
          }
          activeTest = runInlineTest(model, testHost, testBtn, function () { activeTest = null; });
        });

        removeBtn.addEventListener('click', function () {
          ui.confirm({
            title: '删除模型',
            message: '从配置中删除「' + model.displayName + '」（id ' + model.id + '）。',
            confirmText: '删除',
            danger: true
          }).then(function (ok) {
            if (!ok) return;
            return AB.api.deleteModel(model.id).then(function (res) {
              ui.toast('已删除模型 ' + model.displayName, 'ok');
              applyProviders(res.providers);
              rebuildDrawer(provider.id);
            }, function (err) {
              ui.toast(err.message || '删除失败', 'error');
            });
          });
        });

        return node;
      }

      function abortInlineTests() {
        Object.keys(inlineTests).forEach(function (key) {
          if (inlineTests[key]) inlineTests[key].abort();
          delete inlineTests[key];
        });
      }

      function runInlineTest(model, host, btn, onSettled) {
        host.innerHTML = '';
        var out = el('div', { class: 'inline-test-out', text: '' });
        var meta = el('div', { class: 'inline-test-meta', text: '正在请求上游…' });
        host.appendChild(out);
        host.appendChild(meta);

        var controller = new AbortController();
        inlineTests[model.id] = controller;
        btn.innerHTML = '';
        btn.appendChild(AB.icon('stop', 13));
        btn.appendChild(el('span', { class: 'btn-label', text: '停止' }));

        var started = performance.now();
        var ttft = null;

        AB.api.testStream({
          model: model.id,
          prompt: 'ping',
          temperature: 0,
          signal: controller.signal,
          handlers: {
            onText: function (chunk) {
              if (ttft === null) ttft = performance.now() - started;
              out.textContent += chunk;
            }
          }
        }).then(function (res) {
          delete inlineTests[model.id];
          resetButton();
          if (res.error) {
            meta.textContent = '上游返回错误 · ' + AB.fmt.ms(res.totalMs) + ' · HTTP ' + res.status;
            return;
          }
          meta.textContent = 'TTFT ' + AB.fmt.ms(ttft) + ' · 总耗时 ' + AB.fmt.ms(res.totalMs) +
            ' · ' + res.chars + ' 字符 · HTTP ' + res.status;
        }, function (err) {
          delete inlineTests[model.id];
          resetButton();
          if (err && err.name === 'AbortError') {
            meta.textContent = '已中止 · 已收到 ' + out.textContent.length + ' 字符';
            return;
          }
          meta.textContent = '失败：' + (err.message || '未知错误');
          if (!out.textContent) out.textContent = (err.message || '') + '\n';
        });

        function resetButton() {
          if (onSettled) onSettled();
          btn.innerHTML = '';
          btn.appendChild(AB.icon('play', 13));
          btn.appendChild(el('span', { class: 'btn-label', text: '测试' }));
        }
        return controller;
      }

      /* ---------- 拉取模型（抽屉） ---------- */
      function pullModels(provider, host, btn) {
        host.innerHTML = '';
        var form = el('div', { class: 'stack-sm' });
        var note = el('div', {
          class: 'field-hint',
          text: provider.hasKey
            ? '使用分组里已保存的 API Key（服务端复用 provider/baseUrl/apiKey，无需重新输入）'
            : ''
        });
        var goBtn = ui.button('开始拉取', {
          size: 'sm', icon: 'refresh',
          onClick: function () { run(); }
        });
        form.appendChild(el('div', { class: 'row' }, [goBtn, note]));
        host.appendChild(form);

        function run() {
          ui.setBusy(goBtn, true);
          note.textContent = '正在请求 ' + provider.baseUrl + ' …';
          /* v1.1：只发 providerId，明文 key 由服务端按分组取用 */
          AB.api.discoverModels({ providerId: provider.id }).then(function (res) {
            ui.setBusy(goBtn, false);
            if (!alive) return;
            if (res.ok === false && (!res.models || !res.models.length)) {
              note.textContent = '';
              host.innerHTML = '';
              host.appendChild(ui.alert({ tone: 'warn', message: res.error || '上游未返回模型列表' }));
              host.appendChild(form);
              return;
            }
            renderResults(res.models || []);
          }, function (err) {
            ui.setBusy(goBtn, false);
            note.textContent = '失败：' + (err.message || '未知错误');
          });
        }

        function renderResults(ids) {
          host.innerHTML = '';
          if (!ids.length) {
            host.appendChild(ui.alert({ tone: 'info', message: '上游返回了空列表' }));
            host.appendChild(form);
            return;
          }
          var existing = {};
          provider.models.forEach(function (m) { existing[m.id] = true; });
          var box = el('div', { class: 'discover-svc' }, [
            el('div', { class: 'discover-svc-head' }, [
              el('span', { class: 'discover-name', text: '上游可用模型（' + ids.length + '）' }),
              el('span', { class: 'muted', text: '点击添加' })
            ])
          ]);
          var chips = el('div', { class: 'chips' });
          ids.forEach(function (id) {
            var added = !!existing[id];
            var chip = el('button', {
              type: 'button',
              class: 'chip',
              disabled: added,
              title: added ? '已添加' : '添加 ' + id,
              onclick: function () { addModel(id, chip); }
            }, [el('span', { text: id }), added ? el('span', { class: 'chip-tag', text: '已添加' }) : null]);
            chips.appendChild(chip);
          });
          box.appendChild(chips);
          host.appendChild(box);
        }

        function addModel(id, chip) {
          chip.disabled = true;
          AB.api.addProviderModels(provider.id, [
            { id: id, upstreamModel: id, displayName: id }
          ]).then(function (res) {
            ui.toast('已添加模型 ' + id, 'ok');
            applyProviders(res.providers);
            rebuildDrawer(res.provider && res.provider.id ? res.provider.id : provider.id);
          }, function (err) {
            chip.disabled = false;
            ui.toast(err.message || '添加模型失败', 'error');
          });
        }
      }

      /* ---------- 添加供应商对话框 ---------- */
      function openAddDialog(options) {
        options = options || {};
        var form = {
          preset: 'ollama',
          provider: 'ollama',
          baseUrl: PRESETS[0].baseUrl,
          models: [] /* { id, displayName } */
        };

        var presetSelect = el('select', { class: 'select', 'aria-label': '预设' });
        PRESETS.forEach(function (preset) {
          presetSelect.appendChild(el('option', { value: preset.id, text: preset.label, selected: preset.id === form.preset }));
        });

        var protocolSelect = el('select', { class: 'select', 'aria-label': '协议类型' }, [
          el('option', { value: 'ollama', text: 'Ollama 原生（/api/tags）' }),
          el('option', { value: 'openai', text: 'OpenAI 兼容（/v1）' })
        ]);
        protocolSelect.value = form.provider;

        var baseUrlInput = el('input', {
          type: 'text', class: 'input mono', value: form.baseUrl, spellcheck: 'false', 'aria-label': 'Base URL'
        });
        var keyField = ui.passwordField({ placeholder: '本地服务可留空', label: 'API Key' });

        var errorHost = el('div', { class: 'form-error' });
        var modelsHost = el('div', { class: 'added-models' });
        var discoverHost = el('div', { class: 'discover-list' });
        var discoverNote = el('div', { class: 'field-hint', text: '检测常见本机推理服务端口，点模型即可加入。' });

        var manualInput = el('input', {
          type: 'text', class: 'input mono', placeholder: '例如 llama3.2:3b', 'aria-label': '手动输入模型 id'
        });

        var remoteHost = el('div', { class: 'stack-sm' });

        var submitBtn = ui.button('添加供应商', { variant: 'primary', icon: 'plus', onClick: submit });

        /* 预设切换 */
        presetSelect.addEventListener('change', function () {
          var preset = presetById(presetSelect.value);
          form.preset = preset.id;
          form.provider = preset.provider;
          protocolSelect.value = preset.provider;
          baseUrlInput.value = preset.baseUrl;
          baseUrlInput.classList.remove('is-invalid');
          modelsHost.innerHTML = '';
          form.models = [];
          renderModels();
        });
        protocolSelect.addEventListener('change', function () {
          form.provider = protocolSelect.value;
        });

        function showError(message) {
          errorHost.innerHTML = '';
          errorHost.appendChild(ui.alert({ tone: 'error', message: message }));
        }
        function clearError() { errorHost.innerHTML = ''; }

        function hasModel(id) {
          var found = false;
          form.models.forEach(function (m) { if (m.id === id) found = true; });
          return found;
        }

        function addModelToList(id, displayName) {
          if (!id || hasModel(id)) return;
          form.models.push({ id: id, displayName: displayName || id });
          renderModels();
        }

        function renderModels() {
          modelsHost.innerHTML = '';
          if (!form.models.length) {
            modelsHost.appendChild(el('div', { class: 'field-hint', text: '尚未选择模型：可从下方检测结果、拉取列表或手动输入。' }));
            return;
          }
          form.models.forEach(function (item, index) {
            var row = el('div', { class: 'added-model' });
            row.appendChild(AB.icon('box', 13));
            row.appendChild(el('div', { class: 'ellipsis mono', title: item.id }, [
              el('span', { text: item.id })
            ]));
            row.appendChild(ui.button('移除', {
              size: 'sm', icon: 'trash', iconOnly: true, ariaLabel: '移除 ' + item.id,
              onClick: function () {
                form.models.splice(index, 1);
                renderModels();
                renderChipsState();
              }
            }));
            modelsHost.appendChild(row);
          });
        }

        /* 检测本机服务 */
        var scanBtn = ui.button('检测本机服务', {
          size: 'sm', icon: 'search',
          onClick: function () { scan(true); }
        });

        function scan(force) {
          discoverHost.innerHTML = '';
          discoverHost.appendChild(ui.loading('正在扫描本机推理服务…'));
          AB.api.discover(force === true).then(function (res) {
            if (!alive) return;
            discoverHost.innerHTML = '';
            var services = res.services || [];
            if (!services.length) {
              discoverHost.appendChild(ui.empty({
                icon: 'search',
                title: '未发现本机服务',
                desc: '没有检测到 Ollama / LM Studio / vLLM 等本地推理服务，可在下方手动填写云端 Base URL。'
              }));
              return;
            }
            services.forEach(function (service) {
              var already = {};
              (service.alreadyAdded || []).forEach(function (id) { already[id] = true; });
              var box = el('div', { class: 'discover-svc' });
              box.appendChild(el('div', { class: 'discover-svc-head' }, [
                el('span', { class: 'discover-name', text: service.name }),
                ui.tag(service.provider === 'ollama' ? 'Ollama 原生' : 'OpenAI 兼容'),
                el('span', { class: 'muted mono', text: service.baseUrl }),
                el('div', { class: 'spacer' }),
                el('span', { class: 'muted', text: (service.latencyMs || 0) + ' ms' }),
                ui.button('填入', {
                  size: 'sm', icon: 'arrowDown',
                  onClick: function () { fillFrom(service); }
                })
              ]));
              var chips = el('div', { class: 'chips' });
              (service.models || []).forEach(function (id) {
                var added = !!already[id];
                chips.appendChild(el('button', {
                  type: 'button',
                  class: 'chip' + (form.models.some(function (m) { return m.id === id; }) ? ' is-on' : ''),
                  disabled: added,
                  dataset: { modelId: id },
                  title: added ? '已添加' : '加入 ' + id,
                  onclick: function () {
                    fillFrom(service);
                    addModelToList(id);
                    renderChipsState();
                  }
                }, [el('span', { text: id }), added ? el('span', { class: 'chip-tag', text: '已添加' }) : null]));
              });
              box.appendChild(chips);
              discoverHost.appendChild(box);
            });
          }, function (err) {
            if (!alive) return;
            discoverHost.innerHTML = '';
            discoverHost.appendChild(ui.alert({ tone: 'error', message: err.message || '检测失败' }));
          });
        }

        function fillFrom(service) {
          form.provider = service.provider === 'ollama' ? 'ollama' : 'openai';
          protocolSelect.value = form.provider;
          baseUrlInput.value = service.baseUrl;
          baseUrlInput.classList.remove('is-invalid');
        }

        function renderChipsState() {
          var chips = discoverHost.querySelectorAll('.chip');
          Array.prototype.forEach.call(chips, function (chip) {
            var id = chip.dataset.modelId;
            if (!id) return;
            chip.classList.toggle('is-on', hasModel(id));
          });
          remoteHost.innerHTML = '';
        }

        /* 拉取远端模型 */
        var pullBtn = ui.button('拉取模型列表', {
          size: 'sm', icon: 'download',
          title: 'POST /api/bridge/discover/models',
          onClick: function () {
            var baseUrl = baseUrlInput.value.trim();
            if (!/^https?:\/\//i.test(baseUrl)) {
              baseUrlInput.classList.add('is-invalid');
              showError('Base URL 必须以 http:// 或 https:// 开头');
              baseUrlInput.focus();
              return;
            }
            ui.setBusy(pullBtn, true);
            remoteHost.innerHTML = '';
            remoteHost.appendChild(ui.loading('正在请求 ' + baseUrl + ' …'));
            AB.api.discoverModels({
              provider: protocolSelect.value,
              baseUrl: baseUrl,
              apiKey: keyField.input.value
            }).then(function (res) {
              ui.setBusy(pullBtn, false);
              if (!alive) return;
              remoteHost.innerHTML = '';
              if (res.ok === false && (!res.models || !res.models.length)) {
                remoteHost.appendChild(ui.alert({ tone: 'warn', message: res.error || '上游未返回模型列表' }));
                return;
              }
              var chips = el('div', { class: 'chips' });
              (res.models || []).forEach(function (id) {
                chips.appendChild(el('button', {
                  type: 'button',
                  class: 'chip' + (hasModel(id) ? ' is-on' : ''),
                  dataset: { modelId: id },
                  onclick: function () {
                    if (hasModel(id)) return;
                    addModelToList(id);
                    this.classList.add('is-on');
                    renderModels();
                  }
                }, [el('span', { text: id })]));
              });
              remoteHost.appendChild(el('div', { class: 'field-hint', text: '点击模型加入列表（共 ' + (res.models || []).length + ' 个）' }));
              remoteHost.appendChild(chips);
            }, function (err) {
              ui.setBusy(pullBtn, false);
              remoteHost.innerHTML = '';
              remoteHost.appendChild(ui.alert({ tone: 'error', message: err.message || '拉取失败' }));
            });
          }
        });

        manualInput.addEventListener('keydown', function (event) {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          var id = manualInput.value.trim();
          if (!id) return;
          addModelToList(id);
          manualInput.value = '';
        });

        function submit() {
          clearError();
          var baseUrl = baseUrlInput.value.trim();
          baseUrlInput.classList.remove('is-invalid');
          if (!/^https?:\/\//i.test(baseUrl)) {
            baseUrlInput.classList.add('is-invalid');
            showError('Base URL 必须以 http:// 或 https:// 开头，例如 http://127.0.0.1:11434');
            baseUrlInput.focus();
            return;
          }
          if (!form.models.length) {
            showError('至少需要选择一个模型：可从检测结果、拉取列表或手动输入。');
            return;
          }
          var payload = {
            provider: protocolSelect.value,
            baseUrl: baseUrl,
            models: form.models.map(function (m) {
              return { id: m.id, upstreamModel: m.id, displayName: m.displayName || m.id };
            })
          };
          if (keyField.input.value) payload.apiKey = keyField.input.value;

          ui.setBusy(submitBtn, true);
          AB.api.createProvider(payload).then(function (res) {
            ui.setBusy(submitBtn, false);
            ui.toast('已添加供应商 ' + ((res.provider && res.provider.name) || baseUrl) +
              '（' + payload.models.length + ' 个模型）', 'ok');
            handle.close();
            load();
          }, function (err) {
            ui.setBusy(submitBtn, false);
            showError(err.message || '添加供应商失败');
          });
        }

        var handle = ui.openLayer({
          kind: 'dialog',
          wide: true,
          title: '添加供应商',
          body: [
            errorHost,
            el('div', { class: 'row' }, [
              ui.field({ label: '预设', control: presetSelect }),
              ui.field({ label: '协议类型', control: protocolSelect, hint: '所有 OpenAI 兼容服务都选 OpenAI 兼容' })
            ]),
            el('div', { class: 'row' }, [
              ui.field({ label: 'Base URL', control: baseUrlInput, hint: '必须带 http:// 或 https://' }),
              el('div', { style: 'width:200px;flex:none' }, [
                ui.field({ label: 'API Key', control: keyField.control, hint: '本地服务可留空' })
              ])
            ]),
            el('div', { class: 'section-head' }, [
              el('span', { class: 'section-title', text: '模型' }),
              el('div', { class: 'spacer' }),
              pullBtn
            ]),
            remoteHost,
            el('div', { class: 'row' }, [
              manualInput,
              ui.button('添加 id', { size: 'sm', icon: 'plus', onClick: function () {
                var id = manualInput.value.trim();
                if (!id) return;
                addModelToList(id);
                manualInput.value = '';
              } })
            ]),
            modelsHost,
            el('div', { class: 'section-head', style: 'margin-top:6px' }, [
              el('span', { class: 'section-title', text: '检测本机服务' }),
              el('div', { class: 'spacer' }),
              scanBtn
            ]),
            discoverNote,
            discoverHost
          ],
          footer: [
            el('div', { class: 'spacer' }),
            ui.button('取消', { onClick: function () { handle.close(); } }),
            submitBtn
          ]
        });

        renderModels();
        scan(options.autoScan === true);
      }

      load();

      return {
        update: function () {},
        onGatewayChange: function (prev, next) {
          if (prev !== next) load();
        }
      };
    }
  });
})(window.AB);