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
  assert.equal(upstreamBody.max_tokens, 16000);
  assert.match(upstreamBody.system, /NEVER WRITE QUOTE TEXT YOURSELF/);
  assert.match(upstreamBody.system, /NEVER WRITE A YEAR, MONTH, CALENDAR DATE, OR DATE RANGE IN PROSE/);
  assert.ok(upstreamBody.tools[0].input_schema.properties.openingCitations);
  assert.ok(upstreamBody.tools[0].input_schema.properties.seasons.items.properties.citations);
  assert.deepEqual(Object.keys(upstreamBody.tools[0].input_schema.properties.openingCitations.items.properties), ["noteId", "startLine", "endLine"]);
  assert.ok(upstreamBody.tools[0].input_schema.properties.seasons.items.properties.noteIds);
  assert.equal(upstreamBody.tools[0].input_schema.properties.seasons.items.properties.period, undefined);
  assert.ok(upstreamBody.tools[0].input_schema.properties.forgottenIdeas.items.properties.sourceNoteId);
  assert.equal(upstreamBody.tools[0].input_schema.properties.forgottenIdeas.items.properties.whenWritten, undefined);

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
    tenderThread: "This malformed token said {{cite:9}}. Care remains.",
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
  assert.equal(result.language, "This remains.");
  assert.deepEqual(result.languageCitations, []);
  assert.equal(result.unchanged, "Another thought remains.");
  assert.equal(result.patterns, "The pattern remains.");
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
    passed: 8,
    failed: 7,
    failures: [
      { noteId: "", startLine: null, endLine: null, reason: "date_in_prose" },
      { noteId: "n99", startLine: 1, endLine: 1, reason: "note_not_found" },
      { noteId: "n1", startLine: 8, endLine: 9, reason: "invalid_locator" },
      { noteId: "n1", startLine: 3, endLine: 3, reason: "empty_span" },
      { noteId: "", startLine: null, endLine: null, reason: "invalid_locator" },
      { noteId: "n99", startLine: null, endLine: null, reason: "note_not_found" },
      { noteId: "n99", startLine: null, endLine: null, reason: "note_not_found" }
    ]
  });
  assert.deepEqual(restore.loggedErrors, [
    ["Import overview verification totalCitations=15 passed=8 failed=7"]
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
  assert.equal(result.opening, "You wrote “A short exact sentence.”");
  assert.equal(result.opening.includes("additional source words"), false);
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
  assert.deepEqual(JSON.parse(response.body), { error: { message: "Import overview failed" } });
  assert.match(JSON.stringify(restore.loggedErrors), /Import overview provider error.*529/);
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
  return new Response(JSON.stringify({
    content: [
      {
        type: "tool_use",
        name: "submit_import_overview",
        input
      }
    ]
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
