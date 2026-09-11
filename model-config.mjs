import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CONTEXT_K = 272;
const EFFECTIVE_CONTEXT_PERCENT = 95;

const parseContextK = (value, index) => {
  if (value == null || value === "") return DEFAULT_CONTEXT_K;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(number) || number < 1 || number > 10_000) {
    throw new Error(`第 ${index + 1} 行窗口必须是 1 到 10000 的整数（单位 k）`);
  }
  return number;
};

export const validateModels = (models) => {
  if (!Array.isArray(models)) throw new Error("模型配置必须是列表");
  const ids = new Set();
  return models.map((model, index) => {
    const value = model?.id;
    if (typeof value !== "string" || !value.trim() || value.trim().length > 160
        || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`第 ${index + 1} 行模型 ID 不能为空、包含控制字符或超过 160 个字符`);
    }
    const id = value.trim();
    if (ids.has(id)) throw new Error(`第 ${index + 1} 行模型 ID 重复：${id}`);
    ids.add(id);
    return { id, context: parseContextK(model.context, index) };
  });
};

export const loadModels = (configPath, defaultPath) => {
  const source = fs.existsSync(configPath) ? configPath : defaultPath;
  const config = JSON.parse(fs.readFileSync(source, "utf8"));
  return validateModels(config.models);
};

const atomicWrite = (filePath, contents) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

export const saveModels = (configPath, models) => {
  const validated = validateModels(models);
  atomicWrite(configPath, `${JSON.stringify({ models: validated }, null, 2)}\n`);
  return validated;
};

const MINIMAL_MODEL = {
  slug: "",
  display_name: "",
  description: "",
  visibility: "list",
  supported_in_api: true,
  shell_type: "unified_exec",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [],
};

const applyWindow = (entry, tokens) => {
  entry.context_window = tokens;
  entry.max_context_window = tokens;
  entry.effective_context_window_percent = EFFECTIVE_CONTEXT_PERCENT;
};

export const buildCatalog = (bundled, models) => {
  const base = Array.isArray(bundled?.models)
    ? bundled.models.map((entry) => JSON.parse(JSON.stringify(entry)))
    : [];
  const template = base.find((entry) => entry?.slug === "gpt-6-astra") || base[0] || MINIMAL_MODEL;
  const bySlug = new Map(base.map((entry) => [entry.slug, entry]));
  for (const model of models) {
    const tokens = model.context * 1000;
    const existing = bySlug.get(model.id);
    if (existing) {
      applyWindow(existing, tokens);
      existing.visibility = "list";
      continue;
    }
    const entry = {
      ...JSON.parse(JSON.stringify(template)),
      slug: model.id,
      display_name: model.id,
      description: model.id,
      visibility: "list",
      auto_compact_token_limit: null,
      availability_nux: null,
      upgrade: null,
    };
    applyWindow(entry, tokens);
    base.push(entry);
    bySlug.set(model.id, entry);
  }
  return { models: base };
};

export const writeCatalog = (catalogPath, catalog) => {
  atomicWrite(catalogPath, `${JSON.stringify(catalog)}\n`);
};

export const handlePanelRequest = async (request, { configPath, defaultPath, restart, applyCatalog }) => {
  let savedModels;
  try {
    if (request.action === "load") {
      return { ok: true, models: loadModels(configPath, defaultPath) };
    }
    if (request.action !== "save" || typeof request.restart !== "boolean") {
      throw new Error("无效的面板操作");
    }
    savedModels = saveModels(configPath, request.models);
    if (applyCatalog) await applyCatalog(savedModels);
    if (request.restart) await restart(savedModels);
    return { ok: true, saved: true, restarted: request.restart, models: savedModels };
  } catch (error) {
    return {
      ok: false,
      saved: savedModels !== undefined,
      ...(savedModels === undefined ? {} : { models: savedModels }),
      error: `${savedModels === undefined ? "" : "配置已保存，但未能生效："}${error.message}`,
    };
  }
};
