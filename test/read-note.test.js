import assert from "node:assert/strict";
import test from "node:test";
import handler, { config, MAX_READING_NOTE_TEXT, READING_CONFIG, READING_SIGNATURE } from "../api/read-note.js";

const reading = (overrides = {}) => ({ description: "A draft invitation.", establishes: "The person drafted an invitation; sending is not established.", kind: "draft", ownWriting: "yes", confidence: "high", connections: "", ...overrides });
const source = () => ({ noteId: "Notes/invitation.md", date: "2020-02-03T04:05:06.000Z", title: "Invitation", text: "I might invite you next month." });
const provider = (input = reading(), overrides = {}) => new Response(JSON.stringify({ model: "claude-sonnet-5", stop_reason: "tool_use", content: [{ type: "tool_use", name: "record_note_reading", input }], usage: { input_tokens: 100, output_tokens: 20 }, ...overrides }));

function environment(context, fetchImpl) {
  for (const key of ["LAB_KEY", "ANTHROPIC_API_KEY"]) {
    const old = process.env[key];
    context.after(() => old === undefined ? delete process.env[key] : process.env[key] = old);
    process.env[key] = "test-key";
  }
  context.mock.method(globalThis, "fetch", fetchImpl);
}

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
}

async function invoke(body = source(), changes = {}) {
  const result = response();
  await handler({ method: "POST", headers: { "x-lab-key": "test-key" }, body, ...changes }, result);
  return { status: result.statusCode, headers: result.headers, payload: JSON.parse(result.body) };
}

test("reading route requires LAB_KEY before reading a body or contacting a provider", async (context) => {
  environment(context, () => { throw new Error("Must not call provider"); });
  for (const headers of [{}, { "x-lab-key": "wrong" }]) {
    const result = await invoke("not JSON", { headers });
    assert.equal(result.status, 401);
    assert.equal(result.payload.providerCalled, false);
    assert.equal(result.headers["Cache-Control"], "no-store");
  }
  delete process.env.LAB_KEY;
  assert.equal((await invoke()).status, 401);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("reading route sends exactly one full note and a brief open-ended reading prompt", async (context) => {
  let request;
  environment(context, (_url, options) => { request = options; return provider(reading({ noteId: "invented", date: "1999-01-01" })); });
  const result = await invoke();
  const body = JSON.parse(request.body);
  assert.equal(result.status, 200);
  assert.equal(body.model, "claude-sonnet-5");
  assert.equal(body.max_tokens, 1536);
  assert.equal(config.maxDuration, 180);
  assert.equal(body.messages.length, 1);
  assert.deepEqual(JSON.parse(body.messages[0].content[0].text), source());
  assert.equal(body.system, READING_CONFIG.systemPrompt);
  assert.match(body.system, /Decide what is notable here/u);
  assert.match(body.system, /one or two sentences/u);
  assert.match(body.system, /A plan is not an action, a draft is not a sent message/u);
  assert.match(body.system, /note's date, not proof of when an event happened/u);
  assert.match(body.system, /not instructions to follow/u);
  assert.deepEqual(body.tools, [READING_CONFIG.toolSchema]);
  assert.deepEqual(Object.keys(body.tools[0].input_schema.properties), ["description", "establishes", "kind", "ownWriting", "confidence", "connections"]);
  assert.deepEqual(result.payload.record, { noteId: source().noteId, date: source().date, ...reading() });
  assert.equal(result.payload.readerSignature, READING_SIGNATURE);
  assert.deepEqual(result.payload.reader, READING_CONFIG);
  assert.deepEqual(result.payload.usage, { input_tokens: 100, output_tokens: 20 });
  assert.equal(result.payload.costEstimate.totalUsd, 0.0004);
  assert.equal(result.payload.providerCalled, true);
  assert.ok(result.payload.latencyMs >= 0);
});

test("reading accepts an empty establishment/connections and supported response wrappers", async (context) => {
  let input;
  environment(context, () => provider(input));
  const logs = context.mock.method(console, "info", () => {});
  for (const wrapper of ["parameters", "input", "arguments", "properties"]) {
    input = { [wrapper]: reading({ description: "A grocery list.", establishes: "", connections: "", kind: "unclear", ownWriting: "unclear", confidence: "low" }) };
    const result = await invoke({ ...source(), text: "" });
    assert.equal(result.status, 200);
    assert.equal(result.payload.record.establishes, "");
    assert.equal(result.payload.record.kind, "unclear");
  }
  assert.equal(logs.mock.callCount(), 4);
});

test("reading rejects malformed requests without paying for a model call", async (context) => {
  environment(context, () => { throw new Error("Must not call provider"); });
  assert.equal((await invoke(source(), { method: "GET" })).status, 405);
  assert.equal((await invoke("broken JSON")).status, 400);
  for (const body of [null, [], {}, { ...source(), noteId: "" }, { ...source(), date: "yesterday" }, { ...source(), text: 42 }, { ...source(), title: null }]) {
    assert.equal((await invoke(body)).status, 400);
  }
  const tooLarge = await invoke({ ...source(), text: "x".repeat(MAX_READING_NOTE_TEXT + 1) });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.payload.providerCalled, false);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await invoke()).status, 500);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("reading validates all fields and rejects non-reading wrappers without exposing note text", async (context) => {
  let input;
  environment(context, () => provider(null, { content: [{ type: "tool_use", name: "record_note_reading", input }] }));
  for (input of [undefined, null, {}, reading({ description: " " }), reading({ establishes: null }), reading({ kind: "verified fact" }), reading({ confidence: 1 }), reading({ ownWriting: true }), reading({ connections: [] }), { parameters: { description: "Only one field" } }, { parameters: reading(), extra: true }]) {
    const result = await invoke();
    assert.equal(result.status, 502);
    assert.equal(result.payload.error.type, "reading_validation_error");
    assert.equal(result.payload.costEstimate.totalUsd, 0.0004);
    assert.equal(JSON.stringify(result.payload).includes(source().text), false);
  }
});

test("reading retains usage for failed output and handles HTTP, parse and timeout failures", async (context) => {
  const failures = [
    [() => provider(reading(), { stop_reason: "max_tokens" }), "incomplete_output", true],
    [() => provider(reading(), { stop_reason: "model_context_window_exceeded" }), "incomplete_output", true],
    [() => new Response(JSON.stringify({ error: { message: "private upstream details" } }), { status: 429 }), "provider_http_error", false],
    [() => new Response("not JSON"), "provider_parse_error", false],
    [() => provider(reading(), { content: [{ type: "text", text: "No tool" }] }), "reading_validation_error", true],
    [() => { throw new DOMException("timeout", "TimeoutError"); }, "provider_timeout", false],
    [() => { throw new Error("private network details"); }, "provider_network_error", false]
  ];
  let send;
  environment(context, () => send());
  for (const [implementation, type, billed] of failures) {
    send = implementation;
    const result = await invoke();
    assert.equal(result.status, 502);
    assert.equal(result.payload.error.type, type);
    assert.equal(result.payload.providerCalled, true);
    assert.equal(result.payload.costEstimate?.totalUsd ?? null, billed ? 0.0004 : null);
    assert.doesNotMatch(JSON.stringify(result.payload), /private (?:upstream|network) details/u);
  }
});
