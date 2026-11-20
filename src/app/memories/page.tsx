"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api } from "@/lib/client";

type Overview = {
  projects: { projectId: string; projectName: string; repoFullName: string; confirmed: number; pending: number; disabled: number }[];
  totals: { pending: number; confirmed: number };
};

export default function MemoriesOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);

  useEffect(() => {
    const load = () => api<Overview>("/api/memories/overview").then(setData).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <Shell active="memories">
      <div className="topbar">
        <div>
          <div className="hi">记忆库</div>
          <div className="dt">按项目聚合 · 确认决定永久入库 · 提案即注入（FR-G）</div>
        </div>
        <div className="sp" />
        {data && data.totals.pending > 0 && (
          <span className="chip chip-amber"><span className="dot pulse" />跨项目待确认 {data.totals.pending} 条</span>
        )}
      </div>

      <div className="bento">
        {data?.projects.map((p) => (
          <div key={p.projectId} className="b6 mem-ov pcard">
            <div className="shell"><div className="core inner">
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <span className="rname mono">{p.repoFullName.split("/")[0]}</span>
                <span style={{ marginLeft: "auto" }} />
                {p.pending > 0 && <span className="chip chip-amber">待确认 {p.pending}</span>}
              </div>
              <div className="counts">
                <span className="chip chip-green">已确认 {p.confirmed}</span>
                {p.disabled > 0 && <span className="chip chip-gray">已禁用 {p.disabled}</span>}
              </div>
              <div className="ft" style={{ display: "flex", alignItems: "center", marginTop: 14, gap: 8 }}>
                <span className="meta" style={{ fontSize: 11.5, color: "var(--txt-3)" }}>{p.repoFullName}</span>
                <span style={{ flex: 1 }} />
                <Link className="btn btn-ghost btn-sm" href={`/projects/${p.projectId}/memories`}>进入记忆库<I name="i-chev" size={13} /></Link>
              </div>
            </div></div>
          </div>
        ))}
        {data && data.projects.length === 0 && (
          <div className="b12 pcard"><div className="shell"><div className="core inner" style={{ textAlign: "center", padding: "48px 0" }}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}>还没有项目记忆</div>
            <div style={{ fontSize: 12.5, color: "var(--txt-3)", marginBottom: 20 }}>创建项目并完成任务后，记忆提案会出现在这里</div>
            <Link className="btn btn-primary" href="/projects">前往项目<I name="i-arrow" size={14} /></Link>
          </div></div></div>
        )}
      </div>

      <style>{`.b6 { grid-column: span 6; } @media (max-width: 1100px) { .b6 { grid-column: span 12; } }`}</style>
    </Shell>
  );
}
