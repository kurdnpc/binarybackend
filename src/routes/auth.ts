import bcrypt from "bcryptjs";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { q } from "../db/pool.js";
import { clearSessionCookie, requireAdmin, setSessionCookie, signSession } from "../lib/auth.js";
import { HttpError, ok, parse } from "../lib/http.js";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many login attempts, try again later" },
});

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
  remember: z.boolean().default(false),
});

// constant-time-ish failure path so unknown emails don't respond faster
const DUMMY_HASH = bcrypt.hashSync("binary-group-dummy", 10);

authRouter.post("/login", loginLimiter, async (req, res) => {
  const { email, password, remember } = parse(LoginBody, req.body);
  const { rows } = await q<{ id: string; email: string; name: string; role: string; password_hash: string }>(
    "SELECT id, email, name, role, password_hash FROM admins WHERE email = $1",
    [email],
  );
  const admin = rows[0];
  const valid = await bcrypt.compare(password, admin?.password_hash ?? DUMMY_HASH);
  if (!admin || !valid) throw new HttpError(401, "Invalid email or password");

  await q("UPDATE admins SET last_login_at = now() WHERE id = $1", [admin.id]);
  const claims = { sub: admin.id, email: admin.email, name: admin.name, role: admin.role };
  const { token, maxAge } = signSession(claims, remember);
  setSessionCookie(res, token, maxAge);
  res.json(ok({ admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } }));
});

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json(ok(true));
});

authRouter.get("/me", requireAdmin, (req, res) => {
  const a = req.admin!;
  res.json(ok({ id: a.sub, email: a.email, name: a.name, role: a.role }));
});

const PasswordBody = z.object({ current: z.string().min(1), next: z.string().min(10).max(200) });

authRouter.post("/password", requireAdmin, async (req, res) => {
  const { current, next } = parse(PasswordBody, req.body);
  const { rows } = await q<{ password_hash: string }>("SELECT password_hash FROM admins WHERE id = $1", [req.admin!.sub]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password_hash))) throw new HttpError(400, "Current password is wrong");
  await q("UPDATE admins SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(next, 12), req.admin!.sub]);
  res.json(ok(true));
});
