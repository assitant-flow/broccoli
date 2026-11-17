"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api } from "@/lib/client";

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [key, setKey] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [policy, setPolicy] = useState<"pause" | "skip_continue">("pause");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const router = useRouter();

  async function saveAndTest() {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ ok: boolean; models?: string[]; login?: string; error?: string }>("/api/credentials/test", {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", secret: key || undefined }),
      });
      if (key) {
        await api("/api/credentials", { method: "PUT", body: JSON.stringify({ provider: "anthropic", secret: key }) });
      }
      if (!r.ok) {
        setTestResult({ ok: false, detail: r.error ?? "连通失败（可稍后在设置中重试）" });
      } else {
        setTestResult({ ok: true, detail: `连接正常 · 可用模型 ${r.models?.slice(0, 3).join(", ") ?? "…"}` });
      }
      setStep(3);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally { setBusy(false); }
  }

  async function createProject() {
    setBusy(true);
    setErr("");
    try {
      const p = await api<{ id: string }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: name || "my-api", failurePolicy: policy }),
      });
      router.push(`/projects/${p.id}`);
    } catch (e) {
      setErr(String((e as Error).message));
      setBusy(false);
    }
  }

  return (
    <Shell active="dashboard">
      <div style={{ maxWidth: 720, margin: "0 auto", paddingTop: 24 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 8 }}>接入你的项目</div>
          <div style={{ fontSize: 13, color: "var(--txt-3)", fontWeight: 500 }}>GitHub 读写代码并开出 PR · Anthropic Key 驱动 Agent 按你的用量计费</div>
        </div>

        <div className="steps">
          <div className="step done"><span className="sn"><I name="i-check" size={13} /></span><span className="sl">连接 GitHub</span></div>
          <div className="step-line done" />
          <div className={`step ${step === 2 ? "cur" : step > 2 ? "done" : ""}`}>
            <span className="sn">{step > 2 ? <I name="i-check" size={13} /> : "2"}</span><span className="sl">配置 Anthropic Key</span>
          </div>
          <div className={`step-line ${step > 2 ? "done" : ""}`} />
          <div className={`step ${step === 3 ? "cur" : ""}`}><span className="sn">3</span><span className="sl">创建项目</span></div>
        </div>

        <div className="shell"><div className="core inner" style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <I name="i-check" size={15} style={{ color: "var(--acc)" }} />GitHub · 代码通道（MVP 演示）
          </div>
          <div className="sec-note" style={{ marginTop: 0 }}>
            <I name="i-shield" size={15} style={{ color: "var(--acc)", marginTop: 2, flex: "none" }} />
            <div>演示模式使用<b>本地 git 裸仓模拟 GitHub origin</b>：分支、堆叠、diff 均真实执行，PR 落库展示。真实 GitHub OAuth + Octokit 接入为 P1（引擎与仓库层已留适配接口）。</div>
          </div>
        </div></div>

        <div style={{ marginTop: 16 }} className="shell"><div className="core inner" style={{ padding: "22px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <I name="i-key" size={15} style={{ color: "var(--acc)" }} />Anthropic API Key（BYO，可选）
          </div>
          <div className="field">
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-api03-…（留空则使用离线 Mock 引擎演示）" className="mono" />
          </div>
          {testResult && (
            <div className={testResult.ok ? "key-ok" : "key-ok"} style={testResult.ok ? {} : { background: "var(--red-dim)", borderColor: "var(--red-line)", color: "var(--red)" }}>
              <I name={testResult.ok ? "i-check" : "i-alert"} size={14} />{testResult.detail}
            </div>
          )}
          <div className="sec-note">
            <I name="i-lock" size={15} style={{ color: "var(--acc)", marginTop: 2, flex: "none" }} />
            <div><b>密钥以 AES-256-GCM 加密存储</b>，主密钥与数据库分离托管；界面永不回显完整明文。沙箱网络白名单限制外发（生产）。BROCCOLI_ENGINE=claude 时启用真实模型。</div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" disabled={busy} onClick={saveAndTest}>
              {key ? "保存并测试连通性" : "跳过 · 使用 Mock 引擎"}<I name="i-arrow" size={14} />
            </button>
          </div>
        </div></div>

        {step >= 3 && (
          <div style={{ marginTop: 16 }} className="shell"><div className="core inner" style={{ padding: "22px 24px" }}>
            <div style={{ fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <I name="i-folder" size={15} style={{ color: "var(--acc)" }} />创建项目
            </div>
            <div className="field">
              <label>项目名</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-api" className="mono" />
            </div>
            <div className="field">
              <label>失败策略（FR-C3：提交队列时可再覆盖）</label>
              <div className="seg" style={{ marginTop: 4 }}>
                <span className={policy === "pause" ? "on" : ""} onClick={() => setPolicy("pause")}>失败暂停</span>
                <span className={policy === "skip_continue" ? "on" : ""} onClick={() => setPolicy("skip_continue")}>失败自动跳过</span>
              </div>
            </div>
            {err && <div className="err-line">{err}</div>}
            <button className="btn btn-primary" disabled={busy} onClick={createProject}>创建项目<I name="i-arrow" size={14} /></button>
          </div></div>
        )}
      </div>
    </Shell>
  );
}
