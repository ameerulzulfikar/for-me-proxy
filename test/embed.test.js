import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/embed.js";

test("embed forwards text from an already-parsed request body", async (context) => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  let upstreamRequest;

  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    upstreamRequest = { url, options };
    return new Response(JSON.stringify({ data: [{ embedding: [0.25, -0.5] }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  context.after(() => {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  const response = createResponse();
  await handler({ method: "POST", body: { text: "  hello  " } }, response);

  assert.equal(upstreamRequest.url, "https://api.openai.com/v1/embeddings");
  assert.equal(upstreamRequest.options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(upstreamRequest.options.body), {
    model: "text-embedding-3-large",
    input: "hello"
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { embedding: [0.25, -0.5] });
});

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
