/**
 * 开通账号（公网关闭自助注册时由管理员执行）。
 * 口令通过环境变量传入，避免进入 shell 历史：
 *   USER_EMAIL=you@example.com USER_PASSWORD=至少8位 pnpm user:create
 * 容器内（生产编排）：
 *   docker compose -f docker-compose.prod.yml --env-file .env.production \
 *     exec -e USER_EMAIL=you@example.com -e USER_PASSWORD=... app ./node_modules/.bin/tsx scripts/create-user.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { users } from "../src/db/schema";
import { hashPassword } from "../src/lib/crypto";

async function main() {
  const email = (process.env.USER_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.USER_PASSWORD ?? "";
  const displayName = (process.env.USER_NAME ?? "").trim() || email.split("@")[0];
  if (!email.includes("@") || password.length < 8) {
    console.error("需要 USER_EMAIL（邮箱）与 USER_PASSWORD（至少 8 位）");
    process.exit(1);
  }
  const [exists] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (exists) {
    console.log(`• 账号已存在：${email}（未做修改）`);
    process.exit(0);
  }
  await db.insert(users).values({ email, passwordHash: hashPassword(password), displayName });
  console.log(`✓ 已创建账号：${email}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
