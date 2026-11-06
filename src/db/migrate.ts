import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "./pool.js";

const sql = await readFile(path.join(import.meta.dirname, "schema.sql"), "utf8");
await pool.query(sql);
console.log("Database schema is up to date");
await pool.end();
