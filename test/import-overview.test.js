import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/import-overview.js";

test("import overview serializes the writing rules in a valid provider request", async (context) => {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  let upstreamRequest;

  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = async (url, options) => {
    upstreamRequest = { url, options };
    return successfulProviderResponse();
  };

  context.after(() => {
    restoreEnvironment("ANTHROPIC_API_KEY", previousApiKey);
    globalThis.fetch = previousFetch;
  });

  const response = createResponse();
  await handler(createRequest(), response);

  assert.equal(upstreamRequest.url, "https://api.anthropic.com/v1/messages");
  const upstreamBody = JSON.parse(upstreamRequest.options.body);
  assert.equal(upstreamBody.model, "claude-sonnet-5");
  assert.equal(upstreamBody.max_tokens, 16000);
  assert.match(upstreamBody.system, /VOICE: Write plainly and directly/);
  assert.match(upstreamBody.system, /you'd know better than these notes do/);
  assert.equal(response.statusCode, 200);
});

test("import overview retries transient provider failures", async (context) => {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const loggedErrors = [];
  let attempts = 0;

  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts === 1
      ? new Response('{"type":"error"}', { status: 529 })
      : successfulProviderResponse();
  };
  console.error = (...args) => loggedErrors.push(args);

  context.after(() => {
    restoreEnvironment("ANTHROPIC_API_KEY", previousApiKey);
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  });

  const response = createResponse();
  await handler(createRequest(), response);

  assert.equal(attempts, 2);
  assert.equal(response.statusCode, 200);
  assert.match(JSON.stringify(loggedErrors), /providerStatus.*529/);
});

test("import overview does not retry provider 400 responses", async (context) => {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  let attempts = 0;

  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response('{"type":"error","error":{"message":"invalid request"}}', { status: 400 });
  };
  console.error = () => {};

  context.after(() => {
    restoreEnvironment("ANTHROPIC_API_KEY", previousApiKey);
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  });

  const response = createResponse();
  await handler(createRequest(), response);

  assert.equal(attempts, 1);
  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      message: "Import overview failed",
      detail: {
        providerAttempts: [
          {
            attempt: 1,
            providerStatus: 400,
            providerBody: '{"type":"error","error":{"message":"invalid request"}}'
          }
        ]
      }
    }
  });
});

test("import overview surfaces every exception and response across retry attempts", async (context) => {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  let attempts = 0;

  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("diagnostic network failure");
    }
    return new Response('{"type":"error","error":{"message":"invalid request after retry"}}', { status: 400 });
  };
  console.error = () => {};

  context.after(() => {
    restoreEnvironment("ANTHROPIC_API_KEY", previousApiKey);
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  });

  const response = createResponse();
  await handler(createRequest(), response);

  const providerAttempts = JSON.parse(response.body).error.detail.providerAttempts;
  assert.equal(attempts, 2);
  assert.equal(response.statusCode, 502);
  assert.equal(providerAttempts.length, 2);
  assert.equal(providerAttempts[0].attempt, 1);
  assert.match(providerAttempts[0].exception, /diagnostic network failure/);
  assert.deepEqual(providerAttempts[1], {
    attempt: 2,
    providerStatus: 400,
    providerBody: '{"type":"error","error":{"message":"invalid request after retry"}}'
  });
});

function createRequest() {
  return {
    method: "POST",
    body: {
      notes: [
        {
          id: "note-1",
          title: "Project Cedar",
          text: "I completed 12 tracked items for Project Cedar.",
          createdAt: "2026-08-19T00:00:00.000Z"
        }
      ]
    }
  };
}

function successfulProviderResponse() {
  return new Response(JSON.stringify({
    content: [
      {
        type: "tool_use",
        name: "submit_import_overview",
        input: {
          opening: "Opening",
          seasons: [
            { title: "One", period: "2024", narrative: "First" },
            { title: "Two", period: "2025", narrative: "Second" },
            { title: "Three", period: "2026", narrative: "Third" }
          ],
          language: "Language",
          unchanged: "Unchanged",
          patterns: "Patterns",
          forgottenIdeas: [],
          tenderThread: "Tender thread"
        }
      }
    ]
  }), { status: 200 });
}

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
