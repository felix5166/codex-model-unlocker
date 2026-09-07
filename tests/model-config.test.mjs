import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadModels, saveModels, validateModels, handlePanelRequest } from "../model-config.mjs";

const defaults = [{ id: "gpt-6-astra" }];

test("bundled config starts empty without replacing saved models", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "custom-models-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "models.json");
  const defaultPath = new URL("../models.json", import.meta.url);
  assert.deepEqual(loadModels(configPath, defaultPath), []);
  assert.equal(fs.existsSync(configPath), false);
  const previousConfig = JSON.stringify({ models: [{ ...defaults[0], displayName: "GPT-6 Astra" }] });
  fs.writeFileSync(configPath, previousConfig);
  assert.deepEqual(loadModels(configPath, defaultPath), defaults);
  assert.equal(fs.readFileSync(configPath, "utf8"), previousConfig);
});

test("model validation accepts only IDs and rejects invalid rows", () => {
  assert.deepEqual(validateModels([{ id: " alias-id " }]), [{ id: "alias-id" }]);
  assert.deepEqual(validateModels([{ id: "alias-id", displayName: "旧名称" }]), [{ id: "alias-id" }]);
  for (const invalid of [null, {}, [null], [{}], [{ id: 123 }], [{ id: "" }], [{ id: "   " }],
    [{ id: "a\nb" }], [{ id: "x".repeat(161) }],
    [defaults[0], { ...defaults[0], id: " gpt-6-astra " }]]) {
    assert.throws(() => validateModels(invalid));
  }
  assert.deepEqual(validateModels([]), []);
});

test("save/load/restart contract preserves config on invalid input and restart failure", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "custom-models-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "user", "models.json");
  const defaultPath = path.join(directory, "defaults.json");
  saveModels(defaultPath, defaults);
  let restarts = 0;
  let restartFails = false;
  const options = { configPath, defaultPath, restart: async (models) => {
    restarts += 1;
    assert.deepEqual(loadModels(configPath, defaultPath), models);
    if (restartFails) throw new Error("test restart failure");
  } };
  assert.deepEqual(loadModels(configPath, defaultPath), defaults);
  assert.equal(fs.existsSync(configPath), false);
  assert.equal((await handlePanelRequest({ action: "load" }, options)).ok, true);
  const custom = [{ id: "relay-alias" }];
  const saved = await handlePanelRequest({ action: "save", restart: false, models: custom }, options);
  assert.equal(saved.ok, true);
  assert.equal(restarts, 0);
  assert.deepEqual(loadModels(configPath, defaultPath), custom);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { models: custom });
  assert.deepEqual(loadModels(defaultPath, defaultPath), defaults);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ["models.json"]);
  const invalid = await handlePanelRequest({ action: "save", restart: true, models: [...custom, ...custom] }, options);
  assert.equal(invalid.ok, false);
  assert.equal(restarts, 0);
  assert.deepEqual(loadModels(configPath, defaultPath), custom);
  assert.equal((await handlePanelRequest({ action: "save", restart: "yes", models: [] }, options)).ok, false);
  restartFails = true;
  const failed = await handlePanelRequest({ action: "save", restart: true, models: defaults }, options);
  assert.equal(failed.ok, false);
  assert.equal(failed.saved, true);
  assert.match(failed.error, /配置已保存/);
  assert.deepEqual(loadModels(configPath, defaultPath), defaults);
  restartFails = false;
  const cleared = await handlePanelRequest({ action: "save", restart: true, models: [] }, options);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.restarted, true);
  assert.deepEqual(loadModels(configPath, defaultPath), []);
  fs.writeFileSync(configPath, "broken JSON");
  assert.equal((await handlePanelRequest({ action: "load" }, options)).ok, false);
  assert.equal(fs.readFileSync(configPath, "utf8"), "broken JSON");
  const blockedPath = path.join(directory, "not-a-directory");
  fs.writeFileSync(blockedPath, "untouched");
  const cannotSave = await handlePanelRequest({ action: "save", restart: true, models: custom },
    { ...options, configPath: path.join(blockedPath, "models.json") });
  assert.equal(cannotSave.ok, false);
  assert.equal(cannotSave.saved, false);
  assert.equal(restarts, 2);
  assert.equal(fs.readFileSync(blockedPath, "utf8"), "untouched");
});
