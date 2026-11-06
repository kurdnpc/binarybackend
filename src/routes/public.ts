import { createHash } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { q } from "../db/pool.js";
import { clientIp, HttpError, ok, parse } from "../lib/http.js";
import { mapSystem, type SystemRow } from "../lib/mappers.js";

export const publicRouter = Router();

/* ---------------- content ---------------- */

publicRouter.get("/systems", async (_req, res) => {
  const { rows } = await q<SystemRow>("SELECT * FROM systems WHERE published ORDER BY sort, created_at DESC");
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json(ok(rows.map(mapSystem)));
});

publicRouter.get("/systems/:slug", async (req, res) => {
  const { rows } = await q<SystemRow>("SELECT * FROM systems WHERE slug = $1 AND published", [req.params.slug]);
  if (!rows[0]) throw new HttpError(404, "System not found");
  res.json(ok(mapSystem(rows[0])));
});

publicRouter.get("/testimonials", async (_req, res) => {
  const { rows } = await q("SELECT id, quote, name, role, project, color FROM testimonials WHERE published ORDER BY sort");
  res.json(ok(rows));
});

publicRouter.get("/faqs", async (_req, res) => {
  const { rows } = await q("SELECT id, q, a FROM faqs WHERE published ORDER BY sort");
  res.json(ok(rows));
});

publicRouter.get("/team", async (_req, res) => {
  const { rows } = await q("SELECT id, name, role, color, photo FROM team ORDER BY sort");
  res.json(ok(rows));
});

publicRouter.get("/sections/:page", async (req, res) => {
  const { rows } = await q("SELECT key, visible, sort, content FROM page_sections WHERE page = $1 ORDER BY sort", [req.params.page]);
  res.json(ok(rows));
});

publicRouter.get("/settings", async (_req, res) => {
  const { rows } = await q<{ key: string; value: unknown }>("SELECT key, value FROM settings WHERE key = ANY($1)", [["general", "appearance", "whatsapp", "location"]]);
  res.json(ok(Object.fromEntries(rows.map((r) => [r.key, r.value]))));
});

/* ---------------- leads (contact form) ---------------- */

const leadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many requests" } });

const LeadBody = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^[+\d][\d\s-]{6,19}$/),
  services: z.array(z.enum(["web", "mobile", "system", "design", "branding"])).max(5).default([]),
  budget: z.string().max(40).optional(),
  details: z.string().trim().max(4000).optional(),
  source: z.string().max(40).optional(),
  contactMethod: z.enum(["whatsapp", "phone", "any"]).optional(),
  contactTime: z.enum(["anytime", "morning", "afternoon", "evening"]).optional(),
  // follow-up answers per selected service, e.g. { "web.type": "store", "mobile.platform": ["ios","android"] }
  extra: z.record(z.string().max(40), z.union([z.string().max(120), z.array(z.string().max(60)).max(10)])).optional(),
  website: z.string().max(0).optional(), // honeypot must stay empty
});

publicRouter.post("/leads", leadLimiter, async (req, res) => {
  const b = parse(LeadBody, req.body);
  const ipHash = createHash("sha256").update(clientIp(req)).digest("hex").slice(0, 16);
  const { rows } = await q<{ id: string }>(
    `INSERT INTO leads (name, phone, services, budget, details, source, ip_hash, contact_method, contact_time, extra)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [b.name, b.phone, b.services, b.budget || null, b.details || null, b.source || "contact", ipHash, b.contactMethod ?? null, b.contactTime ?? null, JSON.stringify(b.extra ?? {})],
  );
  res.status(201).json(ok({ id: rows[0].id }));
});

/* ---------------- analytics ---------------- */

const trackLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });

const TrackBody = z.object({
  type: z.enum(["pageview", "leave", "whatsapp"]),
  path: z.string().max(300).startsWith("/"),
  session: z.string().min(8).max(64),
  ref: z.string().max(300).optional(),
  duration: z.number().int().min(0).max(6 * 3600).optional(),
  meta: z.record(z.string(), z.string().max(120)).optional(),
});

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview/i;

publicRouter.post("/track", trackLimiter, async (req, res) => {
  const ua = req.get("user-agent") ?? "";
  if (BOT.test(ua)) return void res.status(204).end();
  const b = parse(TrackBody, typeof req.body === "string" ? JSON.parse(req.body) : req.body);
  const day = new Date().toISOString().slice(0, 10);
  // Cookieless unique visitor: salted hash that rotates daily (no IP stored).
  const visitor = createHash("sha256").update(`${day}|${clientIp(req)}|${ua}`).digest("hex").slice(0, 24);
  await q(
    "INSERT INTO events (type, path, visitor, session, ref, meta, duration_s) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [b.type, b.path.split("?")[0], visitor, b.session, b.ref ?? null, b.meta ?? null, b.duration ?? null],
  );
  res.status(204).end();
});
