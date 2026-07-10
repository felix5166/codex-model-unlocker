# Codex 模型解锁器

独立的 macOS 启动器，用来把中转站提供、但被 Codex 桌面端前端白名单隐藏的模型加入模型选择器。不依赖 Codex++，也不修改 Codex 安装包。

## 它做了什么

- 从 `~/.codex/cc-switch-model-catalog.json` 读取模型目录。
- 同时读取 `~/.codex/config.toml` 中当前配置的 `model`。
- 重启 Codex 时启用一个随机的 Chromium 调试端口，仅监听 `127.0.0.1`。
- 在运行时补充 Statsig 模型白名单，并复用 Codex 自身的 React 模型选择回调。
- Codex 退出后自动结束，所有运行时修改同时失效。

它不会修改 `ChatGPT.app`、`Codex.app`、`app.asar`、代码签名、API 密钥或历史会话。

## 赞助商

<p align="center">
  <a href="https://choohub.net">
    <img src="docs/images/choo-hub.png" alt="ChooHub" height="110">
  </a>
</p>
<p align="center">
  <a href="https://choohub.net/"><strong>统一 AI 网关，稳定转发调用</strong></a><br>
  ChooHub 为开发者提供统一的 AI 模型接入服务，通过一套配置即可在 ChatGPT/Codex 工作流中灵活切换所需模型，减少重复接入和环境维护成本，适合个人开发、团队协作与长期项目使用。
</p>


## 使用方法

仓库中的 [Codex-Model-Unlocker-v0.1.2-macOS.zip](release/Codex-Model-Unlocker-v0.1.2-macOS.zip) 是已经打包好的 macOS App，下载并解压后可以直接使用。

1. 确认 Codex 桌面端已经安装在 `/Applications/ChatGPT.app` 或 `/Applications/Codex.app`。
2. 确认模型目录位于 `~/.codex/cc-switch-model-catalog.json`。
3. 双击 `Codex 模型解锁器.app`，选择“重启并解锁”。
4. 新建任务并打开模型选择器。

首次打开如果被 macOS 拦截，可在 Finder 中右键应用并选择“打开”。

## 从源码构建

要求 macOS 13 或更高版本。构建过程只使用系统自带的 `zsh`、Quick Look、`sips`、`iconutil` 和 `codesign`。

```zsh
chmod +x build.sh CodexModelUnlocker test.sh
./test.sh
./build.sh
open "dist/Codex 模型解锁器.app"
```

默认输出到 `dist/`。也可以临时指定其他输出目录：

```zsh
OUTPUT_DIR="$HOME/Desktop" ./build.sh
```

## 源码结构

| 文件 | 作用 |
| --- | --- |
| `CodexModelUnlocker` | `.app` 的启动入口，选择 Codex 内置 Node.js |
| `injector.mjs` | 读取模型、启动 Codex、连接本机 CDP 并维护注入状态 |
| `injection.js` | 在模型菜单出现时补充白名单与自定义模型选项 |
| `Info.plist` | macOS 应用元数据 |
| `AppIcon.svg` | 应用图标源文件 |
| `build.sh` | 生成并临时签名 `.app` |
| `test.sh` | 源码和构建产物的静态检查 |

## 命令行调试

构建后可以直接运行内部注入器并输出日志：

```zsh
"dist/Codex 模型解锁器.app/Contents/MacOS/CodexModelUnlocker" --verbose
```

运行日志和锁文件分别位于：

- `~/Library/Logs/CodexModelUnlocker.log`
- `~/Library/Application Support/CodexModelUnlocker`

## 卸载

退出 Codex 后删除 `Codex 模型解锁器.app` 即可。需要清理运行记录时，再删除上面的日志和应用支持目录。

## 兼容性说明

这是针对 Codex 桌面端当前模型菜单结构的运行时适配。桌面端升级后如果改变 Statsig 配置键或 React 菜单结构，可能需要同步更新本项目。

## 免责声明

本项目是非官方的社区工具，与 OpenAI、Codex、ChatGPT 及任何中转服务商不存在隶属、授权或背书关系。项目只调整 Codex 桌面端运行时的前端模型可见性，不会提供或扩大任何账号、API、模型、付费功能或服务权限；模型出现在选择器中不代表对应服务一定可用。

使用第三方中转服务时，请自行评估其安全性、隐私政策和数据处理方式。API 密钥、提示词、文件及模型输出可能会经过该服务商的服务器，本项目无法控制或保证第三方服务的数据安全、稳定性、计费准确性及合规性。

使用者应自行确认其行为符合所在地法律法规，以及 OpenAI、Codex 和所使用服务商的条款。因安装、使用、修改或分发本项目导致的账号限制、数据泄露、费用损失、软件故障或其他直接、间接损失，项目作者及贡献者不承担责任。请在理解源码和风险后自行决定是否使用，并自行备份重要数据。

本项目按“现状”提供，不作任何明示或暗示的担保，包括但不限于适销性、特定用途适用性、兼容性和持续可用性担保。

## 许可证

本项目采用 [Unlicense](LICENSE)，在法律允许的范围内贡献至公共领域。软件按“现状”提供，不附带任何担保。
