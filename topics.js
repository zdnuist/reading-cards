/**
 * 轻量中文主题聚类 —— 零第三方依赖
 *
 * 1) 分词：CJK 二元组 + 拉丁词（不需要词典），助词表 + 文档频次双重过滤噪声
 * 2) 向量：TF-IDF + L2 归一化
 * 3) 聚类：球形 KMeans（k-means++ 初始化、余弦相似度），固定种子保证结果可复现
 * 4) 命名：簇内文档频次 × 质心权重，取前 3 个词
 */
import { mulberry32, hashSeed } from './db.js';

/* 助词/语气词：二元组里只要含这些字，基本都是噪声（"的基""我们"） */
const PARTICLE = new Set('的了着过呢吗吧啊哦呀嘛呗咯喽么哇啦是'.split(''));

/* 虚词 / 常见句式碎片：既能直接作为二元组丢弃，也能用来判定长词是否夹带它们。
   注意不要把"问题"这类泛化名词放进来 —— 否则"解决问题"会因包含它而被整条剔除。 */
const STOP_FUNC = new Set(`
如果 因为 所以 但是 而且 虽然 然后 就是 不是 没有 可以 应该 需要 通过 对于 关于 以及
这些 那些 什么 怎么 怎样 这样 那样 这个 那个 一个 一些 很多 非常 已经 可能 或者 于是 同时
其实 只有 还是 并且 因此 比如 例如 不过 而是 那么 后来 首先 其次 最后 由于 随着 根据 按照
为了 一切 任何 所有 每个 各种 之类 等等 现在 目前 之前 之后 以后 以前 之外 之内
第一 第二 第三 第四 第五 还有 也是 都会 就会 才能 就能 也会 不要 不能 或许 似乎 好像
显然 当然 居然 竟然 反正 总之 譬如 尤其 特别 十分 极其 稍微 有点 更加 越发
他们 我们 你们 自己 别人 大家
是为 就不 才是 不会 果你 你就 才会 就要 都要 也能 还可 还能 也要 便会 从而 进而 因而 反而 倒是
一种 每一 当你 让他 让人 这件 一句 每个 各种 有点 这种 这家 那种 一家 家公司 为什 它能 一旦 更多
`.trim().split(/\s+/).filter(Boolean));

/* 泛化名词 / 动词：讲不出具体主题，但可能出现在有意义的四字词内部
   （如"解决**问题**"），所以只对二元组本身生效，不做长词的子串判定。 */
const STOP_GENERIC = new Set(`
问题 方式 方法 情况 部分 方面 时候 事情 东西 意思 内容 存在 具有 表示 进行 实现 出现
得到 知道 认为 发现 成为 使得 开始 继续 大量 少量 结果 原因 过程 产生 采取 在于 根本
人们 感到 对方 无法 事情 一点 一些 各种 喜欢 容易
`.trim().split(/\s+/).filter(Boolean));

const STOP_WORDS = new Set([...STOP_FUNC, ...STOP_GENERIC]);
const hasStop = (g) => {
  for (const w of STOP_FUNC) if (g.includes(w)) return true;
  return false;
};

