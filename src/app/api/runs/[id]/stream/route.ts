import { db } from "@/db";
import { stageLogs, projects, taskRuns } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth";
import { subscribeLogs } from "@/lib/pipeline/orchestrator";

/** SSE 实时日志（FR-D7/AC-D7） */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { id } = await params;

  const rows = await db
    .select({ runId: taskRuns.id })
    .from(taskRuns)
    .innerJoin(projects, eq(taskRuns.projectId, projects.id))
    .where(and(eq(taskRuns.id, id), eq(projects.userId, user.id)))
    .limit(1);
  if (!rows.length) return new Response("not found", { status: 404 });

  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };

      void (async () => {
        const unsub = subscribeLogs(id, send); // 先订阅避免缺口
        const backlog = await db.select().from(stageLogs).where(eq(stageLogs.runId, id)).orderBy(asc(stageLogs.ts)).limit(500);
        for (const l of backlog) {
          if (seen.has(l.id)) continue;
          seen.add(l.id);
          send({ ts: l.ts, stageId: l.stageId, level: l.level, line: l.line, id: l.id });
        }
        const onLog = (line: unknown) => {
          const l = line as { id?: string };
          if (l.id && seen.has(l.id)) return;
          if (l.id) seen.add(l.id);
          send(line);
        };
        unsub();
        subscribeLogs(id, onLog);

        const hb = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": hb\n\n"));
          } catch {
            closed = true;
          }
        }, 15000);
        req.signal.addEventListener("abort", () => {
          closed = true;
          clearInterval(hb);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      })();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
