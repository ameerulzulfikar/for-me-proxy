import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/reflect.js";

test("reflect temporarily surfaces the complete provider error", async (context) => {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;

  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = async () => new Response(
    '{"type":"error","error":{"type":"invalid_request_error","message":"diagnostic provider detail"}}',
    { status: 400 }
  );
  console.error = () => {};

  context.after(() => {
    restoreEnvironment("ANTHROPIC_API_KEY", previousApiKey);
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  });

  const response = createResponse();
  await handler({
    method: "POST",
    body: {
      entries: [
        {
          id: "entry-1",
          date: "2026-08-23",
          text: "I completed Project Cedar.",
          mood: "Proud",
          tag: "Work"
        }
      ]
    }
  }, response);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      message: "Reflection failed",
      detail: {
        providerStatus: 400,
        providerBody: '{"type":"error","error":{"type":"invalid_request_error","message":"diagnostic provider detail"}}'
      }
    }
  });
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