export function tokenize(text) {
  const s = String(text || '');
  const toks = [];
  for (const m of s.matchAll(/[A-Za-z][A-Za-z'\-]{1,}/g)) toks.push(m[0].toLowerCase());
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const a = run[i], b = run[i + 1];
      if (PARTICLE.has(a) || PARTICLE.has(b)) continue;
      toks.push(a + b);
    }
  }
  return toks;
}

/* ---------------- TF-IDF ---------------- */

function buildVocab(docsTokens) {
  const df = new Map();
  for (const toks of docsTokens) {
    for (const w of new Set(toks)) df.set(w, (df.get(w) || 0) + 1);
  }
  const n = docsTokens.length;
  const min = 3;                      // 太罕见：错别字或专有名词碎片
  const max = Math.max(10, n * 0.05);  // 太常见：没有区分度
  const vocab = new Map();
  for (const [w, c] of df) {
    if (c >= min && c <= max && !STOP_WORDS.has(w)) vocab.set(w, vocab.size);
  }
  return { vocab, df };
}

function vectorize(docsTokens, vocab, df) {
  const n = docsTokens.length;
  const idf = new Map();
  for (const [w, i] of vocab) idf.set(w, Math.log(1 + n / df.get(w)));
  const idfArr = new Float64Array(vocab.size);
  for (const [w, i] of vocab) idfArr[i] = idf.get(w);

  const vecs = docsTokens.map((toks) => {
    const tf = new Map();
    for (const w of toks) {
      const i = vocab.get(w);
      if (i !== undefined) tf.set(i, (tf.get(i) || 0) + 1);
    }
    const vec = [];
    for (const [i, c] of tf) vec.push([i, (1 + Math.log(c)) * idfArr[i]]);
    let s = 0;
    for (const [, v] of vec) s += v * v;
    s = Math.sqrt(s) || 1;
    for (const e of vec) e[1] /= s;   // 单位向量 → 点积即余弦相似度
    return vec;
  });
  return { vecs, idf };
}

/* ---------------- 球形 KMeans ---------------- */

const toMap = (vec) => new Map(vec);
function dot(vec, cm) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = cm.get(vec[i][0]);
    if (v) s += vec[i][1] * v;
  }
  return s;
}

function kmeans(vecs, k, iters, seed) {
  const n = vecs.length;
  const rnd = mulberry32(seed);
  const centers = [];
  const dist2 = new Float64Array(n).fill(Infinity);

  const refreshD2 = () => {
    const c = centers[centers.length - 1];
    for (let i = 0; i < n; i++) {
      const d = 2 - 2 * dot(vecs[i], c);
      if (d < dist2[i]) dist2[i] = d;
    }
  };

  // k-means++ 初始化
  centers.push(toMap(vecs[Math.floor(rnd() * n)]));
  refreshD2();
  while (centers.length < k) {
    let total = 0;
    for (let i = 0; i < n; i++) total += dist2[i];
    const target = rnd() * total;
    let acc = 0, pick = n - 1;
    for (let i = 0; i < n; i++) { acc += dist2[i]; if (acc >= target) { pick = i; break; } }
    centers.push(toMap(vecs[pick]));
    refreshD2();
  }

  const assign = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0, bestv = -Infinity;
      for (let c = 0; c < k; c++) {
        const v = dot(vecs[i], centers[c]);
        if (v > bestv) { bestv = v; best = c; }
      }
      assign[i] = best;
    }

    const accs = centers.map(() => new Map());
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      counts[assign[i]]++;
      const a = accs[assign[i]];
      for (const [idx, v] of vecs[i]) a.set(idx, (a.get(idx) || 0) + v);
    }
    for (let c = 0; c < k; c++) {
      if (!counts[c]) continue;
      let s = 0;
      for (const v of accs[c].values()) s += v * v;
      s = Math.sqrt(s) || 1;
      const m = new Map();
      for (const [idx, v] of accs[c]) m.set(idx, v / s);
      centers[c] = m;
    }
  }
  return { assign, centers };
}

/* ---------------- 主题命名 ---------------- */

/**
 * 簇命名：直接抽 2~4 字词，长词优先。
 * 这样能得到"指数基金""机器学习"这类完整词，而不是被切碎的"数基""器学"。
 */
