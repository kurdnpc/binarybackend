import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { errorHandler } from "./lib/http.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { publicRouter } from "./routes/public.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    credentials: true,
  }),
);
app.use(compression());
app.use(express.json({ limit: "200kb" }));
app.use(express.text({ type: "text/plain", limit: "10kb" })); // navigator.sendBeacon payloads
app.use(cookieParser());

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "up" });
  } catch {
    res.status(503).json({ ok: false, db: "down" });
  }
});

app.use("/api", publicRouter);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});
app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  console.log(`Binary Group API on http://localhost:${config.PORT} (${config.NODE_ENV})`);
});

const shutdown = async () => {
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
