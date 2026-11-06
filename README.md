# Binary Group — API

Backend for the Binary Group website and admin panel.
**Node.js · Express 5 · PostgreSQL · Zod · JWT (httpOnly cookie)**

## Setup

```bash
cp .env.example .env          # then set JWT_SECRET, REVALIDATE_SECRET, ADMIN_PASSWORD
docker compose up -d          # PostgreSQL on localhost:5433
npm install
npm run db:migrate            # create / update tables
npm run db:seed               # admin user, 24 systems, content, settings
npm run dev                   # http://localhost:4000
```

| Script | |
| --- | --- |
| `npm run dev` | API with auto-reload |
| `npm run build` / `npm start` | production build / run |
| `npm run db:migrate` | apply `src/db/schema.sql` (idempotent) |
| `npm run db:seed` | seed admin + content (skips existing rows) |
| `npm run admin:password -- <email> "<password>"` | create admin or reset password |

## API

**Public**
- `GET /api/systems`, `GET /api/systems/:slug`
- `GET /api/testimonials`, `/api/faqs`, `/api/team`, `/api/sections/:page`, `/api/settings`
- `POST /api/leads` — contact form (validated, rate-limited, honeypot)
- `POST /api/track` — cookieless page-view / WhatsApp-click analytics
- `GET /health`

**Auth** — `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password`

**Admin** (requires session) — `/api/admin/stats`, `/live`, `/leads` (+ `export.csv`), `/systems`, `/testimonials`, `/faqs`, `/team`, `/sections`, `/settings`

After admin edits the API calls `POST {WEB_URL}/api/revalidate` so the website refreshes immediately.

## Production
Set `NODE_ENV=production`, a managed `DATABASE_URL`, strong `JWT_SECRET` and `REVALIDATE_SECRET`,
and `WEB_URL` / `CORS_ORIGINS` to the live site domain. Run behind HTTPS.