function phraseLabel(texts, size) {
  const cnt = new Map();   // 词 -> 簇内出现的卡片数（同一张卡片只计一次）
  for (const t of texts) {
    for (const run of String(t).match(/[\u4e00-\u9fff]+/g) || []) {
      if (run.length < 2) continue;
      const seen = new Set();
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= run.length; i++) {
          const g = run.slice(i, i + n);
          let bad = false;
          for (const ch of g) if (PARTICLE.has(ch)) { bad = true; break; }
          if (!bad) seen.add(g);
        }
      }
      for (const g of seen) cnt.set(g, (cnt.get(g) || 0) + 1);
    }
  }

  const minCnt = Math.max(2, Math.round(size * 0.05));
  const stopParts = new Set();   // 被停用长词切出来的碎片
  const cands = [];
  for (const [g, c] of cnt) {
    if (c < minCnt) continue;
    if (STOP_WORDS.has(g)) continue;
    if (g.length > 2 && hasStop(g)) {
      // 长词夹带虚词被剔除时，它切出的碎片也一起丢掉：
      // "为什么"含"什么"→ 一并丢弃"为什"；"这件事"含"这件"→ 丢弃"件事"
      for (let n = 2; n < g.length; n++) {
        for (let i = 0; i + n <= g.length; i++) stopParts.add(g.slice(i, i + n));
      }
      continue;
    }
    cands.push([g, c, c * Math.sqrt(g.length)]);   // 同等频次下略偏好长词
  }
  const clean = cands.filter(([g]) => !stopParts.has(g));
  clean.sort((a, b) => b[2] - a[2]);
  cands.length = 0;
  cands.push(...clean);

  // 长词会把词组切碎：ABCD 切出 ABC/BCD/BC 等。
  // 只要某个候选是长词的真子串、且频次与长词相当，它就是碎片，丢掉。
  const dropped = new Set();
  for (const [g, c] of cands) {
    if (g.length < 3) continue;
    for (const [g2, c2] of cands) {
      if (g2.length >= g.length || !g.includes(g2)) continue;
      if (c >= c2 * 0.75) dropped.add(g2);
    }
  }

  const picked = [];
  for (const [g] of cands) {
    if (picked.length >= 6) break;
    if (dropped.has(g)) continue;
    picked.push(g);
  }
  // 若短词已被选中的长词包含（如 学习 ⊂ 机器学习），去掉短词
  const kept = picked.filter((g) => !picked.some((h) => h.length > g.length && h.includes(g)));
  return kept.slice(0, 3);
}

/* ---------------- 主入口 ---------------- */

/**
 * @param cards [{id, text, book_id}]
 * @returns {{topics: Array, assign: Map<number, number>}}
 *          topics[i] = {label, words, size, bookCount, sampleIds}
 */
export function buildTopics(cards) {
  const docs = cards.filter((c) => String(c.text || '').trim().length >= 8);
  if (docs.length < 20) return { topics: [], assign: new Map() };

  const docsTokens = docs.map((c) => tokenize(c.text));
  const { vocab, df } = buildVocab(docsTokens);
  if (vocab.size < 10) return { topics: [], assign: new Map() };

  const { vecs, idf } = vectorize(docsTokens, vocab, df);

  const idxs = [];
  for (let i = 0; i < vecs.length; i++) if (vecs[i].length) idxs.push(i);

  const k = Math.max(6, Math.min(24, Math.round(idxs.length / 160)));
  const { assign: raw, centers } = kmeans(
    idxs.map((i) => vecs[i]), k, 18, hashSeed('topics::' + idxs.length)
  );

  const buckets = Array.from({ length: k }, () => ({
    members: [], vecs: [], tokens: [], texts: [], books: new Set(),
  }));
  idxs.forEach((docIdx, j) => {
    const b = buckets[raw[j]];
    b.members.push(docs[docIdx].id);
    b.vecs.push(vecs[docIdx]);
    b.tokens.push(docsTokens[docIdx]);
    b.texts.push(docs[docIdx].text);
    b.books.add(docs[docIdx].book_id);
  });

  const list = [];
  buckets.forEach((b, bi) => {
    if (!b.members.length) return;
    const words = phraseLabel(b.texts, b.members.length);
    const ranked = b.members
      .map((id, i) => ({ id, s: dot(b.vecs[i], centers[bi]) }))
      .sort((x, y) => y.s - x.s);
    list.push({
      bi,
      label: words.join(' · ') || '未命名',
      words,
      size: b.members.length,
      bookCount: b.books.size,
      sampleIds: ranked.slice(0, 4).map((x) => x.id),
    });
  });

  list.sort((a, b) => b.size - a.size);
  const posOf = new Map(list.map((t, i) => [t.bi, i]));

  const assign = new Map();
  idxs.forEach((docIdx, j) => {
    const pos = posOf.get(raw[j]);
    if (pos !== undefined) assign.set(docs[docIdx].id, pos);
  });

  return { topics: list.map((t) => ({ label: t.label, words: t.words, size: t.size, bookCount: t.bookCount, sampleIds: t.sampleIds })), assign };
}
