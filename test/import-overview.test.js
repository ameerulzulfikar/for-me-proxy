import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/import-overview.js";

test("import overview sends the simplified schema, timeline, and unnumbered note text", async (context) => {
  const restore = installProviderMock(context, () => successfulProviderResponse(baseOverviewInput()));
  const response = createResponse();

  await handler(createRequest([
    note("later", "Later", "Latest full text", "2025-05-10T12:00:00.000Z"),
    note("earliest-source-id", "Earliest", "Earliest first line\n\nEarliest third line", "2024-01-02T12:00:00.000Z"),
    note("middle", "Middle", "Middle full text", "2025-03-15T12:00:00.000Z")
  ]), response);

  const upstreamBody = JSON.parse(restore.requests[0].options.body);
  assert.equal(restore.requests.length, 1);
  assert.equal(upstreamBody.model, "claude-sonnet-5");
  assert.equal(upstreamBody.max_tokens, 32000);
  assert.ok(restore.requests[0].options.signal instanceof AbortSignal);
  assert.match(upstreamBody.system, /^Someone has just handed you everything they've written down for years/u);
  assert.match(upstreamBody.system, /Warm, plain, direct\. Short sentences\./u);
  assert.match(upstreamBody.system, /Be generous and be honest/u);
  assert.match(upstreamBody.system, /at least two things they probably haven't put into words about themselves/u);
  assert.match(upstreamBody.system, /Where you're unsure, say so plainly/u);
  assert.match(upstreamBody.system, /Don't work out someone's age unless the notes state it\./u);
  assert.match(upstreamBody.system, /Never mention note IDs or reference the notes by their labels — the reader doesn't know what n412 means\./u);
  assert.match(upstreamBody.system, /Don't mention health conditions, treatments, therapy or diagnoses/u);
  assert.match(upstreamBody.system, /Don't name people who have died or a partner by name — 'your wife' is fine\./u);
  assert.match(upstreamBody.system, /Don't quote at length; if you refer to something they wrote, paraphrase it\./u);
  assert.match(upstreamBody.system, /Don't tell them what to do\.$/u);
  assert.doesNotMatch(upstreamBody.system, /Don't write calendar years or months|\{\{cite|locator|startLine|endLine|4-5/u);

  const tool = upstreamBody.tools[0];
  assert.match(tool.description, /server-computed timeline index/u);
  assert.match(tool.description, /sourceNoteId lets the server compute whenWritten/u);
  assert.doesNotMatch(JSON.stringify(tool), /Citations|citations|\{\{cite|locator|startLine|endLine|QUOTE PROTOCOL|DATE AND SOURCE PROTOCOL/u);
  const schema = tool.input_schema;
  assert.deepEqual(Object.keys(schema.properties), ["portrait", "read", "forgottenIdeas", "tender", "questions"]);
  assert.deepEqual(schema.required, ["portrait", "read", "forgottenIdeas", "tender", "questions"]);
  assert.deepEqual(Object.keys(schema.properties.forgottenIdeas.items.properties), ["title", "sourceNoteId", "why"]);
  assert.deepEqual(schema.properties.forgottenIdeas.items.required, ["title", "sourceNoteId", "why"]);
  assert.equal(schema.properties.forgottenIdeas.minItems, undefined);
  assert.equal(schema.properties.forgottenIdeas.maxItems, undefined);
  assert.equal(schema.properties.questions.minItems, 3);
  assert.equal(schema.properties.questions.maxItems, 3);
  assert.match(schema.properties.questions.description, /^Exactly three questions/u);
  for (const field of Object.values(schema.properties)) {
    assert.equal(typeof field.description, "string");
    assert.ok(field.description.length > 0);
  }

  const prompt = upstreamBody.messages[0].content[0].text;
  assert.equal(prompt.startsWith("TIMELINE INDEX — SERVER-COMPUTED AND AUTHORITATIVE"), true);
  assert.match(prompt, /\| Overall \| January 2024 – May 2025 \| 3 \|/u);
  assert.match(prompt, /\| Year \| 2024 \| 1 \|/u);
  assert.match(prompt, /\| Year \| 2025 \| 2 \|/u);
  assert.match(prompt, /\[NOTE n1 \| DATE: January 2024 \| TITLE: "Earliest"\]\nEarliest first line\n\nEarliest third line\n\[END NOTE n1\]/u);
  assert.ok(prompt.indexOf('[NOTE n1 | DATE: January 2024 | TITLE: "Earliest"]') < prompt.indexOf('[NOTE n2 | DATE: March 2025 | TITLE: "Middle"]'));
  assert.ok(prompt.indexOf('[NOTE n2 | DATE: March 2025 | TITLE: "Middle"]') < prompt.indexOf('[NOTE n3 | DATE: May 2025 | TITLE: "Later"]'));
  assert.doesNotMatch(prompt, /earliest-source-id|n1\|L1\||n2\|L1\||n3\|L1\|/u);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.deepEqual(Object.keys(result), ["portrait", "read", "forgottenIdeas", "tender", "questions", "verification"]);
  assert.deepEqual(result.verification, { totalChecks: 0, passed: 0, failed: 0, failures: [] });
});

test("import overview ignores the removed birthdate experiment", async (context) => {
  const restore = installProviderMock(context, () => successfulProviderResponse(baseOverviewInput()));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", "Text", "2026-08-25T00:00:00.000Z")
  ], { birthdate: "1990-04-12" }), response);

  assert.equal(response.statusCode, 200);
  const prompt = JSON.parse(restore.requests[0].options.body).messages[0].content[0].text;
  assert.doesNotMatch(prompt, /birthdate|date of birth|ages at any note/iu);
});

test("import overview adds month counts when a year has enough notes", async (context) => {
  const restore = installProviderMock(context, () => successfulProviderResponse(baseOverviewInput()));
  const notes = Array.from({ length: 12 }, (_, index) => note(
    `source-${index + 1}`,
    `Note ${index + 1}`,
    `Text ${index + 1}`,
    `2025-${String(index + 1).padStart(2, "0")}-01T00:00:00.000Z`
  ));
  const response = createResponse();

  await handler(createRequest(notes), response);

  const prompt = JSON.parse(restore.requests[0].options.body).messages[0].content[0].text;
  assert.match(prompt, /\| Year \| 2025 \| 12 \|/u);
  assert.match(prompt, /\| Month \| January 2025 \| 1 \|/u);
  assert.match(prompt, /\| Month \| December 2025 \| 1 \|/u);
  assert.equal(response.statusCode, 200);
});

test("import overview computes forgotten-idea dates from sourceNoteId", async (context) => {
  installProviderMock(context, () => successfulProviderResponse(baseOverviewInput({
    forgottenIdeas: [
      { title: "Cedar", sourceNoteId: "n2", why: "It still has a clear use." },
      { title: "Missing", sourceNoteId: "n99", why: "It may still matter." }
    ]
  })));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", "First source", "2024-01-02T00:00:00.000Z"),
    note("two", "Two", "Second source", "2025-03-15T00:00:00.000Z")
  ]), response);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.deepEqual(result.forgottenIdeas, [
    { title: "Cedar", whenWritten: "Mar 2025", why: "It still has a clear use." },
    { title: "Missing", whenWritten: "", why: "It may still matter." }
  ]);
  assert.deepEqual(result.verification, {
    totalChecks: 2,
    passed: 1,
    failed: 1,
    failures: [{ noteId: "n99", reason: "note_not_found" }]
  });
});

test("import overview leaves calendar dates and ordinary prose untouched", async (context) => {
  installProviderMock(context, () => successfulProviderResponse(baseOverviewInput({
    portrait: "In 2020 you changed direction. In March 2024 you chose the larger project.",
    read: "The shift from 2019–2021 still explains the work.",
    forgottenIdeas: [{ title: "The 2022 prototype", sourceNoteId: "n1", why: "You set it aside in April 2022." }],
    tender: "In May 2025 you packed lunch before the call. The ordinary detail stayed beside the work.",
    questions: ["What changed in June 2023?"]
  })));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", "Source", "2026-08-25T00:00:00.000Z")
  ]), response);

  const result = JSON.parse(response.body);
  assert.match(result.portrait, /2020.*March 2024/u);
  assert.match(result.read, /2019–2021/u);
  assert.equal(result.forgottenIdeas[0].title, "The 2022 prototype");
  assert.match(result.forgottenIdeas[0].why, /April 2022/u);
  assert.match(result.tender, /May 2025/u);
  assert.deepEqual(result.questions, ["What changed in June 2023?"]);
  assert.deepEqual(result.verification, { totalChecks: 1, passed: 1, failed: 0, failures: [] });
});

test("import overview removes note-ID parentheticals from every text field and returns three screened questions", async (context) => {
  installProviderMock(context, () => successfulProviderResponse({
    portrait: "You keep returning to the same problem (note n973, n1278, n1687). You still act quickly.",
    read: "The pattern became clearer over time (note n587). It stayed practical.",
    forgottenIdeas: [{
      title: "The pocket brief (n12)",
      sourceNoteId: "n1",
      why: "It connects several loose ideas (notes n12 and n18)."
    }],
    tender: "You kept the school note beside the launch plan (note n3). You packed lunch before the call.",
    questions: [
      "How did therapy change the work?",
      "What made the idea stick (note n8)?",
      "What stayed constant (n12, n14)?",
      "What are you still moving toward?",
      "What would you revisit?",
      "What surprised you?"
    ]
  }));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", "Source", "2026-08-25T00:00:00.000Z")
  ]), response);

  const result = JSON.parse(response.body);
  assert.equal(result.portrait, "You keep returning to the same problem. You still act quickly.");
  assert.equal(result.read, "The pattern became clearer over time. It stayed practical.");
  assert.deepEqual(result.forgottenIdeas, [{
    title: "The pocket brief",
    whenWritten: "Aug 2026",
    why: "It connects several loose ideas."
  }]);
  assert.equal(result.tender, "You kept the school note beside the launch plan. You packed lunch before the call.");
  assert.deepEqual(result.questions, [
    "What made the idea stick?",
    "What stayed constant?",
    "What are you still moving toward?"
  ]);
  assert.doesNotMatch(JSON.stringify(result), /\([^)]*\bn\d+\b[^)]*\)/iu);
  assert.deepEqual(result.verification, {
    totalChecks: 2,
    passed: 1,
    failed: 1,
    failures: [{ reason: "privacy_health" }]
  });
});

