import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { buildRequestBody, parseArguments } from "./overview-lab.mjs";

test("overview lab parses and passes through an optional birthdate", async () => {
  const parsed = await parseArguments(["notes", "--birthdate", "1990-04-12", "--limit", "10"]);

  assert.deepEqual(parsed, {
    folderPath: resolve("notes"),
    limit: 10,
    birthdate: "1990-04-12",
    labInstructions: undefined
  });
  assert.deepEqual(buildRequestBody([{ id: "one" }], parsed.labInstructions, parsed.birthdate), {
    notes: [{ id: "one" }],
    birthdate: "1990-04-12"
  });
});

test("overview lab rejects invalid birthdate flags", async () => {
  await assert.rejects(
    parseArguments(["notes", "--birthdate", "1990-02-30"]),
    /--birthdate must be a valid date in YYYY-MM-DD format/u
  );
  await assert.rejects(
    parseArguments(["notes", "--birthdate", "1990-04-12", "--birthdate", "1991-05-13"]),
    /--birthdate may only be provided once/u
  );
});
