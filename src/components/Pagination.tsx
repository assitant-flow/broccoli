"use client";

/** 通用分页控件（v2β）：列表页统一使用 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end", padding: "12px 2px 0", flexWrap: "wrap" }}>
      <span className="mono" style={{ fontSize: 11, color: "var(--txt-3)" }}>
        共 {total} 条 · 第 {page}/{totalPages} 页
      </span>
      <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
      {Array.from({ length: totalPages }, (_, i) => i + 1)
        .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
        .map((p, idx, arr) => (
          <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {idx > 0 && arr[idx - 1] !== p - 1 && <span style={{ color: "var(--txt-3)", fontSize: 11 }}>…</span>}
            <button
              className="btn btn-ghost btn-sm"
              style={p === page ? { background: "var(--acc-dim)", borderColor: "rgba(52,211,153,.4)", color: "var(--acc)" } : undefined}
              onClick={() => onPageChange(p)}
            >
              {p}
            </button>
          </span>
        ))}
      <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页</button>
    </div>
  );
}
