import { scriptLabNames } from './script-lab-catalog.mjs';

const sources = {
  worldview: '/script-lab/worldview.json',
  'special-props': '/script-lab/special-props.json',
};

async function fetchCatalog(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Cannot open script library');
  return response.json();
}

function addOptions(select, { groups, items }, prefix = '') {
  const sections = new Map();
  for (const item of items) {
    if (!sections.has(item.group)) {
      const section = document.createElement('optgroup');
      section.label = prefix + groups[item.group];
      sections.set(item.group, section);
      select.append(section);
    }
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    sections.get(item.group).append(option);
  }
}

export function setupScriptLab(prompt, insertPrompt) {
  const category = document.getElementById('script-lab-category');
  const select = document.getElementById('script-lab-item');
  const insert = document.getElementById('script-lab-insert');
  const preview = document.getElementById('script-lab-preview');
  const text = document.getElementById('script-lab-text');
  const image = document.getElementById('script-lab-image');
  const status = document.getElementById('script-lab-status');
  const cache = new Map();
  let items = [];
  let selectionVersion = 0;

  function selectedItem() {
    return items.find(item => item.id === select.value);
  }

  function updatePreview() {
    const item = selectedItem();
    insert.disabled = !item;
    preview.hidden = !item;
    text.textContent = item?.text || '';
    image.hidden = !item?.image;
    if (item?.image) {
      image.src = '/script-lab/props/' + encodeURIComponent(item.image) + '.jpg';
      image.alt = item.label;
    } else {
      image.removeAttribute('src');
    }
  }

  async function builtinCatalog(kind) {
    if (!Object.hasOwn(sources, kind)) return null;
    if (!cache.has(kind)) cache.set(kind, await fetchCatalog(sources[kind]));
    return cache.get(kind);
  }

  async function loadCatalog(preserveSelection = false) {
    const previousItem = preserveSelection ? select.value : '';
    const version = ++selectionVersion;
    const kind = category.value;
    items = [];
    select.replaceChildren(new Option('選擇條目', ''));
    select.disabled = true;
    status.textContent = '';
    updatePreview();
    if (!Object.hasOwn(scriptLabNames, kind)) return;

    status.textContent = '正在讀取靈感庫……';
    const [builtin, published] = await Promise.allSettled([
      builtinCatalog(kind),
      fetchCatalog('/api/script-lab?library=' + encodeURIComponent(kind)),
    ]);
    if (version !== selectionVersion) return;
    if (builtin.status === 'fulfilled' && builtin.value) {
      addOptions(select, builtin.value);
      items.push(...builtin.value.items);
    }
    if (published.status === 'fulfilled') {
      addOptions(select, published.value, kind === 'custom' ? '' : '自訂・');
      items.push(...published.value.items);
    }
    select.disabled = !items.length;
    if (items.some(item => item.id === previousItem)) select.value = previousItem;
    updatePreview();
    if (builtin.status === 'rejected' || published.status === 'rejected') {
      status.textContent = items.length ? '部分靈感未能載入，請稍後重新選擇。' : '靈感庫讀取失敗，請稍後重新選擇。';
    } else {
      status.textContent = items.length ? '' : '這個分類目前沒有已上架的條目。';
    }
  }

  category.addEventListener('change', () => { void loadCatalog(); });
  document.addEventListener('script-lab-updated', () => { void loadCatalog(true); });
  document.addEventListener('studio-sectionchange', event => {
    if (event.detail.section === 'create' && category.value) void loadCatalog(true);
  });
  select.addEventListener('change', () => {
    status.textContent = '';
    updatePreview();
  });
  insert.addEventListener('click', () => {
    const item = selectedItem();
    if (!item) return;
    const cursor = prompt.selectionEnd;
    const before = cursor && prompt.value[cursor - 1] !== '\n' ? '\n\n' : '';
    const after = cursor < prompt.value.length && prompt.value[cursor] !== '\n' ? '\n\n' : '';
    const inserted = insertPrompt(before + item.text + after, cursor, cursor);
    status.textContent = inserted ? '已插入「' + item.label + '」。' : '提示詞超過字數上限。';
  });
  void loadCatalog();
}
