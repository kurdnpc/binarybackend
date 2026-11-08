import bcrypt from "bcryptjs";
import systems from "./data/systems.json" with { type: "json" };
import { config } from "../config.js";
import { pool } from "./pool.js";

const withDemoAnalytics = process.argv.includes("--demo-analytics");

async function seedAdmin() {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
    console.warn("ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin user");
    return;
  }
  const hash = await bcrypt.hash(config.ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO admins (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    [config.ADMIN_EMAIL.toLowerCase(), config.ADMIN_NAME ?? "Admin", hash],
  );
  console.log(`admin: ${config.ADMIN_EMAIL}`);
}

async function seedSystems() {
  for (const [i, s] of (systems as Array<Record<string, unknown>>).entries()) {
    await pool.query(
      `INSERT INTO systems (slug, category, icon, name, short, description, intro, tags, platforms, specs, featured, published, sort, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13)
       ON CONFLICT (slug) DO NOTHING`,
      [s.slug, s.category, s.icon, s.name, s.short, s.description, s.intro, s.tags, s.platforms, JSON.stringify(s.specs), s.featured, i, s.createdAt],
    );
  }
  console.log(`systems: ${systems.length}`);
}

async function seedIfEmpty(table: string, cols: string[], rows: unknown[][]) {
  const { rows: c } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  if (c[0].n > 0) return;
  for (const r of rows) {
    await pool.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, r);
  }
  console.log(`${table}: ${rows.length}`);
}

async function seedContent() {
  await seedIfEmpty("testimonials", ["quote", "name", "role", "project", "color", "sort"], [
    ["«سیستەمەکە هەموو ڕۆژێک لە فرۆشگاکەماندا کار دەکات. کاشێرەکان لە یەک ڕۆژدا فێری بوون.»", "ئاراس محەمەد", "خاوەنی مارکێتی ئازادی", "POS System", "#2563eb", 0],
    ["«ئەپەکە پێش کاتی دیاریکراو تەواو بوو و دیزاینەکەی لە هەموو چاوەڕوانییەکمان باشتر بوو.»", "شیلان عومەر", "دامەزرێنەری دیاری", "Dyare", "#db2777", 1],
    ["«هەموو هەفتەیەک پێشکەوتنەکەیان نیشان دەداین. ئەزموونێکی پرۆفیشناڵ بوو لە سەرەتاوە.»", "ڕێباز کەریم", "بەڕێوەبەری IQ Home", "IQ Home", "#0e9f6e", 2],
  ]);
  await seedIfEmpty("faqs", ["q", "a", "sort"], [
    ["دروستکردنی ماڵپەڕ یان ئەپێک چەند کاتی پێویستە؟", "بەپێی قەبارەی پرۆژەکە دەگۆڕێت. ماڵپەڕێکی ناساندن نزیکەی 2 بۆ 4 هەفتە، ئەپ یان سیستەمێکی تەواو 6 بۆ 12 هەفتە.", 0],
    ["نرخی پرۆژەکان چۆن دیاری دەکرێت؟", "دوای کۆبوونەوەی یەکەم و تێگەیشتن لە پێداویستییەکانت، نرخێکی ڕوون و جێگیر پێشکەش دەکەین. پارەدان بە قۆناغ دەبێت، بەپێی پێشکەوتنی کارەکە.", 1],
    ["دوای بڵاوکردنەوە پشتگیری دەکەن؟", "بەڵێ. هەموو پرۆژەیەک ماوەی پشتگیری بێبەرامبەری هەیە، و دواتر دەتوانیت پاکێجی چاودێری و نوێکردنەوەی مانگانە وەربگریت.", 2],
    ["دەتوانن پرۆژەیەکی ئێستام پەرە پێبدەن؟", "بەڵێ. سەرەتا کۆد و سیستەمەکەت هەڵدەسەنگێنین، پاشان پلانێک بۆ باشترکردن، زیادکردنی تایبەتمەندی یان گواستنەوە بۆ تەکنەلۆژیای نوێ دادەنێین.", 3],
    ["ماڵپەڕەکە بە چەند زمان دەبێت؟", "بە هەر زمانێک کە پێویستت بێت. زۆربەی پرۆژەکانمان بە کوردی، عەرەبی و ئینگلیزین، لەگەڵ پاڵپشتی تەواوی ڕاست بۆ چەپ (RTL).", 4],
  ]);
  await seedIfEmpty("team", ["name", "role", "color", "sort"], [
    ["ناوی ئەندام", "دامەزرێنەر و گەشەپێدەری سەرەکی", "#2563eb", 0],
    ["ناوی ئەندام", "دیزاینەری UX / UI", "#0e9f6e", 1],
    ["ناوی ئەندام", "گەشەپێدەری مۆبایل", "#db2777", 2],
    ["ناوی ئەندام", "گەشەپێدەری باکئێند", "#7c3aed", 3],
  ]);

  const sections: [string, string, string, string, boolean][] = [
    ["home", "hero", "سەرەتا (Hero)", "ناونیشان، دوگمەکان و نامێرەکان", true],
    ["home", "principles", "بنەماکانمان", "5 کارت", true],
    ["home", "services", "خزمەتگوزارییەکان", "7 خزمەتگوزاری", true],
    ["home", "systems", "سیستەمەکان", "5 سیستەم", true],
    ["home", "testimonials", "ڕای کڕیاران", "3 ڕا", true],
    ["home", "cta", "بانگهێشت (CTA)", "دوگمەی واتسئەپ", true],
    ["services", "rows", "خزمەتگوزارییەکان", "8 خزمەتگوزاری", true],
    ["services", "tech", "ئامرازەکانی کارمان", "6 گروپ", true],
    ["services", "process", "شێوازی کارکردن", "4 هەنگاو", true],
    ["services", "faq", "پرسیارە باوەکان", "5 پرسیار", true],
    ["services", "cta", "بانگهێشت (CTA)", "", true],
    ["about", "story", "چیرۆکەکەمان", "ژمارەکان", true],
    ["about", "values", "بەهاکانمان", "4 بەها", true],
    ["about", "team", "تیمەکە", "ئەندامانی تیم", true],
    ["about", "cta", "بانگهێشت (CTA)", "", true],
    ["contact", "form", "فۆرمی پەیوەندی", "", true],
    ["contact", "channels", "ڕاستەوخۆ", "واتسئەپ، ئیمەیڵ، ناونیشان", true],
    ["contact", "map", "نەخشە", "", true],
    ["contact", "faq", "پرسیارە باوەکان", "", true],
  ];
  const heroContent = {
    ckb: {
      title: "سیستەمێکت بۆ دروست دەکەین کە بزنسەکەت گەورەتر دەکات.",
      subtitle: "باینەری گروپ، بە نوێترین تەکنەلۆژیا ماڵپەڕ، وێبسایت، ئەپڵیکەیشنی مۆبایل (Android و iOS) و سیستەمی بەڕێوەبردنی داتابەیس دروست دەکات. لە دیزاین و براندینگ تا پەرەپێدان، هۆستینگ و بڵاوکردنەوە هەروەها لە App Store و Google Play، لەگەڵتانین بۆ گەیاندنی پرۆژەکانتان بە باشترین کوالیتی.",
      primary: "پرۆژەیەک دەست پێبکە",
      secondary: "سیستەمەکان ببینە",
    },
    en: { badge: "", title: "", subtitle: "", primary: "", secondary: "" },
    ar: { badge: "", title: "", subtitle: "", primary: "", secondary: "" },
  };
  const order: Record<string, number> = {};
  for (const [page, key, title, subtitle, visible] of sections) {
    order[page] = (order[page] ?? -1) + 1;
    await pool.query(
      `INSERT INTO page_sections (page, key, title, subtitle, visible, sort, content) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (page, key) DO NOTHING`,
      [page, key, title, subtitle, visible, order[page], JSON.stringify(page === "home" && key === "hero" ? heroContent : {})],
    );
  }

  const settings = {
    general: {
      nameKu: "باینەری گروپ",
      nameEn: "Binary Group",
      tagline: "ماڵپەڕ، ئەپ و سیستەم دیزاین و دروست دەکەین — لە سلێمانییەوە بۆ هەموو کوردستان و عێراق.",
      whatsapp: "0750 000 0000",
      email: "hello@binarygroup.dev",
      address: "سلێمانی، هەرێمی کوردستان",
      hours: "شەممە – پێنجشەممە، 9 – 5",
    },
    whatsapp: { defaultMessage: "سڵاو، پرۆژەیەکم هەیە", floatingButton: false },
    appearance: { defaultTheme: "light", allowToggle: true, brand: "#2563eb" },
    location: { label: "باینەری گروپ", address: "سلێمانی، هەرێمی کوردستان", lat: 35.5613, lng: 45.4373, zoom: 15, showMap: true },
  };
  for (const [key, value] of Object.entries(settings)) {
    await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, JSON.stringify(value)]);
  }
  console.log("sections + settings");
}

