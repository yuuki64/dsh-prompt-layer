/**
 * prompt-layer — 个人提示词层（cordis 插件，服务端部分）
 *
 * 全部走宿主公开扩展点，不修改任何 @deepseek-ai 文件：
 *   1. systemPrompt 段（order 可配，默认 -100000）顶到最前，正文来自外部文件，按 mtime 热读
 *   2. 可选按工作区覆盖：cwd 下存在 workspaceFile 时优先用它
 *   3. 可选丢弃宿主 workspace 基线段（默认不丢）
 *   4. 可选注册 approval 应答器（allowed-once），并把会话策略兜底成 ask
 *   5. /prompt-layer status|reload|path 命令、HTTP 接口（面板用）、日志
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const name = "prompt-layer";
export const inject = ["systemPrompt"];

const DEFAULTS = {
  promptFile: "",
  workspaceFile: ".dsh-prompt-layer.md",
  order: -100000,
  dropBaseline: "never", // never | when-inject | always
  neutralize: "off", // off | reminders | aggressive —— 组装期摘掉宿主的注入型块
  normalizeExtra: [], // 额外要删的正则（字符串数组），仅 neutralize 非 off 时生效
  tailFile: "", // 收尾复述正文文件；空 = 交给 tailFrom
  tailFrom: "off", // off | head —— head = 取正文首段压到末尾
  tailOrder: 900000, // 收尾段顺序，越大越靠后
  autoApprove: false,
  autoApproveTools: [], // 只放行匹配的工具名；空 = 全部放行（旧行为）
  unmatchedAction: "fallthrough", // fallthrough | allowed-once | denied
  auditApprovals: true, // 每次放行/拒绝写 logs/prompt-layer-approvals.log
  forceAsk: false,
  maxBytes: 512 * 1024,
  snapshots: true, // 保存/回滚前自动留档
  snapshotDir: "", // 默认 <promptFile 目录>/.pl-snapshots
  keepSnapshots: 20, // 保留最近 N 份
  verbose: false,
};

export function diffLines(before, after, context = 2, maxLines = 60) {
  const a = String(before ?? '').replace(/\r\n/g, '\n').split('\n');
  const b = String(after ?? '').replace(/\r\n/g, '\n').split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > 4000000) return [`（过大：${n} 行 → ${m} 行，跳过逐行对比）`];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ sign: ' ', line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ sign: '-', line: a[i] });
      i += 1;
    } else {
      ops.push({ sign: '+', line: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ sign: '-', line: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ sign: '+', line: b[j] });
    j += 1;
  }
  const changed = ops.map((op, index) => (op.sign === ' ' ? -1 : index)).filter((index) => index >= 0);
  if (!changed.length) return ['（无差异）'];
  const keep = new Set();
  for (const index of changed) {
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < ops.length) keep.add(k);
    }
  }
  const out = [];
  let prev = -1;
  for (const index of [...keep].sort((x, y) => x - y)) {
    if (prev >= 0 && index !== prev + 1) out.push('…');
    out.push(`${ops[index].sign}${ops[index].line}`);
    prev = index;
    if (out.length >= maxLines) {
      out.push('…（截断）');
      break;
    }
  }
  const added = ops.filter((op) => op.sign === '+').length;
  const removed = ops.filter((op) => op.sign === '-').length;
  out.unshift(`+${added} / -${removed}`);
  return out;
}
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function audit(msg) {
  try {
    appendFileSync(join(dshHome(), "logs", "prompt-layer-approvals.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* 尽力而为 */
  }
}

