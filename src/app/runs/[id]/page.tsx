"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api, fmtDuration, fmtTime } from "@/lib/client";

type ConfirmQuestion = {
  question: string;
  options: { key: string; label: string; description?: string; recommended?: boolean }[];
  allowFreeText: boolean;
  context?: string;
};
type Stage = {
  id: string; type: string; seq: number; state: string; modelKey: string | null; modelSource: string;
  summary: string | null; startedAt: string | null; endedAt: string | null;
};
type Artifact = { id: string; stageId: string; name: string; kind: string; storageKey: string | null; meta: Record<string, unknown> };
type Criterion = { id: string; seq: number; content: string; verifyStage: string; status: string; evidence: string | null };
type Subtask = { id: string; seq: number; title: string; state: string };
type LogLine = { ts: string; stageId: string; level: string; line: string };
type Canvas = {
  run: {
    id: string; state: string; branch: string | null; baseBranch: string | null; currentStage: string | null;
    confirmQuestion: ConfirmQuestion | null; confirmAnswer: string | null; repairRound: number; error: string | null;
    startedAt: string | null; endedAt: string | null;
  };
  requirement: { id: string; seq: number; title: string; description: string };
  project: { id: string; name: string };
  stages: Stage[];
  subtasks: Subtask[];
  criteria: Criterion[];
  artifacts: Artifact[];
  logs: LogLine[];
  prs: { id: string; number: number; branch: string; baseBranch: string; body: string; diffStat: string }[];
};

const LAYOUT: Record<string, { x: number; y: number; w: number; h?: number }> = {
  planning: { x: 196, y: 186, w: 246 },
  dev: { x: 496, y: 66, w: 252 },
  test_design: { x: 496, y: 392, w: 252 },
  test_run: { x: 812, y: 190, w: 250 },
  acceptance: { x: 812, y: 382, w: 250 },
};
const STAGE_ORDER = ["planning", "dev", "test_design", "test_run", "acceptance", "delivery"];
const STAGE_NAMES: Record<string, string> = {
  planning: "规划 · Planning", dev: "开发实现", test_design: "测试用例编写", test_run: "测试执行", acceptance: "验收对照", delivery: "交付",
};
const STAGE_ICONS: Record<string, string> = {
  planning: "i-spark", dev: "i-term", test_design: "i-edit", test_run: "i-play", acceptance: "i-shield", delivery: "i-pr",
};

