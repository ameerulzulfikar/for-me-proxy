import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/import-overview.js";

test("import overview sends a chronological labelled scaffold and authoritative timeline", async (context) => {
  const restore = installProviderMock(context, () => successfulProviderResponse(baseOverviewInput()));
  const request = createRequest([
    note("later", "Later", "Latest full text", "2025-05-10T12:00:00.000Z"),
    note("earliest-source-id", "Earliest", "Earliest first line\n\nEarliest third line", "2024-01-02T12:00:00.000Z"),
    note("middle", "Middle", "Middle full text", "2025-03-15T12:00:00.000Z")
  ]);
  const response = createResponse();

  await handler(request, response);

  const upstreamBody = JSON.parse(restore.requests[0].options.body);
  assert.equal(restore.requests.length, 1);
  assert.equal(upstreamBody.model, "claude-sonnet-5");
  assert.equal(upstreamBody.max_tokens, 32000);
  assert.ok(restore.requests[0].options.signal instanceof AbortSignal);
  assert.match(upstreamBody.system, /NEVER WRITE QUOTE TEXT YOURSELF/);
  assert.match(upstreamBody.system, /NEVER WRITE A YEAR, MONTH, CALENDAR DATE, DATE RANGE, OR BARE AGE IN PROSE/);
  assert.match(upstreamBody.system, /Do not write phrases such as "at 19"/);
  assert.match(upstreamBody.system, /at the start of the real estate years/);
  assert.match(upstreamBody.system, /HARD REQUIREMENT: every individual season narrative must contain at least five complete sentences and no more than nine/);
  assert.match(upstreamBody.system, /A season narrative under five sentences is invalid output/);
  assert.match(upstreamBody.system, /Aim for 4-6 seasons total, not more/);
  assert.match(upstreamBody.system, /Every season must include at least one citation token.*at least one concrete non-quoted specific/);
  assert.match(upstreamBody.system, /one substantial paragraph of 6-10 sentences about what the writing style itself reveals/);
  assert.match(upstreamBody.system, /Choose quotes for emotional or revealing weight, not as decoration/);
  assert.match(upstreamBody.system, /Your job is depth, not coverage/);
  assert.ok(upstreamBody.tools[0].input_schema.properties.openingCitations);
  assert.ok(upstreamBody.tools[0].input_schema.properties.seasons.items.properties.citations);
  assert.deepEqual(Object.keys(upstreamBody.tools[0].input_schema.properties.openingCitations.items.properties), ["noteId", "startLine", "endLine"]);
  assert.ok(upstreamBody.tools[0].input_schema.properties.seasons.items.properties.noteIds);
  assert.equal(upstreamBody.tools[0].input_schema.properties.seasons.items.properties.period, undefined);
  assert.ok(upstreamBody.tools[0].input_schema.properties.forgottenIdeas.items.properties.sourceNoteId);
  assert.equal(upstreamBody.tools[0].input_schema.properties.forgottenIdeas.items.properties.whenWritten, undefined);
  assert.deepEqual(upstreamBody.tools[0].input_schema.required, ["opening", "openingCitations", "seasons", "language", "languageCitations", "unchanged", "unchangedCitations", "patterns", "patternsCitations", "forgottenIdeas", "tenderThread", "tenderThreadCitations"]);
  assert.deepEqual(upstreamBody.tools[0].input_schema.properties.seasons.items.required, ["title", "noteIds", "narrative", "citations"]);
  assert.match(upstreamBody.tools[0].input_schema.properties.seasons.items.properties.narrative.description, /5-9 sentences.*Fewer than five sentences is invalid output/);
  assert.equal(upstreamBody.tools[0].input_schema.properties.seasons.items.properties.citations.minItems, 1);
  assert.equal(upstreamBody.tools[0].input_schema.properties.forgottenIdeas.minItems, 3);
  assert.deepEqual(upstreamBody.tools[0].input_schema.properties.forgottenIdeas.items.required, ["title", "sourceNoteId", "why", "citations"]);

  const prompt = upstreamBody.messages[0].content[0].text;
  assert.equal(prompt.startsWith("TIMELINE INDEX — SERVER-COMPUTED AND AUTHORITATIVE"), true);
  assert.match(prompt, /\| Overall \| January 2024 – May 2025 \| 3 \|/);
  assert.match(prompt, /\| Year \| 2024 \| 1 \|/);
  assert.match(prompt, /\| Year \| 2025 \| 2 \|/);
  assert.match(prompt, /\[NOTE n1 \| DATE: January 2024 \| TITLE: "Earliest"\]\nn1\|L1\| Earliest first line\nn1\|L2\| \nn1\|L3\| Earliest third line/);
  assert.ok(prompt.indexOf('[NOTE n1 | DATE: January 2024 | TITLE: "Earliest"]') < prompt.indexOf('[NOTE n2 | DATE: March 2025 | TITLE: "Middle"]\nn2|L1| Middle full text'));
  assert.ok(prompt.indexOf('[NOTE n2 | DATE: March 2025 | TITLE: "Middle"]') < prompt.indexOf('[NOTE n3 | DATE: May 2025 | TITLE: "Later"]\nn3|L1| Latest full text'));
  assert.doesNotMatch(prompt, /earliest-source-id/);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).verification, {
    totalCitations: 3,
    passed: 3,
    failed: 0,
    failures: []
  });
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
  assert.match(prompt, /\| Year \| 2025 \| 12 \|/);
  assert.match(prompt, /\| Month \| January 2025 \| 1 \|/);
  assert.match(prompt, /\| Month \| December 2025 \| 1 \|/);
  assert.equal(response.statusCode, 200);
});

