import { env } from "@/lib/env";

/**
 * Resolve a origem canônica do servidor para a requisição atual.
 * Prioriza headers de proxy reverso (Traefik / Cloudflare / Hostinger)
 * e recai sobre NEXT_PUBLIC_APP_URL.
 */
export function resolveOrigin(req?: Request): string {
  if (req) {
    const proto =
      req.headers.get("x-forwarded-proto") ||
      (req.url.startsWith("https://") ? "https" : "http");
    const host =
      req.headers.get("x-forwarded-host") ||
      req.headers.get("host");

    if (host) {
      return `${proto}://${host}`.replace(/\/$/, "");
    }
  }

  const configured = env.NEXT_PUBLIC_APP_URL;
  if (configured && configured.startsWith("http")) {
    return configured.replace(/\/$/, "");
  }

  return "https://crm.fluxalvo.com";
}
