"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { waitConfigSchema } from "@/lib/followup/graph-schema";
import { MODOS_DE_ESPERA, opcoes } from "@/lib/followup/vocabulario";
import { useT } from "@/hooks/i18n/useT";

import { msToMin, minToMs, type ConfigOf } from "./shared";

export function WaitForm({
  config,
  onChange,
}: {
  config: ConfigOf<"wait">;
  onChange: (c: ConfigOf<"wait">) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<"fixed" | "smart" | "business_days">(config.mode);
  const [durationMin, setDurationMin] = useState(
    config.mode === "fixed" ? msToMin(config.duration_ms) : 10,
  );
  const [minMin, setMinMin] = useState(config.mode === "smart" ? msToMin(config.min_ms) : 5);
  const [maxMin, setMaxMin] = useState(config.mode === "smart" ? msToMin(config.max_ms) : 60);
  const [days, setDays] = useState(config.mode === "business_days" ? config.days : 2);
  const [windowStartHour, setWindowStartHour] = useState(
    config.mode === "business_days" ? (config.window_start_hour ?? 9) : 9,
  );
  const [windowEndHour, setWindowEndHour] = useState(
    config.mode === "business_days" ? (config.window_end_hour ?? 17) : 17,
  );
  const [guidance, setGuidance] = useState(config.mode === "smart" ? (config.guidance ?? "") : "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: {
    mode: "fixed" | "smart" | "business_days";
    durationMin: number;
    minMin: number;
    maxMin: number;
    days: number;
    windowStartHour: number;
    windowEndHour: number;
    guidance: string;
  }) => {
    let candidate: ConfigOf<"wait">;
    if (next.mode === "fixed") {
      candidate = { mode: "fixed", duration_ms: minToMs(next.durationMin) };
    } else if (next.mode === "business_days") {
      candidate = {
        mode: "business_days",
        days: next.days,
        window_start_hour: next.windowStartHour,
        window_end_hour: next.windowEndHour,
      };
    } else {
      candidate = {
        mode: "smart",
        min_ms: minToMs(next.minMin),
        max_ms: minToMs(next.maxMin),
        ...(next.guidance.trim() ? { guidance: next.guidance } : {}),
      };
    }
    const parsed = waitConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="wait-mode">{t("Como calcular a espera")}</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as "fixed" | "smart" | "business_days";
            setMode(next);
            commit({ mode: next, durationMin, minMin, maxMin, days, windowStartHour, windowEndHour, guidance });
          }}
        >
          <SelectTrigger id="wait-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opcoes(MODOS_DE_ESPERA).map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {t(rotulo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {mode === "fixed" && (
        <div className="space-y-2">
          <Label htmlFor="wait-duration">{t("Duração (minutos)")}</Label>
          <Input
            id="wait-duration"
            type="number"
            min={5}
            value={durationMin}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDurationMin(v);
              commit({ mode, durationMin: v, minMin, maxMin, days, windowStartHour, windowEndHour, guidance });
            }}
          />
        </div>
      )}

      {mode === "business_days" && (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="wait-days">{t("Dias úteis")}</Label>
            <Input
              id="wait-days"
              type="number"
              min={1}
              max={30}
              value={days}
              onChange={(e) => {
                const v = Number(e.target.value);
                setDays(v);
                commit({ mode, durationMin, minMin, maxMin, days: v, windowStartHour, windowEndHour, guidance });
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="wait-start-hour">{t("Janela: Início (h)")}</Label>
              <Input
                id="wait-start-hour"
                type="number"
                min={0}
                max={23}
                value={windowStartHour}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setWindowStartHour(v);
                  commit({ mode, durationMin, minMin, maxMin, days, windowStartHour: v, windowEndHour, guidance });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wait-end-hour">{t("Janela: Fim (h)")}</Label>
              <Input
                id="wait-end-hour"
                type="number"
                min={0}
                max={23}
                value={windowEndHour}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setWindowEndHour(v);
                  commit({ mode, durationMin, minMin, maxMin, days, windowStartHour, windowEndHour: v, guidance });
                }}
              />
            </div>
          </div>
        </div>
      )}

      {mode === "smart" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="wait-min">{t("Mínimo (min)")}</Label>
              <Input
                id="wait-min"
                type="number"
                min={5}
                value={minMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMinMin(v);
                  commit({ mode, durationMin, minMin: v, maxMin, days, windowStartHour, windowEndHour, guidance });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wait-max">{t("Máximo (min)")}</Label>
              <Input
                id="wait-max"
                type="number"
                min={5}
                value={maxMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMaxMin(v);
                  commit({ mode, durationMin, minMin, maxMin: v, days, windowStartHour, windowEndHour, guidance });
                }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wait-guidance">{t("Orientação (opcional)")}</Label>
            <Textarea
              id="wait-guidance"
              maxLength={500}
              value={guidance}
              onChange={(e) => {
                setGuidance(e.target.value);
                commit({ mode, durationMin, minMin, maxMin, days, windowStartHour, windowEndHour, guidance: e.target.value });
              }}
            />
          </div>
        </>
      )}
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}
