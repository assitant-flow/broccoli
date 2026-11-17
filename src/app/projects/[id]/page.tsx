"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api, fmtDuration } from "@/lib/client";

type Project = {
  id: string; name: string; repoFullName: string; defaultBranch: string; failurePolicy: string;
  lastSuccessBranch: string | null; settings: { parallelStages?: boolean };
};
type Req = { id: string; seq: number; title: string; status: string; latestRunId: string | null; dependsOnSeq: number | null; skipReason: string | null };
type Run = { id: string; requirementId: string; state: string; currentStage: string | null; error: string | null; startedAt: string | null; endedAt: string | null };
type Pr = { id: string; number: number; title: string; branch: string; baseBranch: string; diffStat: string; status: string };
type Issue = { id: string; number: number; title: string; state: string; syncedRequirementId: string | null };
type MemCounts = { confirmed: number; pending: number };

const STATUS_CHIP: Record<string, { cls: string; label: string }> = {
  queued: { cls: "chip-blue", label: "排队中" },
  active: { cls: "chip-green", label: "执行中" },
  done: { cls: "chip-green", label: "完成" },
  failed: { cls: "chip-red", label: "失败" },
  skipped: { cls: "chip-gray", label: "已跳过" },
  suspended: { cls: "chip-amber", label: "已挂起" },
  cancelled: { cls: "chip-gray", label: "已取消" },
};

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string>("");
  const [project, setProject] = useState<Project | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [prs, setPrs] = useState<Pr[]>([]);
  const [mem, setMem] = useState<MemCounts>({ confirmed: 0, pending: 0 });
  const [draft, setDraft] = useState("");
  const [policy, setPolicy] = useState<"pause" | "skip_continue">("pause");
  const [busy, setBusy] = useState(false);
  const [issueList, setIssueList] = useState<Issue[]>([]);
  const [diffView, setDiffView] = useState<{ title: string; content: string } | null>(null);
  const composeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    params.then((p) => setId(p.id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
    const load = () =>
      api<{ project: Project; requirements: Req[]; runs: Run[]; prs: Pr[] }>(`/api/projects/${id}`)
        .then((d) => {
          setProject(d.project);
          setReqs(d.requirements);
          setRuns(d.runs);
          setPrs(d.prs);
          setPolicy(d.project.failurePolicy === "skip_continue" ? "skip_continue" : "pause");
        })
        .catch(() => {});
    load();
    const loadMem = () =>
      api<{ items: unknown[]; proposals: { status: string }[] }>(`/api/projects/${id}/memories`)
        .then((m) =>
          setMem({
            confirmed: m.items.filter((x) => (x as { status: string }).status === "confirmed").length,
            pending: m.proposals.filter((x) => x.status === "pending").length,
          }),
        )
        .catch(() => {});
    loadMem();
    const loadIssues = () => api<Issue[]>(`/api/projects/${id}/issues`).then(setIssueList).catch(() => {});
    loadIssues();
    const t = setInterval(load, 2500);
    const t2 = setInterval(loadMem, 4000);
    const t3 = setInterval(loadIssues, 4000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
      clearInterval(t3);
    };
  }, [id]);

  async function prAction(prId: string, action: "merge" | "rebase") {
    setBusy(true);
    try {
      const res = await api<{ ok: boolean; message: string }>(`/api/prs/${prId}/actions`, { method: "POST", body: JSON.stringify({ action }) });
      if (!res.ok) alert(res.message);
    } catch (e) {
      alert(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function viewPrDiff(prId: string, title: string) {
    const res = await fetch(`/api/prs/${prId}/diff`);
    setDiffView({ title, content: await res.text() });
  }

  async function pullIssue(issueId: string) {
    setBusy(true);
    try {
      await api(`/api/projects/${id}/issues`, { method: "POST", body: JSON.stringify({ issueIds: [issueId] }) });
    } finally {
      setBusy(false);
    }
  }

  async function moveReq(r: Req, dir: -1 | 1) {
    const queued = reqs.filter((x) => x.status === "queued");
    const idx = queued.findIndex((x) => x.id === r.id);
    const swap = queued[idx + dir];
    if (!swap) return;
    const order = queued.map((x) => x.id);
    order[idx] = swap.id;
    order[idx + dir] = r.id;
    setBusy(true);
    try {
      await api(`/api/projects/${id}/requirements/reorder`, { method: "POST", body: JSON.stringify({ order }) });
    } finally {
      setBusy(false);
    }
  }

  async function submitQueue() {
    const items = draft.split("\n").map((s) => s.trim().replace(/^[-•·]\s*/, "")).filter(Boolean);
    if (!items.length) return;
    setBusy(true);
    try {
      await api(`/api/projects/${id}/requirements`, { method: "POST", body: JSON.stringify({ items, failurePolicy: policy }) });
      setDraft("");
    } finally {
      setBusy(false);
    }
  }

  async function runAction(runId: string, action: string) {
    setBusy(true);
    try {
      await api(`/api/runs/${runId}/actions`, { method: "POST", body: JSON.stringify({ action }) });
    } finally {
      setBusy(false);
    }
  }

  async function requeue(reqId: string) {
    setBusy(true);
    try {
      await api(`/api/requirements/${reqId}/requeue`, { method: "POST" });
    } finally {
      setBusy(false);
    }
  }

  const latestRunOf = (r: Req) => runs.find((x) => x.requirementId === r.id);
  const openPrs = prs.filter((p) => p.status === "open");

  return (
    <Shell active="projects">
      <div className="crumb">项目 <I name="i-chev" size={12} /> <b>{project?.name ?? "…"}</b></div>
      <div className="phd">
        <div>
          <div className="rname">{project?.repoFullName ?? "…"}</div>
          <div className="rmeta">
            <span className="chip chip-gray"><I name="i-branch" size={12} />{project?.defaultBranch}</span>
            <span className="chip chip-gray">{project?.failurePolicy === "pause" ? "失败暂停" : "失败自动跳过"}</span>
            <span className="chip chip-gray">{project?.settings?.parallelStages !== false ? "开发 ∥ 测试用例并行" : "串行执行"}</span>
            {project?.lastSuccessBranch && <span className="chip chip-green"><I name="i-check" size={12} />堆叠至 {project.lastSuccessBranch}</span>}
          </div>
        </div>
        <div className="acts">
          <Link className="btn btn-ghost" href={`/projects/${id}/settings`}><I name="i-sliders" size={15} />阶段与模型</Link>
          <button className="btn btn-primary" onClick={() => composeRef.current?.scrollIntoView({ behavior: "smooth" })}>提交需求<I name="i-plus" size={14} /></button>
        </div>
      </div>

      <div className="split">
        <div>
          <div className="sec-hd">
            <span className="t">需求队列</span>
            <span className="chip chip-gray">全部 {reqs.length}</span>
            <span className="chip chip-green">完成 {reqs.filter((r) => r.status === "done").length}</span>
            {(reqs.filter((r) => r.status === "failed").length > 0) && <span className="chip chip-red">失败 {reqs.filter((r) => r.status === "failed").length}</span>}
            <span className="chip chip-blue">排队 {reqs.filter((r) => r.status === "queued").length}</span>
          </div>

          <div className="compose shell" ref={composeRef} style={{ marginBottom: 16 }}>
            <div className="core inner">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={"每行一条需求，一次可提交多条：\n· 修复登录态过期后无限重定向的问题\n· 引入会话持久化存储，支持限流计数\n· @2 在会话存储就绪后新增限流中间件（@N = 依赖需求 #N，依赖图 v2α）"} />
              <div className="ft">
                <span className="hint"><I name="i-alert" size={13} />失败时：{policy === "pause" ? "暂停队列并邮件通知你" : "自动跳过并继续后续需求"}</span>
                <div className="seg">
                  <span className={policy === "pause" ? "on" : ""} onClick={() => setPolicy("pause")}>失败暂停</span>
                  <span className={policy === "skip_continue" ? "on" : ""} onClick={() => setPolicy("skip_continue")}>失败自动跳过</span>
                </div>
                <span className="sp" />
                <span className="hint">{draft.split("\n").filter((s) => s.trim()).length || 0} 条需求</span>
                <button className="btn btn-primary" onClick={submitQueue} disabled={busy || !draft.trim()}>
                  提交<I name="i-arrow" size={14} />
                </button>
              </div>
            </div>
          </div>

          <div className="queue">
            {reqs.map((r) => {
              const run = latestRunOf(r);
              const chip = STATUS_CHIP[r.status] ?? STATUS_CHIP.queued;
              const isActive = r.status === "active";
              return (
                <div key={r.id} className={`qrow ${isActive ? (run?.state === "wait_confirm" ? "wait" : "run") : r.status === "failed" ? "failed" : r.status === "done" ? "done" : ""}`}>
                  <div className="r1">
                    <span className="no">#{r.seq}</span>
                    <span className="ttl">{r.title}</span>
                    <div className="meta-r">
                      {r.dependsOnSeq && <span className="chip chip-gray" title="依赖图（v2α）：该需求完成后才启动">依赖 #{r.dependsOnSeq}</span>}
                      <span className={`chip ${chip.cls}`}>{isActive ? (run?.state === "wait_confirm" ? "等待确认" : run?.state === "preparing" ? "环境准备" : `执行中 · ${run?.currentStage ?? ""}`) : chip.label}</span>
                      {r.status === "queued" && (
                        <>
                          <button className="ico-btn" title="上移" disabled={busy} onClick={() => moveReq(r, -1)}>↑</button>
                          <button className="ico-btn" title="下移" disabled={busy} onClick={() => moveReq(r, 1)}>↓</button>
                          <button className="ico-btn" title="编辑" onClick={async () => {
                            const t = prompt("修改需求描述", r.title);
                            if (t) await api(`/api/requirements/${r.id}`, { method: "PATCH", body: JSON.stringify({ title: t }) });
                          }}><I name="i-edit" size={14} /></button>
                          <button className="ico-btn" title="删除" onClick={async () => {
                            if (confirm("删除该需求？")) await api(`/api/requirements/${r.id}`, { method: "DELETE" });
                          }}><I name="i-trash" size={14} /></button>
                        </>
                      )}
                      {r.status === "failed" && run && (
                        <>
                          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => runAction(run.id, "retry")}><I name="i-refresh" size={12} />重试</button>
                          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => runAction(run.id, "skip")}>跳过</button>
                          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => runAction(run.id, "terminate")}>终止队列</button>
                        </>
                      )}
                      {["suspended", "cancelled"].includes(r.status) && (
                        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => requeue(r.id)}><I name="i-refresh" size={12} />重新入队</button>
                      )}
                      {run && (r.status === "done" || isActive || r.status === "failed") && (
                        <Link className="chip chip-gray" href={`/runs/${run.id}`}>执行画布<I name="i-chev" size={12} /></Link>
                      )}
                    </div>
                  </div>
                  {isActive && run?.state === "wait_confirm" && (
                    <div className="exp">
                      <span className="cn-ic" style={{ background: "var(--amber-dim)", color: "var(--amber)" }}><I name="i-db" size={14} /></span>
                      <div className="tx"><b>Agent 提问：</b>等待你回答确认问题 · 快照已保存，回复后恢复执行 <Link style={{ color: "var(--amber)" }} href={`/runs/${run.id}`}>→ 去回答</Link></div>
                    </div>
                  )}
                  {r.status === "failed" && run?.error && (
                    <div className="exp">
                      <span className="cn-ic" style={{ background: "var(--red-dim)", color: "var(--red)" }}><I name="i-alert" size={14} /></span>
                      <div className="tx"><b>失败原因：</b>{run.error}</div>
                    </div>
                  )}
                  {r.status === "skipped" && r.skipReason && (
                    <div className="exp">
                      <span className="cn-ic" style={{ background: "rgba(255,255,255,.06)", color: "var(--txt-2)" }}><I name="i-alert" size={14} /></span>
                      <div className="tx"><b>跳过原因：</b>{r.skipReason}</div>
                    </div>
                  )}
                  {r.status === "done" && run && (
                    <div className="exp" style={{ paddingTop: 8, borderTop: "none" }}>
                      <div className="tx mono" style={{ fontSize: 11, color: "var(--txt-3)" }}>
                        执行 {fmtDuration(run.startedAt, run.endedAt)} · {new Date(run.endedAt ?? Date.now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 完成
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {reqs.length === 0 && (
              <div className="qrow" style={{ textAlign: "center", padding: "32px 0", color: "var(--txt-3)", fontSize: 12.5 }}>
                队列为空 —— 在上方输入框提交需求（每行一条），流水线将按序执行
              </div>
            )}
          </div>
        </div>

        <div className="rail">
          <div className="shell"><div className="core" style={{ padding: "16px 20px" }}>
            <div className="sec-hd" style={{ marginBottom: 14 }}><span className="t" style={{ fontSize: 13.5 }}>堆叠 PR 链</span><span className="chip chip-gray" style={{ marginLeft: "auto" }}>按序合并</span></div>
            <div className="pr-node">
              <span className="pt">M</span>
              <div><div className="pn">{project?.defaultBranch ?? "main"}</div><div className="pd">默认分支</div></div>
            </div>
            {prs.map((pr) => (
              <div key={pr.id} className={`pr-node ${pr.status === "merged" ? "done" : pr.status === "open" ? "" : "pend"}`}>
                <span className="pt">{pr.status === "merged" ? <I name="i-check" size={11} /> : `#${pr.number}`}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="pn">PR #{pr.number} · {pr.title.slice(0, 16)}</div>
                  <div className="pd">{pr.branch} → <b>{pr.baseBranch}</b></div>
                  <div className="pc" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {pr.status === "open" ? (
                      <>
                        <span className="chip chip-green">可合并</span>
                        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => prAction(pr.id, "merge")}>合并</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => viewPrDiff(pr.id, `PR #${pr.number} ${pr.title}`)}>diff</button>
                        <button className="btn btn-red-g btn-sm" title="关闭此 PR 及其后继链，受影响需求基于新 base 重新入队（FR-F3）" disabled={busy} onClick={() => { if (confirm(`关闭 PR #${pr.number} 及其后继链并重新入队？`)) prAction(pr.id, "rebase"); }}>堆叠修复</button>
                      </>
                    ) : pr.status === "merged" ? (
                      <span className="chip chip-gray">已合并</span>
                    ) : (
                      <span className="chip chip-gray">已关闭</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {prs.length === 0 && <div style={{ fontSize: 11.5, color: "var(--txt-3)", fontWeight: 500, padding: "4px 0 8px 36px" }}>尚无 PR —— 任务完成后自动开出堆叠 PR</div>}
          </div></div>

          <div className="shell"><div className="core" style={{ padding: "16px 20px" }}>
            <div className="sec-hd" style={{ marginBottom: 10 }}><span className="t" style={{ fontSize: 13.5 }}>Issues 同步</span><span className="chip chip-gray" style={{ marginLeft: "auto" }}>FR-C4 · 状态回写</span></div>
            {issueList.length === 0 && <div style={{ fontSize: 11.5, color: "var(--txt-3)", fontWeight: 500 }}>没有 Issues</div>}
            {issueList.map((is) => (
              <div key={is.id} className="tl-row">
                <span className="mono" style={{ fontSize: 10.5, color: "var(--txt-3)" }}>#{is.number}</span>
                <span className="tx">{is.title}</span>
                {is.state === "closed" ? (
                  <span className="chip chip-green" style={{ marginLeft: "auto" }}>已关闭</span>
                ) : is.syncedRequirementId ? (
                  <span className="chip chip-blue" style={{ marginLeft: "auto" }}>队列中</span>
                ) : (
                  <button className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => pullIssue(is.id)}>拉入队列</button>
                )}
              </div>
            ))}
          </div></div>

          {diffView && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setDiffView(null)}>
              <div className="shell" style={{ width: 760, maxWidth: "94vw" }} onClick={(e) => e.stopPropagation()}>
                <div className="core" style={{ padding: "18px 20px" }}>
                  <div className="strip-hd">
                    <span style={{ fontWeight: 800, fontSize: 14 }}>{diffView.title}</span>
                    <span className="sp" />
                    <button className="btn btn-ghost btn-sm" onClick={() => setDiffView(null)}>关闭</button>
                  </div>
                  <pre className="term" style={{ maxHeight: 460, whiteSpace: "pre-wrap" }}>{diffView.content}</pre>
                </div>
              </div>
            </div>
          )}

          <div className="shell"><div className="core" style={{ padding: "16px 20px" }}>
            <div className="sec-hd" style={{ marginBottom: 10 }}><span className="t" style={{ fontSize: 13.5 }}>记忆注入预览</span><span className="chip chip-blue" style={{ marginLeft: "auto" }}>提案即注入</span></div>
            <div className="cbox">
              <div className="r">已确认记忆<span className="v">{mem.confirmed} 条</span></div>
              <div className="r">待确认提案（立即注入）<span className="v">{mem.pending} 条</span></div>
            </div>
            <Link className="btn btn-ghost btn-sm" style={{ marginTop: 10, width: "100%", justifyContent: "center" }} href={`/projects/${id}/memories`}>打开记忆库<I name="i-chev" size={13} /></Link>
          </div></div>

          <div className="shell"><div className="core" style={{ padding: "16px 20px" }}>
            <div className="sec-hd" style={{ marginBottom: 8 }}><span className="t" style={{ fontSize: 13.5 }}>流水线</span></div>
            <div className="cbox">
              <div className="r">阶段编排<span className="v">规划 → 开发∥测试 → 执行 → 验收 → 交付</span></div>
              <div className="r">并行支线<span className="v">{project?.settings?.parallelStages !== false ? "开启" : "关闭"}</span></div>
              <div className="r">测试执行<span className="v">node --test tests/</span></div>
              <div className="r">验收门禁<span className="v">全部达成才交付</span></div>
            </div>
            <Link className="btn btn-ghost btn-sm" style={{ marginTop: 8, width: "100%", justifyContent: "center" }} href={`/projects/${id}/settings`}>阶段与模型配置</Link>
          </div></div>
        </div>
      </div>
    </Shell>
  );
}
