import { Router } from "express";
import { z } from "zod";
import { pool, q } from "../db/pool.js";
import { requireAdmin } from "../lib/auth.js";
import { HttpError, ok, parse } from "../lib/http.js";
import { mapSystem, type SystemRow } from "../lib/mappers.js";
import { revalidateWeb } from "../lib/revalidate.js";

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const Uuid = z.string().uuid();

/* =========================== Dashboard =========================== */

const pct = (cur: number, prev: number) => (prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 1000) / 10);

adminRouter.get("/stats", async (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));

  const [kpi, series, topPages, whatsapp, leads] = await Promise.all([
    q<{ today: number; yesterday: number; cur: number; prev: number; wa: number; wa_prev: number }>(
      `SELECT
         (SELECT count(DISTINCT visitor) FROM events WHERE type='pageview' AND created_at >= date_trunc('day', now()))::int AS today,
         (SELECT count(DISTINCT visitor) FROM events WHERE type='pageview' AND created_at >= date_trunc('day', now()) - interval '1 day' AND created_at < date_trunc('day', now()))::int AS yesterday,
         (SELECT count(*) FROM (SELECT DISTINCT date_trunc('day', created_at), visitor FROM events WHERE type='pageview' AND created_at >= now() - make_interval(days => $1)) t)::int AS cur,
         (SELECT count(*) FROM (SELECT DISTINCT date_trunc('day', created_at), visitor FROM events WHERE type='pageview' AND created_at >= now() - make_interval(days => $1 * 2) AND created_at < now() - make_interval(days => $1)) t)::int AS prev,
         (SELECT count(*) FROM events WHERE type='whatsapp' AND created_at >= now() - make_interval(days => $1))::int AS wa,
         (SELECT count(*) FROM events WHERE type='whatsapp' AND created_at >= now() - make_interval(days => $1 * 2) AND created_at < now() - make_interval(days => $1))::int AS wa_prev`,
      [days],
    ),
    q<{ day: string; visitors: number; views: number }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
              coalesce(count(DISTINCT e.visitor), 0)::int AS visitors,
              coalesce(count(e.id), 0)::int AS views
         FROM generate_series(date_trunc('day', now()) - make_interval(days => $1 - 1), date_trunc('day', now()), interval '1 day') d
         LEFT JOIN events e ON e.type='pageview' AND e.created_at >= d AND e.created_at < d + interval '1 day'
        GROUP BY d ORDER BY d`,
      [days],
    ),
    q<{ path: string; views: number; avg_s: number | null }>(
      `SELECT p.path, p.views, l.avg_s FROM
         (SELECT path, count(*)::int AS views FROM events WHERE type='pageview' AND created_at >= now() - make_interval(days => $1) GROUP BY path) p
         LEFT JOIN (SELECT path, round(avg(duration_s))::int AS avg_s FROM events WHERE type='leave' AND duration_s > 0 AND created_at >= now() - make_interval(days => $1) GROUP BY path) l USING (path)
       ORDER BY p.views DESC LIMIT 6`,
      [days],
    ),
    q<{ system: string; clicks: number }>(
      `SELECT coalesce(meta->>'system', 'general') AS system, count(*)::int AS clicks
         FROM events WHERE type='whatsapp' AND created_at >= now() - make_interval(days => $1)
        GROUP BY 1 ORDER BY clicks DESC LIMIT 6`,
      [days],
    ),
    q<{ status: string; n: number }>("SELECT status::text, count(*)::int AS n FROM leads GROUP BY status"),
  ]);

  const k = kpi.rows[0];
  const totalViews = series.rows.reduce((s, r) => s + r.views, 0);
  const prevViews = k.prev;
  res.json(
    ok({
      days,
      kpis: {
        today: { value: k.today, change: pct(k.today, k.yesterday) },
        period: { value: k.cur, change: pct(k.cur, prevViews) },
        whatsapp: { value: k.wa, change: k.wa - k.wa_prev },
      },
      series: series.rows,
      totalViews,
      topPages: topPages.rows,
      whatsappBySystem: whatsapp.rows,
      leads: Object.fromEntries(leads.rows.map((r) => [r.status, r.n])),
    }),
  );
});

adminRouter.get("/live", async (_req, res) => {
  const [now, perMinute, pages] = await Promise.all([
    q<{ n: number }>("SELECT count(DISTINCT session)::int AS n FROM events WHERE type='pageview' AND created_at >= now() - interval '5 minutes'"),
    q<{ m: string; n: number }>(
      `SELECT to_char(m, 'HH24:MI') AS m, count(DISTINCT e.session)::int AS n
         FROM generate_series(date_trunc('minute', now()) - interval '29 minutes', date_trunc('minute', now()), interval '1 minute') m
         LEFT JOIN events e ON e.type='pageview' AND e.created_at >= m - interval '4 minutes' AND e.created_at < m + interval '1 minute'
        GROUP BY m ORDER BY m`,
    ),
    q<{ path: string; n: number }>(
      `SELECT path, count(DISTINCT session)::int AS n FROM events
        WHERE type='pageview' AND created_at >= now() - interval '5 minutes' GROUP BY path ORDER BY n DESC LIMIT 5`,
    ),
  ]);
  res.json(ok({ now: now.rows[0].n, perMinute: perMinute.rows, pages: pages.rows }));
});

/* =========================== Leads =========================== */

adminRouter.get("/leads", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const params: unknown[] = [];
  const where: string[] = [];
  if (status && status !== "all") {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length} OR details ILIKE $${params.length})`);
  }
  const { rows } = await q(
    `SELECT id, name, phone, services, budget, details, source, status, notes, contact_method, contact_time, extra, created_at, updated_at
       FROM leads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 500`,
    params,
  );
  res.json(ok(rows));
});

