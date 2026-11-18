import { env } from "@/lib/env";

/**
 * 记忆检索优化（FR-G11，v2β）：记忆膨胀后按相关性筛选注入。
 * 双模式：
 * - keyword（默认，零依赖）：BM25-lite 词频-逆文档频率评分，对中英文均分词
 * - vector（可选）：配置 BROCCOLI_EMBEDDINGS_URL（OpenAI 兼容 /embeddings 端点）
 *   时启用余弦相似度；端点不可用自动回落 keyword，不阻塞流水线
 *
 * 注入策略：已确认记忆 ≤ 注入阈值时全量注入（现状）；超过阈值进入检索模式——
 * 个人偏好恒注入（跨项目）、提案恒注入（提案即注入语义不变，FR-G3），
 * 仅对「已确认项目记忆」做相关性 top-K 筛选。
 */

export interface ScoredMemory<T> {
  item: T;
  score: number;
}

export interface RetrievalResult<T> {
  /** 最终注入集合（顺序：偏好 → 提案 → 相关记忆 top-K） */
  selected: T[];
  mode: "full" | "keyword" | "vector";
  /** 被检索模式排除的记忆数（审计用） */
  excluded: number;
  /** vector 模式失败回落 keyword 的原因（无则 null） */
  fallbackReason: string | null;
}

/* ============ 分词：英文按词、中文按单字 + 双字（bigram） ============ */

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  // 英文/数字词
  for (const m of lower.matchAll(/[a-z0-9_]{2,}/g)) tokens.push(m[0]);
  // 中文：单字 + 相邻双字（保留语义粒度）
  const cjkRuns = lower.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const run of cjkRuns) {
    const chars = [...run];
    for (const c of chars) tokens.push(c);
    for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

/* ============ BM25-lite 关键词相关性 ============ */

export function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  avgDocLen: number,
  docFreq: Map<string, number>,
  totalDocs: number,
  k1 = 1.5,
  b = 0.75,
): number {
  if (!queryTokens.length || !docTokens.length || totalDocs === 0) return 0;
  const docLen = docTokens.length;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const qTokens = [...new Set(queryTokens)]; // 查询词去重（BM25 对查询项求和）
  let score = 0;
  for (const q of qTokens) {
    const f = tf.get(q);
    if (!f) continue;
    const df = docFreq.get(q) ?? 0;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docLen) / avgDocLen)));
  }
  return score;
}

/* ============ 可选 embeddings（OpenAI 兼容端点） ============ */

const embedCache = new Map<string, number[]>();

async function embedText(text: string): Promise<number[] | null> {
  if (!env.embeddingsUrl) return null;
  const cacheKey = `${env.embeddingsModel}:${text.slice(0, 120)}`;
  const cached = embedCache.get(cacheKey);
  if (cached) return cached;
  try {
    const res = await fetch(`${env.embeddingsUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.embeddingsKey}` },
      body: JSON.stringify({ model: env.embeddingsModel, input: text }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { embedding?: number[] }[] };
    const vec = data.data?.[0]?.embedding;
    if (!vec?.length) return null;
    embedCache.set(cacheKey, vec);
    if (embedCache.size > 500) embedCache.clear(); // 简单防膨胀
    return vec;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/* ============ 主入口 ============ */

export interface RetrievalInput<T> {
  /** 相关性查询上下文（需求标题 + 描述） */
  query: string;
  /** 个人偏好（恒注入，FR-G10） */
  preferences: T[];
  /** 待确认提案（恒注入，提案即注入 FR-G3） */
  proposals: T[];
  /** 已确认项目记忆（检索池） */
  items: T[];
  /** 注入字符预算（检索模式下相关记忆的总字符上限） */
  budgetChars?: number;
}

export async function selectMemoriesForInjection<T extends { id: string; content: string }>(
  input: RetrievalInput<T>,
): Promise<RetrievalResult<T>> {
  const budget = input.budgetChars ?? env.memoryInjectBudgetChars;
  const total = input.preferences.length + input.proposals.length + input.items.length;

  // 未超过阈值：全量注入（现状，记忆膨胀前零开销）
  if (total <= env.memoryInjectThreshold) {
    return {
      selected: [...input.preferences, ...input.proposals, ...input.items],
      mode: "full",
      excluded: 0,
      fallbackReason: null,
    };
  }

  // 检索模式：偏好/提案恒注入，项目记忆按相关性 top-K
  const alwaysSelected: T[] = [...input.preferences, ...input.proposals];
  const usedChars = alwaysSelected.reduce((n, m) => n + m.content.length, 0);
  const remainingBudget = Math.max(0, budget - usedChars);

  // vector 模式（配置了 embeddings 端点才尝试）
  let mode: "keyword" | "vector" = "keyword";
  let fallbackReason: string | null = null;
  let scored: ScoredMemory<T>[];

  if (env.embeddingsUrl) {
    try {
      const queryVec = await embedText(input.query);
      if (!queryVec) throw new Error("query embedding 失败");
      const docVecs = await Promise.all(
        input.items.map(async (m) => ({ item: m, vec: await embedText(m.content) })),
      );
      scored = docVecs
        .filter((d): d is { item: T; vec: number[] } => !!d.vec)
        .map((d) => ({ item: d.item, score: cosine(queryVec, d.vec) }))
        .sort((a, b) => b.score - a.score);
      mode = "vector";
    } catch (err) {
      fallbackReason = `embeddings 端点不可用（${String(err).slice(0, 80)}）→ 回落 keyword`;
      scored = [];
    }
  } else {
    scored = [];
  }

  // keyword 模式（或 vector 回落）：BM25-lite
  if (mode === "keyword") {
    const queryTokens = tokenize(input.query);
    const docs = input.items.map((m) => ({ item: m, tokens: tokenize(m.content) }));
    const totalDocs = docs.length || 1;
    const avgDocLen = docs.reduce((n, d) => n + d.tokens.length, 0) / totalDocs;
    const docFreq = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d.tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    scored = docs
      .map((d) => ({ item: d.item, score: bm25Score(queryTokens, d.tokens, avgDocLen, docFreq, totalDocs) }))
      .sort((a, b) => b.score - a.score);
  }

  // top-K + 字符预算（预算内按分数取，零分记忆不注入）
  const selected: T[] = [];
  let used = 0;
  let excluded = input.items.length;
  for (const s of scored) {
    if (selected.length >= env.memoryTopK) break;
    if (s.score <= 0) break;
    if (used + s.item.content.length > remainingBudget) continue;
    selected.push(s.item);
    used += s.item.content.length;
    excluded -= 1;
  }

  return {
    selected: [...alwaysSelected, ...selected],
    mode,
    excluded,
    fallbackReason,
  };
}
