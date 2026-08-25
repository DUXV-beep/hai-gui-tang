// AI 主持人模块：对接 DeepSeek（OpenAI 兼容协议）
// 核心设计：汤底只进 system，绝不放进 user；用 max_tokens / JSON 模式限制输出，防止剧透

const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const KEY = process.env.DEEPSEEK_API_KEY;

async function chat(messages, { maxTokens = 1000, json = false, temperature = 0.2, thinking = false } = {}) {
  if (!KEY) throw new Error('缺少 DEEPSEEK_API_KEY');

  const body = {
    model: MODEL,
    messages,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };

  // DeepSeek V4 默认开启思考模式（effort=high），会先消费 token 做思维链。
  // 海龟汤主持人只需快速判断，默认关闭思考，temperature 才生效、更快更便宜。
  if (thinking) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = 'low';
  } else {
    body.thinking = { type: 'disabled' };
    body.temperature = temperature;
  }

  // 网络抖动/服务端瞬时错误自动重试 1 次（指数退避），仍失败才抛错交给上层降级
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt));
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // 4xx（如 401 鉴权失败）不重试；5xx/429（服务端瞬时）重试
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`DeepSeek API ${res.status}`);
          continue;
        }
        const detail = await res.text().catch(() => '');
        throw new Error(`DeepSeek API ${res.status}: ${detail.slice(0, 300)}`);
      }

      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      lastErr = e;
      if (e && e.message && e.message.startsWith('DeepSeek API')) throw e; // 4xx 等明确错误不重试
    }
  }
  throw lastErr || new Error('AI 请求失败');
}

// 把 AI 四选一答复归类，前端渲染彩色徽章
function classifyAnswer(reply) {
  const t = String(reply || '').replace(/[^\u4e00-\u9fa5]/g, '');
  if (t.includes('无法回答') || t.includes('不能')) return 'unknown';
  if (t.includes('无关')) return 'irrelevant';
  if (t.startsWith('否') || t.startsWith('不')) return 'no';
  if (t.startsWith('是')) return 'yes';
  return 'unknown';
}

// 判断是否有效提问：过短或无意义（纯数字/符号/乱码）的输入视为无效，直接无法回答
function isValidQuestion(q) {
  const text = String(q || '').trim();
  if (text.length < 2) return false;
  const chinese = text.replace(/[^\u4e00-\u9fa5]/g, '').length;
  return chinese >= 2;
}

// 提问通道：只答「是 / 否 / 无关 / 无法回答」四选一
async function answerQuestion(answer, question) {
  // 前置兜底：不是有效问题（如输入「1」「乱码」）直接无法回答，不浪费调用
  if (!isValidQuestion(question)) {
    return '无法回答';
  }
  const content = await chat(
    [
      {
        role: 'system',
        content:
          '你是海龟汤主持人。汤底如下：\n' +
          answer +
          '\n\n玩家会问关于汤面的封闭式问题。你只能回答「是」「否」「无关」「无法回答」中的一个，' +
          '禁止任何解释，禁止引用或复述汤底原文，禁止输出这四个词以外的内容。' +
          '注意：如果玩家输入的不是一个有效问题（例如无意义字符、乱码、不成句的内容），必须回答「无法回答」；' +
          '如果问题是有效问句但与汤面毫无关系，回答「无关」。',
      },
      { role: 'user', content: question },
    ],
    { maxTokens: 24, temperature: 0 }
  );
  return normalizeAnswer(content);
}

// 把 AI 输出归一化到四选一，防止跑偏或剧透
function normalizeAnswer(raw) {
  const t = String(raw || '').replace(/[^\u4e00-\u9fa5]/g, '');
  if (t.includes('无法回答') || t.includes('不能')) return '无法回答';
  if (t.includes('无关')) return '无关';
  if (t.startsWith('否') || t.startsWith('不')) return '否';
  if (t.startsWith('是')) return '是';
  return '无法回答';
}

// 推理失败时的固定反馈白名单：只能从这些短语中选，绝不涉及汤底任何细节
const REJECT_FEEDBACK = [
  '推理与真相还有差距，再想想。',
  '部分吻合，但关键因果还不正确。',
  '方向不太对，试着从另一个角度思考。',
  '还不够完整，把缺失的环节补上。',
];

