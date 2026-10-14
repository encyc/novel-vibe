import { Pool } from "pg";

export function createSchedulerPool(env: NodeJS.ProcessEnv = process.env): Pool {
  if (env.DATABASE_URL?.trim()) {
    return new Pool({ connectionString: env.DATABASE_URL.trim(), max: 4 });
  }
  if (!env.POSTGRES_PASSWORD?.trim()) {
    throw new Error("POSTGRES_PASSWORD is required for scheduler database access");
  }
  return new Pool({
    host: env.POSTGRES_HOST?.trim() || "postgres",
    port: Number(env.POSTGRES_PORT || 5432),
    user: env.POSTGRES_USER?.trim() || "postgres",
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB?.trim() || "insforge",
    max: 4,
  });
}
