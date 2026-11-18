"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { IconDefs, I } from "@/components/Icons";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("thomas@broccoli.dev");
  const [password, setPassword] = useState("broccoli123");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [oauthReady, setOauthReady] = useState(false);
  const router = useRouter();

  useEffect(() => {
    api<{ configured: boolean }>("/api/auth/github/status").then((r) => setOauthReady(r.configured)).catch(() => {});
    const qErr = new URLSearchParams(window.location.search).get("oauth_error");
    if (qErr) setErr(`GitHub 登录失败：${qErr}`);
  }, []);

  async function submit(e?: React.FormEvent, demo = false) {
    e?.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (demo) {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "thomas@broccoli.dev", password: "broccoli123" }) });
      } else if (mode === "login") {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      } else {
        await api("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, displayName: email.split("@")[0] }) });
      }
      router.push("/");
    } catch (e) {
      setErr(String((e as Error).message));
      if (demo) setErr("演示账号不存在 —— 请先运行 pnpm seed 创建种子数据，或直接注册/登录");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <IconDefs />
      <div className="logo" style={{ padding: "0 0 24px" }}>
        <span className="mark"><I name="i-leaf" size={19} /></span>
        <span><span className="nm" style={{ fontSize: 20 }}>Broccoli</span><span className="tag">CLOUD DEV OPS</span></span>
      </div>
      <div className="auth-card shell"><div className="core inner">
        <div className="seg" style={{ marginBottom: 22, width: "100%" }}>
          <span className={mode === "login" ? "on" : ""} onClick={() => setMode("login")} style={{ flex: 1, textAlign: "center" }}>登录</span>
          <span className={mode === "register" ? "on" : ""} onClick={() => setMode("register")} style={{ flex: 1, textAlign: "center" }}>注册</span>
        </div>
        <form onSubmit={(e) => submit(e)}>
          <div className="field">
            <label>邮箱</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" type="email" required />
          </div>
          <div className="field">
            <label>密码</label>
            <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="≥ 6 位" type="password" required />
          </div>
          {err && <div className="err-line">{err}</div>}
          <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} disabled={busy}>
            {mode === "login" ? "登录" : "注册并开始"}<I name="i-arrow" size={14} />
          </button>
        </form>
        <button className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} disabled={busy} onClick={() => submit(undefined, true)}>
          一键体验（演示账号）
        </button>
        {oauthReady && (
          <a className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", marginTop: 10, borderColor: "rgba(52,211,153,.4)" }} href="/api/auth/github/start">
            使用 GitHub 登录<I name="i-arrow" size={14} />
          </a>
        )}
        <div className="onb-note" style={{ textAlign: "center" }}>MVP：邮箱 + 密码认证 · GitHub OAuth 登录（配置后启用）</div>
      </div></div>
    </div>
  );
}
