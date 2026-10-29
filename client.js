/**
 * prompt-layer — 浏览器端面板（右下角 PL 按钮）
 * 纯 DOM，不依赖 React；任何异常都只影响这个面板，不影响宿主界面。
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-layer',
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;
    exports.name = 'dsh-prompt-layer';
    exports.inject = [];

    const API = '/prompt-layer';
    const FAB_ID = 'pl-fab';
    const PANEL_ID = 'pl-panel';
    let panel = null;

    const CSS = `
      #${FAB_ID} {
        position: fixed; right: 18px; bottom: 18px; z-index: 10050;
        width: 40px; height: 40px; border-radius: 50%;
        border: 1px solid rgba(128,128,128,.4); background: rgba(30,30,30,.92);
        color: #e8e8e8; font: 600 12px/1 system-ui, sans-serif; cursor: pointer;
        box-shadow: 0 4px 14px rgba(0,0,0,.35);
      }
      #${FAB_ID}:hover { background: rgba(60,60,60,.95); }
      #${PANEL_ID} {
        position: fixed; right: 18px; bottom: 68px; z-index: 10050;
        width: 460px; max-width: calc(100vw - 36px); max-height: calc(100vh - 120px);
        display: flex; flex-direction: column; gap: 8px; padding: 12px 14px;
        background: rgba(24,24,26,.97); color: #e8e8e8;
        border: 1px solid rgba(128,128,128,.35); border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,.45);
        font: 12px/1.5 ui-monospace, Consolas, monospace;
      }
      #${PANEL_ID} .pl-h { display:flex; justify-content:space-between; align-items:center; font-weight:600; }
      #${PANEL_ID} .pl-row { white-space: pre-wrap; word-break: break-all; opacity: .85; }
      #${PANEL_ID} textarea {
        width: 100%; min-height: 180px; max-height: 42vh; resize: vertical;
        background: #111; color: #ddd; border: 1px solid rgba(128,128,128,.35);
        border-radius: 6px; padding: 8px; font: 12px/1.5 ui-monospace, Consolas, monospace;
      }
      #${PANEL_ID} .pl-btns { display:flex; gap:8px; justify-content:flex-end; }
      #${PANEL_ID} button {
        padding: 4px 10px; border-radius: 6px; cursor: pointer;
        border: 1px solid rgba(128,128,128,.4); background: #2a2a2c; color: #e8e8e8;
      }
      #${PANEL_ID} button.primary { background: #2f6f4f; border-color: #3c8a63; }
    `;

    function injectCss() {
      if (document.getElementById('pl-style')) return;
      const style = document.createElement('style');
      style.id = 'pl-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    async function getJson(path) {
      const response = await fetch(API + path, { headers: { accept: 'application/json' } });
      return response.json();
    }

    async function post(path, body) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return response.json();
    }

    function row(text) {
      const div = document.createElement('div');
      div.className = 'pl-row';
      div.textContent = text;
      return div;
    }

    async function open() {
      if (panel) return;
      injectCss();
      panel = document.createElement('div');
      panel.id = PANEL_ID;

      const head = document.createElement('div');
      head.className = 'pl-h';
      const title = document.createElement('span');
      title.textContent = 'prompt-layer';
      const close = document.createElement('button');
      close.textContent = '×';
      close.onclick = destroy;
      head.append(title, close);

      const info = row('读取中…');
      const editor = document.createElement('textarea');
      editor.spellcheck = false;
      editor.placeholder = '提示词正文…';

      const btns = document.createElement('div');
      btns.className = 'pl-btns';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'primary';
      saveBtn.textContent = '保存';
      const reloadBtn = document.createElement('button');
      reloadBtn.textContent = '重读';
      btns.append(reloadBtn, saveBtn);

      panel.append(head, info, editor, btns);
      document.body.appendChild(panel);

      try {
        const status = await getJson('/status');
        info.textContent = [
          `文件   ${status.promptFile || '(未配置)'}`,
          `生效   ${status.effective || '(未读取)'}`,
          `长度   ${status.chars} 字符   顺序 ${status.order}`,
          `基线   ${status.dropBaseline}    免审批 ${status.autoApprove ? '开' : '关'}${status.forceAsk ? '（策略兜底）' : ''}`,
          status.error ? `错误   ${status.error}` : '',
        ].filter(Boolean).join('\n');
        const body = await getJson('/text');
        editor.value = body.text || '';
      } catch (error) {
        info.textContent = '读取失败：' + (error && error.message ? error.message : error);
      }

      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        try {
          const result = await post('/save', { text: editor.value });
          info.textContent = result.ok ? `已保存 ${result.chars} 字符（下一轮生效）` : '保存失败：' + (result.error || '');
        } catch (error) {
          info.textContent = '保存失败：' + (error && error.message ? error.message : error);
        } finally {
          saveBtn.disabled = false;
        }
      };

      reloadBtn.onclick = async () => {
        try {
          const result = await post('/reload', {});
          const body = await getJson('/text');
          editor.value = body.text || '';
          info.textContent = `已重读 ${result.chars} 字符`;
        } catch (error) {
          info.textContent = '重读失败：' + (error && error.message ? error.message : error);
        }
      };
    }

    function destroy() {
      if (panel) {
        panel.remove();
        panel = null;
      }
    }

    exports.apply = function apply(ctx) {
      try {
        injectCss();
        if (document.getElementById(FAB_ID)) return;
        const fab = document.createElement('button');
        fab.id = FAB_ID;
        fab.textContent = 'PL';
        fab.title = 'prompt-layer 提示词层';
        fab.onclick = () => (panel ? destroy() : open());
        document.body.appendChild(fab);
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            destroy();
            fab.remove();
          });
        }
      } catch (error) {
        console.warn('[prompt-layer] panel init failed', error);
      }
    };

    return module.exports;
  },
});
