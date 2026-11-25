"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api } from "@/lib/client";

type StageCfg = { stageType: string; modelKey: string; source: "recommended" | "custom"; recommendedKey: string };
type Data = { stages: StageCfg[]; parallelStages: boolean; availableModels: string[]; defaultModel: string };

const STAGE_META: Record<string, { name: string; en: string; desc: string; arts: string[]; icon: string }> = {
  planning: { name: "规划", en: "PLANNING", desc: "读取记忆与上下文，将需求拆解为具体子任务，生成实现计划、验收标准，并为后续阶段推荐模型。", arts: ["实现计划.md", "子任务 ×N", "验收标准 ×N"], icon: "i-spark" },
  dev: { name: "开发实现", en: "DEVELOPMENT", desc: "按实现计划完成代码变更，遇到决策点抛出结构化确认；与测试用例编写并行。", arts: ["代码 diff", "确认问答"], icon: "i-term" },
  test_design: { name: "测试用例编写", en: "TEST DESIGN", desc: "依据验收标准逐条编写测试用例，与开发共享计划上下文，不等待开发完成。", arts: ["测试用例集"], icon: "i-edit" },
  test_run: { name: "测试执行", en: "TEST RUN", desc: "沙箱内运行全量测试并生成报告；失败即任务未完成，进入失败策略。", arts: ["测试报告.md"], icon: "i-play" },
  acceptance: { name: "验收对照", en: "ACCEPTANCE", desc: "逐条核对验收标准并记录证据，未达成项回溯修复后重验，全部达成才可交付。", arts: ["验收报告", "达成证据"], icon: "i-shield" },
  delivery: { name: "交付", en: "DELIVERY", desc: "推送分支、开出堆叠 PR（含变更说明），并触发生成记忆提案。", arts: ["PR", "记忆提案 ×N"], icon: "i-pr" },
};

/* 可选模型来自平台 AI 接入设置的模型列表（不再内置厂商模型） */

