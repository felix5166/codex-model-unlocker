import fs from "node:fs";
import path from "node:path";

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
    return { id };
  });
};

export const loadModels = (configPath, defaultPath) => {
  const source = fs.existsSync(configPath) ? configPath : defaultPath;
  const config = JSON.parse(fs.readFileSync(source, "utf8"));
  return validateModels(config.models);
};

export const saveModels = (configPath, models) => {
  const validated = validateModels(models);
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ models: validated }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return validated;
};

export const handlePanelRequest = async (request, { configPath, defaultPath, restart }) => {
  let savedModels;
  try {
    if (request.action === "load") {
      return { ok: true, models: loadModels(configPath, defaultPath) };
    }
    if (request.action !== "save" || typeof request.restart !== "boolean") {
      throw new Error("无效的面板操作");
    }
    savedModels = saveModels(configPath, request.models);
    if (request.restart) await restart(savedModels);
    return { ok: true, saved: true, restarted: request.restart, models: savedModels };
  } catch (error) {
    return {
      ok: false,
      saved: savedModels !== undefined,
      ...(savedModels === undefined ? {} : { models: savedModels }),
      error: `${savedModels === undefined ? "" : "配置已保存，但重启应用失败："}${error.message}`,
    };
  }
};
