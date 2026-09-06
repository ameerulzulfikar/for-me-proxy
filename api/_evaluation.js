import { timingSafeEqual } from "node:crypto";

// Standard Claude API prices in USD per million tokens, checked 2026-09-06.
// input_tokens excludes cache reads/writes; output_tokens already includes thinking.
const SONNET_5_RATES = Object.freeze({ input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 });

export function hasValidLabKey(request) {
  const expectedKey = process.env.LAB_KEY;
  const suppliedKey = typeof request.headers?.get === "function"
    ? request.headers.get("x-lab-key")
    : request.headers?.["x-lab-key"];
  if (typeof expectedKey !== "string" || !expectedKey || typeof suppliedKey !== "string") {
    return false;
  }
  const expected = Buffer.from(expectedKey);
  const supplied = Buffer.from(suppliedKey);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function estimateAnthropicCost(usage, model, cacheTtl = "5m") {
  if (model !== "claude-sonnet-5" || !usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) {
    return null;
  }
  const count = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
  const creation = usage.cache_creation;
  const writes = count(usage.cache_creation_input_tokens);
  const hasBreakdown = Number.isFinite(creation?.ephemeral_1h_input_tokens) || Number.isFinite(creation?.ephemeral_5m_input_tokens);
  const write1h = hasBreakdown ? count(creation?.ephemeral_1h_input_tokens) : cacheTtl === "1h" ? writes : 0;
  const write5m = hasBreakdown ? count(creation?.ephemeral_5m_input_tokens) : cacheTtl === "1h" ? 0 : writes;
  const tokens = {
    input: count(usage.input_tokens),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheRead: count(usage.cache_read_input_tokens),
    output: count(usage.output_tokens)
  };
  const round = (value) => Number(value.toFixed(9));
  const breakdownUsd = Object.fromEntries(Object.entries(tokens).map(([kind, count]) => [kind, round(count * SONNET_5_RATES[kind] / 1_000_000)]));
  return {
    currency: "USD",
    pricingAsOf: "2026-09-06",
    pricingModel: model,
    ratesPerMillionTokens: SONNET_5_RATES,
    totalInputTokens: tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead,
    breakdownUsd,
    totalUsd: round(Object.values(breakdownUsd).reduce((sum, cost) => sum + cost, 0))
  };
}

// Only attach snapshots to authenticated evaluation responses, never normal app responses.
export function createEvaluationRecorder({ promptVersion, systemPrompt, model, maxTokens, toolSchema = null, cacheControl = null }) {
  const startedAt = Date.now();
  return {
    rawModelResponse: null,
    corpus: null,
    snapshot() {
      const usage = this.rawModelResponse?.usage || null;
      return {
        promptVersion,
        systemPrompt,
        requestedModel: model,
        model: this.rawModelResponse?.model || model,
        generation: { max_tokens: maxTokens, cache_control: cacheControl },
        toolSchema,
        corpus: this.corpus,
        rawModelResponse: this.rawModelResponse,
        usage,
        costEstimate: estimateAnthropicCost(usage, model, cacheControl?.ttl),
        serverLatencyMs: Date.now() - startedAt
      };
    }
  };
}
