import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildCatalog, loadModels, saveModels, validateModels, handlePanelRequest } from "../model-config.mjs";

const defaults = [{ id: "gpt-6-astra", context: 272 }];

test("bundled config starts empty without replacing saved models", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "custom-models-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "models.json");
  const defaultPath = new URL("../models.json", import.meta.url);
  assert.deepEqual(loadModels(configPath, defaultPath), []);
  assert.equal(fs.existsSync(configPath), false);
  const previousConfig = JSON.stringify({ models: [{ id: "gpt-6-astra", displayName: "GPT-6 Astra" }] });
  fs.writeFileSync(configPath, previousConfig);
  assert.deepEqual(loadModels(configPath, defaultPath), defaults);
  assert.equal(fs.readFileSync(configPath, "utf8"), previousConfig);
});

test("model validation accepts IDs with default context and rejects invalid rows", () => {
  assert.deepEqual(validateModels([{ id: " alias-id " }]), [{ id: "alias-id", context: 272 }]);
  assert.deepEqual(validateModels([{ id: "alias-id", displayName: "旧名称" }]), [{ id: "alias-id", context: 272 }]);
  assert.deepEqual(validateModels([{ id: "x", context: " 1000 " }]), [{ id: "x", context: 1000 }]);
  for (const invalid of [null, {}, [null], [{}], [{ id: 123 }], [{ id: "" }], [{ id: "   " }],
    [{ id: "a\nb" }], [{ id: "x".repeat(161) }],
    [defaults[0], { ...defaults[0], id: " gpt-6-astra " }],
    [{ id: "x", context: 0 }], [{ id: "x", context: 1.5 }], [{ id: "x", context: 10001 }],
    [{ id: "x", context: "abc" }]]) {
    assert.throws(() => validateModels(invalid));
  }
  assert.deepEqual(validateModels([]), []);
});

test("catalog overlay keeps bundled models and applies k windows", () => {
  const bundled = { models: [{
    slug: "gpt-6-astra",
    display_name: "GPT-6-Astra",
    context_window: 272000,
    max_context_window: 872000,
    effective_context_window_percent: 95,
    visibility: "list",
    extra: "keep",
  }] };
  const catalog = buildCatalog(bundled, [
    { id: "gpt-6-astra", context: 272 },
    { id: "deepseek-v4-pro", context: 1000 },
  ]);
  assert.equal(catalog.models.length, 2);
  assert.deepEqual(catalog.models[0], {
    slug: "gpt-6-astra",
    display_name: "GPT-6-Astra",
    context_window: 272000,
    max_context_window: 272000,
    effective_context_window_percent: 95,
    visibility: "list",
    extra: "keep",
  });
  assert.equal(catalog.models[1].slug, "deepseek-v4-pro");
  assert.equal(catalog.models[1].display_name, "deepseek-v4-pro");
  assert.equal(catalog.models[1].context_window, 1_000_000);
  assert.equal(catalog.models[1].max_context_window, 1_000_000);
  assert.equal(catalog.models[1].effective_context_window_percent, 95);
  assert.equal(catalog.models[1].extra, "keep");
  assert.deepEqual(buildCatalog(bundled, []).models, bundled.models);
});

test("save/load/restart contract preserves config on invalid input and restart failure", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "custom-models-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "user", "models.json");
  const defaultPath = path.join(directory, "defaults.json");
  saveModels(defaultPath, [{ id: "gpt-6-astra" }]);
  let restarts = 0;
  let catalogs = 0;
  let restartFails = false;
  let catalogFails = false;
  const options = {
    configPath,
    defaultPath,
    restart: async (models) => {
      restarts += 1;
      assert.deepEqual(loadModels(configPath, defaultPath), models);
      if (restartFails) throw new Error("test restart failure");
    },
    applyCatalog: async (models) => {
      catalogs += 1;
      assert.deepEqual(loadModels(configPath, defaultPath), models);
      if (catalogFails) throw new Error("test catalog failure");
    },
  };
  assert.deepEqual(loadModels(configPath, defaultPath), defaults);
  assert.equal(fs.existsSync(configPath), false);
  assert.equal((await handlePanelRequest({ action: "load" }, options)).ok, true);
  const custom = [{ id: "relay-alias", context: 1000 }];
  const saved = await handlePanelRequest({ action: "save", restart: false, models: custom }, options);
  assert.equal(saved.ok, true);
  assert.equal(restarts, 0);
  assert.equal(catalogs, 1);
  assert.deepEqual(loadModels(configPath, defaultPath), custom);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { models: custom });
  assert.deepEqual(loadModels(defaultPath, defaultPath), defaults);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ["models.json"]);
  const invalid = await handlePanelRequest({ action: "save", restart: true, models: [...custom, ...custom] }, options);
  assert.equal(invalid.ok, false);
  assert.equal(restarts, 0);
  assert.equal(catalogs, 1);
  assert.deepEqual(loadModels(configPath, defaultPath), custom);
  assert.equal((await handlePanelRequest({ action: "save", restart: "yes", models: [] }, options)).ok, false);
  catalogFails = true;
  const catalogFailed = await handlePanelRequest({ action: "save", restart: true, models: defaults }, options);
  assert.equal(catalogFailed.ok, false);
  assert.equal(catalogFailed.saved, true);
  assert.match(catalogFailed.error, /配置已保存，但未能生效/);
  assert.equal(restarts, 0);
  assert.equal(catalogs, 2);
  assert.deepEqual(loadModels(configPath, defaultPath), defaults);
  catalogFails = false;
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
  assert.equal(catalogs, 4);
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
  assert.equal(catalogs, 4);
  assert.equal(fs.readFileSync(blockedPath, "utf8"), "untouched");
});