test("import overview substitutes exact line locators, computes dates, and removes invalid evidence", async (context) => {
  const providerInput = baseOverviewInput({
    opening: "In 2020 you were rushing. You wrote {{cite:0}} in a list. This remains.",
    openingCitations: [{ noteId: "n1", startLine: 1, endLine: 2 }],
    seasons: [
      {
        title: "One",
        noteIds: ["n2", "n1"],
        narrative: "You wrote {{cite:0}} early on.",
        citations: [{ noteId: "n1", startLine: 1, endLine: 1 }]
      },
      {
        title: "Two",
        noteIds: ["n2"],
        narrative: "You tracked {{cite:0}} carefully.",
        citations: [{ noteId: "n2", startLine: 1, endLine: 1 }]
      },
      {
        title: "Three",
        noteIds: ["n99"],
        narrative: "No quoted words here.",
        citations: []
      }
    ],
    language: "This bad source said {{cite:0}}. This remains.",
    languageCitations: [{ noteId: "n99", startLine: 1, endLine: 1 }],
    unchanged: "This bad range said {{cite:0}}. Another thought remains.",
    unchangedCitations: [{ noteId: "n1", startLine: 8, endLine: 9 }],
    patterns: "This empty source said {{cite:0}}. The pattern remains.",
    patternsCitations: [{ noteId: "n1", startLine: 3, endLine: 3 }],
    forgottenIdeas: [
      {
        title: "Cedar",
        sourceNoteId: "n2",
        why: "You named {{cite:0}}.",
        citations: [{ noteId: "n2", startLine: 1, endLine: 1 }]
      },
      {
        title: "Unquoted",
        sourceNoteId: "n99",
        why: "No quote.",
        citations: []
      }
    ],
    tenderThread: "This malformed token said {{cite:9}}. You clearly redrafted this more than once. Care remains.",
    tenderThreadCitations: []
  });
  const restore = installProviderMock(context, () => successfulProviderResponse(providerInput));
  const response = createResponse();

  await handler(createRequest([
    note("old", "Old", "exact phrase\r\nsecond exact line\r\n", "2024-01-05T00:00:00.000Z"),
    note("new", "New", "Project Cedar\ncarefully tracked", "2025-03-06T00:00:00.000Z")
  ]), response);

  assert.equal(restore.requests.length, 1);
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.opening, "You wrote “exact phrase\r\nsecond exact line” in a list. This remains.");
  assert.deepEqual(result.openingCitations, [{ noteId: "n1", startLine: 1, endLine: 2 }]);
  assert.equal(result.language, "");
  assert.deepEqual(result.languageCitations, []);
  assert.equal(result.unchanged, "Another thought remains.");
  assert.equal(result.patterns, "This empty source said “second exact line”. The pattern remains.");
  assert.deepEqual(result.patternsCitations, [{ noteId: "n1", startLine: 2, endLine: 2 }]);
  assert.equal(result.tenderThread, "Care remains.");
  assert.equal(result.seasons[0].period, "Jan 2024 – Mar 2025");
  assert.equal(result.seasons[1].period, "Mar 2025");
  assert.equal(result.seasons[2].period, "");
  assert.equal(result.seasons[0].narrative, "You wrote “exact phrase” early on.");
  assert.equal(result.seasons[1].narrative, "You tracked “Project Cedar” carefully.");
  assert.equal(result.forgottenIdeas[0].whenWritten, "Mar 2025");
  assert.equal(result.forgottenIdeas[1].whenWritten, "");
  assert.deepEqual(result.verification, {
    totalCitations: 15,
    passed: 9,
    failed: 6,
    failures: [
      { noteId: "", startLine: null, endLine: null, reason: "date_in_prose" },
      { noteId: "n99", startLine: 1, endLine: 1, citationIndex: 0, citationsAvailable: 1, reason: "note_not_found" },
      { noteId: "n1", startLine: 8, endLine: 9, citationIndex: 0, citationsAvailable: 1, reason: "invalid_locator" },
      { noteId: null, startLine: null, endLine: null, citationIndex: 9, citationsAvailable: 0, reason: "invalid_locator" },
      { noteId: "n99", startLine: null, endLine: null, reason: "note_not_found" },
      { noteId: "n99", startLine: null, endLine: null, reason: "note_not_found" }
    ]
  });
  assert.deepEqual(restore.loggedErrors, [
    ["Import overview verification totalCitations=15 passed=9 failed=6"]
  ]);
});