test("import overview keeps relationship-based loss while removing private health and deceased names", async (context) => {
  installProviderMock(context, () => successfulProviderResponse(baseOverviewInput({
    portrait: "A stable opening. Therapy shaped the plan. This changed how you worked. Sarah's death made you rewrite the launch. You rewrote your sister's eulogy four times. A grounded ending.",
    tender: "You rewrote your mother's eulogy four times. You kept your child's snack list beside the launch plan."
  })));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", "Source", "2026-08-25T00:00:00.000Z")
  ]), response);

  const result = JSON.parse(response.body);
  assert.equal(result.portrait, "A stable opening. You rewrote your sister's eulogy four times. A grounded ending.");
  assert.equal(result.tender, "You rewrote your mother's eulogy four times. You kept your child's snack list beside the launch plan.");
  assert.deepEqual(result.verification, {
    totalChecks: 2,
    passed: 0,
    failed: 2,
    failures: [{ reason: "privacy_health" }, { reason: "privacy_deceased" }]
  });
});

test("import overview privacy-screens every response string and redacts partner names response-wide", async (context) => {
  installProviderMock(context, () => successfulProviderResponse({
    portrait: "Your wife Priya backed the move. Priya kept the details straight.",
    read: "You discussed therapy weekly. A safe reading remains.",
    forgottenIdeas: [{ title: "Priya's checklist", sourceNoteId: "n1", why: "Your wife Priya made it practical." }],
    tender: "Sarah's death changed the draft. You rewrote your mother's eulogy four times. You kept the school note beside the launch plan.",
    questions: [
      "How did psoriasis shape the project?",
      "What did Priya make possible?",
      "What did Sarah's death make you change?"
    ]
  }));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", "Source", "2026-08-25T00:00:00.000Z")
  ]), response);

  const result = JSON.parse(response.body);
  assert.equal(result.portrait, "Your wife backed the move. Your partner kept the details straight.");
  assert.equal(result.read, "A safe reading remains.");
  assert.deepEqual(result.forgottenIdeas, [{
    title: "Your partner's checklist",
    whenWritten: "Aug 2026",
    why: "Your wife made it practical."
  }]);
  assert.equal(result.tender, "You rewrote your mother's eulogy four times. You kept the school note beside the launch plan.");
  assert.deepEqual(result.questions, ["What did your partner make possible?"]);
  assert.doesNotMatch(JSON.stringify(result), /Priya|Sarah|therapy|psoriasis/iu);
  assert.equal(result.verification.totalChecks, 10);
  assert.equal(result.verification.passed, 1);
  assert.equal(result.verification.failed, 9);
  assert.deepEqual(result.verification.failures.map(({ reason }) => reason), [
    "privacy_partner",
    "privacy_partner",
    "privacy_health",
    "privacy_partner",
    "privacy_partner",
    "privacy_deceased",
    "privacy_health",
    "privacy_partner",
    "privacy_deceased"
  ]);
});

