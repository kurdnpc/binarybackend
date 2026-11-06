-- Binary Group database schema (idempotent; safe to re-run)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'admin',
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

DO $$ BEGIN
  CREATE TYPE lead_status AS ENUM ('new', 'contacted', 'demo', 'won', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS leads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  phone      text NOT NULL,
  services   text[] NOT NULL DEFAULT '{}',
  budget     text,
  details    text,
  source     text NOT NULL DEFAULT 'contact',
  status     lead_status NOT NULL DEFAULT 'new',
  notes      text,
  ip_hash    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_method text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_time text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status);

CREATE TABLE IF NOT EXISTS systems (
  slug        text PRIMARY KEY,
  category    text NOT NULL CHECK (category IN ('sales', 'services', 'hospitality', 'health')),
  icon        text NOT NULL,
  name        text NOT NULL,
  short       text NOT NULL,
  description text NOT NULL,
  intro       text NOT NULL,
  tags        text[] NOT NULL DEFAULT '{}',
  platforms   text[] NOT NULL DEFAULT '{}',
  specs       jsonb NOT NULL DEFAULT '[]',
  demo_message text,
  featured    boolean NOT NULL DEFAULT false,
  published   boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS systems_published_idx ON systems (published, sort);

CREATE TABLE IF NOT EXISTS testimonials (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote     text NOT NULL,
  name      text NOT NULL,
  role      text NOT NULL,
  project   text NOT NULL,
  color     text NOT NULL DEFAULT '#2563eb',
  published boolean NOT NULL DEFAULT true,
  sort      int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS faqs (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  q         text NOT NULL,
  a         text NOT NULL,
  published boolean NOT NULL DEFAULT true,
  sort      int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS team (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name  text NOT NULL,
  role  text NOT NULL,
  color text NOT NULL DEFAULT '#2563eb',
  photo text,
  sort  int NOT NULL DEFAULT 0
);

-- Page sections shown in the admin "Pages & content" screen.
-- `content` holds editable fields per language: { "ckb": {...}, "en": {...}, "ar": {...} }
CREATE TABLE IF NOT EXISTS page_sections (
  page       text NOT NULL,
  key        text NOT NULL,
  title      text NOT NULL,
  subtitle   text,
  visible    boolean NOT NULL DEFAULT true,
  sort       int NOT NULL DEFAULT 0,
  content    jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page, key)
);

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- First-party, cookieless analytics (no personal data; visitor id is a daily-rotating hash).
CREATE TABLE IF NOT EXISTS events (
  id         bigserial PRIMARY KEY,
  type       text NOT NULL CHECK (type IN ('pageview', 'leave', 'whatsapp')),
  path       text NOT NULL,
  visitor    text NOT NULL,
  session    text NOT NULL,
  ref        text,
  meta       jsonb,
  duration_s int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at DESC);
CREATE INDEX IF NOT EXISTS events_type_created_idx ON events (type, created_at DESC);
