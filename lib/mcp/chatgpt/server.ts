/**
 * Servidor MCP dedicado para conexão do ChatGPT.
 *
 * Utiliza o SDK oficial @modelcontextprotocol/sdk com WebStandardStreamableHTTPServerTransport.
 * Registra exclusivamente as 12 ferramentas operacionais do CRM.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { auditMcpToolCall } from "../audit";
import { ensureRole, ensureScope, type McpAuthResult } from "../auth";
import { verificarTetoMcp } from "../rate-limit";
import { higienizarUuidsDeAterro } from "../uuid-de-aterro";
import type { McpContext } from "../types";
import { chatGptTools } from "./tools";

const SERVER_NAME = "fluxalvo-crm-mcp";
const SERVER_VERSION = "1.2.0";

export function createChatGptMcpServer(
  auth: McpAuthResult,
  requestId: string,
  idempotencyKey?: string,
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const supabase = createAdminClient();

  for (const tool of chatGptTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (rawArgs) => {
        const startedAt = Date.now();

        // Higieniza UUIDs de aterro (nil/max) emitidos por modelos de linguagem
        const higiene = higienizarUuidsDeAterro(
          tool.inputSchema as Record<string, z.ZodTypeAny>,
          (rawArgs ?? {}) as Record<string, unknown>,
        );
        const args = higiene.limpos;
        const argsAudit = tool.redigirParaAuditoria ? tool.redigirParaAuditoria(args) : args;

        const ctx: McpContext = {
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          organizationId: auth.organizationId,
          role: auth.role,
          actor: auth.actor,
          apiTokenId: auth.apiTokenId,
          requestId,
          supabase,
        };

        try {
          await verificarTetoMcp(auth, tool.category);
          ensureScope(auth.scopes, tool.requiresScope);
          ensureRole(auth.role, tool.requiresRole);

          const result = await tool.handler(args as never, ctx);
          const durationMs = Date.now() - startedAt;

          await auditMcpToolCall({
            ctx,
            toolName: tool.name,
            args: argsAudit,
            durationMs,
            success: true,
          });

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown_error";
          const durationMs = Date.now() - startedAt;

          await auditMcpToolCall({
            ctx,
            toolName: tool.name,
            args: argsAudit,
            durationMs,
            success: false,
            errorMessage: message,
          });

          return {
            isError: true,
            content: [{ type: "text", text: message }],
          };
        }
      },
    );
  }

  return server;
}
