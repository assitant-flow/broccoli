/** 独立脚本（seed/smoke）专用入口：绕开 Next 的 globalThis 单例，并暴露连接关闭 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./db/schema";

const url = process.env.DATABASE_URL ?? "postgres://broccoli:broccoli@localhost:5432/broccoli";
const client = postgres(url, { max: 5 });
export const db = drizzle(client, { schema });
export { schema };
export async function poolClose() {
  await client.end();
}
