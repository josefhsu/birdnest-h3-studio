(() => {
  const clock = document.getElementById('gpu-clock');
  if (!clock) return;
  const elapsed = document.getElementById('gpu-clock-elapsed');
  const remaining = document.getElementById('gpu-clock-remaining');
  const status = document.getElementById('gpu-clock-status');
  let runtime = null;
  let receivedAt = 0;
  let timer;

  function duration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    return [hours, minutes, seconds % 60].map(part => String(part).padStart(2, '0')).join(':');
  }

  function show(note, used = '—', left = '—') {
    if (status.textContent !== note) status.textContent = note;
    elapsed.textContent = used;
    remaining.textContent = left;
  }

  function refresh() {
    clearTimeout(timer);
    if (document.hidden || document.body.dataset.activeSection !== 'compute') return;
    const { phase, assignedAt, releasedAt, stopAt, checkedAt } = runtime || {};
    if (phase === 'assigning') {
      show(runtime.assignmentPaused ? 'GPU 申請暫停' : '等待 GPU 配發');
      return;
    }
    if (phase === 'stopped' || phase === 'error') {
      const used = assignedAt && releasedAt ? Math.floor(Math.max(0, releasedAt - assignedAt) / 1000) : null;
      show(phase === 'stopped' ? (assignedAt ? 'GPU 已釋放' : '尚未啟動') : 'GPU 執行未完成',
        used === null ? '—' : duration(used));
      return;
    }
    if (!Number.isFinite(assignedAt)) {
      show(phase ? '等待確認 GPU 配發' : '尚未啟動');
      return;
    }
    const now = (checkedAt || Date.now()) + Math.max(0, performance.now() - receivedAt);
    const used = Math.floor(Math.max(0, now - assignedAt) / 1000);
    const left = stopAt ? Math.ceil(Math.max(0, stopAt - now) / 1000) : null;
    const note = phase === 'stop_failed' ? '等待確認釋放'
      : left === 0 ? '已達上限・等待釋放'
      : phase === 'booting' ? 'GPU 已配發・啟動中'
      : 'GPU 運行中';
    show(note, duration(used), left === null ? 'Colab 預設' : duration(left));
    timer = setTimeout(refresh, 1000);
  }

  document.addEventListener('studio-gpu-status', event => {
    runtime = event.detail;
    receivedAt = performance.now();
    refresh();
  });
  document.addEventListener('studio-sectionchange', refresh);
  document.addEventListener('visibilitychange', refresh);
})();
