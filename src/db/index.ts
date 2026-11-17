import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL ?? "postgres://broccoli:broccoli@localhost:5432/broccoli";

declare global {
  // eslint-disable-next-line no-var
  var __broccoliDb: ReturnType<typeof createDb> | undefined;
}

function createDb() {
  const client = postgres(connectionString, { max: 10, idle_timeout: 20 });
  return drizzle(client, { schema });
}

export const db = globalThis.__broccoliDb ?? (globalThis.__broccoliDb = createDb());
export { schema };
