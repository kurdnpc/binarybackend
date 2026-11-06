import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  // SSL only when the URL asks for it (public proxy URLs); Railway's private network is plain TCP.
  ssl: /sslmode=(require|verify)/.test(config.DATABASE_URL) || process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
});

pool.on("error", (err) => console.error("[pg] idle client error", err));

export const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => pool.query<T>(text, params);
