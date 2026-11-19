"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api } from "@/lib/client";

type AiSettings = { baseUrl: string; model: string; tokenHint: string | null; hasToken: boolean; engine: string; source: string };

const MODEL_CHOICES = ["claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"];

export default function AiSettingsPage() {
  const [current, setCurrent] = useState<AiSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api<AiSettings>("/api/settings/ai")
      .then((r) => {
        setCurrent(r);
        setBaseUrl(r.baseUrl ?? "");
        setModel(r.model ?? "");
      })
      .catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await api("/api/settings/ai", {
        method: "PUT",
        body: JSON.stringify({ baseUrl, model, token: token || undefined }),
      });
      setSaved(true);
      setToken("");
      setTimeout(() => setSaved(false), 2500);
      setCurrent(await api<AiSettings>("/api/settings/ai"));
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setTestResult(null);
    try {
      const r = await api<{ ok: boolean; models?: string[]; error?: string }>("/api/credentials/test", {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", baseUrl, model: model || undefined }),
      });
      setTestResult({ ok: r.ok, detail: r.ok ? `连接正常 · ${r.models?.join(", ") ?? ""}` : r.error ?? "连通失败" });
    } catch (e) {
      setTestResult({ ok: false, detail: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell active="settings">
      <div className="topbar">
        <div>
          <div className="hi">AI 接入设置</div>
          <div className="dt">Anthropic 兼容端点 · 影响该账号全部任务的规划 / 开发 / 验收（v2β）</div>
        </div>
        <div className="sp" />
      </div>

      <div className="bento">
        <div className="b7 pcard"><div className="shell"><div className="core inner" style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <I name="i-key" size={15} style={{ color: "var(--acc)" }} />接入配置
            {current && <span className="chip chip-gray" style={{ marginLeft: "auto" }}>当前来源：{current.source}</span>}
          </div>

          <div className="field">
            <label>Base URL（Anthropic 兼容端点，可指向官方或本地 router / 代理）</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.anthropic.com 或 http://192.168.x.x:1980" className="mono" />
          </div>
          <div className="field">
            <label>模型（覆盖全部阶段；留空则按阶段使用推荐档位）</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="如 glm:glm-5.3[1m] 或 claude-sonnet-4-5" className="mono" style={{ flex: 1 }} />
              <div className="seg">
                {MODEL_CHOICES.map((m) => (
                  <span key={m} className={model === m ? "on" : ""} onClick={() => setModel(m)} style={{ fontSize: 11 }}>{m.replace("claude-", "")}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="field">
            <label>Token / API Key {current?.tokenHint && <span className="mono" style={{ color: "var(--txt-3)" }}>（当前：{current.tokenHint}）</span>}</label>
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder={current?.hasToken ? "留空 = 保持不变；填写则覆盖" : "sk-… / sk-ant-… / router token"} className="mono" type="password" />
          </div>
          {testResult && (
            <div className="key-ok" style={testResult.ok ? {} : { background: "var(--red-dim)", borderColor: "var(--red-line)", color: "var(--red)" }}>
              <I name={testResult.ok ? "i-check" : "i-alert"} size={14} />{testResult.detail}
            </div>
          )}
          {err && <div className="err-line">{err}</div>}
          {saved && <div className="key-ok"><I name="i-check" size={14} />已保存 —— 新任务即按此接入执行</div>}

          <div className="sec-note">
            <I name="i-shield" size={15} style={{ color: "var(--acc)", marginTop: 2, flex: "none" }} />
            <div><b>Token 以 AES-256-GCM 加密存储</b>，界面只回显掩码；保存后立即对新任务生效，不影响进行中的任务。接入优先级：本页设置 &gt; 平台 env &gt; 旧 BYO key。</div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" disabled={busy} onClick={save}>保存设置<I name="i-check" size={14} /></button>
            <button className="btn btn-ghost" disabled={busy} onClick={testConnection}>测试连通性</button>
          </div>
        </div></div></div>

        <div className="b5 pcard"><div className="shell"><div className="core inner" style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <I name="i-zap" size={15} style={{ color: "var(--acc)" }} />说明
          </div>
          <div className="rec-note" style={{ border: "none", background: "transparent", padding: 0 }}>
            <div>
              <p style={{ marginBottom: 10 }}>· 端点需兼容 <b>Anthropic Messages 协议</b>（`POST {"/v1/messages"}`）；本地 AI router / 各类网关均可。</p>
              <p style={{ marginBottom: 10 }}>· 模型名写 router 中的模型 ID（如 `glm:glm-5.3[1m]`）；使用官方端点时填 `claude-…`。</p>
              <p style={{ marginBottom: 10 }}>· 分阶段模型（阶段与模型配置）在此未覆盖时按阶段路由；本页模型设置优先生效于全部阶段。</p>
              <p>· Token 留空保存 = 保持现有 Token 不变；需清除 Token 请清空后点保存两次并确认。</p>
            </div>
          </div>
        </div></div></div>
      </div>
    </Shell>
  );
}
