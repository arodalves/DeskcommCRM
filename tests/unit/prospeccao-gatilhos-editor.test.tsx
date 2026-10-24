// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { TriggerConfigControl } from "@/app/app/ai/followups/[id]/_components/TriggerConfigControl";
const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/followup/useFollowupFlow", () => ({ useUpdateTriggerConfig: () => ({ mutate }) }));
vi.mock("@/hooks/followup/useEtapasDeGatilho", () => ({
  useEtapasDeGatilho: () => ({ etapas: [], carregando: false }),
  etapasPorFunil: () => [],
  nomeDaEtapa: () => "",
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it.each([
  ["prospecting_initial_accepted", "Prospecção — primeira abordagem aceita"],
  ["prospecting_conversation_interrupted", "Prospecção — conversa comercial interrompida"],
])("editor reconhece %s sem reescrever campanhas ao salvar", async (kind, label) => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TriggerConfigControl
        flowId="flow"
        triggerConfig={{ kind, params: { campaign_ids: ["campaign"] } }}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByTestId("trigger-config-button").textContent).toContain(label);
  expect(screen.queryByText(/indisponível/)).toBeNull();
  fireEvent.click(screen.getByTestId("trigger-config-button"));
  const cancel = await screen.findByRole("switch");
  fireEvent.click(cancel);
  fireEvent.click(screen.getByRole("button", { name: "Salvar gatilho" }));
  expect(mutate).toHaveBeenCalledWith(
    { kind, params: { campaign_ids: ["campaign"] }, cancel_on_reply: true },
    expect.anything(),
  );
});