test("import overview removes corrupt words or sentences across every text field", async (context) => {
  installProviderMock(context, () => successfulProviderResponse(baseOverviewInput({
    portrait: "A solid opening. You and你're most honest when building. A clear ending.",
    read: "You track the details carefully. 你 carry the rest.",
    forgottenIdeas: [{ title: "A clean idea", sourceNoteId: "n1", why: "You kept你 the useful part." }],
    tender: "You packed lunch before the call. You kept the 家 list beside the launch plan.",
    questions: ["What did 你 change?", "What remains useful?"]
  })));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", "Source", "2026-08-25T00:00:00.000Z")
  ]), response);

  const result = JSON.parse(response.body);
  assert.doesNotMatch(JSON.stringify(result), /[你家]/u);
  assert.equal(result.portrait, "A solid opening. A clear ending.");
  assert.equal(result.read, "You track the details carefully.");
  assert.deepEqual(result.forgottenIdeas, []);
  assert.equal(result.tender, "You packed lunch before the call. You kept the list beside the launch plan.");
  assert.deepEqual(result.questions, ["What remains useful?"]);
  assert.deepEqual(result.verification.failures.map(({ reason }) => reason), Array.from({ length: 5 }, () => "corrupt_text"));
});

test("import overview drops malformed forgotten ideas and empty screened sections", async (context) => {
  installProviderMock(context, () => successfulProviderResponse(baseOverviewInput({
    read: "Therapy dominated the draft.",
    forgottenIdeas: [
      { title: "", sourceNoteId: "n1", why: "This could still work." },
      { title: "An idea", sourceNoteId: "n1", why: "" },
      { title: "A therapy plan", sourceNoteId: "n1", why: "This could still work." },
      { title: "A valid idea", sourceNoteId: "n1", why: "This is still worth revisiting." }
    ],
    tender: "Therapy was discussed. Care remains."
  })));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", "Source", "2026-08-25T00:00:00.000Z")
  ]), response);

  const result = JSON.parse(response.body);
  assert.equal(Object.hasOwn(result, "read"), false);
  assert.equal(Object.hasOwn(result, "tender"), false);
  assert.deepEqual(result.forgottenIdeas, [{
    title: "A valid idea",
    whenWritten: "Aug 2026",
    why: "This is still worth revisiting."
  }]);
  assert.deepEqual(result.verification, {
    totalChecks: 4,
    passed: 1,
    failed: 3,
    failures: Array.from({ length: 3 }, () => ({ reason: "privacy_health" }))
  });
});

