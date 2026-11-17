"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api, fmtTime } from "@/lib/client";

type Dashboard = {
  projects: {
    id: string; name: string; repoFullName: string; defaultBranch: string; failurePolicy: string; lastSuccessBranch: string | null;
    progress: { done: number; total: number };
    stageDots: { status: string; runState: string | null }[];
    active: { runId: string; reqSeq: number; reqTitle: string; state: string; currentStage: string | null } | null;
    queued: number; failedReq: { seq: number; title: string } | null; openPrs: number;
  }[];
  alerts: {
    kind: "wait_confirm" | "failed"; runId?: string; projectId: string; projectName: string;
    reqSeq?: number; reqTitle?: string; question?: string; error?: string; failurePolicy?: string;
  }[];
  stats: { running: number; waitConfirm: number; failed: number; queued: number; doneToday: number; maxConcurrency: number };
  recentRuns: { id: string; state: string; currentStage: string | null; endedAt: string | null; createdAt: string; reqTitle: string; reqSeq: number; projectName: string }[];
};

function dotClass(status: string, runState: string | null): string {
  if (status === "done") return "done";
  if (runState === "wait_confirm") return "wait";
  if (status === "active" || runState === "running") return "run";
  if (status === "failed") return "fail";
  if (status === "skipped" || status === "cancelled") return "skip";
  return "";
}

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  useEffect(() => {
    const load = () => api<Dashboard>("/api/dashboard").then(setData).catch(() => {});
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, []);

  return (
    <Shell active="dashboard">
      <div className="topbar">
        <div>
          <div className="hi">仪表盘</div>
          <div className="dt">{data ? `有 ${data.stats.waitConfirm + data.stats.failed} 个任务需要你处理 · 并发 ${data.stats.running}/${data.stats.maxConcurrency}` : "加载中…"}</div>
        </div>
        <div className="sp" />
        <Link className="btn btn-ghost" href="/onboarding"><I name="i-plus" size={14} />新建项目</Link>
      </div>

      {data && (
        <>
          {data.alerts.length > 0 && (
            <div className="alerts" style={data.alerts.length === 1 ? { gridTemplateColumns: "1fr" } : {}}>
              {data.alerts.map((a, i) => (
                <div key={i} className={`alert ${a.kind === "wait_confirm" ? "amber" : "red"}`}>
                  <div className="inner">
                    <div className="hd">
                      {a.kind === "wait_confirm" ? (
                        <span className="chip chip-amber"><span className="dot pulse" />等待确认</span>
                      ) : (
                        <span className="chip chip-red"><I name="i-alert" size={12} />执行失败 · {a.failurePolicy === "skip_continue" ? "自动跳过" : "队列已暂停"}</span>
                      )}
                      <span className="chip chip-gray">{a.projectName}</span>
                      <span className="chip chip-gray">需求 #{a.reqSeq}</span>
                    </div>
                    <div className="ttl">{a.kind === "wait_confirm" ? "Agent 需要你做一次决策" : "任务失败，后续需求已阻塞"}</div>
                    <div className="q">{a.kind === "wait_confirm" ? a.question : a.error}</div>
                    <div className="ft">
                      <span className="meta">{a.kind === "wait_confirm" ? "✉ 提醒邮件已发送（见 .data/outbox）" : "✉ 失败邮件已发送"}</span>
                      <div className="acts">
                        <Link className={`btn btn-sm ${a.kind === "wait_confirm" ? "btn-amber" : "btn-primary"}`} href={`/runs/${a.runId}`}>
                          {a.kind === "wait_confirm" ? "去回答" : "处置"}<I name="i-arrow" size={13} />
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="stats">
            <div className="stat"><span className="ic ic-green"><I name="i-play" /></span><div><div className="v">{data.stats.running}</div><div className="l">执行中 · 并发 {data.stats.running}/{data.stats.maxConcurrency}</div></div></div>
            <div className="stat"><span className="ic ic-amber"><I name="i-clock" /></span><div><div className="v">{data.stats.waitConfirm}</div><div className="l">等待确认</div></div></div>
            <div className="stat"><span className="ic ic-red"><I name="i-alert" /></span><div><div className="v">{data.stats.failed}</div><div className="l">失败 / 队列暂停</div></div></div>
            <div className="stat"><span className="ic ic-blue"><I name="i-chev" /></span><div><div className="v">{data.stats.queued}</div><div className="l">排队中</div></div></div>
            <div className="stat"><span className="ic ic-gray"><I name="i-check" /></span><div><div className="v">{data.stats.doneToday}</div><div className="l">今日完成</div></div></div>
          </div>

          <div className="bento">
            {data.projects.map((p) => {
              const pct = p.progress.total ? Math.round((p.progress.done / p.progress.total) * 100) : 0;
              const activeState = p.active?.state;
              return (
                <div key={p.id} className={p.progress.total >= 5 ? "b7 pcard" : "b5 pcard"}>
                  <div className="shell"><div className="core inner">
                    <div className="hd">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="rname">{p.repoFullName.split("/")[0]}</div>
                        <div className="rmeta"><I name="i-branch" size={12} />{p.defaultBranch} · {p.progress.total} 个需求 · {p.lastSuccessBranch ? `堆叠至 ${p.lastSuccessBranch}` : "尚无成功分支"}</div>
                      </div>
                      {p.active && p.active.state === "wait_confirm" ? (
                        <span className="chip chip-amber"><span className="dot pulse" />#{p.active.reqSeq} 等待确认</span>
                      ) : p.active ? (
                        <span className="chip chip-green"><span className="dot pulse" />#{p.active.reqSeq} 执行中</span>
                      ) : p.failedReq ? (
                        <span className="chip chip-red"><I name="i-alert" size={12} />队列已暂停</span>
                      ) : p.progress.total > 0 && p.progress.done === p.progress.total ? (
                        <span className="chip chip-green"><I name="i-check" size={12} />全部完成</span>
                      ) : (
                        <span className="chip chip-gray">{p.queued > 0 ? `${p.queued} 排队` : "空闲"}</span>
                      )}
                    </div>
                    <div className="prow">
                      <span className="num">{p.progress.done}/{p.progress.total}</span>
                      <div className={`bar progress ${p.failedReq ? "red" : activeState === "wait_confirm" ? "amber" : ""}`}><b style={{ width: `${pct}%` }} /></div>
                      <div className="qdots">
                        {p.stageDots.map((d, i) => <i key={i} className={dotClass(d.status, d.runState)} />)}
                      </div>
                    </div>
                    <div className="cur">
                      {p.active ? (
                        <>
                          <I name={activeState === "wait_confirm" ? "i-clock" : "i-play"} size={14} />
                          <span><b style={{ color: "var(--txt)" }}>#{p.active.reqSeq} {p.active.reqTitle}</b>{activeState === "wait_confirm" ? " — 等待你回答，回复后恢复执行" : " — 执行中"}</span>
                        </>
                      ) : p.failedReq ? (
                        <>
                          <I name="i-alert" size={14} />
                          <span><b style={{ color: "var(--txt)" }}>#{p.failedReq.seq} {p.failedReq.title}</b> — 失败，{p.failurePolicy === "skip_continue" ? "自动跳过继续" : "队列已暂停，等待处置"}</span>
                        </>
                      ) : (
                        <>
                          <I name="i-pr" size={14} />
                          <span><b style={{ color: "var(--txt)" }}>{p.openPrs} 个堆叠 PR</b> — 按队列顺序合并即可</span>
                        </>
                      )}
                    </div>
                    <div className="ft">
                      <span className="meta">{p.progress.total > 0 ? `${p.openPrs} 个 PR 已开出` : "尚未提交需求"}</span>
                      <span className="sp" />
                      <Link className="btn btn-ghost btn-sm" href={`/projects/${p.id}`}>进入项目<I name="i-chev" size={13} /></Link>
                    </div>
                  </div></div>
                </div>
              );
            })}
            {data.projects.length === 0 && (
              <div className="b12 pcard"><div className="shell"><div className="core inner" style={{ textAlign: "center", padding: "48px 0" }}>
                <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}>还没有项目</div>
                <div style={{ fontSize: 12.5, color: "var(--txt-3)", marginBottom: 20 }}>创建项目 → 提交成串需求 → AI 在流水线自动执行</div>
                <Link className="btn btn-primary" href="/onboarding">接入第一个项目<I name="i-arrow" size={14} /></Link>
              </div></div></div>
            )}

            {data.recentRuns.length > 0 && (
              <div className="b12 pcard"><div className="shell"><div className="core inner" style={{ padding: "16px 22px" }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "var(--txt-2)", marginBottom: 8 }}>最近活动</div>
                {data.recentRuns.map((r) => (
                  <div key={r.id} className="tl-row">
                    <span className="t">{fmtTime(r.endedAt ?? r.createdAt)}</span>
                    <I name={r.state === "completed" ? "i-check" : r.state === "failed" ? "i-alert" : r.state === "wait_confirm" ? "i-clock" : "i-play"} size={14} />
                    <span className="tx">
                      <b>{r.projectName}</b> · 需求 #{r.reqSeq} {r.reqTitle} —{" "}
                      {r.state === "completed" ? "完成" : r.state === "failed" ? "失败" : r.state === "wait_confirm" ? "等待确认" : r.state === "suspended" ? "已挂起" : "执行中"}
                      {r.currentStage ? ` · ${r.currentStage}` : ""}
                    </span>
                    <Link className="chip chip-gray" href={`/runs/${r.id}`} style={{ marginLeft: "auto" }}>查看</Link>
                  </div>
                ))}
              </div></div></div>
            )}
          </div>
        </>
      )}
    </Shell>
  );
}