function stageChip(state: string) {
  switch (state) {
    case "completed": return { cls: "ok", label: "✓ 完成" };
    case "running": return { cls: "run", label: "● 执行中" };
    case "wait_confirm": return { cls: "warn", label: "⏸ 等待确认" };
    case "failed": return { cls: "bad", label: "✗ 失败" };
    case "skipped": return { cls: "q", label: "⊘ 已跳过" };
    default: return { cls: "q", label: "排队中" };
  }
}
function nodeCls(state: string) {
  switch (state) {
    case "completed": return "done";
    case "running": return "run";
    case "wait_confirm": return "wait";
    case "failed": return "failed";
    case "skipped": return "queued";
    default: return "queued";
  }
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState("");
  const [data, setData] = useState<Canvas | null>(null);
  const [selected, setSelected] = useState<string>("planning");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [tab, setTab] = useState<"canvas" | "logs" | "chat">("canvas");
  const [msgs, setMsgs] = useState<{ id: string; role: string; text: string; createdAt: string }[]>([]);
  const [msgDraft, setMsgDraft] = useState("");
  const [confirmChoice, setConfirmChoice] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const [busy, setBusy] = useState(false);
  const [artifactView, setArtifactView] = useState<{ name: string; content: string } | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    params.then((p) => setId(p.id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
    const load = () => api<{ id: string; role: string; text: string; createdAt: string }[]>(`/api/runs/${id}/messages`).then(setMsgs).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [id]);

  async function sendMessage() {
    if (!msgDraft.trim()) return;
    setBusy(true);
    try {
      await api(`/api/runs/${id}/messages`, { method: "POST", body: JSON.stringify({ text: msgDraft }) });
      setMsgDraft("");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!id) return;
    const load = () => api<Canvas>(`/api/runs/${id}`).then(setData).catch(() => {});
    load();
    const t = setInterval(load, 2200);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/runs/${id}/stream`);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const line = JSON.parse(ev.data) as LogLine & { id?: string };
        setLogs((prev) => {
          if (line.id && prev.some((x) => (x as unknown as { id?: string }).id === line.id)) return prev;
          return [...prev.slice(-400), line];
        });
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [id]);

  const stagesByType = useMemo(() => {
    const m = new Map<string, Stage>();
    data?.stages.forEach((s) => m.set(s.type, s));
    return m;
  }, [data]);

  const selStage = stagesByType.get(selected);
  const selArtifacts = data?.artifacts.filter((a) => a.stageId === selStage?.id) ?? [];
  const doneCount = data?.criteria.filter((c) => c.status === "achieved").length ?? 0;

  async function viewArtifact(a: Artifact) {
    const res = await fetch(`/api/artifacts?runId=${id}&name=${encodeURIComponent(a.name.replace(/[\\/]/g, "_"))}`);
    const content = await res.text();
    setArtifactView({ name: a.name, content });
  }

  async function submitConfirm() {
    if (!confirmChoice && !freeText.trim()) return;
    setBusy(true);
    try {
      const answer = confirmChoice === "free" ? freeText : data?.run.confirmQuestion?.options.find((o) => o.key === confirmChoice)?.label ?? freeText;
      await api(`/api/runs/${id}/confirm`, { method: "POST", body: JSON.stringify({ answer, optionKey: confirmChoice ?? undefined }) });
      setConfirmChoice(null);
      setFreeText("");
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action: string) {
    setBusy(true);
    try {
      await api(`/api/runs/${id}/actions`, { method: "POST", body: JSON.stringify({ action }) });
    } finally {
      setBusy(false);
    }
  }

  const run = data?.run;
  const edges = useMemo(() => {
    const st = (t: string) => stagesByType.get(t);
    const cls = (t: string) => {
      const s = st(t);
      if (!s) return "edge";
      if (s.state === "completed") return "edge done";
      if (s.state === "running") return "edge active";
      if (s.state === "wait_confirm") return "edge done";
      return "edge";
    };
    return [
      { d: "M158 318 C 180 318 176 302 196 302", cls: "edge done" },
      { d: "M442 276 C 470 276 468 160 496 160", cls: cls("dev") },
      { d: "M442 330 C 470 330 468 480 496 480", cls: cls("test_design") },
      { d: "M748 160 C 782 160 780 245 812 245", cls: cls("test_run") },
      { d: "M748 480 C 782 480 780 285 812 285", cls: cls("test_run") },
      { d: "M937 340 L 937 382", cls: cls("acceptance") },
      { d: "M937 532 L 937 576", cls: cls("delivery") },
    ];
  }, [stagesByType]);

  const runChip = () => {
    if (!run) return null;
    if (run.state === "wait_confirm") return <span className="chip chip-amber"><span className="dot pulse" />等待确认</span>;
    if (run.state === "completed") return <span className="chip chip-green"><I name="i-check" size={12} />完成</span>;
    if (run.state === "failed") return <span className="chip chip-red"><I name="i-alert" size={12} />失败</span>;
    if (run.state === "suspended") return <span className="chip chip-amber">已挂起</span>;
    return <span className="chip chip-green"><span className="dot pulse" />执行中 · {run.currentStage}</span>;
  };

  return (
    <Shell active="projects">
      <div className="crumb">
        <Link href="/projects">项目</Link> <I name="i-chev" size={12} /> <Link href={`/projects/${data?.project?.id}`}>{data?.project?.name ?? "…"}</Link> <I name="i-chev" size={12} /> 需求 #{data?.requirement?.seq} · 执行画布
      </div>
      <div className="task-hd">
        <div>
          <div className="ttl-h">{data?.requirement?.title ?? "…"}</div>
          <div className="meta">
            {runChip()}
            <span className="chip chip-gray">总耗时 {fmtDuration(run?.startedAt, run?.endedAt)}</span>
            <span className="chip chip-gray"><I name="i-check" size={12} />验收达成 {doneCount}/{data?.criteria.length ?? 0}</span>
            {run && run.repairRound > 0 && <span className="chip chip-amber">修复轮次 {run.repairRound}</span>}
            {run?.branch && <span className="chip chip-gray"><I name="i-branch" size={12} />{run.branch}</span>}
            {run?.baseBranch && <span className="chip chip-gray">base · {run.baseBranch}</span>}
          </div>
        </div>
        <div className="acts">
          {["failed"].includes(run?.state ?? "") && (
            <>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => runAction("retry")}><I name="i-refresh" size={13} />重试</button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => runAction("skip")}>跳过</button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => runAction("terminate")}>终止队列</button>
            </>
          )}
          {["running", "wait_confirm", "preparing", "queued"].includes(run?.state ?? "") && (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => runAction("cancel")}><I name="i-x" size={13} />取消</button>
          )}
          {run?.state === "completed" && data?.prs.map((pr) => (
            <Link key={pr.id} className="chip chip-green" href={`/projects/${data.project.id}`}>PR #{pr.number} 已开出</Link>
          ))}
        </div>
      </div>

      {/* 确认问答卡（FR-D4） */}
      {run?.state === "wait_confirm" && run.confirmQuestion && !run.confirmAnswer && (
        <div className="confirm-card"><div className="inner">
          <div className="q-hd">
            <span className="cn-ic" style={{ background: "var(--amber-dim)", color: "var(--amber)", width: 34, height: 34 }}><I name="i-db" size={16} /></span>
            <div className="qt">Agent 需要你的决定</div>
            <span className="chip chip-amber" style={{ marginLeft: "auto" }}><span className="dot pulse" />回答后恢复执行</span>
          </div>
          <div className="qq">{run.confirmQuestion.question}</div>
          {run.confirmQuestion.context && <div className="qq" style={{ marginTop: 8, fontSize: 12, color: "var(--txt-3)" }}>{run.confirmQuestion.context}</div>}
          <div className="opts">
            {run.confirmQuestion.options.map((o) => (
              <div key={o.key} className={`opt ${confirmChoice === o.key ? "sel" : ""}`} onClick={() => setConfirmChoice(o.key)}>
                <div className="ot">{o.label} {o.recommended && <span className="rec">推荐</span>}</div>
                {o.description && <div className="od">{o.description}</div>}
              </div>
            ))}
            {run.confirmQuestion.allowFreeText && (
              <div className={`opt ${confirmChoice === "free" ? "sel" : ""}`} onClick={() => setConfirmChoice("free")}>
                <div className="ot">其他方案</div>
                <textarea
                  value={freeText}
                  onChange={(e) => { setFreeText(e.target.value); setConfirmChoice("free"); }}
                  placeholder="补充你的想法…"
                  style={{ width: "100%", marginTop: 8, background: "rgba(255,255,255,.04)", border: "1px dashed var(--line-2)", borderRadius: 10, padding: "8px 10px", fontSize: 12, outline: "none", resize: "vertical" }}
                />
              </div>
            )}
          </div>
          <div className="aft">
            <button className="btn btn-primary" onClick={submitConfirm} disabled={busy || (!confirmChoice && !freeText.trim())}>回答并继续执行<I name="i-arrow" size={14} /></button>
            <span className="sp" />
            <span className="note"><I name="i-clock" size={13} />快照已保存 · 超时未回复自动挂起，队列继续后续任务</span>
          </div>
        </div></div>
      )}

      {run?.state === "failed" && run.error && (
        <div className="alert red" style={{ marginBottom: 20 }}>
          <div className="inner">
            <div className="hd"><span className="chip chip-red"><I name="i-alert" size={12} />执行失败</span></div>
            <div className="q">{run.error}</div>
            <div className="ft">
              <span className="meta">失败策略：暂停队列 · 邮件已发送</span>
              <div className="acts">
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => runAction("retry")}><I name="i-refresh" size={12} />重试</button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => runAction("skip")}>跳过</button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => runAction("terminate")}>终止队列</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {run?.state === "suspended" && (
        <div className="alert amber" style={{ marginBottom: 20 }}>
          <div className="inner">
            <div className="hd"><span className="chip chip-amber">💤 已挂起</span></div>
            <div className="q">等待确认超时，任务已挂起、容器已释放。可将该需求重新入队（base 回退至最后成功分支）。</div>
          </div>
        </div>
      )}

      <div className="tabs">
        <span className={tab === "canvas" ? "on" : ""} onClick={() => setTab("canvas")}>执行画布</span>
        <span className={tab === "logs" ? "on" : ""} onClick={() => setTab("logs")}>实时日志 · {logs.length}</span>
        <span className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>介入讨论 · {msgs.filter((m) => m.role === "user").length}</span>
        <span onClick={() => setTab("canvas")}>子任务 · {data?.subtasks.length ?? 0}</span>
        <span onClick={() => setTab("canvas")}>验收 · {doneCount}/{data?.criteria.length ?? 0}</span>
      </div>

      {tab === "chat" && (
        <div className="shell"><div className="core" style={{ padding: "18px 20px", maxWidth: 860 }}>
          <div className="strip-hd">
            <span style={{ fontWeight: 800, fontSize: 14 }}>介入讨论</span>
            <span className="meta">补充说明将注入后续阶段上下文（FR-E6 · AC-E6）</span>
          </div>
          <div className="chat-sample" style={{ marginBottom: 16, minHeight: 120 }}>
            {msgs.length === 0 && <div style={{ color: "var(--txt-3)", fontSize: 12.5, fontWeight: 500 }}>还没有讨论 —— 你可以随时补充上下文、修正方向或提供额外约束</div>}
            {msgs.map((m) => (
              <div key={m.id} className={`bub ${m.role === "user" ? "u" : "a"}`}>
                <div className="who">{m.role === "user" ? "你" : "AGENT"} · {new Date(m.createdAt).toLocaleTimeString("zh-CN")}</div>
                {m.text}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <textarea
              value={msgDraft}
              onChange={(e) => setMsgDraft(e.target.value)}
              placeholder="例如：登录态需要兼容旧版客户端，token 格式不要变…"
              style={{ flex: 1, minHeight: 64, background: "rgba(255,255,255,.04)", border: "1px solid var(--line-2)", borderRadius: 14, padding: "10px 14px", fontSize: 13, outline: "none", resize: "vertical", color: "var(--txt)", fontFamily: "var(--sans)" }}
            />
            <button className="btn btn-primary" disabled={busy || !msgDraft.trim()} onClick={sendMessage}>发送<I name="i-arrow" size={14} /></button>
          </div>
        </div></div>
      )}

      {tab === "canvas" && (
        <>
          <div className="cv-toolbar">
            <span className="ttl">执行画布</span>
            <span className="legend">
              <span><i style={{ background: "var(--acc-deep)" }} />已完成</span>
              <span><i style={{ background: "var(--acc)" }} className="pulse" />执行中</span>
              <span><i style={{ background: "var(--amber)" }} />等待确认</span>
              <span><i className="lq" />排队中</span>
            </span>
            <span className="sp" />
            <Link className="btn btn-ghost btn-sm" href={`/projects/${data?.project?.id}`}><I name="i-sliders" size={13} />阶段与模型配置</Link>
          </div>
          <div className="shell"><div className="canvas-wrap">
            <svg className="edges" width="1110" height="620" viewBox="0 0 1110 620">
              {edges.map((e, i) => <path key={i} className={e.cls} d={e.d} />)}
            </svg>
            <div className="stage-pill" style={{ left: 18, top: 292, width: 140 }}>
              <I name="i-leaf" size={15} />
              <div><div>需求 #{data?.requirement?.seq}</div><div className="sub">已受理 · {fmtTime(run?.startedAt)}</div></div>
            </div>
            {["planning", "dev", "test_design", "test_run", "acceptance"].map((t) => {
              const s = stagesByType.get(t);
              const layout = LAYOUT[t];
              if (!s) return null;
              const chip = stageChip(s.state);
              const artList = data?.artifacts.filter((a) => a.stageId === s.id) ?? [];
              const criteriaHere = data?.criteria.filter((c) => c.verifyStage === t) ?? [];
              const failedHere = criteriaHere.filter((c) => c.status === "failed").length;
              return (
                <div key={t} className={`cnode ${nodeCls(s.state)} ${selected === t ? "sel" : ""}`} style={{ left: layout.x, top: layout.y, width: layout.w }} onClick={() => setSelected(t)}>
                  <div className="cn-hd">
                    <span className="cn-ic"><I name={STAGE_ICONS[t]} size={14} /></span>
                    <span className="cn-name">{STAGE_NAMES[t]}</span>
                    <span className={`cn-chip ${chip.cls}`}>{chip.label}</span>
                  </div>
                  <span className="cn-model"><I name="i-zap" size={10} />{s.modelKey ?? "—"} · {s.modelSource === "override" ? "临时覆盖" : s.modelSource === "custom" ? "自定义" : "推荐"}</span>
                  <div className="cn-meta">
                    耗时 {fmtDuration(s.startedAt, s.endedAt)}
                    {t === "dev" && run && run.repairRound > 0 ? ` · 修复轮次 ${run.repairRound}` : ""}
                  </div>
                  {s.summary && <div className="cn-desc">{s.summary.slice(0, 88)}{s.summary.length > 88 ? "…" : ""}</div>}
                  {t === "dev" && data?.subtasks.length ? (
                    <div className="cn-prog">
                      <div className="bar progress"><b style={{ width: `${(data.subtasks.filter((x) => x.state === "completed").length / data.subtasks.length) * 100}%` }} /></div>
                      子任务 {data.subtasks.filter((x) => x.state === "completed").length}/{data.subtasks.length}
                    </div>
                  ) : null}
                  {t === "acceptance" && data?.criteria.length ? (
                    <div className="cn-prog">
                      <div className="bar progress"><b style={{ width: `${(doneCount / data.criteria.length) * 100}%` }} /></div>
                      {doneCount}/{data.criteria.length}{failedHere > 0 ? ` · ${failedHere} 未达成` : ""}
                    </div>
                  ) : null}
                  {s.state === "wait_confirm" && <div className="cn-note"><I name="i-db" size={12} />等待你的决定 · 并行支线不受影响</div>}
                  {artList.length > 0 && <div className="cn-art">{artList.slice(0, 3).map((a) => <span key={a.id}>{a.name}</span>)}</div>}
                </div>
              );
            })}
            <div className="stage-pill" style={{ left: 812, top: 576, width: 250 }}>
              <I name="i-pr" size={15} />
              <div>
                <div>交付 · {data?.prs.length ? `PR #${data.prs[0].number} 已开出` : "PR（待验收达成）"}</div>
                <div className="sub">push 分支 + 堆叠 PR + 记忆提案</div>
              </div>
            </div>
          </div></div>

          {/* 选中阶段检查器（FR-D16） */}
          {selStage && (
            <div className="strip shell"><div className="core inner">
              <div className="strip-hd">
                <span className="chip chip-blue">选中阶段</span>
                <span style={{ fontSize: 14, fontWeight: 800 }}>{STAGE_NAMES[selected]}</span>
                <span className="meta">点击画布节点切换详情 · 规划产出的子任务与验收标准驱动后续所有阶段</span>
                <span className="sp" />
                <span className="chip chip-gray">{stageChip(selStage.state).label}</span>
              </div>
              <div className="strip-grid">
                <div>
                  <div className="sg-h">阶段说明</div>
                  <div className="sg-desc">{selStage.summary ?? "等待启动 — 该阶段将按实现计划执行。"}</div>
                  <div style={{ marginTop: 12 }}>
                    <div className="sg-kv">模型<span className="v">{selStage.modelKey}（{selStage.modelSource === "override" ? "临时覆盖" : selStage.modelSource === "custom" ? "自定义" : "推荐"}）</span></div>
                    <div className="sg-kv">耗时<span className="v">{fmtDuration(selStage.startedAt, selStage.endedAt)}</span></div>
                    <div className="sg-kv">开始<span className="v">{selStage.startedAt ? new Date(selStage.startedAt).toLocaleTimeString("zh-CN") : "—"}</span></div>
                  </div>
                </div>
                <div>
                  <div className="sg-h">产物 ×{selArtifacts.length}</div>
                  {selArtifacts.length === 0 && <div className="sg-desc" style={{ color: "var(--txt-3)" }}>尚无产物</div>}
                  {selArtifacts.map((a) => (
                    <div key={a.id} className="art-row">
                      <span className="an">{a.name}</span>
                      {a.storageKey && <span className="view" onClick={() => viewArtifact(a)}>查看</span>}
                    </div>
                  ))}
                </div>
                <div>
                  <div className="sg-h">验收标准 <span className="n">已达成 {doneCount}/{data?.criteria.length ?? 0}</span></div>
                  <div className="progress" style={{ width: 200, marginBottom: 10 }}><b style={{ width: `${data?.criteria.length ? (doneCount / data.criteria.length) * 100 : 0}%` }} /></div>
                  <div className="ac-grid">
                    {data?.criteria.map((c) => (
                      <div key={c.id} className="ac-row">
                        {c.status === "achieved" ? <I name="i-check" size={13} /> : c.status === "failed" ? <I name="i-x" size={13} /> : <span className="wt" />}
                        <span>{c.content}</span>
                        <span className="src" style={c.status === "failed" ? { background: "var(--red-dim)", color: "var(--red)" } : c.status === "achieved" ? { background: "var(--acc-dim)", color: "var(--acc)" } : {}}>
                          {c.status === "achieved" ? "达成" : c.status === "failed" ? "未达成" : "待验证"} · {c.verifyStage}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div></div>
          )}

          {artifactView && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setArtifactView(null)}>
              <div className="shell" style={{ width: 720, maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
                <div className="core" style={{ padding: "18px 20px" }}>
                  <div className="strip-hd">
                    <span style={{ fontWeight: 800, fontSize: 14 }}>{artifactView.name}</span>
                    <span className="sp" />
                    <button className="btn btn-ghost btn-sm" onClick={() => setArtifactView(null)}>关闭</button>
                  </div>
                  <pre className="term" style={{ maxHeight: 420, whiteSpace: "pre-wrap" }}>{artifactView.content}</pre>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "logs" && (
        <div className="termwrap">
          <div className="term">
            {logs.length === 0 && <div className="dim">等待日志…</div>}
            {logs.map((l, i) => (
              <div key={i}>
                <span className="ts">{fmtTime(l.ts)}</span>
                <span className={l.level === "ok" ? "ok" : l.level === "warn" ? "warn" : l.level === "error" ? "err" : "dim"}>
                  {l.level === "ok" ? "✓ " : l.level === "warn" ? "⚠ " : l.level === "error" ? "✗ " : "· "}
                </span>
                {l.line}
              </div>
            ))}
            {run?.state === "running" && <span className="dim" style={{ display: "inline-block", width: 8, height: 14, background: "var(--acc)", animation: "gl 1.2s var(--ease) infinite" }} />}
          </div>
          <div className="file-list shell"><div className="core inner">
            <div className="fh"><I name="i-term" size={14} />本轮产物 · {data?.artifacts.length ?? 0} 个</div>
            {data?.artifacts.map((a) => (
              <div key={a.id} className="frow">
                <span className="fn">{a.name}</span>
                {a.storageKey && <span className="view" onClick={() => viewArtifact(a)}>查看</span>}
              </div>
            ))}
            {data?.artifacts.length === 0 && <div className="dstat">尚无产物</div>}
          </div></div>
        </div>
      )}
    </Shell>
  );
}
