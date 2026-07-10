(() => {
  "use strict";

  const BOOT_MODELS = [];
  const VERSION = "0.1.2";
  const GLOBAL_KEY = "__CODEX_MODEL_UNLOCKER__";
  const STATSIG_MODEL_CONFIG = "107580212";

  const uniqueModelNames = (values) => Array.from(new Set(
    values
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  ));

  if (window[GLOBAL_KEY]?.version === VERSION) {
    window[GLOBAL_KEY].update(BOOT_MODELS);
    return {
      installed: true,
      reused: true,
      models: window[GLOBAL_KEY].models,
      version: VERSION,
    };
  }

  const state = {
    version: VERSION,
    models: uniqueModelNames(BOOT_MODELS),
    selectedModel: uniqueModelNames(BOOT_MODELS)[0] || "",
    installedAt: Date.now(),
    failures: [],
    refreshTimer: null,
    refreshUntil: 0,
  };

  const recordFailure = (scope, error) => {
    state.failures.push({
      scope,
      message: String(error?.message || error),
      at: Date.now(),
    });
    if (state.failures.length > 30) state.failures.shift();
  };

  const modelDescriptor = (name) => ({
    id: name,
    model: name,
    slug: name,
    name,
    displayName: name,
    description: "Custom relay model",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [
      { reasoningEffort: "none", description: "Disable reasoning" },
      { reasoningEffort: "low", description: "Light reasoning" },
      { reasoningEffort: "medium", description: "Balanced reasoning" },
      { reasoningEffort: "high", description: "Deep reasoning" },
      { reasoningEffort: "xhigh", description: "Extra high reasoning" },
    ],
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
  });

  const patchStatsigConfig = (config) => {
    const value = config?.value;
    if (!value || typeof value !== "object") return config;

    const available = Array.isArray(value.available_models)
      ? [...value.available_models]
      : [];
    let changed = false;
    for (const name of state.models) {
      if (!available.includes(name)) {
        available.push(name);
        changed = true;
      }
    }
    if (!changed) return config;

    const nextValue = { ...value, available_models: available };
    try {
      config.value = nextValue;
      return config;
    } catch {
      return { ...config, value: nextValue };
    }
  };

  const statsigClients = () => {
    const root = window.__STATSIG__ || globalThis.__STATSIG__;
    if (!root || typeof root !== "object") return [];
    const clients = [
      root.firstInstance,
      typeof root.instance === "function" ? root.instance() : null,
    ];
    if (root.instances && typeof root.instances === "object") {
      clients.push(...Object.values(root.instances));
    }
    return clients.filter((client, index, all) => (
      client && typeof client === "object" && all.indexOf(client) === index
    ));
  };

  const patchStatsig = () => {
    let patched = false;
    for (const client of statsigClients()) {
      if (typeof client.getDynamicConfig !== "function") continue;
      if (!client.__codexModelUnlockerPatched) {
        const original = client.getDynamicConfig.bind(client);
        client.getDynamicConfig = (name, options) => patchStatsigConfig(original(name, options));
        client.__codexModelUnlockerPatched = true;
        patched = true;
      }
      try {
        patchStatsigConfig(client.getDynamicConfig(STATSIG_MODEL_CONFIG, {
          disableExposureLog: true,
        }));
      } catch (error) {
        recordFailure("statsig-config", error);
      }
    }
    return patched;
  };

  const modelDisplayName = (name) => String(name || "")
    .replace(/^gpt-/i, "GPT-")
    .replace(/-(sol|terra|luna)$/i, (_, suffix) => ` ${suffix[0].toUpperCase()}${suffix.slice(1).toLowerCase()}`);

  const modelSelectContext = (element) => {
    const fiberKey = Object.keys(element || {}).find((key) => key.startsWith("__reactFiber"));
    let fiber = fiberKey ? element[fiberKey] : null;
    for (let depth = 0; fiber && depth < 35; depth += 1, fiber = fiber.return) {
      const props = fiber.pendingProps;
      if (props?.modelOption && typeof props.onSelect === "function") {
        return {
          onSelect: props.onSelect,
          modelOption: props.modelOption,
          selectedModel: props.selectedModel,
          selectedReasoningEffort: props.selectedReasoningEffort,
        };
      }
    }
    return null;
  };

  const replaceModelText = (element, fromValues, toValue) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const normalized = fromValues.map((value) => String(value || "").trim()).filter(Boolean);
    let node = walker.nextNode();
    while (node) {
      const text = String(node.nodeValue || "").trim();
      if (normalized.includes(text)) node.nodeValue = String(node.nodeValue).replace(text, toValue);
      node = walker.nextNode();
    }
  };

  const selectCustomModel = (event, name, context) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const now = Date.now();
    if (state.lastSelection?.name === name && now - state.lastSelection.at < 500) return;
    state.lastSelection = { name, at: now };
    state.selectedModel = name;

    const effort = context.selectedReasoningEffort
      || modelDescriptor(name).defaultReasoningEffort;
    context.onSelect(name, effort);
    window.setTimeout(() => {
      patchSelectedModelLabels();
      refreshBurst(1500);
    }, 0);
  };

  const patchCustomModelMenus = () => {
    let changed = false;
    for (const menu of document.querySelectorAll("[role='menu']")) {
      const items = [...menu.querySelectorAll("[role='menuitem']")];
      const sample = items.find((item) => modelSelectContext(item));
      if (!sample) continue;

      const context = modelSelectContext(sample);
      if (!context) continue;
      state.selectedModel = context.selectedModel || state.selectedModel;

      for (const name of [...state.models].reverse()) {
        if (menu.querySelector(`[data-codex-model-unlocker-row="${CSS.escape(name)}"]`)) continue;
        if (items.some((item) => modelSelectContext(item)?.modelOption?.model === name)) continue;

        const clone = sample.cloneNode(true);
        const displayName = modelDisplayName(name);
        clone.removeAttribute("id");
        clone.removeAttribute("data-highlighted");
        clone.setAttribute("data-codex-model-unlocker-row", name);
        clone.setAttribute("aria-label", displayName);
        clone.setAttribute("data-model-selected", context.selectedModel === name ? "true" : "false");
        replaceModelText(
          clone,
          [context.modelOption.displayName, context.modelOption.model],
          displayName,
        );

        clone.addEventListener("pointerdown", (event) => selectCustomModel(event, name, context), true);
        clone.addEventListener("click", (event) => selectCustomModel(event, name, context), true);
        clone.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") selectCustomModel(event, name, context);
        }, true);
        sample.parentNode?.insertBefore(clone, sample);
        changed = true;
      }
    }
    return changed;
  };

  const patchSelectedModelLabels = () => {
    const name = state.selectedModel;
    if (!state.models.includes(name)) return false;
    const displayName = modelDisplayName(name);
    let changed = false;

    const candidates = [
      document.querySelector("[data-codex-intelligence-trigger='true']"),
      ...document.querySelectorAll("[role='menuitem'][aria-label^='Model '], [role='menuitem'][aria-label^='模型 ']")
    ].filter(Boolean);

    for (const candidate of candidates) {
      const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = String(node.nodeValue || "").trim().toLowerCase();
        if (text === "custom" || text === "自定义") {
          node.nodeValue = String(node.nodeValue).replace(String(node.nodeValue).trim(), displayName);
          changed = true;
        }
        node = walker.nextNode();
      }
    }
    return changed;
  };

  const refreshOnce = () => {
    patchStatsig();
    let changed = false;
    if (patchCustomModelMenus()) changed = true;
    if (patchSelectedModelLabels()) changed = true;
    return changed;
  };

  const refreshBurst = (durationMs = 3000) => {
    state.refreshUntil = Math.max(state.refreshUntil, Date.now() + durationMs);
    if (state.refreshTimer) return;

    const tick = () => {
      state.refreshTimer = null;
      try {
        refreshOnce();
      } catch (error) {
        recordFailure("refresh", error);
      }
      if (Date.now() < state.refreshUntil) {
        state.refreshTimer = window.setTimeout(tick, 120);
      }
    };
    tick();
  };

  state.update = (models) => {
    state.models = uniqueModelNames(models);
    refreshBurst(3500);
    return state.models;
  };
  state.refresh = () => refreshBurst(3500);
  state.diagnostics = () => ({
    version: state.version,
    models: [...state.models],
    installedAt: state.installedAt,
    failures: [...state.failures],
    statsigClients: statsigClients().length,
    selectedModel: state.selectedModel,
    injectedRows: document.querySelectorAll("[data-codex-model-unlocker-row]").length,
  });

  window[GLOBAL_KEY] = state;

  const startObserver = () => {
    if (!document.documentElement || state.observer) return;
    state.observer = new MutationObserver((mutations) => {
      const shouldRefresh = mutations.some((mutation) => (
        [...mutation.addedNodes].some((node) => (
          node?.nodeType === Node.ELEMENT_NODE
          && (
            node.matches?.("[role='menu'], [role='dialog'], [role='listbox'], [data-radix-popper-content-wrapper]")
            || node.querySelector?.("[role='menu'], [role='dialog'], [role='listbox'], [data-radix-popper-content-wrapper]")
          )
        ))
      ));
      if (shouldRefresh) refreshBurst();
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  };

  startObserver();
  if (!state.observer) {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  }
  state.interval = window.setInterval(refreshOnce, 1000);
  document.addEventListener("pointerdown", (event) => {
    const item = event.target?.closest?.("[role='menuitem']");
    const context = item ? modelSelectContext(item) : null;
    if (context?.modelOption?.model) state.selectedModel = context.modelOption.model;
  }, true);
  refreshBurst(5000);

  return {
    installed: true,
    reused: false,
    models: state.models,
    version: VERSION,
  };
})();
