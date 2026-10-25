/**
 * 微信读书同步：Agent API Gateway 客户端 + 落库逻辑
 * 数据来源：/shelf/sync、/user/notebooks（游标分页）、/book/bookmarklist、/review/list/mine
 */
import { upsertBook, upsertHighlight, upsertThought, getDb, getMeta, setMeta, now } from './db.js';

const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';
const SKILL_VERSION = '1.0.5';

/** 配置/鉴权类错误不该重试，也不该把技术细节直接甩给用户 */
function fatal(message, hint) {
  const e = new Error(message);
  e.fatal = true;
  if (hint) e.hint = hint;
  return e;
}

const AUTH_HINT = '在终端执行 export WEREAD_API_KEY=wrk-xxxxxxxx 后重启服务（npm start）。Key 从微信读书 Agent API 获取。';

function apiKey() {
  const k = process.env.WEREAD_API_KEY;
  if (!k) throw fatal('还没有配置微信读书 API Key', AUTH_HINT);
  return k;
}

export async function call(apiName, params = {}, retry = 2) {
  const body = { api_name: apiName, skill_version: SKILL_VERSION, ...params };
  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const res = await fetch(GATEWAY, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      // 业务错误可能是 200 + errcode，所以先解析 body 再看状态码
      let json = null;
      try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
      const code = json && typeof json.errcode === 'number' ? json.errcode : 0;

      if (res.status === 401 || res.status === 403 || code === -2013 || code === -2012) {
        throw fatal('微信读书鉴权失败：API Key 无效或已过期', AUTH_HINT);
      }
      if (!res.ok) throw fatal(`微信读书接口返回 HTTP ${res.status}`);
      if (!json) throw new Error('微信读书接口返回的不是合法 JSON');
      if (json.upgrade_info) {
        throw fatal(`微信读书 Skill 需要升级：${json.upgrade_info.message || ''}`);
      }
      if (code !== 0) throw fatal(`微信读书接口错误：${json.errmsg || code}`);
      return json;
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;                  // 配置/鉴权错误重试没有意义
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 各接口封装 ---------------- */

export async function fetchShelf() {
  const d = await call('/shelf/sync');
  return (d.books || []).map((b) => ({
    bookId: b.bookId,
    title: b.title,
    author: b.author,
    cover: b.cover,
    category: b.category,
    finishReading: b.finishReading || 0,
    readUpdateTime: b.readUpdateTime || 0,
    readerLink: b.readerLink || '',
  }));
}

/** /user/notebooks 游标分页，拉取全部"有笔记的书" */
export async function fetchNotebooks(maxPages = 40) {
  const out = [];
  let lastSort;
  for (let page = 0; page < maxPages; page++) {
    const params = { count: 50 };
    if (lastSort) params.lastSort = lastSort;
    const d = await call('/user/notebooks', params);
    const books = d.books || [];
    if (!books.length) break;
    out.push(...books);
    if (!d.hasMore) break;
    lastSort = books[books.length - 1].sort;
    await sleep(120);
  }
  return out;
}

export async function fetchBookmarks(bookId) {
  const d = await call('/book/bookmarklist', { bookId });
  const chapters = new Map();
  for (const c of d.chapters || []) chapters.set(c.chapterUid, c.title);
  const updated = d.updated || [];
  return updated
    .filter((u) => u && u.markText && String(u.markText).trim().length >= 8)
    .map((u) => ({
      bookmarkId: u.bookmarkId,
      bookId: u.bookId || bookId,
      chapterUid: u.chapterUid || 0,
      chapterTitle: chapters.get(u.chapterUid) || '',
      markText: String(u.markText).trim(),
      createTime: u.createTime || 0,
      colorStyle: u.colorStyle || 0,
      source: 'my',
      popularity: 0,
    }));
}

export async function fetchMyReviews(bookId, maxPages = 6) {
  const out = [];
  let synckey = 0;
  for (let i = 0; i < maxPages; i++) {
    const d = await call('/review/list/mine', { bookid: bookId, synckey, count: 40 });
    const arr = (d.reviews || []).map((x) => x.review || x).filter(Boolean);
    for (const r of arr) {
      out.push({
        reviewId: r.reviewId,
        bookId,
        content: r.content || '',
        abstract: r.abstract || '',
        chapterName: r.chapterName || '',
        chapterUid: r.chapterUid || 0,
        createTime: r.createTime || 0,
        star: r.star ?? -1,
        kind: r.chapterUid ? 'chapter' : (r.abstract ? 'highlight_thought' : 'book'),
      });
    }
    if (!d.hasMore) break;
    synckey = d.synckey;
    if (!synckey) break;
    await sleep(100);
  }
  return out;
}

/* ---------------- 并发池 ---------------- */

async function pool(items, limit, worker) {
  const ret = [];
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      ret[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return ret;
}

/* ---------------- 主同步流程 ---------------- */

export const syncState = {
  running: false,
  phase: 'idle',
  total: 0,
  done: 0,
  books: 0,
  highlights: 0,
  thoughts: 0,
  message: '',
  startedAt: 0,
  finishedAt: 0,
  error: null,
  hint: '',
};

function reset() {
  syncState.running = true;
  syncState.phase = 'init';
  syncState.total = 0;
  syncState.done = 0;
  syncState.books = 0;
  syncState.highlights = 0;
  syncState.thoughts = 0;
  syncState.message = '';
  syncState.startedAt = now();
  syncState.finishedAt = 0;
  syncState.error = null;
  syncState.hint = '';
}

/**
 * @param {object} opt
 *   opt.limit       最多同步多少本"有笔记的书"（按笔记数降序），0 表示全部
 *   opt.includeShelf 是否同步整个书架（898 本，仅书信息，无划线）
 */
export async function runSync(opt = {}) {
  const { limit = 0, includeShelf = true } = opt;
  if (syncState.running) return syncState;
  reset();
  try {
    /* 阶段 1：书架 */
    let shelfCount = 0;
    if (includeShelf) {
      syncState.phase = 'shelf';
      syncState.message = '正在同步书架…';
      const shelf = await fetchShelf();
      for (const b of shelf) upsertBook(b);
      shelfCount = shelf.length;
      syncState.books = shelfCount;
      setMeta('shelf_count', shelfCount);
    }

    /* 阶段 2：有笔记的书 */
    syncState.phase = 'notebooks';
    syncState.message = '正在获取笔记概览…';
    const nbs = await fetchNotebooks();
    const scored = nbs
      .map((x) => ({
        bookId: x.bookId,
        book: x.book || {},
        score: (x.reviewCount || 0) + (x.noteCount || 0) + (x.bookmarkCount || 0),
        noteCount: x.noteCount || 0,
        reviewCount: x.reviewCount || 0,
        bookmarkCount: x.bookmarkCount || 0,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const targets = limit > 0 ? scored.slice(0, limit) : scored;
    syncState.total = targets.length;

    syncState.phase = 'detail';
    syncState.message = `正在同步 ${targets.length} 本书的划线与想法…`;

    await pool(targets, 4, async (t) => {
      try {
        const info = t.book || {};
        upsertBook({
          bookId: t.bookId,
          title: info.title || t.bookId,
          author: info.author || '',
          cover: info.cover || '',
          category: info.category || '',
          finishReading: info.finishReading || 0,
          readUpdateTime: info.readUpdateTime || 0,
          readerLink: info.readerLink || '',
          noteCount: t.noteCount,
          reviewCount: t.reviewCount,
          bookmarkCount: t.bookmarkCount,
        });

        const [marks, revs] = await Promise.all([
          fetchBookmarks(t.bookId).catch(() => []),
          fetchMyReviews(t.bookId).catch(() => []),
        ]);
        for (const m of marks) upsertHighlight(m);
        for (const r of revs) upsertThought(r);
        syncState.highlights += marks.length;
        syncState.thoughts += revs.length;
      } catch (e) {
        // 单本书失败不影响整体
      } finally {
        syncState.done++;
        syncState.message = `同步进度 ${syncState.done}/${syncState.total} · 已收划线 ${syncState.highlights} 条`;
      }
    });

    syncState.phase = 'done';
    syncState.message = '同步完成';
    setMeta('last_sync_at', now());
  } catch (e) {
    syncState.phase = 'error';
    syncState.error = String(e && e.message ? e.message : e);
    syncState.hint = (e && e.hint) || '';
    syncState.message = '同步失败：' + syncState.error;
  } finally {
    syncState.running = false;
    syncState.finishedAt = now();
  }
  return syncState;
}

export function stats() {
  const db = getDb();
  const g = (sql, ...p) => db.prepare(sql).get(...p) || {};
  return {
    books: g('SELECT COUNT(*) c FROM books').c || 0,
    highlights: g('SELECT COUNT(*) c FROM highlights').c || 0,
    thoughts: g('SELECT COUNT(*) c FROM thoughts').c || 0,
    insights: g('SELECT COUNT(*) c FROM insights').c || 0,
    favorites: g('SELECT COUNT(*) c FROM favorites').c || 0,
    likes: g('SELECT COUNT(*) c FROM likes').c || 0,
    lastSyncAt: Number(getMeta('last_sync_at', 0)),
  };
}
