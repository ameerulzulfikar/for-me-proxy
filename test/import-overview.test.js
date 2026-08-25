import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/import-overview.js";

test("import overview sends a chronological labelled scaffold and authoritative timeline", async (context) => {
  const restore = installProviderMock(context, () => successfulProviderResponse(baseOverviewInput()));
  const request = createRequest([
    note("later", "Later", "Latest full text", "2025-05-10T12:00:00.000Z"),
    note("earliest-source-id", "Earliest", "Earliest full text", "2024-01-02T12:00:00.000Z"),
    note("middle", "Middle", "Middle full text", "2025-03-15T12:00:00.000Z")
  ]);
  const response = createResponse();

  await handler(request, response);

  const upstreamBody = JSON.parse(restore.requests[0].options.body);
  assert.equal(restore.requests.length, 1);
  assert.equal(upstreamBody.model, "claude-sonnet-5");
  assert.equal(upstreamBody.max_tokens, 16000);
  assert.match(upstreamBody.system, /Every date you write must be copied verbatim from a note label or from the timeline index/);
  assert.ok(upstreamBody.tools[0].input_schema.properties.openingCitations);
  assert.ok(upstreamBody.tools[0].input_schema.properties.seasons.items.properties.citations);

  const prompt = upstreamBody.messages[0].content[0].text;
  assert.equal(prompt.startsWith("TIMELINE INDEX — SERVER-COMPUTED AND AUTHORITATIVE"), true);
  assert.match(prompt, /\| Overall \| January 2024 – May 2025 \| 3 \|/);
  assert.match(prompt, /\| Year \| 2024 \| 1 \|/);
  assert.match(prompt, /\| Year \| 2025 \| 2 \|/);
  assert.ok(prompt.indexOf('[NOTE n1 | DATE: January 2024 | TITLE: "Earliest"]\nEarliest full text') < prompt.indexOf('[NOTE n2 | DATE: March 2025 | TITLE: "Middle"]\nMiddle full text'));
  assert.ok(prompt.indexOf('[NOTE n2 | DATE: March 2025 | TITLE: "Middle"]\nMiddle full text') < prompt.indexOf('[NOTE n3 | DATE: May 2025 | TITLE: "Later"]\nLatest full text'));
  assert.doesNotMatch(prompt, /earliest-source-id/);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).verification, {
    totalCitations: 0,
    passed: 0,
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

test("import overview removes fabricated quotes and corrects sourced dates", async (context) => {
  const providerInput = baseOverviewInput({
    opening: 'You wrote "exact phrase". You also wrote “fabricated thought”. A repeat said fabricated thought! This remains.',
    openingCitations: [
      { noteId: "n1", quote: '"exact phrase"' },
      { noteId: "n1", quote: "fabricated thought" }
    ],
    seasons: [
      {
        title: "One",
        period: "April 1900",
        narrative: 'You wrote "exact phrase".',
        citations: [{ noteId: "n1", quote: '"exact phrase"' }]
      },
      {
        title: "Two",
        period: "March 2025",
        narrative: "You tracked Project Cedar.",
        citations: [{ noteId: "n2", quote: "Project Cedar" }]
      },
      {
        title: "Three",
        period: "invented date",
        narrative: "No quoted words here.",
        citations: []
      }
    ],
    language: "You called it “missing words”.",
    languageCitations: [{ noteId: "n99", quote: "missing words" }],
    forgottenIdeas: [
      {
        title: "Cedar",
        whenWritten: "January 1999",
        why: "You named Project Cedar.",
        citations: [{ noteId: "n2", quote: "Project Cedar" }]
      },
      {
        title: "Unquoted",
        whenWritten: "",
        why: "No quote.",
        citations: []
      }
    ]
  });
  const restore = installProviderMock(context, () => successfulProviderResponse(providerInput));
  const response = createResponse();

  await handler(createRequest([
    note("old", "Old", "I wrote “exact\nphrase” here.", "2024-01-05T00:00:00.000Z"),
    note("new", "New", "I tracked Project Cedar carefully.", "2025-03-06T00:00:00.000Z")
  ]), response);

  assert.equal(restore.requests.length, 1);
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.opening, 'You wrote "exact phrase". This remains.');
  assert.doesNotMatch(result.opening, /fabricated thought/);
  assert.deepEqual(result.openingCitations, [{ noteId: "n1", quote: '"exact phrase"' }]);
  assert.equal(result.language, "");
  assert.deepEqual(result.languageCitations, []);
  assert.equal(result.seasons[0].period, "January 2024");
  assert.equal(result.seasons[1].period, "March 2025");
  assert.equal(result.seasons[2].period, "");
  assert.equal(result.forgottenIdeas[0].whenWritten, "March 2025");
  assert.deepEqual(result.verification, {
    totalCitations: 10,
    passed: 5,
    failed: 5,
    failures: [
      { noteId: "n1", quote: "fabricated thought", reason: "quote_not_in_note" },
      { noteId: "n99", quote: "missing words", reason: "note_not_found" },
      { noteId: "n1", quote: "April 1900", reason: "date_mismatch" },
      { noteId: "", quote: "invented date", reason: "date_mismatch" },
      { noteId: "n2", quote: "January 1999", reason: "date_mismatch" }
    ]
  });
  assert.deepEqual(restore.loggedErrors, [
    ["Import overview verification totalCitations=10 passed=5 failed=5"]
  ]);
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
      { title: "One", period: "", narrative: "First", citations: [] },
      { title: "Two", period: "", narrative: "Second", citations: [] },
      { title: "Three", period: "", narrative: "Third", citations: [] }
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