/** Optional: generate 30 days of clearly-synthetic analytics so the dashboard can be previewed locally. */
async function seedDemoAnalytics() {
  await pool.query("DELETE FROM events WHERE meta->>'demo' = 'true'");
  const paths = ["/", "/systems", "/systems/salon", "/services", "/contact", "/about", "/systems/gym", "/systems/clinic"];
  const weights = [40, 18, 10, 12, 8, 6, 3, 3];
  const pick = () => {
    let r = Math.random() * 100;
    for (const [i, w] of weights.entries()) if ((r -= w) <= 0) return paths[i];
    return "/";
  };
  const systemsForWa = ["salon", "barbershop", "supermarket", "gym", "clinic"];
  const rows: unknown[][] = [];
  for (let d = 29; d >= 0; d--) {
    const visitors = Math.round(380 + (29 - d) * 9 + Math.random() * 120);
    for (let v = 0; v < visitors; v++) {
      const visitor = `demo-${d}-${v}`;
      const session = `s-${d}-${v}`;
      const pages = 1 + Math.floor(Math.random() * 3);
      for (let p = 0; p < pages; p++) {
        const at = new Date(Date.now() - d * 86400000 - Math.random() * 86400000 * (d === 0 ? 0.3 : 1));
        const path = pick();
        rows.push(["pageview", path, visitor, session, at, null]);
        rows.push(["leave", path, visitor, session, at, 30 + Math.floor(Math.random() * 180)]);
      }
      if (Math.random() < 0.012) {
        rows.push(["whatsapp", "/systems", visitor, session, new Date(Date.now() - d * 86400000), null, systemsForWa[Math.floor(Math.random() * systemsForWa.length)]]);
      }
    }
  }
  const chunk = 1000;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const values: unknown[] = [];
    const sql = part
      .map((r, j) => {
        const [type, path, visitor, session, at, dur, system] = r as [string, string, string, string, Date, number | null, string | undefined];
        values.push(type, path, visitor, session, at, dur, JSON.stringify(system ? { demo: "true", system } : { demo: "true" }));
        const b = j * 7;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
      })
      .join(",");
    await pool.query(`INSERT INTO events (type, path, visitor, session, created_at, duration_s, meta) VALUES ${sql}`, values);
  }
  console.log(`demo analytics: ${rows.length} synthetic events (meta.demo = true)`);
}

await seedAdmin();
await seedSystems();
await seedContent();
if (withDemoAnalytics) await seedDemoAnalytics();
await pool.end();
console.log("seed complete");