test("import overview trims a long cited span at its first sentence", async (context) => {
  const longLine = `A short exact sentence. ${"additional source words ".repeat(20)}`;
  const providerInput = baseOverviewInput({
    opening: "You wrote {{cite:0}}",
    openingCitations: [{ noteId: "n1", startLine: 1, endLine: 1 }]
  });
  installProviderMock(context, () => successfulProviderResponse(providerInput));
  const response = createResponse();

  await handler(createRequest([note("one", "One", longLine, "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.opening, "You wrote “A short exact sentence”.");
  assert.equal(result.opening.includes("additional source words"), false);
});

test("import overview wraps extracted text with one balanced quote pair and cleans trailing punctuation", async (context) => {
  const providerInput = baseOverviewInput({
    opening: "A revealing line was {{cite:0}} in a task list. You repeated {{cite:1}}.",
    openingCitations: [
      { noteId: "n1", startLine: 1, endLine: 1 },
      { noteId: "n1", startLine: 2, endLine: 2 }
    ]
  });
  installProviderMock(context, () => successfulProviderResponse(providerInput));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", '"call psych\'s asap. )\n“Keep going!””', "2026-08-25T00:00:00.000Z")
  ]), response);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.opening, "A revealing line was “call psych's asap” in a task list. You repeated “Keep going”.");
  assert.equal((result.opening.match(/“/gu) || []).length, 2);
  assert.equal((result.opening.match(/”/gu) || []).length, 2);
  assert.doesNotMatch(result.opening, /["„‟″«»]/u);
});

test("import overview makes exactly one provider attempt on failure", async (context) => {
  let attempts = 0;
  const restore = installProviderMock(context, () => {
    attempts += 1;
    return new Response('{"type":"error"}', { status: 529 });
  });
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(attempts, 1);
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
  assert.match(JSON.stringify(restore.loggedErrors), /Import overview provider error.*529/);
});

test("import overview reports max_tokens with provider usage instead of flattening it", async (context) => {
  const restore = installProviderMock(context, () => providerResponse({
    content: [{ type: "text", text: "incomplete" }],
    stopReason: "max_tokens",
    usage: {
      input_tokens: 700000,
      output_tokens: 32000,
      output_tokens_details: { thinking_tokens: 28000 }
    }
  }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      message: "Import overview failed",
      detail: {
        type: "stop_reason",
        message: "Provider stopped with max_tokens before completing the overview",
        stop_reason: "max_tokens",
        usage: {
          input_tokens: 700000,
          output_tokens: 32000,
          output_tokens_details: { thinking_tokens: 28000 }
        }
      }
    }
  });
  assert.match(JSON.stringify(restore.loggedErrors), /stop_reason=max_tokens.*output_tokens=32000/);
});