adminRouter.get("/leads/export.csv", async (_req, res) => {
  const { rows } = await q<Record<string, unknown>>("SELECT created_at, name, phone, array_to_string(services, ' | ') AS services, budget, contact_method, contact_time, extra::text AS extra, status, source, details, notes FROM leads ORDER BY created_at DESC");
  const cols = ["created_at", "name", "phone", "services", "budget", "contact_method", "contact_time", "extra", "status", "source", "details", "notes"];
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const csv = "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c] instanceof Date ? (r[c] as Date).toISOString() : r[c])).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

const LeadPatch = z.object({
  status: z.enum(["new", "contacted", "demo", "won", "lost"]).optional(),
  notes: z.string().max(4000).nullable().optional(),
});

adminRouter.patch("/leads/:id", async (req, res) => {
  const id = parse(Uuid, req.params.id);
  const b = parse(LeadPatch, req.body);
  const { rows } = await q(
    `UPDATE leads SET status = coalesce($2, status), notes = CASE WHEN $3::boolean THEN $4 ELSE notes END, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, b.status ?? null, b.notes !== undefined, b.notes ?? null],
  );
  if (!rows[0]) throw new HttpError(404, "Lead not found");
  res.json(ok(rows[0]));
});

adminRouter.delete("/leads/:id", async (req, res) => {
  await q("DELETE FROM leads WHERE id = $1", [parse(Uuid, req.params.id)]);
  res.json(ok(true));
});

/* =========================== Systems =========================== */

const SpecGroup = z.tuple([z.string().min(1).max(80), z.enum(["calendar", "staff", "heart", "chart"]), z.array(z.string().min(1).max(120)).max(12)]);

const SystemBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
  category: z.enum(["sales", "services", "hospitality", "health"]),
  icon: z.enum(["supermarket", "salon", "barbershop", "gym", "pool", "hotel", "restaurant", "clinic", "pharmacy"]),
  name: z.string().min(2).max(120),
  short: z.string().min(1).max(60),
  description: z.string().min(2).max(400),
  intro: z.string().min(2).max(800),
  tags: z.array(z.string().max(40)).max(6).default([]),
  platforms: z.array(z.string().max(30)).max(5).default([]),
  specs: z.array(SpecGroup).max(8).default([]),
  demoMessage: z.string().max(300).nullable().optional(),
  featured: z.boolean().default(false),
  published: z.boolean().default(true),
  sort: z.number().int().default(0),
});

adminRouter.get("/systems", async (_req, res) => {
  const { rows } = await q<SystemRow>("SELECT * FROM systems ORDER BY sort, created_at DESC");
  res.json(ok(rows.map(mapSystem)));
});

adminRouter.post("/systems", async (req, res) => {
  const s = parse(SystemBody, req.body);
  const { rows } = await q<SystemRow>(
    `INSERT INTO systems (slug, category, icon, name, short, description, intro, tags, platforms, specs, demo_message, featured, published, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [s.slug, s.category, s.icon, s.name, s.short, s.description, s.intro, s.tags, s.platforms, JSON.stringify(s.specs), s.demoMessage ?? null, s.featured, s.published, s.sort],
  ).catch((e: { code?: string }) => {
    if (e.code === "23505") throw new HttpError(409, "A system with this slug already exists");
    throw e;
  });
  revalidateWeb(["systems"]);
  res.status(201).json(ok(mapSystem(rows[0])));
});

adminRouter.put("/systems/:slug", async (req, res) => {
  const s = parse(SystemBody, req.body);
  const { rows } = await q<SystemRow>(
    `UPDATE systems SET slug=$2, category=$3, icon=$4, name=$5, short=$6, description=$7, intro=$8, tags=$9, platforms=$10,
            specs=$11, demo_message=$12, featured=$13, published=$14, sort=$15, updated_at=now()
      WHERE slug=$1 RETURNING *`,
    [req.params.slug, s.slug, s.category, s.icon, s.name, s.short, s.description, s.intro, s.tags, s.platforms, JSON.stringify(s.specs), s.demoMessage ?? null, s.featured, s.published, s.sort],
  );
  if (!rows[0]) throw new HttpError(404, "System not found");
  revalidateWeb(["systems", `system:${req.params.slug}`, `system:${s.slug}`]);
  res.json(ok(mapSystem(rows[0])));
});

adminRouter.patch("/systems/:slug/publish", async (req, res) => {
  const { published } = parse(z.object({ published: z.boolean() }), req.body);
  const { rowCount } = await q("UPDATE systems SET published=$2, updated_at=now() WHERE slug=$1", [req.params.slug, published]);
  if (!rowCount) throw new HttpError(404, "System not found");
  revalidateWeb(["systems", `system:${req.params.slug}`]);
  res.json(ok(true));
});

adminRouter.delete("/systems/:slug", async (req, res) => {
  await q("DELETE FROM systems WHERE slug=$1", [req.params.slug]);
  revalidateWeb(["systems", `system:${req.params.slug}`]);
  res.json(ok(true));
});

/* ============ Simple collections: testimonials / faqs / team ============ */

const collections = {
  testimonials: {
    cols: ["quote", "name", "role", "project", "color", "published", "sort"],
    schema: z.object({
      quote: z.string().min(2).max(600),
      name: z.string().min(1).max(80),
      role: z.string().max(120),
      project: z.string().max(60),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      published: z.boolean().default(true),
      sort: z.number().int().default(0),
    }),
  },
  faqs: {
    cols: ["q", "a", "published", "sort"],
    schema: z.object({ q: z.string().min(2).max(300), a: z.string().min(2).max(2000), published: z.boolean().default(true), sort: z.number().int().default(0) }),
  },
  team: {
    cols: ["name", "role", "color", "photo", "sort"],
    schema: z.object({
      name: z.string().min(1).max(80),
      role: z.string().max(120),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      photo: z.string().url().max(500).nullable().optional(),
      sort: z.number().int().default(0),
    }),
  },
} as const;

for (const [table, def] of Object.entries(collections)) {
  adminRouter.get(`/${table}`, async (_req, res) => {
    const { rows } = await q(`SELECT * FROM ${table} ORDER BY sort`);
    res.json(ok(rows));
  });
  adminRouter.post(`/${table}`, async (req, res) => {
    const b = parse(def.schema, req.body) as Record<string, unknown>;
    const cols = def.cols as readonly string[];
    const { rows } = await q(
      `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
      cols.map((c) => b[c] ?? null),
    );
    revalidateWeb([table]);
    res.status(201).json(ok(rows[0]));
  });
  adminRouter.put(`/${table}/:id`, async (req, res) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(def.schema, req.body) as Record<string, unknown>;
    const cols = def.cols as readonly string[];
    const { rows } = await q(`UPDATE ${table} SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(",")} WHERE id=$1 RETURNING *`, [id, ...cols.map((c) => b[c] ?? null)]);
    if (!rows[0]) throw new HttpError(404, "Not found");
    revalidateWeb([table]);
    res.json(ok(rows[0]));
  });
  adminRouter.delete(`/${table}/:id`, async (req, res) => {
    await q(`DELETE FROM ${table} WHERE id=$1`, [parse(Uuid, req.params.id)]);
    revalidateWeb([table]);
    res.json(ok(true));
  });
}

/* =========================== Page sections =========================== */

adminRouter.get("/sections", async (_req, res) => {
  const { rows } = await q("SELECT * FROM page_sections ORDER BY page, sort");
  res.json(ok(rows));
});

const SectionPatch = z.object({
  visible: z.boolean().optional(),
  content: z.record(z.string(), z.record(z.string(), z.string().max(2000))).optional(),
});

adminRouter.patch("/sections/:page/:key", async (req, res) => {
  const b = parse(SectionPatch, req.body);
  const { rows } = await q(
    `UPDATE page_sections SET visible = coalesce($3, visible), content = coalesce($4, content), updated_at = now()
      WHERE page=$1 AND key=$2 RETURNING *`,
    [req.params.page, req.params.key, b.visible ?? null, b.content ? JSON.stringify(b.content) : null],
  );
  if (!rows[0]) throw new HttpError(404, "Section not found");
  revalidateWeb(["sections"]);
  res.json(ok(rows[0]));
});

adminRouter.put("/sections/:page/order", async (req, res) => {
  const { keys } = parse(z.object({ keys: z.array(z.string()).min(1).max(40) }), req.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [i, key] of keys.entries()) {
      await client.query("UPDATE page_sections SET sort=$3 WHERE page=$1 AND key=$2", [req.params.page, key, i]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  revalidateWeb(["sections"]);
  res.json(ok(true));
});

/* =========================== Settings =========================== */

const Settings = z.object({
  general: z.object({
    nameKu: z.string().min(1).max(80),
    nameEn: z.string().min(1).max(80),
    tagline: z.string().max(300),
    whatsapp: z.string().max(30),
    email: z.string().email().max(120),
    address: z.string().max(120),
    hours: z.string().max(120),
  }),
  whatsapp: z.object({
    defaultMessage: z.string().max(300),
    floatingButton: z.boolean(),
  }),
  appearance: z.object({
    defaultTheme: z.enum(["light", "dark", "system"]),
    allowToggle: z.boolean(),
    brand: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  location: z.object({
    label: z.string().min(1).max(80),
    address: z.string().min(1).max(200),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    zoom: z.number().int().min(3).max(19),
    showMap: z.boolean(),
  }),
});

adminRouter.get("/settings", async (_req, res) => {
  const { rows } = await q<{ key: string; value: unknown }>("SELECT key, value FROM settings");
  res.json(ok(Object.fromEntries(rows.map((r) => [r.key, r.value]))));
});

adminRouter.put("/settings", async (req, res) => {
  const s = parse(Settings, req.body);
  for (const [key, value] of Object.entries(s)) {
    await q(
      "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [key, JSON.stringify(value)],
    );
  }
  revalidateWeb(["settings"]);
  res.json(ok(s));
});
