import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredSecrets, secretsFor } from "./workers.mjs";

function worker(secretsFile) {
  const dir = mkdtempSync(join(tmpdir(), "worker-"));
  if (secretsFile !== undefined) writeFileSync(join(dir, "secrets"), secretsFile);
  return dir;
}

test("a Worker without a secrets file declares nothing", () => {
  const dir = worker();
  assert.deepEqual(declaredSecrets(dir), []);
  assert.deepEqual(secretsFor(dir, { ANYTHING: "x" }), {});
});

test("the secrets file lists names, ignoring blanks, comments and repeats", () => {
  const dir = worker("# the token\nAPI_TOKEN\n\n  OTHER_SECRET  \nAPI_TOKEN\n");
  assert.deepEqual(declaredSecrets(dir), ["API_TOKEN", "OTHER_SECRET"]);
});

test("a name that is not UPPER_SNAKE is refused", () => {
  const dir = worker("api-token\n");
  assert.throws(() => declaredSecrets(dir), /not a secret name: api-token/);
});

test("secretsFor pairs every declared name with its value and names what is missing", () => {
  const dir = worker("API_TOKEN\nOTHER_SECRET\n");
  assert.deepEqual(secretsFor(dir, { API_TOKEN: "t", OTHER_SECRET: "o", UNRELATED: "u" }), { API_TOKEN: "t", OTHER_SECRET: "o" });
  assert.throws(() => secretsFor(dir, { API_TOKEN: "t" }), /not in the production environment's secrets: OTHER_SECRET/);
  assert.throws(() => secretsFor(dir, { API_TOKEN: "t", OTHER_SECRET: "" }), /OTHER_SECRET/);
  assert.throws(() => secretsFor(dir, undefined), /API_TOKEN, OTHER_SECRET/);
});
