import { resolveOrigin } from "@/lib/mcp/oauth/origin";
import {
  CORS_HEADERS,
  getProtectedResourceMetadata,
  jsonResponse,
} from "@/lib/mcp/oauth/service";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const origin = resolveOrigin(req);
  const metadata = getProtectedResourceMetadata(origin);
  return jsonResponse(metadata, 200, {
    "Cache-Control": "public, max-age=3600",
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
