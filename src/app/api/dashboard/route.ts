import { getSessionUser, unauthorized } from "@/lib/auth";
import { ok } from "@/lib/api";
import { dashboardData } from "@/lib/dashboard";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  return ok(await dashboardData(user.id));
}
