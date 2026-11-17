import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok, bad } from "@/lib/api";
import { mergeProjectPr, rebasePrChain } from "@/lib/pipeline/orchestrator";

/** PR 处置（FR-F2 界面合并 / FR-F3 堆叠链修复）：action = merge | rebase */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const { action } = (await req.json()) as { action: string };
  if (action === "merge") return ok(await mergeProjectPr(id, user.id));
  if (action === "rebase") return ok(await rebasePrChain(id, user.id));
  return bad("未知 action");
}