test("import overview keeps only complete tender sections with at least two sentences", async (context) => {
  const providerInputs = [
    baseOverviewInput({ tender: "You rewrote your sister's eulogy four times. You kept your child's snack list beside the launch plan." }),
    baseOverviewInput({ tender: "You kept the school note beside the launch plan. You packed lunch before the investor call" }),
    baseOverviewInput({ tender: "You discussed therapy weekly. You kept the school note beside the launch plan." })
  ];
  installProviderMock(context, () => successfulProviderResponse(providerInputs.shift()));
  const notes = [note("one", "One", "Source", "2026-08-25T00:00:00.000Z")];

  const completeResponse = createResponse();
  await handler(createRequest(notes), completeResponse);
  assert.equal(JSON.parse(completeResponse.body).tender, "You rewrote your sister's eulogy four times. You kept your child's snack list beside the launch plan.");

  const unterminatedResponse = createResponse();
  await handler(createRequest(notes), unterminatedResponse);
  assert.equal(Object.hasOwn(JSON.parse(unterminatedResponse.body), "tender"), false);

  const screenedResponse = createResponse();
  await handler(createRequest(notes), screenedResponse);
  const screenedResult = JSON.parse(screenedResponse.body);
  assert.equal(Object.hasOwn(screenedResult, "tender"), false);
  assert.deepEqual(screenedResult.verification.failures, [{ reason: "privacy_health" }]);
});