function log(msg) {
  try {
    appendFileSync(join(dshHome(), "logs", "prompt-layer.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* 尽力而为 */
  }
}

/** mtime+size 缓存；读失败沿用上一份。 */
function makeReader(file, maxBytes) {
  let cache = { mtime: -1, size: -1, text: "" };
  return () => {
    if (!file) return "";
    try {
      const st = statSync(file);
      if (st.mtimeMs === cache.mtime && st.size === cache.size) return cache.text;
      const text = readFileSync(file, "utf8");
      const cut = text.length > maxBytes ? text.slice(0, maxBytes) : text;
      cache = { mtime: st.mtimeMs, size: st.size, text: cut };
      return cut;
    } catch (error) {
      log(`read ${file} failed: ${error?.message ?? error}`);
      return cache.text;
    }
  };
}

const BASELINE_NAME_HINTS = [
  "agent-instructions",
  "workspace-instruction",
  "workspace_instruction",
  "replacement-workspace",
  "replacement_workspace",
  "baseline",
];
const BASELINE_TEXT_MARKERS = [
  "This complete workspace instruction baseline replaces all earlier workspace instruction baselines",
  "No workspace instructions are currently active",
  "The following workspace instructions may be relevant to your work",
];

function isBaselineSection(section) {
  const sectionName = String(section?.name || "").toLowerCase();
  if (BASELINE_NAME_HINTS.some((hint) => sectionName.includes(hint))) return true;
  if (sectionName.includes("workspace") && (sectionName.includes("baseline") || sectionName.includes("instruction"))) return true;
  const text = typeof section?.text === "string" ? section.text : "";
  return text ? BASELINE_TEXT_MARKERS.some((marker) => text.includes(marker)) : false;
}

function dropBaselineFrom(assembly) {
  const sections = assembly?.sections;
  if (!Array.isArray(sections)) return assembly;
  const kept = sections.filter((section) => !isBaselineSection(section));
  if (kept.length === sections.length) return assembly;
  return { ...assembly, sections: kept };
}

// ---- 注入中和 + 收尾复述 ----
// 研究依据：指令面内的"叫模型无视提醒"弱于流水线级过滤；本地宿主的等价做法是在组装期把这层块摘掉。
const INJECTION_TAG_RE =
  /<(?:ethics_reminder|ip_reminder|cyber_warning|behavior_instructions|safety_reminder)\b[^>]*>[\s\S]*?<\/(?:ethics_reminder|ip_reminder|cyber_warning|behavior_instructions|safety_reminder)>/gi;
const AGGRESSIVE_TAG_RE =
  /<([a-z_][a-z0-9_]*(?:reminder|instruction|policy|guard|notice|rules|warning)[a-z0-9_]*)\b[^>]*>[\s\S]*?<\/\1>/gi;
const OWN_SECTIONS = new Set(["prompt-layer", "prompt-layer-tail"]);

/** 摘掉宿主注入型块；mode: off | reminders | aggressive。 */
export function neutralizeText(text, mode = "off", extra = []) {
  if (!text || mode === "off") return text;
  let out = String(text);
  const patterns = mode === "aggressive" ? [INJECTION_TAG_RE, AGGRESSIVE_TAG_RE] : [INJECTION_TAG_RE];
  for (const re of patterns) out = out.replace(re, "");
  for (const source of Array.isArray(extra) ? extra : []) {
    try {
      out = out.replace(new RegExp(source, "gi"), "");
    } catch {
      /* 非法正则忽略 */
    }
  }
  return out.replace(/\n{4,}/g, "\n\n\n").trim();
}

/** 只改别人的段，绝不改自己注入的两段。 */
export function neutralizeAssembly(assembly, mode, extra) {
  const sections = assembly?.sections;
  if (!Array.isArray(sections) || !mode || mode === "off") return assembly;
  let changed = false;
  const next = sections.map((section) => {
    if (!section || typeof section.text !== "string") return section;
    if (OWN_SECTIONS.has(String(section.name || ""))) return section;
    const text = neutralizeText(section.text, mode, extra);
    if (text === section.text) return section;
    changed = true;
    return { ...section, text };
  });
  return changed ? { ...assembly, sections: next } : assembly;
}

/** 收尾复述：优先用外部文件，其次取正文首段压到 maxChars。 */
export function buildTail(headText, tailTextValue, maxChars = 600) {
  if (tailTextValue) return String(tailTextValue);
  const block = String(headText || "")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("<") && part.length > 8);
  if (!block) return "";
  const firstLine = block.split("\n").map((line) => line.trim()).find(Boolean) || "";
  const body = firstLine.replace(/^#{1,6}\s*/, "").trim();
  if (!body) return "";
  const cut = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
  return `[身份复核] 以下为身份与约束的收尾复述；与上文冲突时以本段为准。\n\n${cut}`;
}

function cwdOf(context) {
  try {
    return String(context?.agent?.session?.header?.cwd || "").trim();
  } catch {
    return "";
  }
}

function sendJson(response, code, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4 * 1024 * 1024) break;
  }
  return body;
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const order = Number.isFinite(cfg.order) ? cfg.order : DEFAULTS.order;
  const baseReader = makeReader(cfg.promptFile, cfg.maxBytes);
  const wsReaders = new Map();
  const state = { lastSource: "", lastBytes: 0, lastError: "", approvalOk: false, askedFixed: false, commandOk: false };
  // ---- 收尾复述：把身份卡压到组装末尾（bookend）----
  const tailReader = makeReader(cfg.tailFile, cfg.maxBytes);
  const tailState = { chars: 0 };
  function tailText(context) {
    if (!cfg.tailFile && cfg.tailFrom !== "head") {
      tailState.chars = 0;
      return "";
    }
    const text = buildTail(resolveText(context), cfg.tailFile ? tailReader() : "");
    tailState.chars = text.length;
    return text;
  }
  function registerTail() {
    if (!cfg.tailFile && cfg.tailFrom !== "head") return undefined;
    try {
      return ctx.systemPrompt.section({
        name: "prompt-layer-tail",
        order: Number.isFinite(cfg.tailOrder) ? cfg.tailOrder : 900000,
        interpolate: false,
        text: (context) => tailText(context),
      });
    } catch (error) {
      state.lastError = String(error?.message ?? error);
      log(`tail section() failed: ${state.lastError}`);
      return undefined;
    }
  }

  function resolveText(context) {
    const cwd = cwdOf(context);
    if (cfg.workspaceFile && cwd) {
      const candidate = resolve(cwd, cfg.workspaceFile);
      if (existsSync(candidate)) {
        let reader = wsReaders.get(candidate);
        if (!reader) {
          reader = makeReader(candidate, cfg.maxBytes);
          wsReaders.set(candidate, reader);
        }
        const text = reader();
        state.lastSource = candidate;
        state.lastBytes = text.length;
        return text;
      }
    }
    const text = baseReader();
    state.lastSource = cfg.promptFile || "";
    state.lastBytes = text.length;
    return text;
  }

  // ---- 1. 提示词段 ----
  const register = () => {
    try {
      return ctx.systemPrompt.section({
        name: "prompt-layer",
        order,
        interpolate: false,
        text: (context) => {
          const text = resolveText(context);
          if (cfg.verbose) log(`inject ${text.length} chars from ${state.lastSource || "(none)"}`);
          return text;
        },
      });
    } catch (error) {
      state.lastError = String(error?.message ?? error);
      log(`section() failed: ${state.lastError}`);
      return undefined;
    }
  };

  try {
    if (typeof ctx?.effect === "function") {
      ctx.effect(() => {
        const disposers = [register(), registerTail()].filter((d) => typeof d === "function");
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* ignore */
            }
          }
        };
      });
    } else {
      register();
      registerTail();
    }
  } catch (error) {
    log(`register failed: ${error?.message ?? error}`);
  }

  // ---- 2. 基线 ----
  if (cfg.dropBaseline === "always" || cfg.dropBaseline === "when-inject") {
    try {
      ctx.on(
        "system-prompt/assemble",
        (assembly, context, next) => {
          const transform = (value) => {
            if (cfg.dropBaseline === "always") return dropBaselineFrom(value);
            return String(resolveText(context) || "").trim() ? dropBaselineFrom(value) : value;
          };
          if (typeof next === "function") return Promise.resolve(next()).then(transform);
          return transform(assembly);
        },
        { global: true, prepend: true },
      );
      log(`baseline drop: ${cfg.dropBaseline}`);
    } catch (error) {
      state.lastError = String(error?.message ?? error);
      log(`assemble hook failed: ${state.lastError}`);
    }
  }

  // ---- 组装期中和宿主注入块（比"让模型自觉无视"更硬，且换模型不失效）----
  if (cfg.neutralize && cfg.neutralize !== "off") {
    try {
      ctx.on(
        "system-prompt/assemble",
        (assembly, context, next) => {
          const transform = (value) => neutralizeAssembly(value, cfg.neutralize, cfg.normalizeExtra || []);
          if (typeof next === "function") return Promise.resolve(next()).then(transform);
          return transform(assembly);
        },
        { global: true, prepend: true },
      );
      log(`neutralize: ${cfg.neutralize}`);
    } catch (error) {
      state.lastError = String(error?.message ?? error);
      log(`neutralize hook failed: ${state.lastError}`);
    }
  }

  // ---- 3. 审批应答器 ----
  if (cfg.autoApprove) {
    const allowPatterns = Array.isArray(cfg.autoApproveTools) ? cfg.autoApproveTools.filter(Boolean) : [];
    const matchesAllow = (name, raw) => {
      if (!allowPatterns.length) return true;
      const target = String(name || "");
      for (const pattern of allowPatterns) {
        const value = String(pattern);
        if (value.startsWith("re:")) {
          try {
            if (new RegExp(value.slice(3), "i").test(`${target} ${raw}`)) return true;
          } catch {
            /* 非法正则忽略 */
          }
          continue;
        }
        if (value.includes("*")) {
          const source = value
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*");
          if (new RegExp(`^${source}$`, "i").test(target)) return true;
          continue;
        }
        if (value.toLowerCase() === target.toLowerCase()) return true;
      }
      return false;
    };
    const answer = (req) => {
      const toolName = String(req?.tool ?? req?.toolName ?? req?.name ?? "");
      let raw = "";
      try {
        raw = JSON.stringify(req?.input ?? req?.args ?? {});
      } catch {
        raw = "";
      }
      if (!matchesAllow(toolName, raw)) {
        if (cfg.unmatchedAction === "denied") {
          if (cfg.auditApprovals) audit(`denied ${toolName || "?"} ${raw.slice(0, 160)}`);
          return "denied";
        }
        if (cfg.unmatchedAction === "allowed-once") {
          if (cfg.auditApprovals) audit(`auto-approve(unmatched) ${toolName || "?"} ${raw.slice(0, 160)}`);
          return "allowed-once";
        }
        if (cfg.verbose) log(`approval fallthrough ${toolName || "?"}`);
        return undefined;
      }
      if (cfg.auditApprovals) audit(`auto-approve ${toolName || "?"} ${raw.slice(0, 160)}`);
      return "allowed-once";
    };
    try {
      ctx.on("approval/request", answer, { prepend: true, global: true });
      state.approvalOk = true;
    } catch (error) {
      log(`approval hook (global) failed: ${error?.message ?? error}`);
      try {
        ctx.on("approval/request", answer, { prepend: true });
        state.approvalOk = true;
      } catch (error2) {
        state.lastError = String(error2?.message ?? error2);
        log(`approval hook failed: ${state.lastError}`);
      }
    }
    log(`autoApprove enabled: rules=${allowPatterns.length || "all"} unmatched=${cfg.unmatchedAction || "fallthrough"}`);
  }

  // ---- 4. 策略兜底 ----
  const fixedAgents = new WeakSet();
  let approvalSvc = null;
  try {
    // approval 服务可能在 apply 之后才就绪，等它出现再拿引用
    ctx.inject(["approval"], (host) => {
      approvalSvc = host?.approval ?? null;
    });
  } catch (error) {
    log(`approval inject failed: ${error?.message ?? error}`);
  }

  function ensureAsk(agent) {
    if (!cfg.forceAsk || !agent || fixedAgents.has(agent)) return;
    const approval = approvalSvc || ctx.get?.("approval");
    if (!approval || typeof approval.setPolicy !== "function") return;
    fixedAgents.add(agent);
    try {
      approval.setPolicy(agent, "ask");
      state.askedFixed = true;
      log("approval policy forced to ask");
    } catch (error) {
      log(`setPolicy failed: ${error?.message ?? error}`);
    }
  }

  if (cfg.forceAsk) {
    try {
      ctx.on("session/created", (session) => ensureAsk(session?.agent), { global: true });
    } catch (error) {
      log(`session/created hook failed: ${error?.message ?? error}`);
    }
    try {
      ctx.on(
        "agent/pre-step",
        (payload, next) => {
          ensureAsk(payload?.agent ?? payload?.context?.agent);
          return typeof next === "function" ? next() : undefined;
        },
        { global: true },
      );
    } catch (error) {
      log(`pre-step hook failed: ${error?.message ?? error}`);
    }
  }

  // ---- 5. HTTP 接口（面板用）----
  const statusPayload = () => ({
    ok: true,
    promptFile: cfg.promptFile || "",
    workspaceFile: cfg.workspaceFile || "",
    effective: state.lastSource || cfg.promptFile || "",
    chars: state.lastBytes,
    order,
    dropBaseline: cfg.dropBaseline,
    neutralize: cfg.neutralize || "off",
    tailFile: cfg.tailFile || "",
    tailFrom: cfg.tailFrom || "off",
    tailOrder: cfg.tailOrder,
    tailChars: tailState.chars,
    snapshots: snapshotList().length,
    snapshotDir: snapshotDirPath(),
    lastSnapshot: state.lastSnapshot || "",
    autoApprove: cfg.autoApprove,
    autoApproveTools: Array.isArray(cfg.autoApproveTools) ? cfg.autoApproveTools : [],
    unmatchedAction: cfg.unmatchedAction || "fallthrough",
    forceAsk: cfg.forceAsk,
    approvalOk: state.approvalOk,
    commandOk: state.commandOk,
    error: state.lastError || "",
    exists: cfg.promptFile ? existsSync(cfg.promptFile) : false,
  });

  // ---- 快照：改前留档，可回滚 ----
  function snapshotDirPath() {
    if (!cfg.snapshots) return '';
    if (cfg.snapshotDir) return cfg.snapshotDir;
    if (!cfg.promptFile) return '';
    return join(dirname(cfg.promptFile), '.pl-snapshots');
  }

  function snapshotList() {
    const dir = snapshotDirPath();
    if (!dir || !existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((file) => file.endsWith('.md'))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  function pruneSnapshots() {
    const dir = snapshotDirPath();
    const keep = Math.max(1, Number(cfg.keepSnapshots) || 20);
    const list = snapshotList();
    for (const file of list.slice(keep)) {
      try {
        unlinkSync(join(dir, file));
      } catch {
        /* ignore */
      }
    }
  }

  function snapshotNow(reason = 'auto') {
    const dir = snapshotDirPath();
    if (!dir || !cfg.promptFile || !existsSync(cfg.promptFile)) return '';
    try {
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = join(dir, `${stamp}-${reason}.md`);
      writeFileSync(dest, readFileSync(cfg.promptFile, 'utf8'), 'utf8');
      pruneSnapshots();
      state.lastSnapshot = dest;
      log(`snapshot ${dest}`);
      return dest;
    } catch (error) {
      state.lastError = String(error?.message ?? error);
      return '';
    }
  }
  function savePrompt(text) {
    if (!cfg.promptFile) throw new Error("promptFile 未配置");
    snapshotNow("pre-save");
    const tmp = `${cfg.promptFile}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, String(text ?? ""), "utf8");
    renameSync(tmp, cfg.promptFile);
    state.lastBytes = String(text ?? "").length;
    state.lastSource = cfg.promptFile;
  }

  function guard(request) {
    const site = String(request?.headers?.["sec-fetch-site"] || "");
    return site !== "cross-site";
  }

  try {
    ctx.inject(["webServer"], (host) => {
      host.effect(() => {
        const un = [];
        const reg = (spec) => {
          try {
            const d = host.webServer.register(spec, "prompt-layer");
            if (typeof d === "function") un.push(d);
          } catch (error) {
            log(`route ${spec.path} failed: ${error?.message ?? error}`);
          }
        };
        reg({
          kind: "exact",
          path: "/prompt-layer/status",
          handler: (request, response) => {
            if (!guard(request)) {
              sendJson(response, 403, { ok: false });
              return;
            }
            sendJson(response, 200, statusPayload());
          },
        });
        reg({
          kind: "exact",
          path: "/prompt-layer/text",
          handler: (request, response) => {
            if (!guard(request)) {
              sendJson(response, 403, { ok: false });
              return;
            }
            const text = cfg.promptFile && existsSync(cfg.promptFile) ? readFileSync(cfg.promptFile, "utf8") : "";
            sendJson(response, 200, { ok: true, file: cfg.promptFile || "", text });
          },
        });
        reg({
          kind: "exact",
          path: "/prompt-layer/save",
          handler: async (request, response) => {
            if (!guard(request) || request.method !== "POST") {
              sendJson(response, 403, { ok: false });
              return;
            }
            try {
              const body = JSON.parse((await readBody(request)) || "{}");
              savePrompt(body.text);
              log(`saved ${String(body.text ?? "").length} chars to ${cfg.promptFile}`);
              sendJson(response, 200, { ok: true, chars: String(body.text ?? "").length });
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            }
          },
        });
        reg({
          kind: "exact",
          path: "/prompt-layer/reload",
          handler: (request, response) => {
            if (!guard(request)) {
              sendJson(response, 403, { ok: false });
              return;
            }
            const text = baseReader();
            wsReaders.clear();
            sendJson(response, 200, { ok: true, chars: text.length });
          },
        });
        reg({
          kind: 'exact',
          path: '/prompt-layer/history',
          handler: (request, response) => {
            if (!guard(request)) {
              sendJson(response, 403, { ok: false });
              return;
            }
            sendJson(response, 200, { ok: true, dir: snapshotDirPath(), files: snapshotList() });
          },
        });
        return () => {
          for (const f of un) {
            try {
              f();
            } catch {
              /* ignore */
            }
          }
        };
      });
    });
  } catch (error) {
    log(`webServer inject failed: ${error?.message ?? error}`);
  }

  // ---- 6. 命令（等 commands 服务就绪再注册）----
  const commandSpec = {
    name: "prompt-layer",
    description: "个人提示词层：status/reload/path/lint/snap/undo/diff",
    input: { hint: "status | reload | path | lint | snap | undo [n] | diff" },
    handler: (invocation) => {
      const parts = String(invocation?.rawInput ?? "").trim().split(/\s+/);
      const arg = parts[0] || 'status';
      if (arg === "reload") {
        const text = baseReader();
        return { kind: "success", text: `已重读 ${cfg.promptFile || "(未配置)"}：${text.length} 字符` };
      }
      if (arg === "snap") {
        const dest = snapshotNow("manual");
        return { kind: "success", text: dest ? `已留档 ${dest}` : "快照未启用，或没有可读的正文文件" };
      }
      if (arg === "undo") {
        const list = snapshotList();
        const index = Math.max(1, Number(parts[1]) || 1) - 1;
        const file = list[index];
        if (!file) return { kind: "success", text: "没有可回滚的快照" };
        const dir = snapshotDirPath();
        snapshotNow("pre-undo");
        writeFileSync(cfg.promptFile, readFileSync(join(dir, file), "utf8"), "utf8");
        const restored = baseReader();
        return { kind: "success", text: `已回滚到 ${file}（${restored.length} 字符；回滚前已留档）` };
      }
      if (arg === "diff") {
        const list = snapshotList();
        if (!list.length) return { kind: "success", text: "没有快照可对比" };
        const dir = snapshotDirPath();
        const before = readFileSync(join(dir, list[0]), "utf8");
        const current = cfg.promptFile && existsSync(cfg.promptFile) ? readFileSync(cfg.promptFile, "utf8") : "";
        return { kind: "success", text: [`对比 ${list[0]} → 当前`, ...diffLines(before, current)].join("\n") };
      }
      if (arg === "lint") {
        const text = String(resolveText(null) || "");
        const lines = text.split(/\r?\n/);
        const headings = lines.filter((line) => /^#{2,3}\s/.test(line)).map((line) => line.trim());
        const dup = [...new Set(headings.filter((item, index) => headings.indexOf(item) !== index))];
        const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
        const negatives = (text.match(/禁止|不要|不能|不可|永远不|never|do not|don't/gi) || []).length;
        return {
          kind: "success",
          text: [
            "prompt-layer lint",
            `  字符         ${text.length}`,
            `  估算 tokens  ~${Math.ceil(text.length / 1.6)}`,
            `  最长行       ${longest} 字符`,
            `  重复标题     ${dup.length ? dup.join(" / ") : "无"}`,
            `  否定式约束   ${negatives} 处（改成正面表述通常更稳）`,
            `  收尾复述     ${cfg.tailFile || (cfg.tailFrom === "head" ? "head 自动" : "关")}`,
          ].join("\n"),
        };
      }
      if (arg === "path") {
        return { kind: "success", text: state.lastSource || cfg.promptFile || "(未配置)" };
      }
      const lines = [
        "prompt-layer",
        `  全局正文     ${cfg.promptFile || "(未配置)"}`,
        `  工作区覆盖   ${cfg.workspaceFile || "(关)"}`,
        `  当前生效     ${state.lastSource || "(还没读到)"}`,
        `  当前长度     ${state.lastBytes} 字符`,
        `  段顺序       ${order}`,
        `  基线策略     ${cfg.dropBaseline}`,
        `  注入中和     ${cfg.neutralize || "off"}`,
        `  收尾复述     ${cfg.tailFile || (cfg.tailFrom === "head" ? "head 自动" : "关")}`,
        `  快照         ${snapshotList().length} 份${cfg.snapshots ? "" : "（已关）"}`,
        `  免审批       ${cfg.autoApprove ? "开" : "关"}${cfg.forceAsk ? "（策略兜底 ask）" : ""}`,
        `  放行规则     ${Array.isArray(cfg.autoApproveTools) && cfg.autoApproveTools.length ? cfg.autoApproveTools.join(",") : "全部放行"}${cfg.autoApprove && cfg.autoApproveTools?.length ? `（未匹配 ${cfg.unmatchedAction || "fallthrough"}）` : ""}`,
        `  审批钩子     ${state.approvalOk ? "已挂" : "未挂或未启用"}`,
        `  最近错误     ${state.lastError || "无"}`,
      ];
      return { kind: "success", text: lines.join("\n") };
    },
  };

  try {
    ctx.inject(["commands"], (host) => {
      const commands = host?.commands;
      if (!commands || typeof commands.register !== "function") {
        log("commands service present but has no register()");
        return;
      }
      try {
        commands.register(commandSpec);
        state.commandOk = true;
        log("command /prompt-layer registered");
      } catch (error) {
        state.lastError = String(error?.message ?? error);
        log(`command register failed: ${state.lastError}`);
      }
    });
  } catch (error) {
    log(`commands inject failed: ${error?.message ?? error}`);
  }

  if (cfg.verbose) log(`applied: order=${order} drop=${cfg.dropBaseline} approve=${cfg.autoApprove} forceAsk=${cfg.forceAsk}`);
}