// 归一化：去标点空白、转小写，用于复述检测
function normalizeText(s) {
  return String(s || '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

// 硬校验：玩家把汤面原文粘贴进推理区 → 视为复述，直接判失败（不调用模型，防误判 + 省钱）
function isEchoOf(soupFace, deduction) {
  const a = normalizeText(soupFace);
  const b = normalizeText(deduction);
  if (!a || !b || b.length < 12) return false;
  if (a.length >= 8 && b.includes(a)) return true; // 汤面整段被包含
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const ch of setA) if (setB.has(ch)) inter += 1;
  const union = setA.size + setB.size - inter;
  if (union === 0) return false;
  return inter / union > 0.8; // 字符高度重合 → 复述
}

// 推理通道：判断玩家推理与汤底是否一致，返回 { accept, feedback }
async function judgeDeduction(answer, soupFace, deduction) {
  // 前置防护：复述汤面直接失败
  if (isEchoOf(soupFace, deduction)) {
    return { accept: false, feedback: '请给出你的推理和解释，而不是复述汤面。' };
  }

  const raw = await chat(
    [
      {
        role: 'system',
        content:
          '你是海龟汤主持人。汤面（谜面）如下：\n' +
          soupFace +
          '\n\n汤底（真实答案）如下：\n' +
          answer +
          '\n\n玩家会给出完整的故事推理。请判断玩家推理是否与汤底的核心因果一致（允许细节差异，但关键因果必须吻合）。' +
          '注意：汤面只是对奇怪场景的描述，并不包含答案。玩家仅仅复述汤面、或把汤面原文粘贴过来，都是错误推理，必须 accept:false。' +
          '宁可保守，不确定时 accept:false。' +
          '只输出一个 JSON 对象，格式：{"accept": true 或 false, "reason": "一句话反馈"}。' +
          '当 accept 为 false 时，reason 只能从以下备选反馈中选一句原文（不要自己发挥，不要提及汤底的任何人物、地点、物品或情节）：\n' +
          JSON.stringify(REJECT_FEEDBACK) +
          '\n当 accept 为 true 时，reason 输出一句祝贺语，如「完全正确！」，同样不要复述汤底。禁止输出 JSON 以外的内容。',
      },
      { role: 'user', content: deduction },
    ],
    { maxTokens: 120, temperature: 0.2, json: true }
  );

  // 容错解析 + 白名单兜底：模型返回的 reason 不在白名单内一律替换成通用反馈，杜绝泄底
  try {
    const parsed = JSON.parse(raw);
    const accept = !!parsed.accept;
    let feedback = String(parsed.reason || '').trim();
    if (accept) {
      if (!feedback) feedback = '完全正确！';
    } else {
      if (!REJECT_FEEDBACK.includes(feedback)) {
        feedback = REJECT_FEEDBACK[Math.floor(Math.random() * REJECT_FEEDBACK.length)];
      }
    }
    return { accept, feedback };
  } catch {
    return {
      accept: /"accept"\s*:\s*true/i.test(raw),
      feedback: REJECT_FEEDBACK[0],
    };
  }
}

// 投稿初审：检查汤底是否逻辑闭环、有无明显歧义、是否违规，返回 { pass, reason }
async function reviewSip(soupFace, answer) {
  const raw = await chat(
    [
      {
        role: 'system',
        content:
          '你是海龟汤内容审核员。请审核一道投稿的海龟汤，重点检查：' +
          '1) 汤底是否逻辑闭环、能否自圆其说（最重要）；' +
          '2) 汤面是否存在导致答案不唯一的明显歧义或漏洞；' +
          '3) 内容是否违规（色情、过度暴力血腥、政治敏感等）。' +
          '只输出一个 JSON 对象：{"pass": true 或 false, "reason": "一句中文理由（通过时给简评；拒绝时明确指出问题在哪，帮助作者修改）"}。' +
          '禁止输出 JSON 以外的内容。',
      },
      { role: 'user', content: '汤面：\n' + soupFace + '\n\n汤底：\n' + answer },
    ],
    { maxTokens: 200, temperature: 0.2, json: true }
  );
  try {
    const parsed = JSON.parse(raw);
    return { pass: !!parsed.pass, reason: String(parsed.reason || '') };
  } catch {
    // 结果解析失败：保守拒绝，让作者重试
    return { pass: false, reason: '系统解析审核结果失败，请稍后重试' };
  }
}

// AI 提示：给玩家一句不泄底的方向性提示
// 结合汤面、玩家已问过的问题、当前是第几次提示，分层递进，避免跳步/重复。
async function generateHint({ answer, content, askHistory = [], hintIndex = 1 }) {
  const history =
    askHistory.length > 0
      ? '玩家目前已问过的问题：\n' + askHistory.map((q, i) => `${i + 1}. ${q}`).join('\n') + '\n\n'
      : '玩家还未提出任何问题。\n\n';
  const stageHint =
    hintIndex <= 1
      ? '这是玩家的第 1 个提示。请给一个最宏观的方向性提示，帮助玩家找到思考的切入口，不要深入到具体情节。'
      : hintIndex === 2
        ? '这是玩家的第 2 个提示。可以稍稍收窄方向，但仍停留在思考方向层面，不要直接点破核心情节。'
        : '这是玩家的第 3（最后一个）提示。可以把方向进一步聚焦，但仍不要直接说出汤底真相或关键推理结论。';
  const raw = await chat(
    [
      {
        role: 'system',
        content:
          '你是海龟汤主持人。下面是本局的汤面与汤底。\n\n汤面：\n' +
          content +
          '\n\n汤底：\n' +
          answer +
          '\n\n' +
          history +
          stageHint +
          '\n要求：只输出一句提示（25 字以内），只给思考方向或值得留意的细节，绝不给出核心情节的关键点，' +
          '也不要重复玩家已经问过或推理过的方向。以「想想…」开头。',
      },
      { role: 'user', content: '请给提示' },
    ],
    { maxTokens: 70, temperature: 0.7 }
  );
  return raw.trim();
}

module.exports = { answerQuestion, judgeDeduction, reviewSip, generateHint, classifyAnswer };