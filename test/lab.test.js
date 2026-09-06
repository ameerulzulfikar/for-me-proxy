import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/lab.js";
import { OVERVIEW_PROMPT_VERSION } from "../api/import-overview.js";

test("lab requires its key before making a provider request", async (context) => {
  const previousLabKey = process.env.LAB_KEY;
  const previousFetch = globalThis.fetch;
  let fetchCalled = false;

  process.env.LAB_KEY = "test-lab-key";
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called");
  };

  context.after(() => {
    restoreEnvironment("LAB_KEY", previousLabKey);
    globalThis.fetch = previousFetch;
  });

  const response = createResponse();
  await handler({ method: "POST", headers: {}, body: {} }, response);

  assert.equal(fetchCalled, false);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), { error: { message: "Unauthorized" } });
});

test("lab sends free-text analysis with an authoritative timeline index", async (context) => {
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const previousLabKey = process.env.LAB_KEY;
  const previousFetch = globalThis.fetch;
  let upstreamRequest;

  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.LAB_KEY = "test-lab-key";
  globalThis.fetch = async (url, options) => {
    upstreamRequest = { url, options };
    return new Response(JSON.stringify({
      content: [
        { type: "text", text: "First part. " },
        { type: "text", text: "Second part." }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  context.after(() => {
    restoreEnvironment("ANTHROPIC_API_KEY", previousAnthropicKey);
    restoreEnvironment("LAB_KEY", previousLabKey);
    globalThis.fetch = previousFetch;
  });

  const instructions = "Find the strongest recurring themes.\nKeep the answer concise.";
  const notes = [
    { id: "one", title: "One", text: "First note", createdAt: "2020-01-02T00:00:00.000Z" },
    { id: "two", title: "Two", text: "Second note", createdAt: "2021-06-03T00:00:00.000Z" },
    { id: "three", title: "Three", text: "Third note", createdAt: "2020-12-04T00:00:00.000Z" }
  ];
  const response = createResponse();

  await handler({
    method: "POST",
    headers: { "x-lab-key": "test-lab-key" },
    body: { notes, instructions }
  }, response);

  assert.equal(upstreamRequest.url, "https://api.anthropic.com/v1/messages");
  assert.equal(upstreamRequest.options.headers["x-api-key"], "test-anthropic-key");

  const upstreamBody = JSON.parse(upstreamRequest.options.body);
  assert.equal(upstreamBody.model, "claude-sonnet-5");
  assert.equal(upstreamBody.max_tokens, 16000);
  assert.equal("tools" in upstreamBody, false);
  assert.equal("tool_choice" in upstreamBody, false);
  assert.equal(upstreamBody.system.endsWith(`\n\n${instructions}`), true);
  assert.match(upstreamBody.system, /Never fabricate or alter a quote/);
  assert.match(upstreamBody.system, /You must not name deceased people, partners, health conditions/);

  const prompt = upstreamBody.messages[0].content[0].text;
  assert.match(prompt, /Overall createdAt range: 2020-01-02T00:00:00\.000Z to 2021-06-03T00:00:00\.000Z/);
  assert.match(prompt, /Notes per year: 2020: 2; 2021: 1/);
  assert.ok(prompt.indexOf("TIMELINE INDEX") < prompt.indexOf("NOTES"));
  assert.match(prompt, /All dates and date ranges in the response must be consistent with this index/);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "text/plain; charset=utf-8");
  assert.equal(response.body, "First part. Second part.");
});

test("legacy lab can return authenticated run metadata without changing its prompt or generation settings", async (context) => {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousLabKey = process.env.LAB_KEY;
  const previousFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.LAB_KEY = "test-lab-key";
  context.after(() => {
    restoreEnvironment("ANTHROPIC_API_KEY", previousApiKey);
    restoreEnvironment("LAB_KEY", previousLabKey);
    globalThis.fetch = previousFetch;
  });
  const requests = [];
  const raw = { model: "claude-sonnet-5", content: [{ type: "text", text: "A reading." }], usage: { input_tokens: 1000, output_tokens: 100 } };
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify(raw));
  };
  const request = { method: "POST", headers: { "x-lab-key": "test-lab-key" }, body: { notes: [], instructions: "Test instructions." } };
  const normal = createResponse();
  await handler(request, normal);
  const detailed = createResponse();
  await handler({ ...request, body: { ...request.body, includeEvaluation: true } }, detailed);
  const result = JSON.parse(detailed.body);
  assert.equal(result.analysis, normal.body);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(result.evaluation.systemPrompt, requests[1].system);
  assert.ok(result.evaluation.promptVersion.startsWith(`${OVERVIEW_PROMPT_VERSION}/lab-`));
  assert.match(result.evaluation.promptVersion, /\/lab-[a-f0-9]{12}$/u);
  assert.deepEqual(result.evaluation.rawModelResponse, raw);
  assert.deepEqual(result.evaluation.usage, raw.usage);
  assert.equal(result.evaluation.costEstimate.totalUsd, 0.003);
  assert.equal(detailed.headers["Cache-Control"], "no-store");
});

function restoreEnvironment(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

function createResponse() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    }
  };
}
