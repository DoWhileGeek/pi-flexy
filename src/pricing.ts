// All money values are USD estimates. These are not charges returned by OpenAI.
export const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type Rates = Record<(typeof COST_KEYS)[number], number>;
export type Cost = Rates & { total: number };
export interface ModelPrices extends Rates {
  tiers?: Array<Rates & { inputTokensAbove: number }>;
}
export interface PricingSnapshot {
  source: "pi-model-catalog";
  unit: "USD-per-million-tokens";
  capturedAt: string;
  rates: ModelPrices;
}
export interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  totalTokens: number;
  cost: Cost; // Pi has already applied the response's service-tier multiplier.
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function tokens(value: unknown): value is number {
  return amount(value) && Number.isSafeInteger(value);
}
export function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-12, Math.max(Math.abs(a), Math.abs(b)) * 1e-9);
}
function decodeRates(value: unknown): Rates | undefined {
  if (!record(value) || !COST_KEYS.every(key => amount(value[key]))) return undefined;
  return { input: value.input as number, output: value.output as number, cacheRead: value.cacheRead as number, cacheWrite: value.cacheWrite as number };
}
export function decodeCost(value: unknown): Cost | undefined {
  const rates = decodeRates(value);
  if (!rates || !record(value) || !amount(value.total)) return undefined;
  const total = COST_KEYS.reduce((sum, key) => sum + rates[key], 0);
  if (!Number.isFinite(total) || !nearlyEqual(total, value.total)) return undefined;
  return { ...rates, total: value.total };
}
export function decodeUsage(value: unknown): UsageSnapshot | undefined {
  if (!record(value) || !COST_KEYS.every(key => tokens(value[key])) || !tokens(value.totalTokens)) return undefined;
  const cost = decodeCost(value.cost);
  const cacheWrite1h = value.cacheWrite1h ?? 0;
  const reasoning = value.reasoning ?? 0;
  if (!cost || !tokens(cacheWrite1h) || !tokens(reasoning) || cacheWrite1h > (value.cacheWrite as number) || reasoning > (value.output as number)) return undefined;
  const total = COST_KEYS.reduce((sum, key) => sum + (value[key] as number), 0);
  if (!Number.isSafeInteger(total) || total !== value.totalTokens) return undefined;
  return {
    input: value.input as number, output: value.output as number,
    cacheRead: value.cacheRead as number, cacheWrite: value.cacheWrite as number,
    cacheWrite1h, reasoning, totalTokens: total, cost,
  };
}
function decodeModelPrices(value: unknown): ModelPrices | undefined {
  const rates = decodeRates(value);
  if (!rates || !record(value)) return undefined;
  if (value.tiers === undefined) return rates;
  if (!Array.isArray(value.tiers) || value.tiers.length > 128) return undefined;
  const tiers: NonNullable<ModelPrices["tiers"]> = [];
  for (const raw of value.tiers) {
    const tier = decodeRates(raw);
    if (!tier || !record(raw) || !tokens(raw.inputTokensAbove)) return undefined;
    tiers.push({ ...tier, inputTokensAbove: raw.inputTokensAbove });
  }
  return { ...rates, tiers };
}
export function capturePricing(cost: unknown, capturedAt: string): PricingSnapshot | undefined {
  const rates = decodeModelPrices(cost);
  if (!rates || !Number.isFinite(Date.parse(capturedAt))) return undefined;
  return { source: "pi-model-catalog", unit: "USD-per-million-tokens", capturedAt, rates };
}
export function decodePricing(value: unknown): PricingSnapshot | undefined {
  if (!record(value) || value.source !== "pi-model-catalog" || value.unit !== "USD-per-million-tokens" || typeof value.capturedAt !== "string") return undefined;
  return capturePricing(value.rates, value.capturedAt);
}

/** Mirrors Pi 0.84's standard-price calculation, without touching the assistant's usage. */
export function standardCost(prices: ModelPrices, usage: UsageSnapshot): Cost | undefined {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let rates: Rates = prices;
  let threshold = -1;
  for (const tier of prices.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      rates = tier;
      threshold = tier.inputTokensAbove;
    }
  }
  const cost: Cost = {
    input: (rates.input / 1e6) * usage.input,
    output: (rates.output / 1e6) * usage.output,
    cacheRead: (rates.cacheRead / 1e6) * usage.cacheRead,
    cacheWrite: ((usage.cacheWrite - usage.cacheWrite1h) * rates.cacheWrite + usage.cacheWrite1h * rates.input * 2) / 1e6,
    total: 0,
  };
  cost.total = COST_KEYS.reduce((sum, key) => sum + cost[key], 0);
  return decodeCost(cost);
}
export function scaleCost(cost: Cost, multiplier: number): Cost {
  return {
    input: cost.input * multiplier, output: cost.output * multiplier,
    cacheRead: cost.cacheRead * multiplier, cacheWrite: cost.cacheWrite * multiplier,
    total: cost.total * multiplier,
  };
}
export function costsMatch(a: Cost, b: Cost): boolean {
  return [...COST_KEYS, "total" as const].every(key => nearlyEqual(a[key], b[key]));
}
