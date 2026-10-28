# dsh-prompt-layer

给 [DeepSeek Harness](https://www.deepseek.com/harness/) 用的极小提示词层插件：**每轮把你自己的文本顶到系统提示最前面**，可选放宽审批与丢掉宿主基线。

单文件、零依赖、不修改任何 `@deepseek-ai/*` 包、不解包 asar、不带自更新。

## 它做什么

1. 注册一个 `order = -100000` 的 `systemPrompt` 段，内容来自你指定的文件（改文件即时生效，按 mtime 缓存）。
2. 可选：在 `system-prompt/assemble` 阶段丢弃宿主 workspace 基线段（默认关——丢了你的 `AGENTS.md` 就不进提示了）。
3. 可选：注册一个 `approval/request` 应答器，把所有审批请求判为 `allowed-once`（默认关）。

## 它不做什么

- 不改宿主源码、不接管更新、不动桌面端 `app.asar`
- 不写入/覆盖 `AGENTS.md`、不管理规则集
- 不联网

## 一条命令安装

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main/install.ps1 | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main/install.sh | bash
```

脚本只做四件事：把 `index.mjs` 复制进你的 DSH profile、建一个空的 `prompt-layer.md`、备份 `cordis.patch.yml`、在末尾追加插件配置（检测到已配置就跳过）。**不删除任何东西。**

跑完**完全退出宿主再打开**（托盘也要退），聊天里输 `/prompt-layer status`；然后把你的提示词写进 `~/.dsh/prompt-layer.md`（写文件即时生效）。

### 想直接用作者同款正文

仓库里有一份作者在用的 `prompt.full.md`，一条命令覆盖过去即可（会自动盖掉安装时建的空文件）：

```powershell
irm https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main/prompt.full.md -OutFile "$env:USERPROFILE\.dsh\prompt-layer.md"
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/yuuki64/dsh-prompt-layer/main/prompt.full.md -o ~/.dsh/prompt-layer.md
```

覆盖不用重启（文件按修改时间热读），`/prompt-layer status` 里长度变成 25900 左右就是接上了。不用这份正文的话，自己写 `~/.dsh/prompt-layer.md` 就行。

> 国内访问 `raw.githubusercontent.com` 不通时，换成 jsDelivr 镜像：
> `irm https://cdn.jsdelivr.net/gh/yuuki64/dsh-prompt-layer@main/install.ps1 | iex`
> （jsDelivr 对分支有缓存，更新可能延迟十几小时）

## 手动安装

1. 把 `index.mjs` 复制到 profile 目录，改名 `prompt-layer.mjs`：

```powershell
Copy-Item .\index.mjs "$env:USERPROFILE\.dsh\profiles\desktop\prompt-layer.mjs"
```

2. 建一个提示词文件（内容自己写）：

```powershell
notepad "$env:USERPROFILE\.dsh\prompt-layer.md"
```

3. 在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 末尾追加（改前先备份）：

```yaml
- insert:
    - id: prompt-layer
      name: ./prompt-layer.mjs
      config:
        promptFile: 'C:\Users\<you>\.dsh\prompt-layer.md'
        order: -100000
        dropBaseline: 'never'
        autoApprove: false
        verbose: false
- id: system-prompt
  config:
    includeHarnessIdentity: false
    personaPrefix: ''
```

4. 完全退出宿主再启动（托盘也要退）。聊天里输入 `/prompt-layer status` 查看状态。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `promptFile` | 空 | 提示词文本文件绝对路径；改文件即时生效 |
| `order` | `-100000` | 段顺序，越小越靠前（宿主身份是 `-1000`） |
| `dropBaseline` | `never` | `never` 保留 AGENTS.md；`when-inject` 有注入就丢；`always` 总丢 |
| `autoApprove` | `false` | 注册审批应答器，所有请求判 `allowed-once` |
| `maxBytes` | `524288` | 文件读取上限 |
| `verbose` | `false` | 写 `$DSH_HOME/logs/prompt-layer.log` |

## 卸载

删掉 profile 里的 `prompt-layer.mjs`、删掉 yaml 里那两段、重启。

## 注意

- `autoApprove: true` 之后，agent 执行命令、改文件不再询问；再配合 `sandbox-policy.mode: danger-full-access` 等于完全不设防。
- `dropBaseline: when-inject` 会让 `AGENTS.md` / 项目说明不再进入提示词，确认后再开。
- 提示词文件按原样注入（关闭了 `{{...}}` 插值），内容由使用者自行负责。

## 兼容

在 DeepSeek Harness 0.2.1-rc.3（桌面端）上验证：`ctx.systemPrompt.section()`、`system-prompt/assemble` waterfall、`approval/request` 应答器均可用。

## License

TBD（发布前请作者选定；未放 LICENSE 文件时默认保留所有权利）。
