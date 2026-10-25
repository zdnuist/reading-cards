/**
 * 「流动的书」智能解读层
 * -------------------------------------------------------------
 * 设计目标：让“读过的书”真正被“内化”。
 *
 * - 若配置了 LLM_* 环境变量，调用大模型生成「解读 / 跨书联想 / 苏格拉底提问」；
 * - 未配置时走高质量模板兜底，保证离线 / 演示环境永远可用、且输出稳定可读；
 * - 调用大模型失败也自动回退模板，绝不抛错中断体验。
 *
 * 配置（写到 .env，留空即走模板）：
 *   LLM_API_KEY=sk-xxx
 *   LLM_BASE_URL=https://api.openai.com/v1   # 也支持任意 OpenAI 兼容端点（如通义/DeepSeek）
 *   LLM_MODEL=gpt-4o-mini
 */

const BASE = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS || 45000);

export const aiEnabled = Boolean(KEY);

/* ---------------- 模板兜底（离线 / 演示无忧） ---------------- */

function splitClauses(text) {
  return String(text)
    .split(/[。！？!?\n；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

function pick(arr, seed = Math.random()) {
  return arr[Math.floor(seed * arr.length) % arr.length];
}

function templateHighlight(text) {
  const clauses = splitClauses(text);
  const key = (clauses.sort((a, b) => b.length - a.length)[0]) || String(text).slice(0, 40);

  const interps = [
    `这段话的重心在「${key}」。知识若不曾被你重新讲述，便只是别人脑子里的过客——试着用自己的话把它复述一遍。`,
    `「${key}」之所以被你划下来，是因为它戳中了某个尚未言明的经验。把它和你的现实连起来，记忆才会落地。`,
    `你为这一句划了线，说明它在和过去的你对话。「${key}」值得被追问：它在你的生活里，对应着哪一幕？`,
    `「${key}」读起来理所当然，但真正懂，是要能举出一个反例。试着想一个它不成立的情形。`,
  ];
  const assocs = [
    '把它和你最近读的另一本书并排：它们的分歧或共鸣，正是你思考生长的地方。',
    '它让你联想到哪本书的哪个观点？把两本书放在同一张桌上，你会看见自己的知识地图。',
    '如果用一个比喻解释这句话，你会想到什么？比喻出现，往往意味着理解真正发生了。',
    '这句话在三年前和三年后，对你意味着完全不同的事。哪个版本的你更需要它？',
  ];
  const ques = [
    '如果三年前的你读到这句，你会对那时的自己说什么？',
    '这句话里，哪一部分你其实并不同意？不同意的地方，往往最值得想。',
    '把它变成明天就能做的一件小事，会是什么？',
    '假设你要向一个完全不懂的人讲清这句，你会从哪里开头？',
  ];

  return {
    engine: 'template',
    interpretation: pick(interps),
    association: pick(assocs),
    question: pick(ques),
  };
}

function templateDaily(text) {
  const clauses = splitClauses(text);
  const seedClause = pick(clauses.slice(0, 6)) || String(text).slice(0, 24);
  const intros = [
    `今天挑的这几段，像是从不同书里递来的同一句话——而它说的是：「${seedClause}」`,
    `复习不是重复，而是让旧文字遇见新的你。今天的卡片，等你慢慢翻开。`,
    `有人把书读完就放下，有人把书读进生活。今天这几段，值得你慢一点。`,
    `六张卡片，六次与过去自己的重逢。先翻哪一张，都由你。`,
  ];
  return { engine: 'template', interpretation: pick(intros) };
}

/* ---------------- 大模型调用（OpenAI 兼容） ---------------- */

function parseJsonLoose(s) {
  let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch { /* continue */ }
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch { /* continue */ } }
  throw new Error('llm json parse failed');
}

async function llmInterpret(text, ctx = {}) {
  const mode = ctx.mode || 'highlight';
  const sys =
    '你是「流动的书」的阅读内化助手。用户会给你一段读书划线（可能带书名/作者）。' +
    '请用简体中文输出 JSON：' +
    (mode === 'daily'
      ? '{ "interpretation": 一句富有文学感、鼓励今天阅读的导语(不超过40字) }'
      : '{ "interpretation": 一句对这段话的解读, "association": 一句跨书/跨经验的联想, "question": 一个引导深度思考的苏格拉底式提问 }') +
    '。只输出 JSON，不要解释。';

  const user = JSON.stringify({
    text,
    book: ctx.book || '',
    author: ctx.author || '',
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  let data;
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.85,
        ...(process.env.LLM_ENABLE_THINKING === '1' ? {} : { enable_thinking: false }),
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`llm http ${r.status} ${detail.slice(0, 160)}`);
    }
    data = await r.json();
  } finally {
    clearTimeout(timer);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('llm empty');
  const c = parseJsonLoose(content);

  if (mode === 'daily') {
    return {
      engine: 'llm',
      interpretation: c.interpretation || c.导语 || c.intro || '',
    };
  }
  return {
    engine: 'llm',
    interpretation: c.interpretation || c.解读 || '',
    association: c.association || c.联想 || '',
    question: c.question || c.提问 || '',
  };
}

/* ---------------- 对外入口 ---------------- */

export async function interpret(text, ctx = {}) {
  const clean = String(text || '').trim();
  if (aiEnabled) {
    try {
      return await llmInterpret(clean, ctx);
    } catch (e) {
      console.error('[ai] llm failed, fallback to template:', e.message);
    }
  }
  return ctx.mode === 'daily' ? templateDaily(clean) : templateHighlight(clean);
}