test("import overview tolerates missing metadata, wrong optional types, and unexpected fields", async (context) => {
  installProviderMock(context, () => providerResponse({
    content: [{
      type: "tool_use",
      name: "submit_import_overview",
      input: {
        opening: "Partial output",
        seasons: [{ title: "A usable season", narrative: "A usable narrative", unexpected: true }],
        language: 42,
        patterns: { unexpected: true },
        forgottenIdeas: [{ title: "An idea", why: "It may matter", unexpected: true }],
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
  assert.equal(result.opening, "Partial output");
  assert.deepEqual(result.openingCitations, []);
  assert.deepEqual(result.seasons, [{
    title: "A usable season",
    period: "",
    narrative: "A usable narrative",
    citations: []
  }]);
  assert.equal(result.language, "");
  assert.equal(result.unchanged, "");
  assert.equal(result.patterns, "");
  assert.equal(result.tenderThread, "");
  assert.deepEqual(result.forgottenIdeas, [{
    title: "An idea",
    whenWritten: "",
    why: "It may matter",
    citations: []
  }]);
  assert.deepEqual(result.verification, {
    totalCitations: 1,
    passed: 0,
    failed: 1,
    failures: [{ noteId: "", startLine: null, endLine: null, reason: "note_not_found" }]
  });
});

test("import overview reports failed fields and key shapes for an unusable tool payload", async (context) => {
  installProviderMock(context, () => providerResponse({
    content: [{
      type: "tool_use",
      name: "submit_import_overview",
      input: {
        seasons: "not-an-array",
        forgottenIdeas: [{ title: "An idea", unexpected: true }],
        unexpectedTopLevel: true
      }
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
    failed_fields: [
      { field: "opening", reason: "missing", expected: "non-empty string" },
      { field: "seasons", reason: "wrong_type", expected: "array", actual: "string" }
    ],
    top_level_keys: ["seasons", "forgottenIdeas", "unexpectedTopLevel"],
    first_season_keys: [],
    first_forgotten_idea_keys: ["title", "unexpected"],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  });
});

test("import overview distinguishes empty core fields as failed constraints", async (context) => {
  installProviderMock(context, () => providerResponse({
    content: [{
      type: "tool_use",
      name: "submit_import_overview",
      input: { opening: "", seasons: [], forgottenIdeas: [] }
    }],
    stopReason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body).error.detail.failed_fields, [
    { field: "opening", reason: "failed_constraint", constraint: "must not be empty" },
    { field: "seasons", reason: "failed_constraint", constraint: "must contain at least one object" }
  ]);
});

test("import overview handles malformed partial content without entering verification", async (context) => {
  installProviderMock(context, () => providerResponse({
    content: { partial: true },
    stopReason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 }
  }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body).error.detail, {
    type: "missing_tool_output",
    message: "Provider response did not contain the required overview tool output",
    failed_fields: [{ field: "$", reason: "wrong_type", expected: "object", actual: "undefined" }],
    top_level_keys: [],
    first_season_keys: [],
    first_forgotten_idea_keys: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 }
  });
});

test("import overview identifies malformed provider JSON as a parse error", async (context) => {
  installProviderMock(context, () => new Response("{not-json", { status: 200 }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  const detail = JSON.parse(response.body).error.detail;
  assert.equal(detail.type, "parse_error");
  assert.match(detail.message, /JSON/u);
  assert.equal(typeof detail.stack, "string");
  assert.equal(detail.stop_reason, null);
  assert.equal(detail.usage, null);
});

test("import overview identifies a provider timeout", async (context) => {
  installProviderMock(context, () => {
    const error = new Error("The operation timed out");
    error.name = "TimeoutError";
    throw error;
  });
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  const detail = JSON.parse(response.body).error.detail;
  assert.equal(detail.type, "timeout");
  assert.equal(detail.message, "The operation timed out");
  assert.equal(detail.stop_reason, null);
  assert.equal(detail.usage, null);
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
    opening: "Opening",
    openingCitations: [],
    seasons: [
      { title: "One", noteIds: ["n1"], narrative: "First", citations: [] },
      { title: "Two", noteIds: ["n1"], narrative: "Second", citations: [] },
      { title: "Three", noteIds: ["n1"], narrative: "Third", citations: [] }
    ],
    language: "Language",
    languageCitations: [],
    unchanged: "Unchanged",
    unchangedCitations: [],
    patterns: "Patterns",
    patternsCitations: [],
    forgottenIdeas: [],
    tenderThread: "Tender thread",
    tenderThreadCitations: [],
    ...overrides
  };
}

function successfulProviderResponse(input) {
  return providerResponse({
    content: [
      {
        type: "tool_use",
        name: "submit_import_overview",
        input
      }
    ],
    stopReason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  });
}

function providerResponse({ content, stopReason, usage }) {
  return new Response(JSON.stringify({
    content,
    stop_reason: stopReason,
    usage
  }), { status: 200 });
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

function createRequest(notes) {
  return { method: "POST", body: { notes } };
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
