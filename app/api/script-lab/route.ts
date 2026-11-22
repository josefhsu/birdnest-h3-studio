import { db } from '../../../lib/colab-auth';
import { studioIdentity } from '../../../lib/studio-access';
import { sameOrigin } from '../../../lib/studio-validation';
import { scriptLabNames } from '../../../public/script-lab-catalog.mjs';

type Library = keyof typeof scriptLabNames;
type Item = { library?: Library; group: string; label: string; text: string };
type Entry = {
  id: string;
  draft: string;
  published: string | null;
  revision: number;
};
const columns = 'id, draft, published, revision';
const entryId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

function editorEntry(row: Entry) {
  return {
    id: row.id,
    ...(JSON.parse(row.draft) as Item),
    revision: row.revision,
    published: row.published !== null,
    hasUnpublishedChanges: row.published !== null && row.draft !== row.published,
  };
}

function isLibrary(value: unknown): value is Library {
  return typeof value === 'string' && Object.hasOwn(scriptLabNames, value);
}

function validatedItem(value: Record<string, unknown>): Item | null {
  const { library = 'custom', group, label, text } = value;
  if (!isLibrary(library) || typeof group !== 'string' || typeof label !== 'string' || typeof text !== 'string') return null;
  const trimmedGroup = group.trim();
  if ((library === 'custom' && !trimmedGroup) || group.length > 40 ||
      !label.trim() || label.length > 100 || !text.trim() || text.length > 12000) return null;
  const item = { group: trimmedGroup || '自訂條目', label: label.trim(), text };
  return library === 'custom' ? item : { ...item, library };
}

export async function GET(request: Request) {
  try {
    const identity = await studioIdentity(request);
    if (!identity) return json({ error: '請先登入工作室。' }, 401);
    const params = new URL(request.url).searchParams;
    if (params.get('admin') === '1') {
      if (identity.role !== 'administrator') return json({ error: '此功能僅供管理員使用。' }, 403);
      const rows = await db().prepare('SELECT ' + columns + ' FROM songyin_script_lab_entries ORDER BY updated_at DESC').bind().all<Entry>();
      return json({ items: rows.results.map(editorEntry) });
    }
    const library = params.get('library') ?? 'custom';
    if (!isLibrary(library)) return json({ error: '找不到這個靈感庫。' }, 400);
    const rows = await db().prepare(`SELECT id, published FROM songyin_script_lab_entries
      WHERE published IS NOT NULL AND COALESCE(json_extract(published, '$.library'), 'custom') = ?
      ORDER BY updated_at DESC`).bind(library).all<{ id: string; published: string }>();
    const items = rows.results.map(row => {
      const { group, label, text } = JSON.parse(row.published) as Item;
      return { id: row.id, group, label, text };
    });
    return json({ groups: Object.fromEntries(items.map(({ group }) => [group, group])), items });
  } catch {
    return json({ error: '暫時無法讀取自訂靈感庫。' }, 503);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await studioIdentity(request);
    if (identity?.role !== 'administrator') return json({ error: '此功能僅供管理員使用。' }, 403);
  } catch {
    return json({ error: '請由管理員工作室送出。' }, 403);
  }

  let input: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 76000) return json({ error: '靈感條目過長。' }, 413);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ error: '靈感資料格式有誤。' }, 400);
    input = parsed;
  } catch {
    return json({ error: '靈感資料格式有誤。' }, 400);
  }
  const { id, action, revision } = input;
  if (typeof id !== 'string' || !entryId.test(id) || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    return json({ error: '靈感條目的識別資料有誤。' }, 400);
  }

  try {
    const time = Date.now();
    let row: Entry | null;
    if (action === 'unpublish' && revision > 0) {
      row = await db().prepare('UPDATE songyin_script_lab_entries SET published=NULL, revision=revision+1, updated_at=? WHERE id=? AND revision=? RETURNING ' + columns)
        .bind(time, id, revision).first<Entry>();
    } else if (action === 'save' || action === 'publish') {
      const item = validatedItem(input);
      if (!item) return json({ error: '請核對上架分類、分組（40 字內）、標題（100 字內）與劇本文字（12,000 字內）。' }, 400);
      const draft = JSON.stringify(item);
      const publish = action === 'publish';
      if (revision === 0) {
        row = await db().prepare('INSERT INTO songyin_script_lab_entries (id, draft, published, revision, updated_at) VALUES (?,?,?,1,?) ON CONFLICT(id) DO NOTHING RETURNING ' + columns)
          .bind(id, draft, publish ? draft : null, time).first<Entry>();
      } else {
        row = await db().prepare('UPDATE songyin_script_lab_entries SET draft=?, published=CASE WHEN ? THEN ? ELSE published END, revision=revision+1, updated_at=? WHERE id=? AND revision=? RETURNING ' + columns)
          .bind(draft, publish ? 1 : 0, draft, time, id, revision).first<Entry>();
      }
    } else {
      return json({ error: '無法辨識這個靈感庫操作。' }, 400);
    }
    if (!row) return json({ error: '條目已在其他頁面更新。請關閉並重新開啟管理視窗。' }, 409);
    return json({ item: editorEntry(row) });
  } catch {
    return json({ error: '靈感庫暫時無法儲存，請稍後再試。' }, 503);
  }
}
