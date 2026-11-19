"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api } from "@/lib/client";

type Notif = { id: string; type: string; runId: string | null; createdAt: string; reqTitle: string | null; reqSeq: number | null; projectName: string | null };

const TYPE_META: Record<string, { cls: string; label: string }> = {
  wait_confirm: { cls: "chip-amber", label: "等待确认" },
  failed: { cls: "chip-red", label: "失败" },
  suspended: { cls: "chip-amber", label: "已挂起" },
  completed: { cls: "chip-green", label: "完成" },
};

export default function NotificationsPage() {
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    const load = () => api<Notif[]>("/api/notifications").then(setNotifs).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  const filtered = filter === "all" ? notifs : notifs.filter((n) => n.type === filter);
  const counts = {
    all: notifs.length,
    wait_confirm: notifs.filter((n) => n.type === "wait_confirm").length,
    failed: notifs.filter((n) => n.type === "failed").length,
    completed: notifs.filter((n) => n.type === "completed").length,
  };

  return (
    <Shell active="notifications">
      <div className="topbar">
        <div><div className="hi">站内通知</div><div className="dt">任务状态变化实时汇入 · 与关键邮件同源去重（FR-E5）</div></div>
        <div className="sp" />
        <div className="seg">
          <span className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>全部 {counts.all}</span>
          <span className={filter === "wait_confirm" ? "on" : ""} onClick={() => setFilter("wait_confirm")}>等待确认 {counts.wait_confirm}</span>
          <span className={filter === "failed" ? "on" : ""} onClick={() => setFilter("failed")}>失败 {counts.failed}</span>
          <span className={filter === "completed" ? "on" : ""} onClick={() => setFilter("completed")}>完成 {counts.completed}</span>
        </div>
      </div>

      <div className="bento">
        <div className="b12 pcard"><div className="shell"><div className="core inner" style={{ padding: "10px 22px" }}>
          {filtered.length === 0 && (
            <div style={{ textAlign: "center", padding: "48px 0", color: "var(--txt-3)", fontSize: 13 }}>
              暂无通知 —— 任务进入「等待确认」「失败」「完成」时会在这里出现，同时发送邮件提醒
            </div>
          )}
          {filtered.map((n) => {
            const meta = TYPE_META[n.type] ?? TYPE_META.completed;
            return (
              <div key={n.id} className="tl-row" style={{ padding: "14px 0" }}>
                <span className={`chip ${meta.cls}`}><span className={n.type === "completed" ? "" : "dot"} />{meta.label}</span>
                <span className="tx" style={{ flex: 1, minWidth: 0, whiteSpace: "normal" }}>
                  {n.projectName && <b>{n.projectName}</b>}
                  {n.reqSeq != null && <> · 需求 #{n.reqSeq} <b>{n.reqTitle ?? ""}</b></>}
                  <span className="mono" style={{ color: "var(--txt-3)", fontSize: 11, marginLeft: 8 }}>{new Date(n.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                </span>
                {n.runId && <Link className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} href={`/runs/${n.runId}`}>查看任务<I name="i-chev" size={13} /></Link>}
              </div>
            );
          })}
        </div></div></div>
      </div>
    </Shell>
  );
}
