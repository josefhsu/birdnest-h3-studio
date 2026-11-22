(() => {
  'use strict';
  const panel = document.getElementById('generation-queue');
  if (!panel) return;

  const list = document.getElementById('generation-queue-items');
  const count = document.getElementById('queue-count');
  const message = document.getElementById('queue-message');
  const clear = document.getElementById('clear-generation-queue');
  const types = { video: '影片', image: '圖片', tts: '音訊', audio: '音訊' };
  let snapshot;
  let busy = false;
  let timer;
  let requestId = 0;

  const isVisible = () => !panel.hidden && !document.hidden;
  async function request(body) {
    const response = await fetch('/api/colab/queue', body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '目前無法取得生成排隊，請稍後再試。');
    return result;
  }

  function render() {
    if (!snapshot) return;
    const { items, cancellable } = snapshot;
    const label = items.length + ' 項等待中';
    count.textContent = !cancellable && items.length
      ? label + '。此批次啟動於更新前，下一批可使用刪除。'
      : label;
    clear.disabled = busy || !cancellable || !items.length;
    const previousFocus = list.contains(document.activeElement) ? document.activeElement.dataset.queueId : null;
    const rows = items.map(item => {
      const row = document.createElement('article');
      row.className = 'queue-row';
      const content = document.createElement('div');
      const title = document.createElement('strong');
      const type = item.operation === 'upscale' ? '影片放大' : (types[item.kind] || '生成');
      title.textContent = type + (Number.isFinite(item.seconds) ? '・' + item.seconds + ' 秒' : '');
      const prompt = document.createElement('p');
      prompt.textContent = item.prompt || item.id;
      content.append(title, prompt);
      const remove = document.createElement('button');
      remove.className = 'subtle-button queue-remove';
      remove.type = 'button';
      remove.textContent = '刪除';
      remove.dataset.queueId = item.id;
      remove.setAttribute('aria-label', '刪除排隊項目 ' + (item.prompt || item.id));
      remove.disabled = busy || !cancellable;
      row.append(content, remove);
      return row;
    });
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'queue-empty';
      empty.textContent = '目前沒有等待生成的工作。';
      rows.push(empty);
    }
    list.replaceChildren(...rows);
    if (previousFocus) {
      const target = [...list.querySelectorAll('button')].find(button => button.dataset.queueId === previousFocus);
      target?.focus({ preventScroll: true });
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (isVisible() && !busy) timer = setTimeout(refresh, 5000);
  }

  async function refresh() {
    if (!isVisible() || busy) return;
    const activeRequest = ++requestId;
    try {
      const next = await request();
      if (requestId === activeRequest && isVisible() && JSON.stringify(next) !== JSON.stringify(snapshot)) {
        if (!snapshot) message.textContent = '';
        snapshot = next;
        render();
      }
    } catch (error) {
      if (requestId === activeRequest && isVisible() && !snapshot) message.textContent = error.message;
    } finally {
      if (requestId === activeRequest) schedule();
    }
  }

  async function remove(body, confirmation) {
    if (busy || !snapshot?.cancellable || !window.confirm(confirmation)) return;
    busy = true;
    ++requestId;
    clearTimeout(timer);
    render();
    message.textContent = '正在更新排隊清單……';
    try {
      const result = await request({ ...body, batchId: snapshot.batchId });
      message.textContent = (result.removed ? '已移除 ' + result.removed + ' 項。' : '沒有項目可移除。') +
        (result.skipped ? ' 另有 ' + result.skipped + ' 項已離開等待狀態，已保留。' : '');
    } catch (error) {
      message.textContent = error.message;
    } finally {
      busy = false;
      render();
      void refresh();
    }
  }

  function updateVisibility() {
    ++requestId;
    clearTimeout(timer);
    if (isVisible()) void refresh();
  }

  clear.addEventListener('click', () => {
    void remove({ all: true }, '刪除目前所有等待生成的項目？生成中的工作會繼續執行。');
  });
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-queue-id]');
    if (button) void remove({ id: button.dataset.queueId }, '刪除這個等待生成的項目？');
  });
  document.addEventListener('studio-sectionchange', updateVisibility);
  document.addEventListener('visibilitychange', updateVisibility);
  updateVisibility();
})();
