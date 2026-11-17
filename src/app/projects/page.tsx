"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { I } from "@/components/Icons";
import { api } from "@/lib/client";

type Project = { id: string; name: string; repoFullName: string; defaultBranch: string; failurePolicy: string; lastSuccessBranch: string | null };

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  useEffect(() => {
    api<Project[]>("/api/projects").then(setProjects).catch(() => {});
  }, []);

  async function create() {
    if (!name.trim()) return;
    const p = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
    setName("");
    window.location.href = `/projects/${p.id}`;
  }

  return (
    <Shell active="projects">
      <div className="topbar">
        <div><div className="hi">项目</div><div className="dt">{projects.length} 个项目 · 每个项目一条需求队列与流水线</div></div>
      </div>
      <div className="bento">
        {projects.map((p) => (
          <div key={p.id} className="b5 pcard"><div className="shell"><div className="core inner">
            <div className="hd">
              <div style={{ flex: 1 }}>
                <div className="rname">{p.name}</div>
                <div className="rmeta"><I name="i-branch" size={12} />{p.defaultBranch} · {p.failurePolicy === "pause" ? "失败暂停" : "失败自动跳过"}</div>
              </div>
              <Link className="btn btn-ghost btn-sm" href={`/projects/${p.id}`}>进入<I name="i-chev" size={13} /></Link>
            </div>
          </div></div></div>
        ))}
        <div className="b5 pcard"><div className="shell"><div className="core inner">
          <div className="hd"><div><div className="rname" style={{ fontFamily: "var(--sans)" }}>新建项目</div>
          <div className="rmeta">本地模拟 GitHub origin · 真实 git 堆叠分支</div></div></div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="项目名，如 my-api" className="mono"
              style={{ flex: 1, height: 38, borderRadius: 12, border: "1px solid var(--line-2)", background: "rgba(255,255,255,.04)", padding: "0 14px", fontSize: 12.5, outline: "none" }} />
            <button className="btn btn-primary btn-sm" onClick={create}><I name="i-plus" size={13} />创建</button>
          </div>
        </div></div></div>
      </div>
    </Shell>
  );
}
