import {
  CORS_HEADERS,
  errorResponse,
  handleClientRegistration,
} from "@/lib/mcp/oauth/service";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("invalid_request", "Corpo JSON inválido.");
  }

  return handleClientRegistration(body);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
