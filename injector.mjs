import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.21";
const APP_TITLE = "ChatGPT自定义模型";
const HOME = os.homedir();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SUPPORT_DIR = path.join(HOME, "Library", "Application Support", "CodexModelUnlocker");
const STATE_PATH = path.join(SUPPORT_DIR, "state.json");
const LOCK_PATH = path.join(SUPPORT_DIR, "launcher.lock");
const LOG_PATH = path.join(HOME, "Library", "Logs", "CodexModelUnlocker.log");
const MODEL_CONFIG = path.join(SCRIPT_DIR, "models.json");
const STATUS_MENU_PATH = path.join(SCRIPT_DIR, "ChatGPTCustomModelsStatusMenu");
const BUNDLE_ID = "com.openai.codex";
let statusMenuProcess = null;

fs.mkdirSync(SUPPORT_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

const args = process.argv.slice(2);
const optionValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const hasOption = (name) => args.includes(name);
const attachPort = Number(optionValue("--attach-port") || 0);
const runOnce = hasOption("--once");
const noDialog = hasOption("--no-dialog");
const requestedAppPath = optionValue("--app");

const log = (message, detail = null) => {
  const suffix = detail == null
    ? ""
    : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  const line = `${new Date().toISOString()} ${message}${suffix}`;
  fs.appendFileSync(LOG_PATH, `${line}\n`, { mode: 0o600 });
  if (hasOption("--verbose")) process.stderr.write(`${line}\n`);
};

const runAppleScript = (script) => spawnSync(
  "/usr/bin/osascript",
  ["-e", script],
  { encoding: "utf8" },
);

const quoteAppleScript = (value) => String(value)
  .replaceAll("\\", "\\\\")
  .replaceAll("\"", "\\\"")
  .replaceAll("\n", " ");

const notify = (message) => {
  if (noDialog) return;
  runAppleScript(`display notification "${quoteAppleScript(message)}" with title "${APP_TITLE}"`);
};

const showError = (message) => {
  log("error", message);
  if (noDialog) return;
  runAppleScript(`display alert "${APP_TITLE}" message "${quoteAppleScript(message)}" as critical`);
};

const startStatusMenu = (models) => {
  if (statusMenuProcess || !fs.existsSync(STATUS_MENU_PATH)) return;
  try {
    statusMenuProcess = spawn(
      STATUS_MENU_PATH,
      ["--parent-pid", String(process.pid), "--models", JSON.stringify(models)],
      { detached: true, stdio: "ignore" },
    );
    statusMenuProcess.once("error", (error) => {
      log("status_menu_failed", String(error?.message || error));
      statusMenuProcess = null;
    });
    statusMenuProcess.unref();
  } catch (error) {
    log("status_menu_failed", String(error?.message || error));
    statusMenuProcess = null;
  }
};

const confirmRestart = () => {
  if (noDialog) return true;
  const result = runAppleScript([
    `display dialog "需要重启一次 Codex 才能解锁本地模型选择器。调试端口只会绑定到 127.0.0.1。"`,
    `with title "${APP_TITLE}"`,
    `buttons {"取消", "重启并解锁"}`,
    `default button "重启并解锁"`,
    `cancel button "取消"`,
    `with icon caution`,
  ].join(" "));
  return result.status === 0;
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const acquireLock = () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(LOCK_PATH, "wx", 0o600);
      fs.writeFileSync(descriptor, String(process.pid));
      fs.closeSync(descriptor);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const pid = Number(fs.readFileSync(LOCK_PATH, "utf8").trim());
      if (processIsAlive(pid)) return false;
      fs.rmSync(LOCK_PATH, { force: true });
    }
  }
  return false;
};

const releaseLock = () => {
  try {
    const pid = Number(fs.readFileSync(LOCK_PATH, "utf8").trim());
    if (pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
  } catch {
    // The lock may already be gone during shutdown.
  }
};

const candidateApps = [
  requestedAppPath,
  "/Applications/ChatGPT.app",
  "/Applications/Codex.app",
  path.join(HOME, "Applications", "ChatGPT.app"),
  path.join(HOME, "Applications", "Codex.app"),
].filter(Boolean);

const findApp = () => candidateApps.find((candidate) => fs.existsSync(candidate));

const appIsRunning = (appPath) => {
  const pattern = `${appPath}/Contents/MacOS/`;
  return spawnSync("/usr/bin/pgrep", ["-f", pattern]).status === 0;
};

const bringAppToFront = (appPath) => {
  spawnSync("/usr/bin/open", [appPath]);
};

const quitApp = async (appPath) => {
  runAppleScript(`tell application id "${BUNDLE_ID}" to quit`);
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (!appIsRunning(appPath)) return true;
    await sleep(250);
  }
  return false;
};

const getFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => (error ? reject(error) : resolve(port)));
  });
});

const bundleExecutable = (appPath) => {
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  let declared = "";
  try {
    const result = spawnSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPath],
      { encoding: "utf8" },
    );
    declared = result.status === 0 ? result.stdout.trim() : "";
  } catch {
    // Fall back to the app name when plutil is unavailable or Info.plist is invalid.
  }
  const appName = path.basename(appPath, ".app");
  const names = [declared, appName, "ChatGPT", "Codex"].filter((name, index, all) => (
    name && !name.includes("/") && all.indexOf(name) === index
  ));
  const executable = names
    .map((name) => path.join(appPath, "Contents", "MacOS", name))
    .find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error(`未找到应用可执行文件：${path.join(appPath, "Contents", "MacOS")}`);
  return executable;
};

const launchApp = (appPath, port) => new Promise((resolve, reject) => {
  let executable;
  try {
    executable = bundleExecutable(appPath);
  } catch (error) {
    reject(error);
    return;
  }
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.once("error", (error) => {
    log("app_launch_failed", { executable, error: String(error?.message || error) });
    reject(new Error(`启动应用失败：${String(error?.message || error)}`));
  });
  child.once("spawn", () => {
    child.unref();
    resolve();
  });
});

const normalizeModel = (item) => {
  const id = typeof item === "string"
    ? item
    : item?.id || item?.model || item?.slug || item?.name;
  if (typeof id !== "string") return null;
  const normalizedId = id.trim();
  if (!normalizedId || normalizedId.length > 160 || /[\u0000-\u001f]/.test(normalizedId)) return null;
  const displayName = typeof item === "object" && typeof item?.displayName === "string"
    ? item.displayName.trim()
    : normalizedId;
  if (!displayName || displayName.length > 160 || /[\u0000-\u001f]/.test(displayName)) return null;
  return { id: normalizedId, displayName };
};

const loadModels = () => {
  if (!fs.existsSync(MODEL_CONFIG)) return [];
  const config = JSON.parse(fs.readFileSync(MODEL_CONFIG, "utf8"));
  const configured = Array.isArray(config) ? config : config.models;
  const models = Array.isArray(configured) ? configured.map(normalizeModel) : [];
  const unique = new Map();
  for (const model of models.filter(Boolean)) {
    if (!unique.has(model.id)) unique.set(model.id, model);
  }
  return [...unique.values()];
};

const buildInjectionSource = (models) => {
  const template = fs.readFileSync(path.join(SCRIPT_DIR, "injection.js"), "utf8");
  const marker = "const BOOT_MODELS = [];";
  if (!template.includes(marker)) throw new Error("Injection template marker is missing");
  return template.replace(marker, `const BOOT_MODELS = ${JSON.stringify(models)};`);
};

const fetchJson = async (url, timeoutMs = 1500) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
};

const fetchTargets = async (port) => {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  if (!Array.isArray(targets)) return [];
  return targets.filter((target) => (
    ["page", "webview"].includes(target.type)
    && typeof target.webSocketDebuggerUrl === "string"
    && !String(target.url || "").startsWith("devtools://")
    && !String(target.url || "").includes("avatar-overlay")
  ));
};

class CDPSession {
  constructor(target) {
    this.target = target;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.scriptIdentifier = null;
  }

  async connect() {
    this.socket = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket connection timed out")), 5000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket connection failed"));
      }, { once: true });
    });

    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id == null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
      else pending.resolve(message.result || {});
    });

    this.socket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();
    });

    await this.command("Page.enable");
  }

  command(method, params = {}) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP session is not connected"));
    }
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 7000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async inject(source) {
    if (this.scriptIdentifier) {
      await this.command("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: this.scriptIdentifier,
      }).catch(() => {});
    }
    const registered = await this.command("Page.addScriptToEvaluateOnNewDocument", {
      source,
      runImmediately: true,
    });
    this.scriptIdentifier = registered.identifier || null;

    const evaluated = await this.command("Runtime.evaluate", {
      expression: source,
      returnByValue: true,
      awaitPromise: false,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (evaluated.exceptionDetails) {
      const description = evaluated.exceptionDetails.exception?.description
        || evaluated.exceptionDetails.text
        || "Injection evaluation failed";
      throw new Error(description);
    }
    return evaluated.result?.value || null;
  }

  close() {
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      // Ignore close errors during shutdown.
    }
  }
}

