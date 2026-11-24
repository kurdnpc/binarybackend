import { Router } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
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

  const [kpi, series, topPages, whatsapp, leads, sysClicks, sysTotals] = await Promise.all([
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
    // which systems visitors click on (links to /systems/<slug>), with current name/icon from the systems table
    q<{ system: string; name: string | null; icon: string | null; clicks: number; visitors: number }>(
      `SELECT e.meta->>'system' AS system, s.name, s.icon,
              count(*)::int AS clicks, count(DISTINCT e.visitor)::int AS visitors
         FROM events e LEFT JOIN systems s ON s.slug = e.meta->>'system'
        WHERE e.type='system_click' AND e.meta->>'system' IS NOT NULL AND e.created_at >= now() - make_interval(days => $1)
        GROUP BY 1, 2, 3 ORDER BY clicks DESC LIMIT 12`,
      [days],
    ),
    q<{ cur: number; prev: number }>(
      `SELECT count(*) FILTER (WHERE created_at >= now() - make_interval(days => $1))::int AS cur,
              count(*) FILTER (WHERE created_at < now() - make_interval(days => $1))::int AS prev
         FROM events WHERE type='system_click' AND created_at >= now() - make_interval(days => $1 * 2)`,
      [days],
    ),
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
      systemClicks: { total: sysTotals.rows[0].cur, change: pct(sysTotals.rows[0].cur, sysTotals.rows[0].prev), bySystem: sysClicks.rows },
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

/* ---------- Systems import (JSON / CSV converted in the browser) ---------- */

const ImportSystem = SystemBody.extend({ createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional() });
type ImportSystemT = z.infer<typeof ImportSystem>;
const COMPARED = ["category", "icon", "name", "short", "description", "intro", "tags", "platforms", "specs", "demoMessage", "featured", "published", "sort"] as const;

const issuesOf = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "row"}: ${i.message}`);

type SystemsPlan = {
  created: string[];
  updated: { slug: string; fields: string[] }[];
  unchanged: string[];
  errors: { row: number; slug?: string; issues: string[] }[];
  valid: ImportSystemT[];
};

/** Validate every row and compare with what is stored (matched by slug). Systems not in the file are kept. */
async function planSystems(rows: unknown[]): Promise<SystemsPlan> {
  const { rows: existing } = await q<SystemRow>("SELECT * FROM systems");
  const bySlug = new Map(existing.map((r) => [r.slug, mapSystem(r)]));
  const plan: SystemsPlan = { created: [], updated: [], unchanged: [], errors: [], valid: [] };
  const seen = new Set<string>();
  rows.forEach((raw, i) => {
    const r = ImportSystem.safeParse(raw);
    const slug = typeof (raw as { slug?: unknown })?.slug === "string" ? (raw as { slug: string }).slug : undefined;
    if (!r.success) return void plan.errors.push({ row: i + 1, slug, issues: issuesOf(r.error) });
    const s = { ...r.data, demoMessage: r.data.demoMessage?.trim() || null };
    if (seen.has(s.slug)) return void plan.errors.push({ row: i + 1, slug: s.slug, issues: ["slug: duplicated in the file"] });
    seen.add(s.slug);
    plan.valid.push(s);
    const cur = bySlug.get(s.slug);
    if (!cur) return void plan.created.push(s.slug);
    const fields = COMPARED.filter((f) => JSON.stringify(cur[f] ?? null) !== JSON.stringify(s[f] ?? null));
    if (fields.length) plan.updated.push({ slug: s.slug, fields: [...fields] });
    else plan.unchanged.push(s.slug);
  });
  return plan;
}

async function applySystems(client: PoolClient, list: ImportSystemT[]) {
  for (const s of list) {
    await client.query(
      `INSERT INTO systems (slug, category, icon, name, short, description, intro, tags, platforms, specs, demo_message, featured, published, sort, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, coalesce($15::timestamptz, now()))
       ON CONFLICT (slug) DO UPDATE SET category=EXCLUDED.category, icon=EXCLUDED.icon, name=EXCLUDED.name, short=EXCLUDED.short,
         description=EXCLUDED.description, intro=EXCLUDED.intro, tags=EXCLUDED.tags, platforms=EXCLUDED.platforms, specs=EXCLUDED.specs,
         demo_message=EXCLUDED.demo_message, featured=EXCLUDED.featured, published=EXCLUDED.published, sort=EXCLUDED.sort, updated_at=now()`,
      [s.slug, s.category, s.icon, s.name, s.short, s.description, s.intro, s.tags, s.platforms, JSON.stringify(s.specs), s.demoMessage ?? null, s.featured, s.published, s.sort, s.createdAt ?? null],
    );
  }
}

async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const ImportBody = z.object({ systems: z.array(z.unknown()).min(1).max(500), dryRun: z.boolean().default(true) });

/** dryRun=true → preview only. dryRun=false → valid rows are upserted in one transaction (rows with errors are skipped). */
adminRouter.post("/systems/import", async (req, res) => {
  const b = parse(ImportBody, req.body);
  const { valid, ...summary } = await planSystems(b.systems);
  let applied = false;
  if (!b.dryRun && valid.length) {
    await inTransaction((c) => applySystems(c, valid));
    revalidateWeb(["systems", ...valid.map((s) => `system:${s.slug}`)]);
    applied = true;
  }
  res.json(ok({ ...summary, applied }));
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

// Section text per language: { ckb: { title: "…", tags: ["…"], items: [{ title: "…", tags: ["…"] }] } }
const Text = z.string().max(4000);
const TextList = z.array(z.string().max(300)).max(40);
const ContentValue = z.union([Text, TextList, z.array(z.record(z.string().max(40), z.union([Text, TextList]))).max(40)]);

const SectionPatch = z.object({
  visible: z.boolean().optional(),
  content: z
    .record(z.string().max(10), z.record(z.string().max(40), ContentValue))
    .refine((c) => JSON.stringify(c).length < 150_000, "Content too large")
    .optional(),
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

/* =========================== Page meta (browser tab title + description) =========================== */

const PAGE_KEYS = ["home", "services", "systems", "about", "contact"] as const;
const PageMeta = z.object({ title: z.string().trim().max(80), description: z.string().trim().max(300) });

adminRouter.put("/pages/:page/meta", async (req, res) => {
  const page = parse(z.enum(PAGE_KEYS), req.params.page);
  const meta = parse(PageMeta, req.body);
  const { rows } = await q<{ value: unknown }>(
    `INSERT INTO settings (key, value, updated_at) VALUES ('pages', jsonb_build_object($1::text, $2::jsonb), now())
     ON CONFLICT (key) DO UPDATE SET value = settings.value || jsonb_build_object($1::text, $2::jsonb), updated_at = now()
     RETURNING value`,
    [page, JSON.stringify(meta)],
  );
  revalidateWeb(["settings"]);
  res.json(ok(rows[0].value));
});

/* =========================== Settings =========================== */

const SocialUrl = z.string().trim().max(300).refine((v) => v === "" || /^https:\/\/[^\s]+$/i.test(v), "must be empty or start with https://").default("");

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
  // social profile links (empty = hidden on the website)
  social: z
    .object({ instagram: SocialUrl, facebook: SocialUrl, linkedin: SocialUrl, tiktok: SocialUrl, youtube: SocialUrl, x: SocialUrl })
    .optional(),
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

/* =========================== Whole-site backup / restore =========================== */
// Content only: systems, page sections, testimonials, FAQ, team, settings. Never leads, admins or analytics.

const BACKUP_TYPE = "binary-group/backup";
const COLLECTIONS = ["testimonials", "faqs", "team"] as const;
const PARTS = ["systems", "sections", "testimonials", "faqs", "team", "settings"] as const;
type Part = (typeof PARTS)[number];

adminRouter.get("/backup", async (_req, res) => {
  const [systems, sections, testimonials, faqs, team, settings] = await Promise.all([
    q<SystemRow>("SELECT * FROM systems ORDER BY sort, created_at DESC"),
    q("SELECT page, key, title, subtitle, visible, sort, content FROM page_sections ORDER BY page, sort"),
    q("SELECT * FROM testimonials ORDER BY sort"),
    q("SELECT * FROM faqs ORDER BY sort"),
    q("SELECT * FROM team ORDER BY sort"),
    q<{ key: string; value: unknown }>("SELECT key, value FROM settings ORDER BY key"),
  ]);
  res.setHeader("Content-Disposition", `attachment; filename="binary-group-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    type: BACKUP_TYPE,
    version: 1,
    exportedAt: new Date().toISOString(),
    systems: systems.rows.map((r) => {
      const { updatedAt: _u, ...rest } = mapSystem(r);
      return rest;
    }),
    sections: sections.rows,
    testimonials: testimonials.rows,
    faqs: faqs.rows,
    team: team.rows,
    settings: Object.fromEntries(settings.rows.map((r) => [r.key, r.value])),
  });
});

