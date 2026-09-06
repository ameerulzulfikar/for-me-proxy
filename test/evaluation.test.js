import assert from "node:assert/strict";
import test from "node:test";
import { estimateAnthropicCost } from "../api/_evaluation.js";

test("cost estimates distinguish uncached input, cache creation, reads, and output", () => {
  const usage = { input_tokens: 100000, output_tokens: 3000 };
  assert.equal(estimateAnthropicCost(usage, "claude-sonnet-5").totalUsd, 0.23);
  const writes = { input_tokens: 0, cache_creation_input_tokens: 100000, output_tokens: 3000 };
  assert.equal(estimateAnthropicCost(writes, "claude-sonnet-5", "5m").totalUsd, 0.28);
  assert.equal(estimateAnthropicCost(writes, "claude-sonnet-5", "1h").totalUsd, 0.43);
  const reads = { input_tokens: 0, cache_read_input_tokens: 100000, output_tokens: 3000, output_tokens_details: { thinking_tokens: 1000 } };
  assert.equal(estimateAnthropicCost(reads, "claude-sonnet-5").totalUsd, 0.05);
  assert.equal(estimateAnthropicCost(reads, "claude-sonnet-5").totalInputTokens, 100000);
});

test("mixed TTL cache writes are charged once using the provider's breakdown", () => {
  const usage = {
    input_tokens: 100, cache_creation_input_tokens: 300, cache_read_input_tokens: 180, output_tokens: 50,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 }
  };
  const cost = estimateAnthropicCost(usage, "claude-sonnet-5", "1h");
  assert.equal(cost.totalInputTokens, 580);
  assert.equal(cost.totalUsd, 0.001636);
});

test("unknown usage or prices stay unknown rather than being recorded as free", () => {
  assert.equal(estimateAnthropicCost(null, "claude-sonnet-5"), null);
  assert.equal(estimateAnthropicCost({}, "claude-sonnet-5"), null);
  assert.equal(estimateAnthropicCost({ input_tokens: 100, output_tokens: 100 }, "unpriced-model"), null);
});
