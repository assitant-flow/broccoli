/**
 * 单元测试：记忆检索引擎（src/lib/memory-retrieval.ts）
 * 覆盖：分词、BM25 相关性排序、全量/检索模式切换、恒注入不变量、字符预算、零相关。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, bm25Score, selectMemoriesForInjection } from "../../src/lib/memory-retrieval";

test("分词：英文词、中文单字与双字 bigram", () => {
  const t = tokenize("修复登录态 fix login-redirect");
  assert.ok(t.includes("fix") && t.includes("login") && t.includes("redirect"), "英文词拆分");
  assert.ok(t.includes("修复"), "中文单字");
  assert.ok(t.includes("登录"), "中文双字");
});

test("分词：英文转小写", () => {
  const t = tokenize("PostgreSQL Redis");
  assert.ok(t.includes("postgresql") && !t.includes("PostgreSQL"));
});

test("BM25：含查询词的文档得分高于不含的", () => {
  const q = tokenize("page 参数校验");
  const good = tokenize("page 参数校验 throw Error");
  const bad = tokenize("深色主题字体偏好");
  const df = new Map<string, number>([["page", 1], ["参数", 1], ["校验", 1]]);
  const sGood = bm25Score(q, good, 6, df, 2);
  const sBad = bm25Score(q, bad, 6, df, 2);
  assert.ok(sGood > sBad, `good=${sGood} bad=${sBad}`);
});

test("BM25：空文档或空查询得 0 分", () => {
  const df = new Map<string, number>();
  assert.equal(bm25Score(tokenize("x"), [], 4, df, 1), 0);
  assert.equal(bm25Score([], tokenize("x"), 4, df, 1), 0);
});

const MANY = Array.from({ length: 20 }, (_, i) =>
  i < 3
    ? { id: `m${i}`, content: `订单分页 page 参数校验规范第${i}条：非法输入抛出错误` }
    : { id: `m${i}`, content: `无关记忆条目${i}：冬季主题与字体偏好调整说明` },
);

test("检索模式：低记忆量走全量注入", async () => {
  const r = await selectMemoriesForInjection({
    query: "分页参数校验",
    preferences: [{ id: "p1", content: "commit 用中文" }],
    proposals: [{ id: "pr1", content: "新增提案" }],
    items: [{ id: "m1", content: "技术栈 Next.js" }, { id: "m2", content: "测试用 vitest" }],
  });
  assert.equal(r.mode, "full");
  assert.equal(r.selected.length, 4);
  assert.equal(r.excluded, 0);
});

test("检索模式：超阈值按相关性排序，无关记忆被排除", async () => {
  const r = await selectMemoriesForInjection({
    query: "为订单接口添加分页 page 参数校验",
    preferences: [{ id: "p1", content: "commit 用中文" }],
    proposals: [],
    items: MANY,
  });
  assert.equal(r.mode, "keyword");
  const ids = r.selected.map((m) => m.id);
  assert.ok(ids.includes("p1"), "偏好恒注入（FR-G10）");
  assert.ok(["m0", "m1", "m2"].every((id) => ids.includes(id)), "相关记忆入选");
  assert.ok(!ids.includes("m15") && !ids.includes("m19"), "无关记忆排除");
  assert.equal(r.excluded, MANY.length - 3);
});

test("检索模式：字符预算约束（预算内按分数取）", async () => {
  const r = await selectMemoriesForInjection({
    query: "为订单接口添加分页 page 参数校验",
    preferences: [{ id: "p1", content: "commit 用中文" }],
    proposals: [],
    items: MANY,
    budgetChars: 15, // 偏好占 10 → 余 5，相关记忆（19 字符）放不下
  });
  const ids = r.selected.map((m) => m.id);
  assert.ok(!ids.some((id) => id.startsWith("m")), "预算不足 → 项目记忆不注入");
  assert.ok(ids.includes("p1"), "偏好仍恒注入");
});

test("检索模式：零相关查询 → 项目记忆全部排除，偏好恒注入", async () => {
  const r = await selectMemoriesForInjection({
    query: "量子密码学协议设计 xyzzy",
    preferences: [{ id: "p1", content: "commit 用中文" }],
    proposals: [],
    items: MANY,
  });
  const ids = r.selected.map((m) => m.id);
  assert.ok(!ids.some((id) => id.startsWith("m")), "CJK 单字碰撞规避后应全排除");
  assert.deepEqual(ids, ["p1"]);
  assert.equal(r.excluded, MANY.length);
});

test("检索模式：提案恒注入（提案即注入 FR-G3）", async () => {
  const r = await selectMemoriesForInjection({
    query: "完全无关 xyzzy",
    preferences: [],
    proposals: [{ id: "pr9", content: "新提案立即生效" }],
    items: MANY,
  });
  assert.ok(r.selected.some((m) => m.id === "pr9"), "提案不被检索筛掉");
});

test("检索模式：top-K 上限生效", async () => {
  // 14 条相关 + 6 条无关 = 20 > 阈值 16 → 检索模式；top-K 默认 12 → 相关入选 ≤ 12
  const relevant = Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`,
    content: `订单分页 page 参数校验细则版本${i}：非法输入抛出错误`,
  }));
  const irrelevant = Array.from({ length: 6 }, (_, i) => ({
    id: `x${i}`,
    content: `冬季主题与字体偏好调整说明条目${i}`,
  }));
  const r = await selectMemoriesForInjection({
    query: "订单分页 page 参数校验",
    preferences: [],
    proposals: [],
    items: [...relevant, ...irrelevant],
  });
  assert.equal(r.mode, "keyword");
  const ids = r.selected.map((m) => m.id);
  assert.ok(ids.every((id) => id.startsWith("r")), "无关记忆不占 top-K 名额");
  assert.ok(r.selected.length <= 12, `top-K 上限，实际 ${r.selected.length}`);
  assert.equal(r.excluded, 20 - r.selected.length);
});

export {};
