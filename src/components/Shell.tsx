"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/client";
import { IconDefs, I } from "./Icons";

type Me = { id: string; email: string; displayName: string };

export function Shell({ active, children }: { active: "dashboard" | "projects" | "memories" | "usage" | "notifications" | "settings"; children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [projectCount, setProjectCount] = useState<number>(0);
  const [notifCount, setNotifCount] = useState<number>(0);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch(() => {});
    api<{ id: string }[]>("/api/projects").then((p) => setProjectCount(p.length)).catch(() => {});
  }, [pathname]);

  useEffect(() => {
    const load = () => api<unknown[]>("/api/notifications").then((n) => setNotifCount(n.length)).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [pathname]);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  const firstLetter = me?.email?.[0]?.toUpperCase() ?? "T";

  return (
    <>
      <IconDefs />
      <div className="app">
        <aside className="side">
          <div className="logo">
            <span className="mark"><I name="i-leaf" size={19} /></span>
            <span>
              <span className="nm">Broccoli</span>
              <span className="tag">CLOUD DEV OPS</span>
            </span>
          </div>
          <Link className={`nav-item ${active === "dashboard" ? "on" : ""}`} href="/"><I name="i-grid" size={17} />仪表盘</Link>
          <Link className={`nav-item ${active === "projects" ? "on" : ""}`} href="/projects"><I name="i-folder" size={17} />项目<span className="cnt">{projectCount}</span></Link>
          <span className="nav-item" style={{ opacity: 0.5, cursor: "default" }}><I name="i-spark" size={17} />记忆库<span className="cnt">按项目</span></span>
          <Link className={`nav-item ${active === "usage" ? "on" : ""}`} href="/usage"><I name="i-gauge" size={17} />用量与成本</Link>
          <Link className={`nav-item ${active === "settings" ? "on" : ""}`} href="/settings/ai"><I name="i-key" size={17} />接入设置</Link>
          <Link className={`nav-item ${active === "notifications" ? "on" : ""}`} href="/notifications">
            <I name="i-mail" size={17} />站内通知
            {notifCount > 0 && (
              <span className="cnt" style={{ background: notifCount > 2 ? "var(--amber-dim)" : "rgba(255,255,255,.06)", color: notifCount > 2 ? "var(--amber)" : "var(--txt-3)", borderRadius: 999, padding: "1px 8px", fontSize: 10 }}>
                {notifCount}
              </span>
            )}
          </Link>

          <div className="foot">
            <span className="av">{firstLetter}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="nm">{me?.displayName ?? "…"}</div>
              <div className="st"><span className="dot" />BYO Key · 已连通</div>
            </div>
            <button className="ico-btn" title="退出登录" onClick={logout}><I name="i-x" size={14} /></button>
          </div>
        </aside>
        <div className="main">{children}</div>
      </div>
    </>
  );
}