const BackupSection = z.object({
  page: z.string().min(1).max(40),
  key: z.string().min(1).max(40),
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).nullable().optional(),
  visible: z.boolean(),
  sort: z.number().int(),
  content: z.record(z.string().max(10), z.record(z.string().max(40), ContentValue)),
});
const PagesMeta = z.record(z.enum(PAGE_KEYS), PageMeta);
const BackupSettings = Settings.partial().extend({ pages: PagesMeta.optional() });

const RestoreBody = z.object({
  backup: z.object({ type: z.literal(BACKUP_TYPE), version: z.literal(1) }).passthrough(),
  parts: z.array(z.enum(PARTS)).min(1),
  dryRun: z.boolean().default(true),
});

type PartReport = { count: number; errors: string[]; note?: string; plan?: Omit<SystemsPlan, "valid"> };

/** Validate the chosen parts; dryRun=false applies them in ONE transaction (any invalid part blocks the restore). */
adminRouter.post("/backup/restore", async (req, res) => {
  const { backup, parts, dryRun } = parse(RestoreBody, req.body);
  const data = backup as Record<string, unknown>;
  const report: Partial<Record<Part, PartReport>> = {};
  const apply: ((c: PoolClient) => Promise<void>)[] = [];
  const arr = (k: string) => (Array.isArray(data[k]) ? (data[k] as unknown[]) : null);

  for (const part of parts) {
    if (part === "systems") {
      const list = arr("systems");
      if (!list) { report.systems = { count: 0, errors: ["missing"] }; continue; }
      const { valid, ...plan } = await planSystems(list);
      report.systems = { count: valid.length, errors: plan.errors.map((e) => `#${e.row} ${e.slug ?? ""} — ${e.issues.join("; ")}`), plan, note: "merge by slug — systems not in the file are kept" };
      apply.push((c) => applySystems(c, valid));
    } else if (part === "sections") {
      const r = z.array(BackupSection).max(200).safeParse(data.sections);
      if (!r.success) { report.sections = { count: 0, errors: issuesOf(r.error).slice(0, 20) }; continue; }
      report.sections = { count: r.data.length, errors: [], note: "text, visibility and order of each section" };
      apply.push(async (c) => {
        for (const s of r.data) {
          await c.query(
            `INSERT INTO page_sections (page, key, title, subtitle, visible, sort, content, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now())
             ON CONFLICT (page, key) DO UPDATE SET title=EXCLUDED.title, subtitle=EXCLUDED.subtitle, visible=EXCLUDED.visible, sort=EXCLUDED.sort, content=EXCLUDED.content, updated_at=now()`,
            [s.page, s.key, s.title, s.subtitle ?? null, s.visible, s.sort, JSON.stringify(s.content)],
          );
        }
      });
    } else if (part === "settings") {
      const r = BackupSettings.safeParse(data.settings);
      if (!r.success) { report.settings = { count: 0, errors: issuesOf(r.error).slice(0, 20) }; continue; }
      const entries = Object.entries(r.data).filter(([, v]) => v !== undefined);
      report.settings = { count: entries.length, errors: [] };
      apply.push(async (c) => {
        for (const [key, value] of entries) {
          await c.query(
            "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            [key, JSON.stringify(value)],
          );
        }
      });
    } else {
      const table = part;
      const def = collections[table];
      const r = z.array(def.schema.extend({ id: Uuid.optional() })).max(200).safeParse(data[table]);
      if (!r.success) { report[table] = { count: 0, errors: issuesOf(r.error).slice(0, 20) }; continue; }
      report[table] = { count: r.data.length, errors: [], note: "replaces the current list" };
      apply.push(async (c) => {
        await c.query(`DELETE FROM ${table}`);
        const cols = def.cols as readonly string[];
        for (const row of r.data as Record<string, unknown>[]) {
          await c.query(
            `INSERT INTO ${table} (id, ${cols.join(",")}) VALUES (coalesce($1::uuid, gen_random_uuid()), ${cols.map((_, i) => `$${i + 2}`).join(",")})`,
            [row.id ?? null, ...cols.map((k) => row[k] ?? null)],
          );
        }
      });
    }
  }

  // systems rows with errors are skipped; any other part with errors blocks the restore
  const blocking = Object.entries(report).filter(([k, v]) => k !== "systems" && v.errors.length);
  let applied = false;
  if (!dryRun) {
    if (blocking.length) throw new HttpError(400, "Backup has invalid parts", Object.fromEntries(blocking.map(([k, v]) => [k, v.errors])));
    await inTransaction(async (c) => {
      for (const fn of apply) await fn(c);
    });
    revalidateWeb(["systems", "sections", "settings", "testimonials", "faqs", "team"]);
    applied = true;
  }
  res.json(ok({ report, applied }));
});

