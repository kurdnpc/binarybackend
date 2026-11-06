import { config } from "../config.js";

/** Tell the Next.js site to refresh cached content right after an admin edit (fire-and-forget). */
export function revalidateWeb(tags: string[] = ["content"]) {
  if (!config.REVALIDATE_SECRET) return;
  fetch(`${config.WEB_URL}/api/revalidate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-revalidate-secret": config.REVALIDATE_SECRET },
    body: JSON.stringify({ tags }),
    signal: AbortSignal.timeout(3000),
  }).catch((e) => console.warn("[revalidate] failed:", (e as Error).message));
}