test("import overview reports provider HTTP failures", async (context) => {
  const restore = installProviderMock(context, () => new Response('{"type":"error"}', { status: 529 }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(restore.requests.length, 1);
  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      message: "Import overview failed",
      detail: {
        type: "provider_http_error",
        message: "Provider returned HTTP 529",
        provider_status: 529,
        provider_body: { type: "error" },
        stop_reason: null,
        usage: null
      }
    }
  });
  assert.match(JSON.stringify(restore.loggedErrors), /Import overview provider error.*529/u);
});

test("import overview reports max_tokens with provider usage", async (context) => {
  installProviderMock(context, () => providerResponse({
    content: [{ type: "text", text: "incomplete" }],
    stopReason: "max_tokens",
    usage: { input_tokens: 700000, output_tokens: 32000, output_tokens_details: { thinking_tokens: 28000 } }
  }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body).error.detail, {
    type: "stop_reason",
    message: "Provider stopped with max_tokens before completing the overview",
    stop_reason: "max_tokens",
    usage: { input_tokens: 700000, output_tokens: 32000, output_tokens_details: { thinking_tokens: 28000 } }
  });
});

test("import overview tolerates wrong optional types and unexpected fields", async (context) => {
  installProviderMock(context, () => providerResponse({
    content: [{
      type: "tool_use",
      name: "submit_import_overview",
      input: {
        portrait: "Partial output",
        read: 42,
        forgottenIdeas: [{ title: "An idea", why: "It may matter", unexpected: true }],
        questions: ["One?", 42, "Two?", "Three?", "Four?"],
        unexpectedTopLevel: true
      }
    }],
    stopReason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.portrait, "Partial output");
  assert.equal(Object.hasOwn(result, "read"), false);
  assert.equal(Object.hasOwn(result, "tender"), false);
  assert.deepEqual(result.questions, ["One?", "Two?", "Three?"]);
  assert.deepEqual(result.forgottenIdeas, [{ title: "An idea", whenWritten: "", why: "It may matter" }]);
  assert.deepEqual(result.verification, {
    totalChecks: 1,
    passed: 0,
    failed: 1,
    failures: [{ noteId: "", reason: "note_not_found" }]
  });
});

test("import overview reports failed fields and key shapes for unusable tool input", async (context) => {
  installProviderMock(context, () => providerResponse({
    content: [{
      type: "tool_use",
      name: "submit_import_overview",
      input: { forgottenIdeas: [{ title: "An idea", unexpected: true }], unexpectedTopLevel: true }
    }],
    stopReason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body).error.detail, {
    type: "tool_input_validation_error",
    message: "Provider tool input failed overview validation",
    failed_fields: [{ field: "portrait", reason: "missing", expected: "non-empty string" }],
    top_level_keys: ["forgottenIdeas", "unexpectedTopLevel"],
    first_forgotten_idea_keys: ["title", "unexpected"],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  });
});

test("import overview distinguishes empty portrait from malformed partial content", async (context) => {
  const providerResponses = [
    providerResponse({
      content: [{ type: "tool_use", name: "submit_import_overview", input: { portrait: "", forgottenIdeas: [] } }],
      stopReason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 200 }
    }),
    providerResponse({
      content: { partial: true },
      stopReason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 }
    })
  ];
  installProviderMock(context, () => providerResponses.shift());
  const notes = [note("one", "One", "Text", "2026-08-25T00:00:00.000Z")];

  const emptyResponse = createResponse();
  await handler(createRequest(notes), emptyResponse);
  assert.deepEqual(JSON.parse(emptyResponse.body).error.detail.failed_fields, [
    { field: "portrait", reason: "failed_constraint", constraint: "must not be empty" }
  ]);

  const partialResponse = createResponse();
  await handler(createRequest(notes), partialResponse);
  assert.deepEqual(JSON.parse(partialResponse.body).error.detail, {
    type: "missing_tool_output",
    message: "Provider response did not contain the required overview tool output",
    failed_fields: [{ field: "$", reason: "wrong_type", expected: "object", actual: "undefined" }],
    top_level_keys: [],
    first_forgotten_idea_keys: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 }
  });
});