/* =========================== Dynamic QR codes =========================== */

const QrCode = z.string().regex(/^[a-z0-9-]{2,40}$/, "a-z, 0-9 and - only (2–40)");
// internal path ("/systems/salon", "/services#web") or an external https link — never "//host" or javascript:
const QrTarget = z
  .string()
  .trim()
  .max(500)
  .refine((t) => (t.startsWith("/") && !t.startsWith("//") && !t.includes("\\")) || /^https:\/\/[^\s/$.?#][^\s]*$/i.test(t), "must start with / or https://");
const QrBody = z.object({ code: QrCode, label: z.string().trim().min(1).max(80), target: QrTarget, active: z.boolean().default(true) });

adminRouter.get("/qr", async (_req, res) => {
  const { rows } = await q(
    `SELECT l.code, l.label, l.target, l.active, l.created_at, l.updated_at,
            coalesce((SELECT sum(scans) FROM qr_scans s WHERE s.code = l.code), 0)::int AS total,
            coalesce((SELECT sum(scans) FROM qr_scans s WHERE s.code = l.code AND s.day >= (now() AT TIME ZONE 'Asia/Baghdad')::date - 6), 0)::int AS week,
            (SELECT json_agg(json_build_object('day', to_char(d, 'YYYY-MM-DD'), 'scans', coalesce(s.scans, 0)) ORDER BY d)
               FROM generate_series((now() AT TIME ZONE 'Asia/Baghdad')::date - 29, (now() AT TIME ZONE 'Asia/Baghdad')::date, interval '1 day') d
               LEFT JOIN qr_scans s ON s.code = l.code AND s.day = d::date) AS series
       FROM qr_links l
      ORDER BY (l.code = 'main') DESC, l.created_at`,
  );
  res.json(ok(rows));
});

adminRouter.post("/qr", async (req, res) => {
  const b = parse(QrBody, req.body);
  const { rows } = await q("INSERT INTO qr_links (code, label, target, active) VALUES ($1,$2,$3,$4) RETURNING *", [b.code, b.label, b.target, b.active]).catch(
    (e: { code?: string }) => {
      if (e.code === "23505") throw new HttpError(409, "This code already exists");
      throw e;
    },
  );
  res.status(201).json(ok(rows[0]));
});

adminRouter.put("/qr/:code", async (req, res) => {
  const b = parse(QrBody, req.body);
  const old = String(req.params.code);
  // the main code backs /redirect — its name is fixed
  if (old === "main" && b.code !== "main") throw new HttpError(400, "The main code cannot be renamed");
  const { rows } = await q(
    "UPDATE qr_links SET code=$2, label=$3, target=$4, active=$5, updated_at=now() WHERE code=$1 RETURNING *",
    [old, b.code, b.label, b.target, b.active],
  ).catch((e: { code?: string }) => {
    if (e.code === "23505") throw new HttpError(409, "This code already exists");
    throw e;
  });
  if (!rows[0]) throw new HttpError(404, "QR code not found");
  res.json(ok(rows[0]));
});

adminRouter.delete("/qr/:code", async (req, res) => {
  if (req.params.code === "main") throw new HttpError(400, "The main code cannot be deleted");
  await q("DELETE FROM qr_links WHERE code=$1", [req.params.code]);
  res.json(ok(true));
});
