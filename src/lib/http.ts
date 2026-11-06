import type { ErrorRequestHandler, Request } from "express";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Parse + validate a request part with zod; throws a 400 with field errors. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, "Validation failed", z.flattenError(r.error).fieldErrors);
  return r.data;
}

export const ok = <T>(data: T) => ({ data });

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }
  console.error(`[api] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: "Internal server error" });
};

export const clientIp = (req: Request) => (req.ip ?? req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