export default function StageConfigPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [envDraft, setEnvDraft] = useState("");

  useEffect(() => {
    params.then((p) => setId(p.id));
  }, [params]);
  useEffect(() => {
    if (!id) return;
    api<Data>(`/api/projects/${id}/stage-configs`).then(setData).catch(() => {});
    api<{ defaultBranch: string; settings: { env?: Record<string, string> } }>(`/api/projects/${id}`)
      .then((p) => {
        setDefaultBranch(p.defaultBranch);
        const env = p.settings?.env ?? {};
        setEnvDraft(Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
      })
      .catch(() => {});
  }, [id]);

  async function saveProject() {
    setBusy(true);
    try {
      const env: Record<string, string> = {};
      envDraft.split("\n").forEach((line) => {
        const i = line.indexOf("=");
        if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ defaultBranch, settings: { env } }) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const updates = Object.entries(dirty).map(([stageType, modelKey]) => ({ stageType, modelKey }));
      await api(`/api/projects/${id}/stage-configs`, { method: "PUT", body: JSON.stringify({ updates }) });
      setDirty({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      const d = await api<Data>(`/api/projects/${id}/stage-configs`);
      setData(d);
    } finally { setBusy(false); }
  }

  async function reset() {
    setBusy(true);
    try {
      await api(`/api/projects/${id}/stage-configs`, { method: "POST" });
      setData(await api<Data>(`/api/projects/${id}/stage-configs`));
      setDirty({});
    } finally { setBusy(false); }
  }

  async function toggleParallel() {
    if (!data) return;
    setBusy(true);
    try {
      setData(await api<Data>(`/api/projects/${id}/stage-configs`, { method: "PUT", body: JSON.stringify({ parallelStages: !data.parallelStages }) }));
    } finally { setBusy(false); }
  }

  const customCount = data?.stages.filter((s) => s.source === "custom" || dirty[s.stageType]).length ?? 0;

  return (
    <Shell active="projects">
      <div className="crumb">
        <Link href="/projects">项目</Link> <I name="i-chev" size={12} /> <Link href={`/projects/${id}`}>{data ? "设置" : "…"}</Link> <I name="i-chev" size={12} /> 阶段与模型
      </div>
      <div className="task-hd">
        <div>
          <div className="ttl-h">阶段与模型配置</div>
          <div className="meta">
            <span className="chip chip-gray">项目默认 · 新队列自动应用</span>
            <span className="chip chip-green">推荐配置已启用 {6 - customCount}/6</span>
            {saved && <span className="chip chip-green"><I name="i-check" size={12} />已保存</span>}
          </div>
        </div>
        <div className="acts">
          <button className="btn btn-ghost" disabled={busy} onClick={reset}>恢复全部推荐</button>
          <button className="btn btn-primary" disabled={busy || Object.keys(dirty).length === 0} onClick={save}>保存修改<I name="i-check" size={14} /></button>
        </div>
      </div>

      <div className="cfg-wrap">
        <div>
          {data?.stages.map((s) => {
            const meta = STAGE_META[s.stageType];
            // 空值 = 跟随平台默认模型（不再有内置推荐档位）
            const current = dirty[s.stageType] ?? s.modelKey ?? "";
            const isCustom = !!current;
            return (
              <div key={s.stageType} className="stage-card">
                <span className="si"><I name={meta.icon} size={17} /></span>
                <div className="sinfo">
                  <div className="sn2">{meta.name} <span className="en">{meta.en}</span></div>
                  <div className="sd">{meta.desc}</div>
                  <div className="sa">{meta.arts.map((a) => <span key={a}>{a}</span>)}</div>
                </div>
                <div className="model-pick">
                  <select
                    className="model-sel"
                    value={current}
                    onChange={(e) => setDirty({ ...dirty, [s.stageType]: e.target.value })}
                    style={{ appearance: "none", outline: "none", cursor: "pointer" }}
                  >
                    <option value="" style={{ background: "#0b0e0c" }}>跟随平台默认{data.defaultModel ? `（${data.defaultModel}）` : ""}</option>
                    {data.availableModels.map((m) => <option key={m} value={m} style={{ background: "#0b0e0c" }}>{m}{m === data.defaultModel ? "（默认）" : ""}</option>)}
                  </select>
                  {isCustom ? (
                    <span className="chip chip-amber" style={{ height: 22, fontSize: 9.5 }}>自定义</span>
                  ) : (
                    <span className="chip chip-green" style={{ height: 22, fontSize: 9.5 }}>平台默认</span>
                  )}
                </div>
              </div>
            );
          })}

          <div className="para-card">
            <div className="para-hd">
              <div className="para-t"><I name="i-zap" size={15} style={{ color: "var(--acc)" }} />开发实现 ∥ 测试用例编写 <span className="en">PARALLEL</span></div>
              <span className={`toggle ${data?.parallelStages ? "on" : ""}`} style={{ marginLeft: "auto" }} onClick={toggleParallel} />
            </div>
            <div className="para-d">两个阶段<b>并行执行、互不阻塞</b>：开发等待人工确认时，测试用例线继续推进；两者汇合后进入测试执行。关闭后按串行执行。</div>
          </div>
        </div>

        <div className="rail">
          <div className="plan-out shell"><div className="core inner">
            <div className="sec-hd" style={{ marginBottom: 12 }}>
              <span className="t" style={{ fontSize: 13.5 }}>推荐策略</span>
              <span className="chip chip-blue" style={{ marginLeft: "auto" }}>静态映射 + 记忆偏好</span>
            </div>
            <div className="rec-note" style={{ border: "none", background: "transparent", padding: 0 }}>
              <I name="i-zap" size={14} style={{ color: "var(--acc)", marginTop: 2, flex: "none" }} />
              <div>
                <b>推荐</b>由平台按阶段任务类型静态映射（规划用重推理档位、执行用均衡档位、测试执行/交付用轻量档位），并结合项目记忆中的模型偏好；<b>自定义</b>随项目保存，提交队列时可临时覆盖（P1）。BYO Key 下各阶段模型费用直接计入你的账户。
              </div>
            </div>
          </div></div>

          <div className="plan-out shell"><div className="core inner">
            <div className="sec-hd" style={{ marginBottom: 12 }}>
              <span className="t" style={{ fontSize: 13.5 }}>项目设置</span>
              <span className="chip chip-gray" style={{ marginLeft: "auto" }}>FR-B3</span>
            </div>
            <div className="field">
              <label>默认分支</label>
              <input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} className="mono" />
            </div>
            <div className="field">
              <label>环境变量 / Secrets（每行 KEY=VALUE，保存后注入沙箱环境；界面不回显值）</label>
              <textarea value={envDraft} onChange={(e) => setEnvDraft(e.target.value)} placeholder={"API_KEY=***\nDB_URL=***"} className="mono" />
            </div>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={saveProject}>保存项目设置</button>
            <div style={{ borderTop: "1px dashed var(--line)", margin: "16px 0 12px" }} />
            <div style={{ fontSize: 11.5, color: "var(--txt-3)", fontWeight: 600, marginBottom: 8 }}>危险区</div>
            <button className="btn btn-red-g btn-sm" disabled={busy} onClick={async () => {
              if (!confirm("删除项目？容器立即回收、队列清空，删除后不可恢复。")) return;
              await api(`/api/projects/${id}`, { method: "DELETE" });
              window.location.href = "/projects";
            }}><I name="i-trash" size={13} />删除项目</button>
          </div></div>

          <Link className="btn btn-ghost" style={{ width: "100%", justifyContent: "center" }} href={`/projects/${id}`}><I name="i-arrow" size={14} />返回项目</Link>
        </div>
      </div>
    </Shell>
  );
}