const writeState = (state) => {
  const temporary = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, STATE_PATH);
};

const cleanupState = () => {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (state.pid === process.pid) fs.rmSync(STATE_PATH, { force: true });
  } catch {
    // State is optional during partial startup.
  }
};

const waitForTargets = async (port, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchTargets(port);
      if (targets.length > 0) return targets;
    } catch {
      // The DevTools endpoint is expected to be unavailable during startup.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for the Codex renderer");
};

const main = async () => {
  if (!acquireLock()) {
    const appPath = findApp();
    if (appPath) bringAppToFront(appPath);
    notify("模型解锁已在运行");
    return;
  }

  const appPath = findApp();
  if (!appPath && !attachPort) throw new Error("未找到 ChatGPT.app 或 Codex.app");

  let models = loadModels();
  if (models.length === 0) {
    throw new Error(`模型配置中没有可用模型：${MODEL_CONFIG}`);
  }

  let port = attachPort;
  if (!port) {
    if (appIsRunning(appPath)) {
      if (!confirmRestart()) {
        log("restart_cancelled");
        return;
      }
      const stopped = await quitApp(appPath);
      if (!stopped) throw new Error("Codex 未能正常退出；请手动退出后重试");
    }

    port = await getFreePort();
    await launchApp(appPath, port);
  }

  log("launcher_started", { version: VERSION, appPath, port, models });
  writeState({ pid: process.pid, version: VERSION, appPath, port, models, startedAt: Date.now() });
  startStatusMenu(models);
  await waitForTargets(port);

  const sessions = new Map();
  let source = buildInjectionSource(models);
  let sourceKey = JSON.stringify(models);
  let successNotified = false;
  let appMissingSince = null;

  while (true) {
    let targets = [];
    try {
      targets = await fetchTargets(port);
    } catch (error) {
      if (runOnce) throw error;
    }

    const activeIds = new Set(targets.map((target) => target.id));
    for (const [id, session] of sessions) {
      if (!activeIds.has(id) || session.closed) {
        session.close();
        sessions.delete(id);
      }
    }

    let injectedThisPass = 0;
    for (const target of targets) {
      if (sessions.has(target.id)) continue;
      const session = new CDPSession(target);
      try {
        await session.connect();
        const result = await session.inject(source);
        sessions.set(target.id, session);
        injectedThisPass += 1;
        log("target_injected", {
          targetId: target.id,
          title: target.title,
          url: target.url,
          result,
        });
      } catch (error) {
        session.close();
        log("target_injection_failed", { targetId: target.id, error: String(error?.message || error) });
      }
    }

    if (!successNotified && sessions.size > 0) {
      successNotified = true;
      notify(`已解锁 ${models.length} 个模型：${models.map((model) => model.displayName).join(", ")}`);
    }

    if (runOnce && (injectedThisPass > 0 || sessions.size > 0)) break;

    const nextModels = loadModels();
    const nextKey = JSON.stringify(nextModels);
    if (nextModels.length > 0 && nextKey !== sourceKey) {
      models = nextModels;
      sourceKey = nextKey;
      source = buildInjectionSource(models);
      for (const session of sessions.values()) {
        try {
          await session.inject(source);
        } catch (error) {
          log("target_reinjection_failed", String(error?.message || error));
        }
      }
      writeState({ pid: process.pid, version: VERSION, appPath, port, models, startedAt: Date.now() });
      notify(`模型目录已更新：${models.map((model) => model.displayName).join(", ")}`);
    }

    if (!attachPort && !appIsRunning(appPath)) {
      appMissingSince ??= Date.now();
      if (Date.now() - appMissingSince > 5000) break;
    } else {
      appMissingSince = null;
    }

    await sleep(1000);
  }

  for (const session of sessions.values()) session.close();
  log("launcher_stopped");
};

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { statusMenuProcess?.kill("SIGTERM"); } catch {}
  statusMenuProcess = null;
  cleanupState();
  releaseLock();
};

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("exit", shutdown);

try {
  await main();
} catch (error) {
  showError(String(error?.message || error));
  process.exitCode = 1;
} finally {
  shutdown();
}
