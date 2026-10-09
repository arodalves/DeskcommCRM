import {
  CORS_HEADERS,
  errorResponse,
  handleRevocationRequest,
} from "@/lib/mcp/oauth/service";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const contentType = req.headers.get("content-type") || "";
  const params: Record<string, string> = {};

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const searchParams = new URLSearchParams(text);
    for (const [key, value] of searchParams.entries()) {
      params[key] = value;
    }
  } else if (contentType.includes("application/json")) {
    try {
      const json = await req.json();
      if (json && typeof json === "object") {
        for (const [key, value] of Object.entries(json)) {
          if (typeof value === "string") {
            params[key] = value;
          }
        }
      }
    } catch {
      return errorResponse("invalid_request", "Corpo JSON inválido.");
    }
  } else {
    for (const [key, value] of req.nextUrl.searchParams.entries()) {
      params[key] = value;
    }
  }

  return handleRevocationRequest(params);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
