/**
 * Endpoint MCP público para conexão com ChatGPT (/mcp).
 *
 * Utiliza transporte Streamable HTTP (WebStandardStreamableHTTPServerTransport)
 * compatível com a especificação moderna de MCP consumida pelo ChatGPT.
 *
 * Autenticação via Bearer token (tabela api_tokens).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { chaveDaRequisicao } from "@/lib/api/idempotency";
import { ensureResource, McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { createChatGptMcpServer } from "@/lib/mcp/chatgpt/server";
import { resolveOrigin } from "@/lib/mcp/oauth/origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Idempotency-Key, X-Request-Id, Accept",
  "Access-Control-Expose-Headers": "X-Request-Id, WWW-Authenticate",
};

function jsonRpcError(
  code: number,
  message: string,
  status: number,
  origin?: string,
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...CORS_HEADERS,
  };

  if (status === 401 && origin) {
    headers["WWW-Authenticate"] =
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
  }

  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers,
    },
  );
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const origin = resolveOrigin(req);
  let auth;

  try {
    auth = await validateBearerToken(req.headers.get("authorization"));
    ensureResource(auth.scopes, `${origin}/mcp`);
  } catch (err) {
    if (err instanceof McpAuthError) {
      return jsonRpcError(err.mcpCode, err.message, err.httpStatus, origin);
    }
    const msg = err instanceof Error ? err.message : "auth_failed";
    return jsonRpcError(-32603, msg, 500, origin);
  }

  const idempotencyKey = chaveDaRequisicao(req);
  if (idempotencyKey !== null && !z.string().uuid().safeParse(idempotencyKey).success) {
    return jsonRpcError(-32602, "Idempotency-Key deve ser UUID", 400);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({});
  const server = createChatGptMcpServer(
    auth,
    requestId,
    idempotencyKey ?? undefined,
  );

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(req as unknown as Request);
    response.headers.set("X-Request-Id", requestId);
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      response.headers.set(k, v);
    }
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "transport_error";
    return jsonRpcError(-32603, msg, 500);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
