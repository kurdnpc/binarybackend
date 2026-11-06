import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { HttpError } from "./http.js";

export const AUTH_COOKIE = "bg_admin";

export type AdminClaims = { sub: string; email: string; name: string; role: string };

declare module "express-serve-static-core" {
  interface Request {
    admin?: AdminClaims;
  }
}

export function signSession(claims: AdminClaims, remember: boolean) {
  const maxAge = remember ? 30 * 24 * 3600 : 12 * 3600;
  const token = jwt.sign(claims, config.JWT_SECRET, { expiresIn: maxAge, issuer: "binary-group" });
  return { token, maxAge };
}

export function setSessionCookie(res: Response, token: string, maxAgeS: number) {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeS * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(AUTH_COOKIE, { path: "/" });
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = req.cookies?.[AUTH_COOKIE] ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
  if (!token) throw new HttpError(401, "Not authenticated");
  try {
    req.admin = jwt.verify(token, config.JWT_SECRET, { issuer: "binary-group" }) as AdminClaims;
    next();
  } catch {
    throw new HttpError(401, "Session expired");
  }
}
