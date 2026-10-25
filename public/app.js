/* 「流动的书」前端逻辑 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------- 工具 ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts) * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function fmtDateTime(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function dayKey(ts) {
    const d = new Date(Number(ts));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function relTime(ts) {
    const diff = Date.now() - Number(ts);
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
    if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
    return fmtDateTime(ts);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
  }

  async function api(url, opt = {}) {
    const res = await fetch(url, {
      method: opt.method || 'GET',
      headers: opt.body ? { 'Content-Type': 'application/json' } : {},
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (j.error) throw new Error(j.error);
    return j;
  }

  /* ---------- 状态 ---------- */
  const state = {
    view: 'today',
    today: { day: '', cards: [] },
    // 4000+ 张卡片，12 张/页要翻 300 多页，24 张/页更实际
    lib: { page: 1, size: 24, q: '', book: '', favOnly: false, total: 0, pages: 1 },
    detailCache: new Map(),
    booksAll: [],
    keyConfigured: true,   // 由 /api/stats 决定，false 时页面顶部给出配置指引
  };

  /* ---------- 顶部提示条（未配置 Key / 同步报错） ---------- */
  const setupBar = $('#setupBar');
  const setupTx = setupBar.querySelector('.setup-tx');
  const setupDefault = setupTx.innerHTML;

  function showSetup(title, bodyHtml, mode) {
    setupTx.innerHTML = `<b>${esc(title)}</b><p>${bodyHtml}</p>`;
    setupBar.dataset.mode = mode;
    setupBar.classList.remove('hidden');
  }
  function resetSetup() {
    setupTx.innerHTML = setupDefault;
    setupBar.dataset.mode = 'nokey';
    setupBar.classList.remove('hidden');
  }

  /* ---------- 卡片渲染 ---------- */
  function coverHTML(c, title) {
    if (c && c.cover) {
      return `<img class="cover" src="${esc(c.cover)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cover',textContent:'${esc((title || '书').slice(0, 1))}'}))" />`;
    }
    return `<div class="cover">${esc((title || '书').slice(0, 1))}</div>`;
  }

  function badgesHTML(c) {
    const b = [];
    if (c.favorited) b.push('<span class="badge">已收藏</span>');
    if (c.insight_count > 0) b.push(`<span class="badge g">${c.insight_count} 条感悟</span>`);
    if (c.review_due && c.review_due <= todayStr()) b.push('<span class="badge d">待复习</span>');
    return b.length ? `<div class="badges">${b.join('')}</div>` : '';
  }

  function cardHTML(c) {
    return `
      <article class="card" data-id="${c.id}">
        <div class="card-inner">
          <div class="card-face card-front">
            ${badgesHTML(c)}
            <div class="quote-mark">&ldquo;</div>
            <p class="quote">${esc(c.mark_text)}</p>
            <div class="front-meta">
              <div class="fm-book">《${esc(c.book_title || '未知书目')}》</div>
              <div class="fm-author">${esc(c.author || '')}</div>
            </div>
            <div class="front-foot">
              <span class="chapter">${esc(c.chapter_title || '')}</span>
              <span class="hint">点击翻面 →</span>
            </div>
          </div>
          <div class="card-face card-back" data-loaded="0"></div>
        </div>
      </article>`;
  }

  function backHTML(d) {
    const c = d.card, b = d.book || {};
    const t = d.matchedThought;
    const ins = d.insights || [];
    const insightsOf = (k) => ins.filter((i) => (i.kind || 'insight') === k);

    const items = (k) => insightsOf(k).map((i) => `
      <div class="insight-item ${k === 'action' ? 'a' : ''}" data-ins="${i.id}">
        <span class="kind">${k === 'action' ? '行动' : '感悟'}</span>
        <div class="txt">${esc(i.content)}<time>${fmtDateTime(i.created_at)}</time></div>
        <button class="del" data-act="del-insight" data-id="${i.id}" title="删除">×</button>
      </div>`).join('');

    return `
      <div class="bk-scroll">
        <div class="bk-head">
          ${coverHTML(b, b.title)}
          <div style="min-width:0">
            <div class="bk-title">《${esc(b.title || c.book_title || '未知')}》</div>
            <div class="bk-meta">
              ${esc(b.author || c.author || '佚名')}${b.category ? ' · ' + esc(b.category) : ''}
              <br>划线于 ${fmtDate(c.create_time) || '未知'} · 全书 ${c.book_highlight_count || 0} 条划线 / ${c.book_thought_count || 0} 条想法
              ${c.reader_link ? `<a class="bk-reader" href="${esc(c.reader_link)}" target="_blank" rel="noopener">打开阅读 ↗</a>` : ''}
            </div>
            <div class="bk-tags">
              ${c.chapter_title ? `<span class="tag">${esc(c.chapter_title)}</span>` : ''}
              ${b.finish_reading ? '<span class="tag">已读完</span>' : ''}
              ${c.topic_label
                ? `<span class="topic-chip" data-act="topic" data-topic="${c.topic_id}" title="看看同一主题下别的书怎么讲"># ${esc(c.topic_label)}</span>`
                : ''}
            </div>
          </div>
        </div>

        <div class="sec ai-sec" id="aiSec-${c.id}">
          <div class="sec-t">AI 解读 <span class="ai-tag" id="aiTag-${c.id}"></span></div>
          <button class="btn ai-btn" data-act="ai-interpret" data-text="${esc(c.mark_text)}" data-book="${esc(c.book_title || '')}">✨ 让 AI 帮我读这一句</button>
          <div class="ai-box" id="aiBox-${c.id}"></div>
        </div>

        <div class="sec">
          <div class="sec-t">当时我在微信读书的想法</div>
          ${t && t.content
            ? `<div class="thought">${esc(t.content)}</div>`
            : `<div class="empty-mini">这条划线当时没有留下想法 —— 现在补上也不迟。</div>`}
        </div>

        <div class="sec">
          <div class="sec-t">现在的感悟</div>
          ${items('insight')}
          <div class="write-row">
            <input class="input" placeholder="它让你想到了什么？" data-in="insight" />
            <button class="btn sm" data-act="add-insight" data-kind="insight">记下</button>
          </div>
        </div>

        <div class="sec">
          <div class="sec-t">行动结果</div>
          ${items('action')}
          <div class="write-row">
            <input class="input" placeholder="因此你做了什么？" data-in="action" />
            <button class="btn sm" data-act="add-insight" data-kind="action">记下</button>
          </div>
        </div>

        <div class="hint" style="text-align:center;margin-top:14px">— 点击空白处翻回正面 —</div>
      </div>
      <div class="bk-actions">
        <button class="act ${c.liked ? 'on' : ''}" data-act="like">${c.liked ? '♥' : '♡'} 同感</button>
        <button class="act g ${c.favorited ? 'on' : ''}" data-act="fav">${c.favorited ? '★' : '☆'} 收藏</button>
        <button class="act" data-act="share">⤓ 成图</button>
        <span class="spacer"></span>
        <button class="act r" data-act="review" data-q="0">忘了</button>
        <button class="act" data-act="review" data-q="1">记得</button>
        <button class="act" data-act="review" data-q="2">简单</button>
      </div>`;
  }

  /** 把详情数据画到卡片背面，并挂上「可滚动」提示 */
  function paintBack(back, d) {
    back.innerHTML = backHTML(d);
    back.dataset.loaded = '1';
    const sc = $('.bk-scroll', back);
    if (!sc) return;
    const upd = () => {
      back.classList.toggle('scrollable', sc.scrollHeight > sc.clientHeight + 2);
      back.classList.toggle('at-end', sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4);
    };
    sc.addEventListener('scroll', upd, { passive: true });
    upd();
  }

  async function loadBack(cardEl) {
    const id = cardEl.dataset.id;
    const back = $('.card-back', cardEl);
    if (back.dataset.loaded === '1') return;
    back.innerHTML = '<div class="bk-scroll"><div class="empty-mini">加载中…</div></div>';
    try {
      const d = await api('/api/cards/detail?id=' + id);
      state.detailCache.set(String(id), d);
      paintBack(back, d);
    } catch (e) {
      back.innerHTML = `<div class="bk-scroll"><div class="empty-mini">加载失败：${esc(e.message)}</div></div>`;
    }
  }

  function todayStr() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* ---------- 卡片成图（Canvas 手绘，无第三方依赖） ---------- */
  const POSTER = { W: 1080, H: 1350, PAD: 104, NOTE_Y: 980, NOTE_H: 220 };
  const SERIF = '"Songti SC","Noto Serif CJK SC","Source Han Serif SC",Georgia,serif';
  const SANS = '-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

  /** 按 CJK/西文分词，避免把英文单词从中间切断 */
  function tokenize(text) {
    return String(text).match(/[A-Za-z0-9][A-Za-z0-9'’\-.]*|\s+|[\s\S]/g) || [];
  }

  function wrapLines(ctx, text, maxW) {
    const lines = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const tk of tokenize(para)) {
        const t = line + tk;
        if (line.trim() && ctx.measureText(t).width > maxW) {
          lines.push(line.replace(/\s+$/, ''));
          line = tk.replace(/^\s+/, '');
        } else {
          line = t;
        }
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    // 避头尾：标点不落在行首，挂回上一行行尾
    const noStart = '，。、；：？！）》」』】%,.;:?!)]}';
    for (let i = 1; i < lines.length; i++) {
      while (lines[i] && noStart.includes(lines[i][0])) {
        lines[i - 1] += lines[i][0];
        lines[i] = lines[i].slice(1);
      }
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** 把一张卡片画成 1080×1350 的分享海报 */
  function drawPoster(d) {
    const { W, H, PAD, NOTE_Y, NOTE_H } = POSTER;
    const S = 2; // 2 倍图，导出的 PNG 为 2160×2700
    const cv = document.createElement('canvas');
    cv.width = W * S; cv.height = H * S;
    const ctx = cv.getContext('2d');
    ctx.scale(S, S);
    ctx.textBaseline = 'alphabetic';

    const c = d.card, b = d.book || {};
    const ins = (d.insights || []).filter((i) => (i.kind || 'insight') === 'insight')[0];
    const todo = (d.insights || []).filter((i) => i.kind === 'action')[0];
    const note = ins ? ins.content : (todo ? todo.content : '');

    // 背景与边框
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#fffdf8'); g.addColorStop(1, '#f5eddf');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#e6ddcb'; ctx.lineWidth = 2;
    ctx.strokeRect(30, 30, W - 60, H - 60);

    // 页眉
    ctx.fillStyle = '#96551f';
    ctx.font = `600 22px ${SANS}`;
    ctx.fillText('流动的书', PAD, 108);
    ctx.fillStyle = '#918878';
    ctx.font = `400 18px ${SANS}`;
    ctx.textAlign = 'right';
    ctx.fillText(fmtDate(Date.now() / 1000), W - PAD, 108);
    ctx.textAlign = 'left';
    ctx.strokeStyle = '#e6ddcb'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, 140); ctx.lineTo(W - PAD, 140); ctx.stroke();

    // 正文：按篇幅挑字号，保证不溢出；再在可用区域里垂直居中，避免下半部大片留白
    const textW = W - PAD * 2;
    const availTop = 306;
    const availBottom = note ? NOTE_Y - 16 : H - 148;
    const sigH = 112; // 出处三行（书名 / 作者 / 章节）的预留高度
    const textMax = Math.max(200, availBottom - availTop - sigH);

    let fs = 27, lines = [];
    for (const s of [46, 42, 38, 34, 30, 27]) {
      ctx.font = `400 ${s}px ${SERIF}`;
      const ls = wrapLines(ctx, c.mark_text, textW);
      fs = s; lines = ls;
      if (ls.length * s * 1.78 <= textMax) break;
    }
    const lh = fs * 1.78;
    const maxLines = Math.max(1, Math.floor(textMax / lh));
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = lines[maxLines - 1].replace(/[，。、,.]$/, '') + '……';
    }

    const blockH = lines.length * lh + sigH;
    const bodyTop = availTop + Math.max(0, (availBottom - availTop - blockH) / 2);

    // 引号装饰跟随正文
    ctx.fillStyle = '#efe1cd';
    ctx.font = `700 130px ${SERIF}`;
    ctx.fillText('\u201C', PAD - 10, bodyTop - 28);

    ctx.fillStyle = '#231e18';
    ctx.font = `400 ${fs}px ${SERIF}`;
    lines.forEach((l, i) => ctx.fillText(l, PAD, bodyTop + i * lh + fs * 0.92));

    // 出处：书名 / 作者 / 章节分行，避免长章节名和作者连成一串
    let y = bodyTop + lines.length * lh + 54;
    ctx.fillStyle = '#231e18';
    ctx.font = `600 ${fs >= 38 ? 26 : 24}px ${SERIF}`;
    ctx.fillText(`《${b.title || c.book_title || '未知'}》`, PAD, y);
    y += 30;
    const author = b.author || c.author || '';
    if (author) {
      ctx.fillStyle = '#8d8377';
      ctx.font = `400 19px ${SANS}`;
      ctx.fillText(author, PAD, y);
    }
    if (c.chapter_title) {
      y += 26;
      ctx.fillStyle = '#a89a86';
      ctx.font = `400 17px ${SANS}`;
      ctx.fillText(c.chapter_title, PAD, y);
    }

    // 我的感悟 —— 框高随内容收缩，短感悟不会留一大块空
    if (note) {
      const ns = 21, nlh = ns * 1.9;
      const nMax = Math.max(1, Math.floor((NOTE_H - 74) / nlh));
      let nls = wrapLines(ctx, note, textW - 54);
      if (nls.length > nMax) {
        nls = nls.slice(0, nMax);
        nls[nMax - 1] = nls[nMax - 1].replace(/[，。、,.]$/, '') + '……';
      }
      const noteH = Math.min(NOTE_H, 74 + nls.length * nlh + 16);
      ctx.fillStyle = 'rgba(244,231,215,.68)';
      roundRect(ctx, PAD, NOTE_Y, textW, noteH, 14); ctx.fill();

      ctx.fillStyle = '#96551f';
      ctx.font = `600 16px ${SANS}`;
      ctx.fillText(ins ? '我的感悟' : '我的行动', PAD + 26, NOTE_Y + 38);

      ctx.fillStyle = '#4a4137';
      ctx.font = `400 ${ns}px ${SANS}`;
      nls.forEach((l, i) => ctx.fillText(l, PAD + 26, NOTE_Y + 74 + i * nlh));
    }

    // 页脚
    ctx.fillStyle = '#a89a86';
    ctx.font = `400 16px ${SANS}`;
    ctx.fillText('每天，让读过的书重新经过你一次', PAD, H - 64);
    ctx.textAlign = 'right';
    ctx.fillText('流动的书 · 阅读复习助手', W - PAD, H - 64);
    ctx.textAlign = 'left';

    return cv;
  }

  /* ---------- 瀑布流布局 ----------
     grid 细行（2px）+ 每张卡片按自身高度换算 grid-row span。
     只测量卡片正面撑出的高度，背面是绝对定位，不参与测量。 */
  const ROW_H = 2, GRID_GAP = 18;

  function masonry(root) {
    if (!root) return;
    for (const c of $$('.card', root)) {
      // 视图隐藏时高度为 0，跳过，等 ResizeObserver 在显示后补算
      const h = c.offsetHeight;
      if (!h) continue;
      c.style.gridRowEnd = 'span ' + Math.ceil((h + GRID_GAP) / ROW_H);
    }
  }
  function masonryAll() {
    ['#todayCards', '#libCards', '#topicCards'].forEach((s) => masonry($(s)));
  }
  // 同步算一次（读 offsetHeight 会强制布局），再用一帧兜底捕获字体/图片落位后的变化
  function relayout() {
    masonryAll();
    requestAnimationFrame(masonryAll);
  }

  /* ---------- 视图：今日 ---------- */
  async function renderToday(force = false) {
    const box = $('#todayCards');
    box.innerHTML = '<div class="empty">正在挑选今天的卡片…</div>';
    const d = await api('/api/cards/daily?n=6' + (force ? '&r=' + Date.now() : ''));
    state.today = d;
    if (!d.cards.length) {
      const noKey = !state.keyConfigured;
      box.innerHTML = `
        <div class="empty">
          <b>还没有卡片</b>
          <p>${noKey
            ? '配置好 API Key 之后，这里会出现每天回顾的卡片。'
            : '把微信读书里的划线同步过来，它们就会变成每天回顾的卡片。'}</p>
          ${noKey ? '' : '<button class="btn primary" id="emptySync">立即同步</button>'}
        </div>`;
      const es = $('#emptySync');
      if (es) es.onclick = startSync;
      $('#todayTip').textContent = '';
      $('#btnShuffle').disabled = true;
      return;
    }
    $('#btnShuffle').disabled = false;
    box.innerHTML = d.cards.map(cardHTML).join('');
    $('#todayTip').textContent = `${d.cards.length} 张 · 每天 0 点自动换新`;
    relayout();
    fillDailyIntro(d.cards);
  }

  /** 今日 AI 导语：把今天的卡片拼成一段提示，调用解读接口生成一句鼓励语（按日期缓存） */
  async function fillDailyIntro(cards) {
    const el = $('#dailyIntro');
    if (!el) return;
    const day = todayStr();
    const cacheKey = 'dailyIntro:' + day;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) { el.innerHTML = `<span class="di-mark">✨</span><span>${esc(JSON.parse(cached))}</span>`; el.classList.remove('hidden'); return; }
    } catch { /* ignore */ }
    const text = cards.slice(0, 6).map((c) => `${c.book_title || ''}：${c.mark_text || ''}`).join('\n');
    if (!text.trim()) return;
    el.classList.add('hidden');
    try {
      const r = await api('/api/ai/interpret', { method: 'POST', body: { text, mode: 'daily' } });
      if (r.interpretation) {
        localStorage.setItem(cacheKey, JSON.stringify(r.interpretation));
        el.innerHTML = `<span class="di-mark">✨</span><span>${esc(r.interpretation)}</span>`;
        el.classList.remove('hidden');
      }
    } catch { /* 导语失败不影响主流程 */ }
  }

  async function shuffleToday() {
    const box = $('#todayCards');
    const exclude = $$('.card', box).map((e) => e.dataset.id).join(',');
    const d = await api(`/api/cards/random?n=6&exclude=${exclude}`);
    box.innerHTML = d.cards.length
      ? d.cards.map(cardHTML).join('')
      : '<div class="empty"><b>没有更多卡片了</b>试试同步更多书籍</div>';
    $('#todayTip').textContent = '随机一批 · 刷新或点「换一批」再换';
    relayout();
  }

  /* ---------- 视图：卡片库 ---------- */
  async function renderLibrary() {
    const { page, size, q, book, favOnly } = state.lib;
    const url = `/api/cards/library?page=${page}&size=${size}&q=${encodeURIComponent(q)}&book_id=${encodeURIComponent(book)}&favorited=${favOnly ? 1 : 0}`;
    const d = await api(url);
    state.lib.total = d.total;
    const pages = Math.max(1, Math.ceil(d.total / size));
    // 筛选后结果变少时，当前页可能越界：回到最后一页重取，不要显示"没有匹配的卡片"
    if (page > pages) { state.lib.page = pages; return renderLibrary(); }
    state.lib.pages = pages;
    $('#libPager').textContent = `${page} / ${pages}`;
    $('#libPrev').disabled = page <= 1;
    $('#libNext').disabled = page >= pages;
    $('#libCards').innerHTML = d.cards.length
      ? d.cards.map(cardHTML).join('')
      : '<div class="empty"><b>没有匹配的卡片</b>换个关键词试试</div>';
    relayout();
  }

  /* ---------- 视图：收藏夹 ---------- */
  async function renderFavorites() {
    const d = await api('/api/favorites?size=200');
    const box = $('#favList');
    if (!d.items.length) {
      box.innerHTML = '<div class="empty"><b>收藏夹还是空的</b>遇到有同感的卡片，点「收藏」并写下此刻的想法</div>';
      return;
    }
    box.innerHTML = d.items.map((i) => `
      <div class="fav-item">
        <div class="fav-body">
          <div class="fav-quote">${esc(i.mark_text)}</div>
          <div class="fav-book">《${esc(i.book_title || '未知')}》 ${esc(i.author || '')}${i.chapter_title ? ' · ' + esc(i.chapter_title) : ''}</div>
          ${i.fav_note ? `<div class="fav-note">${esc(i.fav_note)}</div>` : ''}
        </div>
        <div class="fav-side">
          <b>${esc(dayKey(i.fav_at))}</b>
          ${esc(relTime(i.fav_at))}
          <div style="margin-top:8px;display:flex;gap:6px;justify-content:flex-end">
            <button class="btn sm ghost" data-act="goto" data-id="${i.highlight_id}">查看</button>
            <button class="btn sm ghost" data-act="unfav" data-id="${i.highlight_id}">取消收藏</button>
          </div>
        </div>
      </div>`).join('');
  }

  /* ---------- 视图：我的感悟 ---------- */
  let insightsData = [];
  async function renderInsights() {
    const d = await api('/api/insights/all?size=300');
    insightsData = d.items;
    const box = $('#insightList');
    if (!d.items.length) {
      box.innerHTML = '<div class="empty"><b>还没有写下感悟</b>翻开任意卡片，在背面记下此刻的想法</div>';
      $('#insightTip').textContent = '';
      return;
    }
    $('#insightTip').textContent = `共 ${d.items.length} 条 · 感悟 ${d.items.filter(i => i.kind !== 'action').length} / 行动 ${d.items.filter(i => i.kind === 'action').length}`;
    const byDay = new Map();
    for (const i of d.items) {
      const k = dayKey(i.created_at);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(i);
    }
    box.innerHTML = Array.from(byDay.entries()).map(([day, arr]) => `
      <div class="tl-day">
        <div class="tl-date">${esc(day)}</div>
        ${arr.map((i) => `
          <div class="tl-item">
            <span class="tl-kind ${i.kind === 'action' ? 'a' : ''}">${i.kind === 'action' ? '行动' : '感悟'}</span>
            <span style="font-size:11.5px;color:var(--ink-3)">${esc(fmtDateTime(i.created_at))}</span>
            <div class="tl-txt">${esc(i.content)}</div>
            <div class="tl-src" data-act="goto" data-id="${i.target_id}">来自《${esc(i.book_title || '未知')}》 — ${esc((i.mark_text || '').slice(0, 40))}…</div>
          </div>`).join('')}
      </div>`).join('');
  }

  /* ---------- 视图：书架 ---------- */
  async function renderBooks() {
    const q = $('#bookSearch').value.trim();
    const hasNotes = $('#bookHasNotes').checked;
    const d = await api(`/api/books?size=120&q=${encodeURIComponent(q)}&with_notes=${hasNotes ? 1 : 0}`);
    const box = $('#bookList');
    if (!d.items.length) { box.innerHTML = '<div class="empty"><b>没有匹配的书</b></div>'; return; }
    box.innerHTML = d.items.map((b) => `
      <div class="book-card" data-book="${esc(b.book_id)}">
        ${coverHTML(b, b.title)}
        <div style="min-width:0">
          <h4>${esc(b.title)}</h4>
          <p>${esc(b.author || '佚名')}</p>
          <div class="cnt">${b.highlight_count || 0} 张卡片 · ${b.thought_count || 0} 条想法</div>
        </div>
      </div>`).join('');
  }

  /* ---------- 视图：主题 ---------- */
  const topicState = { open: null, page: 1, size: 24, total: 0 };

  async function renderTopics() {
    const d = await api('/api/topics');
    if (!d.topics.length) {
      $('#topicTip').textContent = '';
      $('#topicList').innerHTML = '<div class="empty"><b>卡片太少，还聚不出主题</b>先同步微信读书</div>';
      return;
    }
    $('#topicTip').textContent = `${d.topics.length} 个主题 · 卡片多的排前面`;
    $('#topicList').innerHTML = d.topics.map((t) => `
      <div class="topic-card" data-topic="${t.id}">
        <h4>${esc(t.label)}</h4>
        <div class="topic-meta"><b>${t.cardCount}</b> 张卡片 · 跨 <b>${t.bookCount}</b> 本书</div>
        <div class="topic-samples">
          ${t.samples.map((s) => `<p>${esc(s.mark_text)}<br><span>《${esc(s.title || '未知')}》</span></p>`).join('')}
        </div>
      </div>`).join('');
  }

  function showTopicList() {
    topicState.open = null;
    $('#topicCardsWrap').classList.add('hidden');
    $('#topicWrap').classList.remove('hidden');
    $('#topicListBar').classList.remove('hidden');
  }

  async function openTopic(id, page = 1) {
    topicState.open = id;
    topicState.page = page;
    const d = await api(`/api/topics/cards?topic=${id}&page=${page}&size=${topicState.size}`);
    topicState.total = d.total;
    $('#topicWrap').classList.add('hidden');
    $('#topicListBar').classList.add('hidden');
    $('#topicCardsWrap').classList.remove('hidden');
    $('#topicName').textContent = d.label || '';
    const pages = Math.max(1, Math.ceil(d.total / topicState.size));
    $('#tcPager').textContent = `${page} / ${pages}`;
    $('#tcPrev').disabled = page <= 1;
    $('#tcNext').disabled = page >= pages;
    $('#topicCards').innerHTML = d.cards.length
      ? d.cards.map(cardHTML).join('')
      : '<div class="empty"><b>这个主题下还没有卡片</b></div>';
    relayout();
  }

  /* ---------- 视图：成长看板 ---------- */

  /** 每日复习量堆叠柱：深色=还记得，浅色=忘了 */
  function barChart(daily) {
    const W = 700, H = 200, L = 34, R = 6, T = 12, B = 28;
    const iw = W - L - R, ih = H - T - B;
    const max = Math.max(1, ...daily.map((d) => d.n));
    const bw = iw / daily.length;
    let bars = '';
    daily.forEach((d, i) => {
      const x = L + i * bw;
      const h = (d.n / max) * ih;
      const okH = (d.ok / max) * ih;
      if (h > 0) {
        bars += `<rect x="${(x + 1).toFixed(1)}" y="${(T + ih - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="#e6dbc7"/>`;
        bars += `<rect x="${(x + 1).toFixed(1)}" y="${(T + ih - okH).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${okH.toFixed(1)}" rx="1.5" fill="#7aa892"/>`;
      }
    });
    const ticks = [0, max / 2, max].map((v) =>
      `<text x="${L - 6}" y="${(T + ih - (v / max) * ih + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#918878">${Math.round(v)}</text>`
    ).join('');
    const idx = [0, Math.floor((daily.length - 1) / 2), daily.length - 1];
    const xl = idx.map((i) =>
      `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="10" fill="#918878">${esc(daily[i].day.slice(5))}</text>`
    ).join('');
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每日复习量">
      <line x1="${L}" y1="${T + ih}" x2="${W - R}" y2="${T + ih}" stroke="#d8cfbe" stroke-width="1"/>
      ${ticks}${bars}${xl}</svg></div>
      <div class="legend"><span><i style="background:#7aa892"></i>还记得</span><span><i style="background:#e6dbc7"></i>忘了</span></div>`;
  }

  async function renderDashboard() {
    const days = $('#dashDays').value || '30';
    const d = await api('/api/dashboard?days=' + days);
    const total = d.poolTotal || 0;
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    const recall = d.firstRecall.n ? pct(d.firstRecall.ok, d.firstRecall.n) : null;
    const evRate = d.events.n ? pct(d.events.ok, d.events.n) : null;

    const kpi = (v, unit, label, sub) =>
      `<div class="kpi"><b>${v}${unit ? `<span class="u">${unit}</span>` : ''}</b><span>${label}</span><small>${sub}</small></div>`;

    let html = '<div class="kpis">';
    html += kpi(recall === null ? '—' : recall, recall === null ? '' : '%', '首回忆成功率',
      recall === null ? '还没有复习记录' : `${d.firstRecall.n} 张卡片第一次被回忆时的表现`);
    html += kpi(d.reviewed || 0, '', '已复习过的卡片',
      `共 ${total} 张 · 覆盖 ${pct(d.reviewed, total)}%`);
    html += kpi(d.mastered || 0, '', '真正记住的卡片',
      '间隔已推到 15 天以上');
    html += kpi(d.due || 0, '', '今日待复习',
      d.todayDone ? `今天已复习 ${d.todayDone} 次` : '还没开始');
    html += kpi(d.insights || 0, '', '感悟',
      `行动 ${d.actions || 0} 条 · 分布在 ${d.insightDays || 0} 天`);
    html += kpi(d.streak || 0, '', '连续天数', '每天翻几张就断不了');
    html += '</div>';

    if (!d.events.n) {
      html += `
        <div class="panel">
          <h3>还没有复习记录</h3>
          <p class="ph">回到「今日卡片」，翻到背面点「记得」或「忘了」——每点一次，这里就多一个真实的数据点。<br>
          <b>首回忆成功率</b>是最诚实的指标：它衡量的不是你划了多少线，而是合上书之后你还剩多少。</p>
        </div>`;
    } else {
      const sum = d.daily.reduce((a, b) => a + b.n, 0);
      html += `
        <div class="panel">
          <h3>每日复习量</h3>
          <p class="ph">近 ${days} 天共复习 ${sum} 次，整体答对率 ${evRate}%。柱子越高说明当天翻得越多，深色占比越高说明记得越牢。</p>
          ${barChart(d.daily)}
        </div>`;
    }

    if (d.reviewed) {
      // 只按「已复习卡片」自己量级做标尺：未复习数量级太大，放进同一坐标会把其他条压成 0
      const mx = Math.max(1, ...d.stages.map((r) => r.count));
      html += `
        <div class="panel">
          <h3>卡片成熟度</h3>
          <p class="ph">已完成首次复习的 ${d.reviewed} 张卡片，各自的下一复习间隔。间隔越长，说明它已经从「读过」变成「记得」。
          还有 ${d.untouched} 张仍在等待第一次复习。</p>
          <div class="mat">
            ${d.stages.map((r) => `
              <div class="mat-row">
                <div class="lb">${esc(r.label)}</div>
                <div class="tr"><div class="fl" style="width:${Math.round((r.count / mx) * 100)}%"></div></div>
                <div class="ct">${r.count}</div>
              </div>`).join('')}
          </div>
        </div>`;
    }

    if (d.dueCards && d.dueCards.length) {
      html += `
        <div class="panel">
          <h3>现在就该复习的 ${d.due} 张</h3>
          <p class="ph">点开翻面，凭记忆回想一下，再点「记得」或「忘了」。</p>
          <div class="due-grid" id="dashDue">${d.dueCards.map(cardHTML).join('')}</div>
        </div>`;
    }

    if (d.books && d.books.length) {
      html += `
        <div class="panel">
          <h3>复习得最多的书</h3>
          <p class="ph">哪些书的内容你反复回忆过，哪些只划过一次就放下了。</p>
          ${d.books.map((b) => `
            <div class="bkrow">
              <div class="nm">《${esc(b.title)}》<em>${esc(b.author || '')}</em></div>
              <div class="vl">复习 ${b.reviewed} 张 · <b>巩固 ${b.solid || 0}</b></div>
            </div>`).join('')}
        </div>`;
    }

    $('#dashBody').innerHTML = html;
    renderBackupInfo();
  }

  /* ---------- 数据备份 ---------- */

  async function renderBackupInfo() {
    try {
      const d = await api('/api/backups');
      $('#bkLast').textContent = d.lastAt
        ? `${fmtDateTime(d.lastAt)}（${relTime(d.lastAt)}）`
        : '还没有备份过';
      $('#bkFiles').innerHTML = d.list.length
        ? `${d.list.length} 份 · ${(d.totalSize / 1048576).toFixed(1)} MB · 保留最近 7 份`
        : '暂无备份文件';
    } catch {
      $('#bkLast').textContent = '读取备份信息失败';
    }
  }

  async function doBackup(btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/backup', { method: 'POST', body: {} });
      toast(`已备份：${r.name}（${(r.size / 1048576).toFixed(1)} MB）`);
      await renderBackupInfo();
    } catch (e) {
      toast(e.message || '备份失败');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function exportJson(btn) {
    if (btn) btn.disabled = true;
    try {
      const d = await api('/api/export');
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `流动的书-我的数据-${todayStr()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      const n = (d.insights || []).length;
      toast(`已导出：${n} 条感悟 · ${(d.favorites || []).length} 条收藏`);
    } catch (e) {
      toast(e.message || '导出失败');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function loadBookOptions() {
    const d = await api('/api/books?size=200&with_notes=1');
    state.booksAll = d.items;
    const sel = $('#libBook');
    sel.innerHTML = '<option value="">全部书籍</option>' +
      d.items.map((b) => `<option value="${esc(b.book_id)}">${esc(b.title)}（${b.highlight_count}）</option>`).join('');
  }

  /* ---------- 统计 ---------- */
  async function renderStats() {
    const s = await api('/api/stats');
    state.keyConfigured = s.keyConfigured !== false;
    if (!state.keyConfigured) {
      if (setupBar.dataset.mode !== 'error') resetSetup();   // 别覆盖掉同步报错
    } else if (setupBar.dataset.mode === 'nokey') {
      setupBar.classList.add('hidden');
      setupBar.dataset.mode = '';
    }
    $('#stStreak').textContent = s.streak || 0;
    $('#stCards').textContent = s.highlights || 0;
    $('#stFav').textContent = s.favorites || 0;
    $('#stDue').textContent = s.due || 0;
    const d = new Date();
    const wk = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
    // 窄屏用紧凑格式，否则整行日期会被折成两行、末字单独落行
    const narrow = window.matchMedia('(max-width:560px)').matches;
    $('#todayDate').textContent = narrow
      ? `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${wk.replace('星期', '周')}`
      : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${wk}`;
    $('#btnCheckin').textContent = s.todayDone ? '今日已打卡 ✓' : '今日打卡';
    $('#btnCheckin').disabled = !!s.todayDone;
    return s;
  }

  /* ---------- 同步 ---------- */
  let syncTimer;
  async function startSync() {
    const btn = $('#btnSync');
    btn.disabled = true;
    try { await api('/api/sync', { method: 'POST', body: { limit: 0, includeShelf: true } }); }
    catch (e) { toast(e.message); btn.disabled = false; return; }
    toast('已开始同步，正在拉取你的书架与划线…');
    clearInterval(syncTimer);
    syncTimer = setInterval(async () => {
      let st;
      try {
        st = await api('/api/sync/status');
      } catch (e) {
        clearInterval(syncTimer);
        btn.disabled = false;
        btn.textContent = '同步微信读书';
        toast('读取同步状态失败：' + e.message);
        return;
      }
      btn.textContent = st.running ? `同步中 ${st.done}/${st.total}` : '同步微信读书';
      if (!st.running) {
        clearInterval(syncTimer);
        btn.disabled = false;
        btn.textContent = '同步微信读书';
        if (st.syncError) {
          toast('同步失败：' + st.syncError);
          if (st.hint) showSetup('同步失败：' + st.syncError, esc(st.hint), 'error');
        } else {
          toast(`同步完成：${st.books} 本书 · ${st.highlights} 条划线 · ${st.thoughts} 条想法`);
        }
        renderStats(); loadBookOptions();
        if (state.view === 'today') renderToday(true);
        if (state.view === 'books') renderBooks();
      }
    }, 1000);
  }

  /* ---------- 事件 ---------- */
  async function switchView(v) {
    state.view = v;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    $$('.view').forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + v));
    if (v === 'today') await renderToday();
    if (v === 'library') await renderLibrary();
    if (v === 'favorites') await renderFavorites();
    if (v === 'insights') await renderInsights();
    if (v === 'books') await renderBooks();
    if (v === 'dashboard') await renderDashboard();
    if (v === 'topics') {
      if (topicState.open === null) showTopicList();
      await renderTopics();
    }
  }

  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (t) switchView(t.dataset.view);
  });

  $('#btnSync').addEventListener('click', startSync);
  $('#btnShuffle').addEventListener('click', shuffleToday);

  $('#btnCheckin').addEventListener('click', async () => {
    await api('/api/checkin', { method: 'POST', body: {} });
    toast('打卡成功，明天见');
    renderStats();
  });

  /* 卡片交互：翻面 + 背面操作 */
  document.addEventListener('click', async (e) => {
    const card = e.target.closest('.card');

    // 打开某张卡片的跳转
    // 收藏夹里直接取消收藏（不必先找到那张卡）
    const unfav = e.target.closest('[data-act="unfav"]');
    if (unfav) {
      const id = Number(unfav.dataset.id);
      unfav.disabled = true;
      try {
        await api('/api/favorites', { method: 'POST', body: { target_type: 'highlight', target_id: id, favorited: false } });
        toast('已移出收藏夹');
        await renderFavorites();
        renderStats();
      } catch (err) {
        unfav.disabled = false;
        toast(err.message || '操作失败');
      }
      return;
    }

    const goto = e.target.closest('[data-act="goto"]');
    if (goto) {
      await switchView('library');
      $('#libSearch').value = '';
      $('#libFavOnly').checked = false;
      state.lib.q = '';
      state.lib.book = '';
      state.lib.favOnly = false;
      state.lib.page = 1;
      const id = goto.dataset.id;
      const d = await api('/api/cards/detail?id=' + id);
      $('#libCards').innerHTML = cardHTML(d.card);
      const el = $('.card', $('#libCards'));
      relayout();
      await loadBack(el);
      el.classList.add('flipped');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    if (!card) return;

    // 交互元素不触发翻面
    if (e.target.closest('button,input,textarea,select,a,label,.insight-item')) return;

    const isFront = !!e.target.closest('.card-front');
    if (isFront) {
      await loadBack(card);
      card.classList.add('flipped');
    } else if (e.target.closest('.card-back')) {
      card.classList.remove('flipped');
    }
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.dataset.act === 'goto') return;
    const card = btn.closest('.card');
    if (!card) return;
    const id = Number(card.dataset.id);
    const act = btn.dataset.act;

    try {
      if (act === 'like') {
        const on = !btn.classList.contains('on');
        await api('/api/likes', { method: 'POST', body: { target_type: 'highlight', target_id: id, liked: on } });
        btn.classList.toggle('on', on);
        btn.innerHTML = `${on ? '♥' : '♡'} 同感`;
        toast(on ? '已标记为同感' : '已取消同感');
      }

      if (act === 'fav') {
        const on = !btn.classList.contains('on');
        if (on) {
          pendingFav = { id, btn };
          $('#nmText').value = '';
          $('#noteModal').classList.remove('hidden');
          $('#nmText').focus();
        } else {
          await api('/api/favorites', { method: 'POST', body: { target_type: 'highlight', target_id: id, favorited: false } });
          btn.classList.remove('on'); btn.innerHTML = '☆ 收藏';
          toast('已移出收藏夹');
          renderStats();
        }
      }

      if (act === 'review') {
        const q = Number(btn.dataset.q);
        const r = await api('/api/reviews', { method: 'POST', body: { target_type: 'highlight', target_id: id, quality: q } });
        toast(q === 0 ? '已重置，明天再见一次' : `记住了 · 下次复习 ${r.due_date}`);
        renderStats();
      }

      if (act === 'add-insight') {
        const kind = btn.dataset.kind;
        const input = $(`input[data-in="${kind}"]`, card);
        const content = input.value.trim();
        if (!content) { input.focus(); return; }
        await api('/api/insights', { method: 'POST', body: { target_type: 'highlight', target_id: id, kind, content } });
        input.value = '';
        const d = await api('/api/cards/detail?id=' + id);
        state.detailCache.set(String(id), d);
        paintBack($('.card-back', card), d);
        toast(kind === 'action' ? '行动已记下' : '感悟已记下');
        renderStats();
      }

      if (act === 'topic') {
        const tid = Number(btn.dataset.topic);
        await switchView('topics');
        await openTopic(tid);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

      if (act === 'share') {
        let d = state.detailCache.get(String(id));
        if (!d) { d = await api('/api/cards/detail?id=' + id); state.detailCache.set(String(id), d); }
        shareCanvas = drawPoster(d);
        $('#shareImg').src = shareCanvas.toDataURL('image/png');
        shareName = `流动的书-${String(d.book?.title || '卡片').replace(/[\\/:*?"<>|]/g, '')}-${todayStr()}.png`;
        $('#shareModal').classList.remove('hidden');
      }

      if (act === 'del-insight') {
        await api('/api/insights', { method: 'DELETE', body: { id: Number(btn.dataset.id) } });
        const d = await api('/api/cards/detail?id=' + id);
        paintBack($('.card-back', card), d);
        toast('已删除');
        renderStats();
      }

      if (act === 'ai-interpret') {
        const box = $('#aiBox-' + id);
        const tag = $('#aiTag-' + id);
        const text = btn.dataset.text || '';
        const book = btn.dataset.book || '';
        if (box.dataset.done === '1') { box.classList.toggle('collapsed'); return; }
        box.dataset.done = '1';
        box.classList.remove('collapsed');
        box.innerHTML = '<div class="ai-loading">AI 正在读这一句…</div>';
        try {
          const r = await api('/api/ai/interpret', { method: 'POST', body: { text, book, mode: 'highlight' } });
          tag.textContent = r.engine === 'llm' ? '· 大模型' : '· 内置引擎';
          box.innerHTML = `
            <div class="ai-line"><span class="ai-k">解读</span><p>${esc(r.interpretation)}</p></div>
            ${r.association ? `<div class="ai-line"><span class="ai-k">联想</span><p>${esc(r.association)}</p></div>` : ''}
            ${r.question ? `<div class="ai-line q"><span class="ai-k">追问</span><p>${esc(r.question)}</p></div>` : ''}
            ${r.cached ? '<div class="ai-foot">（命中缓存）</div>' : ''}`;
          toast('AI 解读已生成');
        } catch (e) {
          box.dataset.done = '0';
          box.innerHTML = `<div class="ai-err">解读失败：${esc(e.message)}</div>`;
        }
      }
    } catch (err) {
      toast(err.message || '操作失败');
    }
  });

  /* 收藏弹窗 */
  let pendingFav = null;
  $('#nmCancel').addEventListener('click', () => {
    $('#noteModal').classList.add('hidden');
    pendingFav = null;
  });
  $('#nmSave').addEventListener('click', async () => {
    if (!pendingFav) return;
    const note = $('#nmText').value.trim();
    await api('/api/favorites', {
      method: 'POST',
      body: { target_type: 'highlight', target_id: pendingFav.id, favorited: true, note },
    });
    pendingFav.btn.classList.add('on');
    pendingFav.btn.innerHTML = '★ 收藏';
    $('#noteModal').classList.add('hidden');
    pendingFav = null;
    toast(note ? '已收藏，并记下此刻的想法' : '已收藏');
    renderStats();
    if (state.view === 'favorites') renderFavorites();
  });

  /* 成图预览与下载 */
  let shareCanvas = null, shareName = '';
  $('#shCancel').addEventListener('click', () => $('#shareModal').classList.add('hidden'));
  $('#shDown').addEventListener('click', () => {
    if (!shareCanvas) return;
    shareCanvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = shareName || 'card.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
  });

  /* 卡片库筛选 */
  let libTimer;
  $('#libSearch').addEventListener('input', (e) => {
    clearTimeout(libTimer);
    const v = e.target.value;
    libTimer = setTimeout(() => { state.lib.q = v; state.lib.page = 1; renderLibrary(); }, 320);
  });
  $('#libBook').addEventListener('change', (e) => { state.lib.book = e.target.value; state.lib.page = 1; renderLibrary(); });
  $('#libFavOnly').addEventListener('change', (e) => { state.lib.favOnly = e.target.checked; state.lib.page = 1; renderLibrary(); });
  $('#libPrev').addEventListener('click', () => {
    if (state.lib.page > 1) { state.lib.page--; renderLibrary(); }
  });
  $('#libNext').addEventListener('click', () => {
    if (state.lib.page < (state.lib.pages || 1)) { state.lib.page++; renderLibrary(); }
  });

  /* 书架 */
  let bkTimer;
  $('#bookSearch').addEventListener('input', (e) => {
    clearTimeout(bkTimer);
    const v = e.target.value;
    bkTimer = setTimeout(renderBooks, 320);
  });
  $('#bookHasNotes').addEventListener('change', renderBooks);
  $('#dashDays').addEventListener('change', renderDashboard);

  /* 主题 */
  $('#topicList').addEventListener('click', (e) => {
    const t = e.target.closest('.topic-card');
    if (t) openTopic(Number(t.dataset.topic));
  });
  $('#topicBack').addEventListener('click', () => { showTopicList(); renderTopics(); });
  $('#tcPrev').addEventListener('click', () => {
    if (topicState.page > 1) openTopic(topicState.open, topicState.page - 1);
  });
  $('#tcNext').addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil(topicState.total / topicState.size));
    if (topicState.page < pages) openTopic(topicState.open, topicState.page + 1);
  });
  /* 备份与导出 */
  $('#btnBackup').addEventListener('click', () => doBackup($('#btnBackup')));
  $('#btnBackup2').addEventListener('click', () => doBackup($('#btnBackup2')));
  $('#btnExportJson').addEventListener('click', () => exportJson($('#btnExportJson')));

  $('#btnRebuildTopics').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = '聚类中…';
    try {
      await api('/api/topics/build', { method: 'POST', body: {} });
      showTopicList();
      await renderTopics();
      toast('已按最新卡片重新聚类');
    } finally {
      btn.disabled = false; btn.textContent = '重新聚类';
    }
  });
  $('#btnAddBook').addEventListener('click', () => $('#bookModal').classList.remove('hidden'));
  $('#nbCancel').addEventListener('click', () => $('#bookModal').classList.add('hidden'));
  $('#nbSave').addEventListener('click', async () => {
    const title = $('#nbTitle').value.trim();
    if (!title) { $('#nbTitle').focus(); return; }
    await api('/api/books', {
      method: 'POST',
      body: { title, author: $('#nbAuthor').value.trim(), category: $('#nbCategory').value.trim(), cover: $('#nbCover').value.trim() },
    });
    $('#bookModal').classList.add('hidden');
    ['#nbTitle', '#nbAuthor', '#nbCategory', '#nbCover'].forEach((s) => { $(s).value = ''; });
    toast('书籍已添加');
    renderBooks(); loadBookOptions();
  });

  /* 导出 Markdown */
  $('#btnExport').addEventListener('click', () => {
    if (!insightsData.length) { toast('还没有内容可导出'); return; }
    const byDay = new Map();
    for (const i of insightsData) {
      const k = dayKey(i.created_at);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(i);
    }
    let md = `# 流动的书 · 我的感悟与行动\n\n> 导出时间：${fmtDateTime(Date.now())}\n\n`;
    for (const [day, arr] of byDay) {
      md += `## ${day}\n\n`;
      for (const i of arr) {
        md += `- **${i.kind === 'action' ? '行动' : '感悟'}** ${i.content}\n`;
        md += `  - 来自《${i.book_title || '未知'}》${i.author ? ' / ' + i.author : ''}\n`;
      }
      md += '\n';
    }
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `流动的书-我的感悟-${todayStr()}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 Markdown');
  });

  /* ---------- 访客 / 管理员模式 ---------- */
  async function applyMode() {
    let me = { role: 'guest', owner: false, keyConfigured: false };
    try { me = await api('/api/me'); } catch (e) { /* 默认访客 */ }
    state.role = me.role;
    state.owner = !!me.owner;
    state.uid = me.uid || (me.owner ? 'owner' : 'guest');
    state.keyConfigured = !!me.keyConfigured;

    const isOwner = !!me.owner;
    $('#modeText').textContent = isOwner
      ? '管理员模式 · 已登录：可同步 / 备份 / 导出 / 管理书籍'
      : '访客模式 · 欢迎体验《流动的书》—— 你看到的书籍由主人分享，你写下的感悟与收藏仅自己可见';
    $('#modeBar').classList.toggle('guest', !isOwner);
    $('#modeBar').classList.toggle('owner', isOwner);

    $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isOwner));
    $('#btnAdmin').classList.toggle('hidden', isOwner);
    $('#btnLogout').classList.toggle('hidden', !isOwner);

    // 访客不展示「未配置 Key」提示（那是给管理员看的）
    if (!isOwner) setupBar.classList.add('hidden');
    else if (state.keyConfigured) setupBar.classList.add('hidden');
    else resetSetup();
  }

  function showLogin() {
    $('#loginPwd').value = '';
    $('#loginModal').classList.remove('hidden');
    setTimeout(() => $('#loginPwd').focus(), 30);
  }
  function hideLogin() { $('#loginModal').classList.add('hidden'); }

  async function doLogin() {
    const pwd = $('#loginPwd').value;
    const ok = $('#loginOk');
    ok.disabled = true;
    try {
      const r = await api('/api/login', { method: 'POST', body: { password: pwd } });
      if (!r.ok) throw new Error(r.error || '登录失败');
      hideLogin();
      toast('已以管理员身份登录');
      await applyMode();
      await renderStats(); loadBookOptions();
      if (state.view === 'today') renderToday(true);
      if (state.view === 'books') renderBooks();
    } catch (e) {
      toast(e.message || '口令错误');
    } finally {
      ok.disabled = false;
    }
  }

  async function doLogout() {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch (e) {}
    toast('已退出管理员模式');
    await applyMode();
  }

  $('#btnAdmin').addEventListener('click', showLogin);
  $('#btnLogout').addEventListener('click', doLogout);
  $('#loginCancel').addEventListener('click', hideLogin);
  $('#loginOk').addEventListener('click', doLogin);
  $('#loginPwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  /* ---------- 启动 ---------- */
  (async function boot() {
    await renderStats();
    await applyMode();
    await loadBookOptions();
    await switchView('today');

    // 容器宽度变化（窗口缩放、响应式列数切换、视图由隐藏转可见）后重排瀑布流
    const lastW = new WeakMap();
    const ro = new ResizeObserver((entries) => {
      let need = false;
      for (const en of entries) {
        const w = Math.round(en.contentRect.width);
        if (lastW.get(en.target) !== w) { lastW.set(en.target, w); need = true; }
      }
      if (need) masonryAll();
    });
    ['#todayCards', '#libCards'].forEach((s) => ro.observe($(s)));
    window.addEventListener('resize', () => masonryAll());
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(masonryAll);
  })();
})();
