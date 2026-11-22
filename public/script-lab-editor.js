import { scriptLabNames } from './script-lab-catalog.mjs';

(() => {
  const dialog = document.getElementById('script-lab-editor');
  if (!dialog) return;
  const open = document.getElementById('script-lab-manage');
  const close = document.getElementById('script-lab-close');
  const list = document.getElementById('script-lab-entries');
  const form = document.getElementById('script-lab-entry-form');
  const library = form.elements.namedItem('library');
  const group = form.elements.namedItem('group');
  const catalog = document.getElementById('script-lab-category');
  const status = document.getElementById('script-lab-editor-status');
  const unpublish = document.getElementById('script-lab-unpublish');
  let items = [];
  let current;
  let busy = false;

  async function request(body) {
    const response = await fetch(body ? '/api/script-lab' : '/api/script-lab?admin=1', body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '目前無法更新靈感庫。');
    return data;
  }

  function updateGroupField() {
    group.required = library.value === 'custom';
    group.placeholder = group.required ? '例如：台灣奇幻' : '選填，預設為自訂條目';
  }

  function selectEntry(item, updateFields = true) {
    current = item || { id: crypto.randomUUID(), revision: 0, group: '', label: '', text: '', library: catalog.value || 'custom' };
    const choices = items.map(entry => {
      const state = !entry.published ? '草稿' : entry.hasUnpublishedChanges ? '已上架・有草稿' : '已上架';
      const libraryName = scriptLabNames[entry.library || 'custom'];
      return new Option(entry.label + '（' + libraryName + '・' + state + '）', entry.id);
    });
    list.replaceChildren(new Option('新增條目', ''), ...choices);
    list.value = item?.id || '';
    unpublish.hidden = !item?.published;
    if (updateFields) {
      library.value = current.library || 'custom';
      updateGroupField();
      for (const name of ['group', 'label', 'text']) form.elements.namedItem(name).value = current[name];
    }
  }

  function setBusy(value) {
    busy = value;
    list.disabled = value;
    close.disabled = value;
    for (const input of form.elements) input.disabled = value;
    form.setAttribute('aria-busy', String(value));
  }

  open.addEventListener('click', async () => {
    dialog.showModal();
    setBusy(true);
    status.textContent = '正在讀取自訂靈感……';
    try {
      const data = await request();
      items = data.items;
      selectEntry(items.find(item => item.id === current?.id));
      status.textContent = '';
    } catch (error) {
      selectEntry(null);
      status.textContent = error.message;
    } finally {
      setBusy(false);
      if (dialog.open) list.focus();
    }
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => {
    if (busy) event.preventDefault();
  });
  library.addEventListener('change', updateGroupField);
  list.addEventListener('change', () => {
    selectEntry(items.find(item => item.id === list.value));
    status.textContent = '';
  });

  async function save(action) {
    if (!current || busy) return;
    const { id, revision } = current;
    const fields = Object.fromEntries(new FormData(form));
    setBusy(true);
    status.textContent = '正在儲存……';
    try {
      const { item } = await request({ id, revision, action, ...fields });
      items = [item, ...items.filter(entry => entry.id !== item.id)];
      selectEntry(item, action !== 'unpublish');
      if (action !== 'save') document.dispatchEvent(new Event('script-lab-updated'));
      status.textContent = {
        save: '草稿已儲存。',
        publish: '已上架至「' + scriptLabNames[item.library || 'custom'] + '」。',
        unpublish: '已下架，草稿已保留。',
      }[action];
    } catch (error) {
      status.textContent = error.message;
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    void save(event.submitter?.value || 'save');
  });
  unpublish.addEventListener('click', () => { void save('unpublish'); });
})();