test("import overview identifies malformed JSON and provider timeouts", async (context) => {
  const responses = [
    () => new Response("{not-json", { status: 200 }),
    () => {
      const error = new Error("The operation timed out");
      error.name = "TimeoutError";
      throw error;
    }
  ];
  installProviderMock(context, () => responses.shift()());
  const notes = [note("one", "One", "Text", "2026-08-25T00:00:00.000Z")];

  const parseResponse = createResponse();
  await handler(createRequest(notes), parseResponse);
  const parseDetail = JSON.parse(parseResponse.body).error.detail;
  assert.equal(parseDetail.type, "parse_error");
  assert.match(parseDetail.message, /JSON/u);
  assert.equal(typeof parseDetail.stack, "string");

  const timeoutResponse = createResponse();
  await handler(createRequest(notes), timeoutResponse);
  const timeoutDetail = JSON.parse(timeoutResponse.body).error.detail;
  assert.equal(timeoutDetail.type, "timeout");
  assert.equal(timeoutDetail.message, "The operation timed out");
  assert.equal(timeoutDetail.stop_reason, null);
  assert.equal(timeoutDetail.usage, null);
});

test("import overview rejects invalid createdAt values before calling the provider", async (context) => {
  const restore = installProviderMock(context, () => successfulProviderResponse(baseOverviewInput()));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "not-a-date")]), response);

  assert.equal(restore.requests.length, 0);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: { message: "Invalid notes array" } });
});

function baseOverviewInput(overrides = {}) {
  return {
    portrait: "Portrait",
    read: "Read",
    forgottenIdeas: [],
    tender: "You notice care. You keep the small details.",
    questions: ["What do you want?", "What keeps returning?", "What changed you?"],
    ...overrides
  };
}

function successfulProviderResponse(input) {
  return providerResponse({
    content: [{ type: "tool_use", name: "submit_import_overview", input }],
    stopReason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  });
}

function providerResponse({ content, stopReason, usage }) {
  return new Response(JSON.stringify({ content, stop_reason: stopReason, usage }), { status: 200 });
}

function installProviderMock(context, fetchImplementation) {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const requests = [];
  const loggedErrors = [];

  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return fetchImplementation(url, options);
  };
  console.error = (...args) => loggedErrors.push(args);

  context.after(() => {
    restoreEnvironment("ANTHROPIC_API_KEY", previousApiKey);
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  });

  return { requests, loggedErrors };
}

function createRequest(notes, fields = {}) {
  return { method: "POST", body: { notes, ...fields } };
}

function note(id, title, text, createdAt) {
  return { id, title, text, createdAt };
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
