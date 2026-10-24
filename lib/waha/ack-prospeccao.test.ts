// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
import { dispatchWahaEvent } from "./ingest";
import { FalhaTransitoriaDeIngestao } from "./falha-transitoria";

function banco() {
  const rows: Array<Record<string, unknown>> = [];
  const admin = {
    from() {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let patch: Record<string, unknown> = {};
      const q = {
        select() {
          return q;
        },
        update(p: Record<string, unknown>) {
          patch = p;
          return q;
        },
        eq(k: string, v: unknown) {
          filters.push((r) => r[k] === v);
          return q;
        },
        in(k: string, v: unknown[]) {
          filters.push((r) => v.includes(r[k]));
          return q;
        },
        limit() {
          return q;
        },
        or(v: string) {
          const a = Number(v.split(".").at(-1));
          filters.push((r) => r.ack == null || Number(r.ack) < a);
          return q;
        },
        maybeSingle() {
          return Promise.resolve({
            data: rows.find((r) => filters.every((f) => f(r))) ?? null,
            error: null,
          });
        },
        then(resolve: (r: unknown) => unknown) {
          for (const r of rows.filter((r) => filters.every((f) => f(r)))) Object.assign(r, patch);
          return Promise.resolve(resolve({ error: null }));
        },
      };
      return q;
    },
  };
  return { rows, admin: admin as never };
}
const session = { id: "2442", organization_id: "org", waha_session_name: "gael" };
const event = (ack: number) => ({
  event: "message.ack",
  session: "gael",
  payload: { id: "true_123@lid_ABC", fromMe: true, ack },
});
describe("ACK da mensagem manual — corrida de produção", () => {
  it("ACK antes do INSERT solicita replay; depois persiste entrega e não cria mensagem", async () => {
    const { rows, admin } = banco();
    await expect(
      dispatchWahaEvent(admin, session as never, event(2), "req"),
    ).rejects.toBeInstanceOf(FalhaTransitoriaDeIngestao);
    rows.push({
      id: "m",
      organization_id: "org",
      channel_session_id: "2442",
      direction: "outbound",
      external_id: "ABC",
      sent_via: "external_device",
      ack: 1,
      status: "sent",
      delivered_at: null,
    });
    await dispatchWahaEvent(admin, session as never, event(2), "retry");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ack: 2, status: "delivered" });
    expect(rows[0]!.delivered_at).toBeTruthy();
  });
  it("ACK repetido ou fora de ordem preserva leitura e timestamps", async () => {
    const { rows, admin } = banco();
    rows.push({
      id: "m",
      organization_id: "org",
      channel_session_id: "2442",
      direction: "outbound",
      external_id: "ABC",
      ack: 1,
      status: "sent",
    });
    await dispatchWahaEvent(admin, session as never, event(2), "delivery");
    const delivered = rows[0]!.delivered_at;
    await dispatchWahaEvent(admin, session as never, event(3), "read");
    const read = rows[0]!.read_at;
    await dispatchWahaEvent(admin, session as never, event(2), "late");
    await dispatchWahaEvent(admin, session as never, event(3), "duplicate");
    expect(rows[0]).toMatchObject({
      ack: 3,
      status: "read",
      delivered_at: delivered,
      read_at: read,
    });
  });
  it("outra organização ou conexão não recebe confirmação", async () => {
    const { rows, admin } = banco();
    for (const [org, channel] of [
      ["other", "2442"],
      ["org", "1266"],
    ])
      rows.push({
        organization_id: org,
        channel_session_id: channel,
        direction: "outbound",
        external_id: "ABC",
        ack: 1,
        status: "sent",
      });
    await expect(
      dispatchWahaEvent(admin, session as never, event(2), "req"),
    ).rejects.toBeInstanceOf(FalhaTransitoriaDeIngestao);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
  });
});
