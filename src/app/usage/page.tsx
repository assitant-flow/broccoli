"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api } from "@/lib/client";

type Usage = {
  totals: { in: number; out: number; seconds: number };
  byRun: { runId: string; reqTitle: string; reqSeq: number; projectName: string; inputTokens: number; outputTokens: number; containerSeconds: number }[];
};

export default function UsagePage() {
  const [data, setData] = useState<Usage | null>(null);
  useEffect(() => {
    const load = () => api<Usage>("/api/usage").then(setData).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <Shell active="usage">
      <div className="topbar">
        <div><div className="hi">用量与成本</div><div className="dt">BYO Key · 模型费用直接计入你的 Anthropic 账户（FR-H4）</div></div>
      </div>

      {data && (
        <>
          <div className="stats">
            <div className="stat"><span className="ic ic-blue">Σ</span><div><div className="v">{(data.totals.in / 1000).toFixed(1)}k</div><div className="l">输入 tokens</div></div></div>
            <div className="stat"><span className="ic ic-green">Σ</span><div><div className="v">{(data.totals.out / 1000).toFixed(1)}k</div><div className="l">输出 tokens</div></div></div>
            <div className="stat"><span className="ic ic-gray"><I name="i-clock" size={17} /></span><div><div className="v">{Math.round(data.totals.seconds / 60)}m</div><div className="l">容器时长</div></div></div>
            <div className="stat"><span className="ic ic-amber"><I name="i-term" size={17} /></span><div><div className="v">{data.byRun.length}</div><div className="l">任务数</div></div></div>
          </div>

          <div className="bento">
            <div className="b12 pcard"><div className="shell"><div className="core inner" style={{ padding: "16px 22px" }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: "var(--txt-2)", marginBottom: 6 }}>按任务</div>
              {data.byRun.length === 0 && <div style={{ fontSize: 12.5, color: "var(--txt-3)" }}>暂无用量记录</div>}
              {data.byRun.map((r) => (
                <div key={r.runId} className="tl-row">
                  <span className="chip chip-gray">{r.projectName}</span>
                  <span className="tx">#{r.reqSeq} {r.reqTitle}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--txt-3)", marginLeft: "auto" }}>
                    in {(r.inputTokens / 1000).toFixed(1)}k · out {(r.outputTokens / 1000).toFixed(1)}k · 容器 {Math.round(r.containerSeconds)}s
                  </span>
                  <Link className="chip chip-gray" href={`/runs/${r.runId}`}>查看</Link>
                </div>
              ))}
            </div></div></div>
          </div>
        </>
      )}
    </Shell>
  );
}
