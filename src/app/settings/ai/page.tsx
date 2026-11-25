"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api } from "@/lib/client";

type Protocol = "anthropic" | "openai";

type AiSettings = {
  baseUrl: string;
  protocol: Protocol;
  models: string[];
  defaultModel: string;
  tokenHint: string | null;
  hasToken: boolean;
  envFallback: boolean;
  engine: string;
};

const PROTOCOL_LABEL: Record<Protocol, { name: string; path: string; hint: string }> = {
  anthropic: { name: "Anthropic Messages", path: "POST /v1/messages", hint: "官方 Anthropic 及兼容网关（Claude Code 生态）" },
  openai: { name: "OpenAI Chat Completions", path: "POST /v1/chat/completions", hint: "OpenAI 兼容：官方 / vLLM / LiteLLM / 多数聚合网关" },
};

export default function AiSettingsPage() {
  const [current, setCurrent] = useState<AiSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("anthropic");
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [err, setErr] = useState("");

  function hydrate(r: AiSettings) {
    setCurrent(r);
    setBaseUrl(r.baseUrl ?? "");
    setProtocol(r.protocol ?? "anthropic");
    setModels(r.models ?? []);
    setDefaultModel(r.defaultModel ?? "");
  }

  useEffect(() => {
    api<AiSettings>("/api/settings/ai").then(hydrate).catch((e) => setErr(String((e as Error).message)));
  }, []);

  function addModel() {
    const v = modelDraft.trim();
    if (!v) return;
    if (!models.includes(v)) setModels([...models, v]);
    if (!defaultModel) setDefaultModel(v);
    setModelDraft("");
  }

  function removeModel(m: string) {
    const next = models.filter((x) => x !== m);
    setModels(next);
    if (defaultModel === m) setDefaultModel(next[0] ?? "");
  }

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await api("/api/settings/ai", {
        method: "PUT",
        body: JSON.stringify({ baseUrl, protocol, models, defaultModel, token: token || undefined }),
      });
      setToken("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      hydrate(await api<AiSettings>("/api/settings/ai"));
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function fetchModels() {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ models: string[] }>("/api/settings/ai", {
        method: "POST",
        body: JSON.stringify({ baseUrl, token: token || undefined }),
      });
      const merged = [...new Set([...models, ...r.models])];
      setModels(merged);
      if (!defaultModel) setDefaultModel(merged[0] ?? "");
      setTestResult({ ok: true, detail: `从端点拉取到 ${r.models.length} 个模型` });
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
      const probe = defaultModel || models[0] || "";
      const r = await api<{ ok: boolean; error?: string; sample?: string; protocol?: string }>("/api/credentials/test", {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", baseUrl, protocol, model: probe || undefined, secret: token || undefined }),
      });
      setTestResult({
        ok: r.ok,
        detail: r.ok ? `连接正常（${r.protocol ?? protocol} · ${probe}）${r.sample ? ` · 响应：${r.sample}` : ""}` : (r.error ?? "连通失败"),
      });
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
          <div className="dt">平台级配置 · 全平台任务共用此端点与密钥 · 模型由你维护的列表决定</div>
        </div>
        <div className="sp" />
        {current && <span className="chip chip-gray">引擎：{current.engine}</span>}
      </div>

      <div className="bento">
        <div className="b7 pcard"><div className="shell"><div className="core inner" style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <I name="i-key" size={15} style={{ color: "var(--acc)" }} />接入配置
            {current?.hasToken && <span className="chip chip-green" style={{ marginLeft: "auto" }}>已配置密钥</span>}
          </div>

          <div className="field">
            <label>Base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com 或 http://192.168.x.x:1980" className="mono" />
          </div>

          <div className="field">
            <label>接口模式（决定请求路径与鉴权头）</label>
            <div className="seg" style={{ width: "100%" }}>
              {(Object.keys(PROTOCOL_LABEL) as Protocol[]).map((p) => (
                <span key={p} className={protocol === p ? "on" : ""} onClick={() => setProtocol(p)} style={{ flex: 1, textAlign: "center" }}>
                  {PROTOCOL_LABEL[p].name}
                </span>
              ))}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--txt-3)", marginTop: 6 }}>
              {PROTOCOL_LABEL[protocol].path} · {PROTOCOL_LABEL[protocol].hint}
            </div>
          </div>

          <div className="field">
            <label>模型列表（阶段与批次只能从这里选择）</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addModel(); } }}
                placeholder="输入模型 ID，回车添加（如 glm-5.3、gpt-5.5、deepseek-v4-pro）"
                className="mono"
                style={{ flex: 1 }}
              />
              <button className="btn btn-ghost btn-sm" onClick={addModel} disabled={!modelDraft.trim()}>添加</button>
              <button className="btn btn-ghost btn-sm" onClick={fetchModels} disabled={busy} title="请求 {Base URL}/v1/models 并合并">从端点拉取</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              {models.length === 0 && <span style={{ fontSize: 11.5, color: "var(--txt-3)" }}>还没有模型 —— 手动添加或点「从端点拉取」</span>}
              {models.map((m) => (
                <span key={m} className={`chip ${defaultModel === m ? "chip-green" : "chip-gray"}`} style={{ gap: 6 }}>
                  <span
                    className="mono"
                    style={{ cursor: "pointer" }}
                    title="设为默认模型"
                    onClick={() => setDefaultModel(m)}
                  >
                    {m}{defaultModel === m ? " · 默认" : ""}
                  </span>
                  <span style={{ cursor: "pointer", opacity: 0.7 }} title="移除" onClick={() => removeModel(m)}>×</span>
                </span>
              ))}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--txt-3)", marginTop: 6 }}>点模型名设为默认；默认模型用于未单独指定模型的阶段</div>
          </div>

          <div className="field">
            <label>API Key {current?.tokenHint && <span className="mono" style={{ color: "var(--txt-3)" }}>（当前：{current.tokenHint}）</span>}</label>
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder={current?.hasToken ? "留空 = 保持不变；填写则覆盖" : "sk-…"} className="mono" type="password" />
          </div>

          {testResult && (
            <div className="key-ok" style={testResult.ok ? {} : { background: "var(--red-dim)", borderColor: "var(--red-line)", color: "var(--red)" }}>
              <I name={testResult.ok ? "i-check" : "i-alert"} size={14} />{testResult.detail}
            </div>
          )}
          {err && <div className="err-line">{err}</div>}
          {saved && <div className="key-ok"><I name="i-check" size={14} />已保存 —— 新任务即按此配置执行</div>}

          <div className="sec-note">
            <I name="i-shield" size={15} style={{ color: "var(--acc)", marginTop: 2, flex: "none" }} />
            <div>
              <b>平台级设置</b>：影响所有项目与账号（写操作仅限平台所有者）。API Key 以 AES-256-GCM 加密存储，界面只回显掩码。
              接入优先级：本页配置 &gt; 平台 env 兜底 &gt; 旧 BYO key。未配置时任务回落离线演示引擎。
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" disabled={busy} onClick={save}>保存设置<I name="i-check" size={14} /></button>
            <button className="btn btn-ghost" disabled={busy || !(defaultModel || models[0])} onClick={testConnection}>测试连通性</button>
          </div>
        </div></div></div>

        <div className="b5 pcard"><div className="shell"><div className="core inner" style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <I name="i-zap" size={15} style={{ color: "var(--acc)" }} />说明
          </div>
          <div className="rec-note" style={{ border: "none", background: "transparent", padding: 0 }}>
            <div>
              <p style={{ marginBottom: 10 }}>· 模型不再内置：平台不预设任何厂商模型名，可选模型完全由上面的列表决定。</p>
              <p style={{ marginBottom: 10 }}>· 项目「阶段与模型配置」与提交时的批次覆盖，只能从该列表中选择；未指定时用默认模型。</p>
              <p style={{ marginBottom: 10 }}>· 「从端点拉取」请求 <span className="mono">{"{Base URL}"}/v1/models</span>（多数网关支持）。拉取失败不影响手动添加。</p>
              <p style={{ marginBottom: 10 }}>· 两种接口模式的鉴权头不同：Anthropic 用 <span className="mono">x-api-key</span> + Bearer；OpenAI 用 <span className="mono">Bearer</span>。</p>
              <p>· 更换 Base URL / 接口模式后请点「测试连通性」，确认端点可达再提交任务。</p>
            </div>
          </div>
        </div></div></div>
      </div>
    </Shell>
  );
}
