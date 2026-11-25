"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { IconDefs, I } from "@/components/Icons";

type PublicConfig = { mode: "local" | "public"; registration: "open" | "closed"; demoLogin: boolean; githubOAuth: boolean };

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const router = useRouter();

  useEffect(() => {
    api<PublicConfig>("/api/public-config").then(setCfg).catch(() => {});
    const qErr = new URLSearchParams(window.location.search).get("oauth_error");
    if (qErr) setErr(`GitHub 登录失败：${qErr}`);
  }, []);

  // 注册关闭时只保留登录（公网默认）
  const registerOpen = cfg?.registration !== "closed";
  const activeMode = registerOpen ? mode : "login";

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (activeMode === "login") {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      } else {
        await api("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, displayName: email.split("@")[0] }) });
      }
      router.push("/");
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function demoLogin() {
    setErr("");
    setBusy(true);
    try {
      await api("/api/auth/demo", { method: "POST" });
      router.push("/");
    } catch {
      setErr("演示账号不可用（本地预演请先运行 pnpm seed）");
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
        {registerOpen && (
          <div className="seg" style={{ marginBottom: 22, width: "100%" }}>
            <span className={activeMode === "login" ? "on" : ""} onClick={() => setMode("login")} style={{ flex: 1, textAlign: "center" }}>登录</span>
            <span className={activeMode === "register" ? "on" : ""} onClick={() => setMode("register")} style={{ flex: 1, textAlign: "center" }}>注册</span>
          </div>
        )}
        <form onSubmit={(e) => submit(e)}>
          <div className="field">
            <label>邮箱</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" type="email" autoComplete="email" required />
          </div>
          <div className="field">
            <label>密码</label>
            <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="≥ 8 位" type="password" autoComplete={activeMode === "login" ? "current-password" : "new-password"} required />
          </div>
          {err && <div className="err-line">{err}</div>}
          <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} disabled={busy}>
            {activeMode === "login" ? "登录" : "注册并开始"}<I name="i-arrow" size={14} />
          </button>
        </form>
        {cfg?.demoLogin && (
          <button className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} disabled={busy} onClick={demoLogin}>
            一键体验（演示账号）
          </button>
        )}
        {cfg?.githubOAuth && (
          <a className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", marginTop: 10, borderColor: "rgba(52,211,153,.4)" }} href="/api/auth/github/start">
            使用 GitHub 登录<I name="i-arrow" size={14} />
          </a>
        )}
        <div className="onb-note" style={{ textAlign: "center" }}>
          {registerOpen ? "邮箱 + 密码认证" : "注册已关闭 · 账号由管理员开通"}
        </div>
      </div></div>
    </div>
  );
}
