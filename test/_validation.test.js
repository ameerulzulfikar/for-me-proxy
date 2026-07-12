import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { readJsonBody } from "../api/_validation.js";

test("readJsonBody returns an already-parsed platform body", async () => {
  const body = { text: "hello" };

  assert.equal(await readJsonBody({ body }), body);
});

test("readJsonBody parses a platform-provided JSON string", async () => {
  assert.deepEqual(await readJsonBody({ body: '{"text":"hello"}' }), { text: "hello" });
});

test("readJsonBody still parses an unconsumed request stream", async () => {
  const request = Readable.from(['{"text":', '"hello"}']);

  assert.deepEqual(await readJsonBody(request), { text: "hello" });
});
