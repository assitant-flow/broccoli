"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api } from "@/lib/client";

type Proposal = { id: string; type: string; content: string; status: string; sourceRunId: string | null; injectedCount: number };
type Item = { id: string; type: string; content: string; status: string; version: number; createdAt: string; updatedAt: string };
type Impact = { runId: string; runState: string; reqTitle: string; reqSeq: number; reqStatus: string; requirementId: string };

const TYPE_CLS: Record<string, string> = { decision: "chip-blue", convention: "chip-blue", lesson: "chip-amber", fact: "chip-gray" };
const TYPE_LABEL: Record<string, string> = { decision: "决策", convention: "规范", lesson: "教训", fact: "事实" };

export default function MemoriesPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [trace, setTrace] = useState<{ title: string; impacted: Impact[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<{ id: string; content: string }[]>([]);
  const [prefDraft, setPrefDraft] = useState("");

  useEffect(() => {
    params.then((p) => setId(p.id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
    const load = () => api<{ items: Item[]; proposals: Proposal[] }>(`/api/projects/${id}/memories`).then((d) => { setItems(d.items); setProposals(d.proposals); }).catch(() => {});
    load();
    const loadPrefs = () => api<{ id: string; content: string }[]>("/api/user/preferences").then(setPrefs).catch(() => {});
    loadPrefs();
    const t = setInterval(load, 3500);
    const t2 = setInterval(loadPrefs, 5000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
    };
  }, [id]);

  async function writeBack() {
    setBusy(true);
    try {
      const res = await api<{ ok: boolean; message: string }>(`/api/projects/${id}/memories/write-back`, { method: "POST" });
      alert(res.message);
    } catch (e) {
      alert(String((e as Error).message));
    } finally { setBusy(false); }
  }

  async function addPref() {
    if (!prefDraft.trim()) return;
    setBusy(true);
    try {
      await api("/api/user/preferences", { method: "POST", body: JSON.stringify({ content: prefDraft }) });
      setPrefDraft("");
      setPrefs(await api<{ id: string; content: string }[]>("/api/user/preferences"));
    } finally { setBusy(false); }
  }

  async function delPref(id2: string) {
    setBusy(true);
    try {
      await api(`/api/user/preferences?id=${id2}`, { method: "DELETE" });
      setPrefs((p) => p.filter((x) => x.id !== id2));
    } finally { setBusy(false); }
  }

  async function confirmProposal(pid: string) {
    setBusy(true);
    try {
      await api(`/api/proposals/${pid}`, { method: "POST" });
    } finally { setBusy(false); }
  }

  async function confirmAll() {
    setBusy(true);
    try {
      await api(`/api/projects/${id}/memories`, { method: "POST", body: JSON.stringify({}) });
    } finally { setBusy(false); }
  }

  async function rejectProposal(p: Proposal) {
    setBusy(true);
    try {
      const res = await api<{ impacted: Impact[] }>(`/api/proposals/${p.id}`, { method: "DELETE" });
      setTrace({ title: p.content, impacted: res.impacted });
    } finally { setBusy(false); }
  }

  async function requeue(reqId: string) {
    setBusy(true);
    try {
      await api(`/api/requirements/${reqId}/requeue`, { method: "POST" });
      setTrace(null);
    } finally { setBusy(false); }
  }

  async function toggleItem(item: Item) {
    setBusy(true);
    try {
      await api(`/api/memories/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: item.status === "confirmed" ? "disabled" : "confirmed" }) });
    } finally { setBusy(false); }
  }

  const pending = proposals.filter((p) => p.status === "pending");
  const confirmed = items.filter((i) => i.status === "confirmed");
  const disabled = items.filter((i) => i.status === "disabled");

  return (
    <Shell active="memories">
      <div className="crumb">
        <Link href="/projects">项目</Link> <I name="i-chev" size={12} /> <b>记忆库</b>
      </div>
      <div className="mem-hd">
        <div>
          <div className="t">记忆库</div>
          <div className="mono" style={{ fontSize: 12, color: "var(--txt-3)", marginTop: 5 }}>执行前自动注入 · 确认决定永久入库 · 否决可追溯</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <span className="chip chip-green">已确认 {confirmed.length}</span>
          <span className="chip chip-amber">待确认 {pending.length}</span>
          {disabled.length > 0 && <span className="chip chip-gray">已禁用 {disabled.length}</span>}
        </div>
        <div className="acts">
          <a className="btn btn-ghost" href={`/api/projects/${id}/memories/export`} download><I name="i-arrow" size={14} />导出 Markdown</a>
          <button className="btn btn-ghost" disabled={busy} onClick={writeBack} title="将已确认记忆生成为仓库 CLAUDE.md 并提交到 main（FR-G9）"><I name="i-arrow" size={14} />写回仓库</button>
          <button className="btn btn-primary" disabled={busy || pending.length === 0} onClick={confirmAll}>批量确认 {pending.length} 条<I name="i-check" size={14} /></button>
        </div>

        <div className="shell" style={{ marginBottom: 22 }}><div className="core" style={{ padding: "14px 18px" }}>
          <div className="sec-hd" style={{ marginBottom: 8 }}>
            <span className="t" style={{ fontSize: 13 }}>个人偏好（跨项目注入，v2α · FR-G10）</span>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input
              value={prefDraft}
              onChange={(e) => setPrefDraft(e.target.value)}
              placeholder="如：commit 信息使用中文；不做过度设计…"
              style={{ flex: 1, height: 34, borderRadius: 12, border: "1px solid var(--line-2)", background: "rgba(255,255,255,.04)", padding: "0 12px", fontSize: 12, outline: "none" }}
            />
            <button className="btn btn-ghost btn-sm" disabled={busy || !prefDraft.trim()} onClick={addPref}>添加</button>
          </div>
          {prefs.map((p) => (
            <div key={p.id} className="tl-row">
              <span className="chip chip-blue" style={{ height: 22, fontSize: 10 }}>偏好</span>
              <span className="tx">{p.content}</span>
              <button className="ico-btn" onClick={() => delPref(p.id)}><I name="i-trash" size={13} /></button>
            </div>
          ))}
          {prefs.length === 0 && <div style={{ fontSize: 11.5, color: "var(--txt-3)", fontWeight: 500 }}>暂无个人偏好 —— 将注入你所有项目的任务上下文</div>}
        </div></div>
      </div>

      {pending.length > 0 && (
        <>
          <div className="sec-hd"><span className="t">待确认提案</span><span className="chip chip-blue">已注入队列后续任务（提案即注入，FR-G3）</span></div>
          <div className="prop-grid">
            {pending.map((p) => (
              <div key={p.id} className="prop shell"><div className="core inner">
                <div className="ph"><span className={`chip ${TYPE_CLS[p.type] ?? "chip-gray"}`}>{TYPE_LABEL[p.type] ?? p.type}</span><span className="src">{p.sourceRunId ? `来源任务 ${p.sourceRunId.slice(0, 8)}` : ""}</span></div>
                <div className="body">{p.content}</div>
                <div className="inj"><I name="i-arrow" size={13} />已注入 {p.injectedCount} 个后续任务（无需等待确认）</div>
                <div className="pa">
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => confirmProposal(p.id)}>确认入库<I name="i-check" size={12} /></button>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => rejectProposal(p)} style={{ color: "var(--red)" }}>否决</button>
                </div>
              </div></div>
            ))}
          </div>
        </>
      )}

      <div className="sec-hd"><span className="t">已确认记忆</span><span className="chip chip-gray">{confirmed.length} 条 · 全量注入每个任务</span></div>
      <div className="mem-rows">
        {confirmed.map((m) => (
          <div key={m.id} className="mem-row">
            <span className={`chip ${TYPE_CLS[m.type] ?? "chip-gray"}`}>{TYPE_LABEL[m.type] ?? m.type}</span>
            <div className="body">
              <div className="tx">{m.content}</div>
              <div className="mt">v{m.version} · 更新于 {new Date(m.updatedAt).toLocaleDateString("zh-CN")}</div>
            </div>
            <span className={`toggle on`} onClick={() => toggleItem(m)} />
            <button className="ico-btn" onClick={async () => {
              const c = prompt("编辑记忆内容", m.content);
              if (c) await api(`/api/memories/${m.id}`, { method: "PATCH", body: JSON.stringify({ content: c }) });
            }}><I name="i-edit" size={14} /></button>
            <button className="ico-btn" onClick={async () => { if (confirm("删除该记忆？")) await api(`/api/memories/${m.id}`, { method: "DELETE" }); }}><I name="i-trash" size={14} /></button>
          </div>
        ))}
        {confirmed.length === 0 && <div className="mem-row" style={{ justifyContent: "center", color: "var(--txt-3)", fontSize: 12.5 }}>还没有已确认记忆 —— 完成任务后在上方确认提案即可入库</div>}
        {disabled.map((m) => (
          <div key={m.id} className="mem-row off">
            <span className="chip chip-gray">{TYPE_LABEL[m.type] ?? m.type}</span>
            <div className="body"><div className="tx">{m.content}</div><div className="mt">已禁用 · 历史注入记录保留</div></div>
            <span className="toggle" onClick={() => toggleItem(m)} />
            <button className="ico-btn" onClick={async () => { if (confirm("删除该记忆？")) await api(`/api/memories/${m.id}`, { method: "DELETE" }); }}><I name="i-trash" size={14} /></button>
          </div>
        ))}
      </div>

      {trace && (
        <div className="shell"><div className="core" style={{ padding: 9 }}><div className="trace">
          <div className="th"><I name="i-alert" size={17} style={{ color: "var(--red)" }} /><span className="tt">否决影响评估 · 依赖追溯</span><span className="chip chip-red" style={{ marginLeft: "auto" }}>已否决「{trace.title.slice(0, 24)}…」</span></div>
          <div className="td">该提案曾注入以下任务，其产出将基于被否决的结论。系统不会自动重跑 —— 由你决定是否<b>重新入队</b>以获得正确上下文。</div>
          {trace.impacted.map((i) => (
            <div key={i.runId} className="trace-row">
              <span className="mono" style={{ color: "var(--txt-3)", fontSize: 11 }}>#{i.reqSeq}</span>
              <span className="tt2">{i.reqTitle}</span>
              <span className="chip chip-gray">{i.reqStatus}</span>
              <Link className="btn btn-ghost btn-sm" href={`/runs/${i.runId}`}>查看</Link>
              <button className="btn btn-red-g btn-sm" disabled={busy} onClick={() => requeue(i.requirementId)}><I name="i-refresh" size={12} />重新入队</button>
            </div>
          ))}
          {trace.impacted.length === 0 && <div className="td" style={{ marginBottom: 0 }}>该提案尚未注入任何任务（可能是最早的任务产生的），否决无影响。</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setTrace(null)}>关闭</button>
          </div>
        </div></div></div>
      )}
    </Shell>
  );
}
