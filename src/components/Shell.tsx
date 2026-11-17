"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/client";
import { IconDefs, I } from "./Icons";

type Me = { id: string; email: string; displayName: string };
type Notif = { id: string; type: string; runId: string | null; createdAt: string; dedupeKey: string };

const NOTIF_META: Record<string, { cls: string; label: string }> = {
  wait_confirm: { cls: "chip-amber", label: "等待确认" },
  failed: { cls: "chip-red", label: "失败" },
  suspended: { cls: "chip-amber", label: "已挂起" },
  completed: { cls: "chip-green", label: "完成" },
};

export function Shell({ active, children }: { active: "dashboard" | "projects" | "memories" | "usage"; children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [projectCount, setProjectCount] = useState<number>(0);
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch(() => {});
    api<{ id: string }[]>("/api/projects").then((p) => setProjectCount(p.length)).catch(() => {});
  }, [pathname]);

  useEffect(() => {
    const load = () => api<Notif[]>("/api/notifications").then(setNotifs).catch(() => {});
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

          <div style={{ position: "relative", marginTop: 8 }}>
            <button className={`nav-item ${bellOpen ? "on" : ""}`} style={{ width: "100%" }} onClick={() => setBellOpen((v) => !v)}>
              <I name="i-mail" size={17} />站内通知
              {notifs.length > 0 && <span className="cnt" style={{ background: "var(--amber-dim)", color: "var(--amber)", borderRadius: 999, padding: "1px 7px", fontSize: 10 }}>{notifs.length}</span>}
            </button>
            {bellOpen && (
              <div className="shell" style={{ position: "absolute", right: 0, bottom: "110%", width: 320, zIndex: 40 }}>
                <div className="core" style={{ padding: "12px 14px", maxHeight: 360, overflowY: "auto" }}>
                  {notifs.length === 0 && <div style={{ fontSize: 12, color: "var(--txt-3)", fontWeight: 500 }}>暂无通知 —— 任务状态变化会在这里出现</div>}
                  {notifs.map((n) => {
                    const meta = NOTIF_META[n.type] ?? NOTIF_META.completed;
                    return (
                      <div key={n.id} className="tl-row">
                        <span className="chip chip-gray" style={{ height: 22, fontSize: 10 }}>{meta.label}</span>
                        <span className="tx">{new Date(n.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                        {n.runId && <Link className="view" style={{ color: "var(--blue)", fontSize: 11 }} href={`/runs/${n.runId}`}>查看任务</Link>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

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
