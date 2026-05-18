import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type MeterFormat = "used_percent" | "remaining_percent" | "used_limit" | "remaining_limit" | "used_remaining";

type MeterRule = {
  key?: string;
  label?: string;
  match?: string;
  format?: MeterFormat;
  unit?: string;
  decimals?: number;
};

type CheckerRule = {
  checkerId: string;
  label?: string;
  meterSeparator?: string;
  meters?: MeterRule[];
};

type Config = {
  baseUrl: string;
  adminKey: string;
  pollMs?: number;
  checkers: CheckerRule[];
};

type QuotaMeter = {
  key?: string;
  label?: string;
  used?: number;
  limit?: number;
  remaining?: number;
  utilizationPercent?: number;
  unit?: string;
};

type QuotaChecker = {
  checkerId?: string;
  success?: boolean;
  latest?: QuotaMeter[];
  meters?: QuotaMeter[];
};


const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");

let config: Config = loadConfig();
let currentCtx: ExtensionContext | undefined;
let timer: NodeJS.Timeout | undefined;
let lastLine: string | undefined;
let refreshInFlight: Promise<void> | undefined;

function loadConfig(): Config {
  return { ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) } as Config;
}

function formatNumber(value: number, decimals = 0): string {
  return value.toFixed(decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatValue(value: unknown, meter: QuotaMeter, rule: MeterRule): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;

  const unit = rule.unit ?? meter.unit ?? "";
  const decimals = rule.decimals ?? (Math.abs(value) < 10 && unit !== "%" ? 2 : 0);
  const formatted = formatNumber(value, decimals);

  if (unit === "$" || unit === "usd") return `$${formatted}`;
  if (unit === "%" || unit === "percentage") return `${formatted}%`;
  return unit ? `${formatted}${unit}` : formatted;
}


function findMeter(checker: QuotaChecker, rule: MeterRule): QuotaMeter | undefined {
  const meters = checker.meters ?? checker.latest ?? [];
  if (rule.key) {
    const byKey = meters.find((meter) => meter.key === rule.key);
    if (byKey) return byKey;
  }
  if (rule.match) {
    const re = new RegExp(rule.match, "i");
    return meters.find((meter) => re.test(meter.key ?? "") || re.test(meter.label ?? ""));
  }
  return undefined;
}

function formatMeter(meter: QuotaMeter | undefined, rule: MeterRule): string {
  if (!meter) return "?";

  switch (rule.format ?? "used_percent") {
    case "remaining_percent":
      return formatValue(meter.remaining, { ...meter, unit: "%" }, rule) ?? "?";
    case "used_limit": {
      const used = formatValue(meter.used, meter, rule) ?? "?";
      const limit = formatValue(meter.limit, meter, rule) ?? "?";
      return `${used}/${limit}`;
    }
    case "remaining_limit": {
      const remaining = formatValue(meter.remaining, meter, rule) ?? "?";
      const limit = formatValue(meter.limit, meter, rule) ?? "?";
      return `${remaining}/${limit}`;
    }
    case "used_remaining": {
      const used = formatValue(meter.used, meter, rule) ?? "?";
      const remaining = formatValue(meter.remaining, meter, rule) ?? "?";
      return `${used}/${remaining}`;
    }
    case "used_percent":
    default:
      return formatValue(meter.used, { ...meter, unit: "%" }, rule) ?? "?";
  }
}

function autoRulesForChecker(checker: QuotaChecker): CheckerRule {
  const meters = checker.meters ?? checker.latest ?? [];
  const label = (checker as Record<string, unknown>).checkerType as string | undefined ?? checker.checkerId ?? "?";
  // When all meters share the same unit, suppress per-meter unit to avoid repetition
  const sharedUnit = meters.length > 1 && meters.every((m) => m.unit && m.unit === meters[0].unit);
  return {
    checkerId: checker.checkerId ?? "",
    label,
    meters: meters.map((m) => ({
      key: m.key,
      label: m.key,
      format: "used_limit" as MeterFormat,
      unit: sharedUnit ? "" : undefined,
    })),
    meterSeparator: sharedUnit ? undefined : " / ",
  };
}

function lineFromPayload(payload: QuotaChecker[]): string {
  const byId = new Map(payload.map((checker) => [checker.checkerId, checker]));
  const configured = new Set(config.checkers.map((r) => r.checkerId));

  // Configured checkers first (with their formatting rules), then any unconfigured ones (auto-discovered)
  const allRules = [
    ...config.checkers,
    ...payload
      .filter((c) => !configured.has(c.checkerId))
      .map((c) => autoRulesForChecker(c)),
  ];

  return allRules
    .map((rule) => {
      const checker = byId.get(rule.checkerId);
      const label = rule.label ?? rule.checkerId;
      if (!checker || checker.success === false) return `${label}: ?`;

      const checkerMeters = checker.meters ?? checker.latest ?? [];
      const meterParts = (rule.meters ?? []).map((meterRule) => {
        const value = formatMeter(findMeter(checker, meterRule), meterRule);
        return meterRule.label ? `${meterRule.label} ${value}` : value;
      });

      // If all meters share the same unit and it was suppressed per-meter (auto-discovered only), append it once
      const isAutoDiscovered = !configured.has(rule.checkerId);
      const renderedMeters = (rule.meters ?? [])
        .map((mr) => findMeter(checker, mr))
        .filter((m): m is QuotaMeter => m !== undefined);
      const sharedUnit =
        isAutoDiscovered &&
        renderedMeters.length > 1 && renderedMeters.every((m) => m.unit && m.unit === renderedMeters[0].unit)
          ? renderedMeters[0].unit
          : undefined;
      const unitSuffix = sharedUnit && sharedUnit !== "%" ? ` ${sharedUnit}` : "";

      return `${label}: ${meterParts.length > 0 ? meterParts.join(rule.meterSeparator ?? " / ") + unitSuffix : "ok"}`;
    })
    .join(" | ");
}

function renderWidget(): void {
  const ctx = currentCtx;
  if (!ctx?.hasUI) return;

  if (!lastLine) {
    ctx.ui.setWidget("plexus-quotas", undefined);
    return;
  }

  ctx.ui.setWidget(
    "plexus-quotas",
    (_tui, theme) => ({
      render(width: number) {
        return [truncateToWidth(theme.fg("dim", lastLine!), width, theme.fg("dim", "..."))];
      },
      invalidate() {},
    }),
    { placement: "belowEditor" },
  );
}

async function doRefresh(): Promise<void> {
  try {
    config = loadConfig();
    const response = await fetch(`${config.baseUrl}/v0/management/quotas`, {
      headers: { "x-admin-key": config.adminKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = (await response.json()) as QuotaChecker[];
    lastLine = lineFromPayload(payload);
    renderWidget();
  } catch {
    lastLine = config.checkers.map((checker) => `${checker.label ?? checker.checkerId}: ?`).join(" | ");
    renderWidget();
  }
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}

function startPolling(): void {
  if (timer) clearInterval(timer);
  void refresh();
  timer = setInterval(() => void refresh(), config.pollMs ?? 60_000);
  timer.unref?.();
}

export default function plexusQuotas(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    startPolling();
  });

  pi.on("input", (event, ctx) => {
    currentCtx = ctx;
    if (event.source === "interactive") void refresh();
  });

  pi.on("message_end", (_event, ctx) => {
    currentCtx = ctx;
    void refresh();
  });

  pi.on("agent_end", (_event, ctx) => {
    currentCtx = ctx;
    void refresh();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    currentCtx?.ui.setWidget("plexus-quotas", undefined);
    currentCtx = undefined;
  });

  pi.registerCommand("plexus-quotas", {
    description: "Refresh Plexus quota footer widget",
    handler: async (_args, ctx) => {
      currentCtx = ctx;
      await refresh();
      ctx.ui.notify(lastLine ?? "No quota data", "info");
    },
  });
}
