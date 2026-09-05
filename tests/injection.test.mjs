import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../injection.js", import.meta.url), "utf8");
const MODEL_CONFIG = "107580212";
const MODEL = { id: "test-custom-model", displayName: "Test Custom Model" };
const plain = (value) => ({ value });
const normalize = (value) => JSON.parse(JSON.stringify(value));

function boot(configs = {}, models = [MODEL]) {
  const calls = [];
  const intervals = new Map();
  const timeouts = new Map();
  const listeners = new Map();
  const documentListeners = new Map();
  let sequence = 0;
  const sdk = {
    getDynamicConfig(name, ...args) {
      calls.push({ name, args, receiver: this });
      if (Object.hasOwn(configs, name)) {
        const value = configs[name];
        return typeof value === "function" ? value() : value;
      }
      return plain({});
    },
  };
  class FakeResponse {
    constructor(url, payload) {
      this.url = url;
      this.payload = payload;
    }

    async json() {
      return this.payload;
    }
  }
  const window = {
    __STATSIG__: { firstInstance: sdk },
    setInterval(fn, ms) {
      const id = ++sequence;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    setTimeout(fn, ms) {
      const id = ++sequence;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    dispatchEvent() {
      return true;
    },
    addEventListener(name, fn) {
      listeners.set(fn, name);
    },
    removeEventListener(_name, fn) {
      listeners.delete(fn);
    },
  };
  const context = vm.createContext({
    window,
    document: {
      scripts: [],
      documentElement: null,
      querySelectorAll: () => [],
      addEventListener(name, fn) {
        documentListeners.set(fn, name);
      },
      removeEventListener(_name, fn) {
        documentListeners.delete(fn);
      },
    },
    performance: { getEntriesByType: () => [] },
    URL,
    Response: FakeResponse,
    Node: { ELEMENT_NODE: 1 },
    fetch: async () => {
      throw new Error("Unexpected network call in offline test");
    },
  });
  let executable = source.replace(
    "const BOOT_MODELS = [];",
    `const BOOT_MODELS = ${JSON.stringify(models)};`,
  );
  executable = executable.replace(
    "  window[GLOBAL_KEY] = state;",
    "  window.__testApi = { refreshOnce };\n  window[GLOBAL_KEY] = state;",
  );
  new vm.Script(executable, { filename: "injection-under-test.js" })
    .runInContext(context, { timeout: 1000 });
  return {
    sdk,
    calls,
    window,
    intervals,
    timeouts,
    listeners,
    documentListeners,
    state: window.__CODEX_MODEL_UNLOCKER__,
    api: window.__testApi,
  };
}

test("non-model dynamic configs retain their identity and shape", () => {
  const config = plain({ enabled: true, review_threshold: 0.5 });
  const value = config.value;
  const env = boot({ guardian: config });

  assert.equal(env.sdk.getDynamicConfig("guardian"), config);
  assert.equal(config.value, value);
  assert.deepEqual(config.value, { enabled: true, review_threshold: 0.5 });
  env.state.dispose();
});

test("non-model value getters are not inspected", () => {
  let reads = 0;
  const config = {
    get value() {
      reads += 1;
      throw new Error("must not read");
    },
  };
  const env = boot({ unrelated: config });

  assert.equal(env.sdk.getDynamicConfig("unrelated"), config);
  assert.equal(reads, 0);
  env.state.dispose();
});

test("the model config is extended without mutating the SDK cache", () => {
  const config = plain({ available_models: ["existing"], keep: { setting: true } });
  const env = boot({ [MODEL_CONFIG]: config }, [MODEL, MODEL]);

  const result = env.sdk.getDynamicConfig(MODEL_CONFIG);
  assert.notEqual(result, config);
  assert.notEqual(result.value, config.value);
  assert.deepEqual(normalize(result.value.available_models), ["existing", MODEL.id]);
  assert.deepEqual(config.value.available_models, ["existing"]);
  assert.equal(result.value.keep, config.value.keep);
  env.state.dispose();
});

test("unknown or malformed model config shapes fail closed", async (t) => {
  for (const [name, value] of [
    ["missing", undefined],
    ["null", null],
    ["record", {}],
    ["mixed list", ["existing", 7]],
  ]) {
    await t.test(name, () => {
      const config = plain(value === undefined ? { enabled: true } : { available_models: value });
      const env = boot({ [MODEL_CONFIG]: config });
      assert.equal(env.sdk.getDynamicConfig(MODEL_CONFIG), config);
      env.state.dispose();
    });
  }
});

test("frozen model configs are handled with copy-on-write", () => {
  const config = Object.freeze(plain(Object.freeze({
    available_models: Object.freeze(["existing"]),
  })));
  const env = boot({ [MODEL_CONFIG]: config });

  assert.deepEqual(
    normalize(env.sdk.getDynamicConfig(MODEL_CONFIG).value.available_models),
    ["existing", MODEL.id],
  );
  assert.deepEqual(config.value.available_models, ["existing"]);
  env.state.dispose();
});

test("an own get method preserves SDK behavior and extends only the model list", () => {
  const backing = { available_models: ["existing"], another: { keep: true } };
  const getCalls = [];
  const config = {
    value: backing,
    get(key, fallback, extra) {
      getCalls.push({ receiver: this, key, fallback, extra });
      return backing[key] ?? fallback;
    },
  };
  const env = boot({ [MODEL_CONFIG]: config });
  const result = env.sdk.getDynamicConfig(MODEL_CONFIG);
  const fallback = [];

  assert.deepEqual(normalize(result.get("available_models", fallback, "extra")), ["existing", MODEL.id]);
  assert.equal(getCalls[0].receiver, config);
  assert.equal(getCalls[0].fallback, fallback);
  assert.equal(getCalls[0].extra, "extra");
  assert.equal(result.get("another", null), backing.another);
  assert.deepEqual(backing.available_models, ["existing"]);
  env.state.dispose();
});

test("prototype get methods fail closed", () => {
  class Config {
    #models = ["existing"];

    value = { available_models: ["existing"] };

    get() {
      return this.#models;
    }
  }
  const config = new Config();
  const env = boot({ [MODEL_CONFIG]: config });

  assert.equal(env.sdk.getDynamicConfig(MODEL_CONFIG), config);
  env.state.dispose();
});

test("SDK errors and request arguments are preserved", () => {
  const expected = new Error("SDK failure");
  const env = boot({ bad: () => { throw expected; } });
  const options = { disableExposureLog: false };

  assert.throws(
    () => env.sdk.getDynamicConfig("bad", options, "third argument"),
    (error) => error === expected,
  );
  const call = env.calls.at(-1);
  assert.equal(call.receiver, env.sdk);
  assert.equal(call.args[0], options);
  assert.equal(call.args[1], "third argument");
  env.state.dispose();
});

test("refresh discovers the wrapper without reading dynamic configs", () => {
  const env = boot();
  const wrapper = env.sdk.getDynamicConfig;

  for (let index = 0; index < 100; index += 1) env.api.refreshOnce();
  assert.equal(env.sdk.getDynamicConfig, wrapper);
  assert.equal(env.calls.length, 0);
  assert.equal(env.state.statsigPatches.length, 1);
  env.state.dispose();
});

test("dispose restores the SDK method and leaves its cache clean", () => {
  const config = plain({ available_models: ["existing"] });
  const env = boot({ [MODEL_CONFIG]: config });

  env.sdk.getDynamicConfig(MODEL_CONFIG);
  env.state.dispose();
  assert.equal(env.window.__CODEX_MODEL_UNLOCKER__, undefined);
  assert.equal(env.intervals.size + env.timeouts.size + env.listeners.size + env.documentListeners.size, 0);
  assert.equal(env.sdk.getDynamicConfig(MODEL_CONFIG), config);
  assert.deepEqual(config.value.available_models, ["existing"]);
});
