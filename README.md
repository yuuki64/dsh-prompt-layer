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

脚本会装到 `$DSH_HOME/profiles/` 下所有 profile（desktop、web 一起），做四件事：把 `index.mjs` 复制进每个 profile、建一个空的 `prompt-layer.md`、备份各自的 `cordis.patch.yml`、在末尾追加配置（检测到已配置就跳过）。**不删除任何东西。**

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

4. 完全退出宿主再启动（托盘也要退）。聊天里输入 `/prompt-layer status` 查看状态，`/prompt-layer lint` 体检正文，`/prompt-layer snap|diff|undo` 管理版本。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `promptFile` | 空 | 全局提示词文件绝对路径；改文件即时生效 |
| `workspaceFile` | `.dsh-prompt-layer.md` | 工作区覆盖：当前目录存在这个文件就优先用它 |
| `order` | `-100000` | 段顺序，越小越靠前（宿主身份是 `-1000`） |
| `dropBaseline` | `never` | `never` 保留 AGENTS.md；`when-inject` 有注入就丢；`always` 总丢 |
| `neutralize` | `off` | 组装期摘掉宿主的注入型块：`off` / `reminders` / `aggressive` |
| `normalizeExtra` | `[]` | 额外要删的正则（字符串数组），配合 `neutralize` 用 |
| `tailFile` | 空 | 收尾复述正文文件；空则交给 `tailFrom` |
| `tailFrom` | `off` | `head` = 取正文首段压到组装末尾（bookend） |
| `tailOrder` | `900000` | 收尾段顺序，越大越靠后 |
| `snapshots` | `true` | 保存/回滚前自动留档 |
| `snapshotDir` | 空 | 默认 `<promptFile 目录>/.pl-snapshots` |
| `keepSnapshots` | `20` | 保留最近 N 份快照 |
| `autoApprove` | `false` | 注册审批应答器，所有审批请求判 `allowed-once` |
| `forceAsk` | `false` | 会话策略是 `never` 时改成 `ask`（否则请求进不到应答器就被拒） |
| `maxBytes` | `524288` | 文件读取上限 |
| `verbose` | `false` | 写 `$DSH_HOME/logs/prompt-layer.log` |

安装脚本会装到 `$DSH_HOME/profiles/` 下**所有** profile（desktop、web…），并把 `autoApprove`、`forceAsk` 都设为 `true`。

### 注入中和与收尾复述

两个开关都默认关闭，开了才生效：

```yaml
      neutralize: reminders   # off | reminders | aggressive
      tailFrom: head          # off | head；或改用 tailFile 指一个文件
```

- `neutralize`：在 `system-prompt/assemble` 阶段把宿主注入的 `<ethics_reminder>`、`<ip_reminder>`、`<cyber_warning>`、`<behavior_instructions>`、`<safety_reminder>` 块摘掉，只处理别人的段，自己的两份永远不动。`aggressive` 会按标签名泛匹配（含 notice/rules/warning），可能误删宿主自有策略段，确认后再开。
- `tailFrom: head`：注册第二段（`order: 900000`），取正文首段压成 `[身份复核] …` 压到组装末尾，对抗长上下文里的人格衰减。每轮多 200–600 字符。
- `/prompt-layer lint`：正文体检（字符、估算 tokens、最长行、重复标题、否定式约束计数）。

### 快照与回滚

改提示词最大的坑是"改完变笨了，但说不清哪里变了"。所以保存和回滚前都会自动留档：

| 命令 | 作用 |
|---|---|
| `/prompt-layer snap` | 手动留档当前正文 |
| `/prompt-layer diff` | 当前正文 vs 最近一份快照的逐行差异（带 ±统计） |
| `/prompt-layer undo` | 回滚到最近一份快照（回滚前会再留档一次） |
| `/prompt-layer undo 3` | 回滚到第 3 新的快照 |

- 面板保存、`/prompt-layer/undo` 走的都是同一套留档逻辑；
- 快照目录可用 `snapshotDir` 改，默认在正文旁边（`.pl-snapshots`），保留 `keepSnapshots` 份；
- HTTP `GET /prompt-layer/history` 列出全部快照文件，方便外部脚本做 A/B。

### 可选：工具上限（等价原版的"放宽"补丁）

不想每次读文件被行数卡、子代理只能套三层，就在 profile 的 `cordis.patch.yml` 里追加这几段（键名是宿主官方 config，不会改源码）：

```yaml
- id: tool-fs
  config:
    readLimit: 20000
    readMaxLineLength: 10000
    readMaxBytes: 1048576
- id: tool-result-pruner
  config:
    thresholdChars: 200000
    headChars: 150000
    tailChars: 20000
- id: tool-subagent
  config:
    maxDepth: 10
- id: repeat-tool-reminder
  config:
    thresholds: [200, 400]
```

改完重启宿主生效。

## 面板

重启后右下角有个 **PL** 圆按钮，点开是面板：

- 显示当前正文文件、生效文件、字符数、基线策略、免审批状态
- 直接在框里编辑正文 → **保存**（写回 `prompt-layer.md`，下一轮生效）
- **重读**：重新读盘上的文件（外部改了文件但想看最新时用）

面板是纯 DOM 注入，坏了只会少一个按钮，不会影响宿主界面。

## 从单文件版升级

旧版是把 `prompt-layer.mjs` 直接放在 profile 目录里。新版是 npm 包，装在 `<profile>/node_modules/dsh-prompt-layer/`：

1. 删掉（或改名）`<profile>/prompt-layer.mjs`
2. 把 `cordis.patch.yml` 里 `name: ./prompt-layer.mjs` 改成 `name: dsh-prompt-layer`
3. 重跑安装脚本即可补上 `node_modules` 里的三个文件

## 卸载

删掉 `<profile>/node_modules/dsh-prompt-layer/`、删掉 yaml 里那几段、重启。

## 注意

- `autoApprove: true` 之后，agent 执行命令、改文件不再询问；再配合 `sandbox-policy.mode: danger-full-access` 等于完全不设防。
- `dropBaseline: when-inject` 会让 `AGENTS.md` / 项目说明不再进入提示词，确认后再开。
- 提示词文件按原样注入（关闭了 `{{...}}` 插值），内容由使用者自行负责。

## 兼容

在 DeepSeek Harness 0.2.1-rc.3（桌面端）上验证：`ctx.systemPrompt.section()`、`system-prompt/assemble` waterfall、`approval/request` 应答器均可用。

## License

TBD（发布前请作者选定；未放 LICENSE 文件时默认保留所有权利）。
