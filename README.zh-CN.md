# Claude Code GMN Proxy

[English README](./README.md)

让 Claude Code 直接复用已经为 Codex 配置好的模型和供应商。

## 目标

在一台已经能正常使用 Codex 的机器上：

1. 安装 Claude Code
2. 安装这个桥接代理
3. 运行 `claude-codex`

整个过程不需要手动改写网关配置。

## 工作原理

- 从 `~/.codex/config.toml` 读取当前生效的 Codex 模型与供应商配置
- 从 `~/.codex/auth.json` 读取上游 API Key
- 暴露一个本地 Anthropic 兼容接口给 Claude Code 使用
- 将 Claude Code 的 `POST /v1/messages` 请求转换为 OpenAI 的 `POST /v1/responses`
- 当你运行 `claude-codex` 时自动拉起本地代理

## 安装

先安装 Claude Code：

```bash
npm install -g @anthropic-ai/claude-code
```

再安装这个桥接代理：

```bash
npm install -g github:yang0/claude-code-gmn-proxy
```

## 使用方式

交互式：

```bash
claude-codex
```

非交互式：

```bash
claude-codex -p "Reply with PONG only." --output-format json
```

别名命令：

```bash
cloud-code
```

## 平台说明

- Linux 和 Windows 都可用
- Linux 下可选安装 `systemd` 用户服务
- Windows 下直接运行 `claude-codex` 即可，不依赖 WSL 或 `bash`

## 可选：systemd 用户服务

安装后台用户服务：

```bash
cloud-code-proxy-install-service
```

更多说明见 `docs/systemd-user-service.md`。

## 本地开发

```bash
npm test
node src/server.mjs
```

## 说明

- 这个桥接代理围绕 Claude Code CLI 的工作流设计，不是完整的 Anthropic API 兼容层
- 即使没有安装 `systemd`，代理也可以按需自动启动
- 如果已经安装了用户服务，启动器会优先复用该服务
