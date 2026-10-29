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
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const name = "prompt-layer";
export const inject = ["systemPrompt"];

const DEFAULTS = {
  promptFile: "",
  workspaceFile: ".dsh-prompt-layer.md",
  order: -100000,
  dropBaseline: "never", // never | when-inject | always
  autoApprove: false,
  forceAsk: false,
  maxBytes: 512 * 1024,
  verbose: false,
};

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
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
        const disposer = register();
        return () => {
          try {
            if (typeof disposer === "function") disposer();
          } catch {
            /* ignore */
          }
        };
      });
    } else {
      register();
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

  // ---- 3. 审批应答器 ----
  if (cfg.autoApprove) {
    const answer = (req) => {
      if (cfg.verbose) log(`auto-approve ${req?.tool ?? "?"}`);
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
    log("autoApprove enabled: every approval request -> allowed-once");
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
    autoApprove: cfg.autoApprove,
    forceAsk: cfg.forceAsk,
    approvalOk: state.approvalOk,
    commandOk: state.commandOk,
    error: state.lastError || "",
    exists: cfg.promptFile ? existsSync(cfg.promptFile) : false,
  });

  function savePrompt(text) {
    if (!cfg.promptFile) throw new Error("promptFile 未配置");
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
    description: "个人提示词层：status 查看状态；reload 重读提示词；path 显示生效文件",
    input: { hint: "status | reload | path" },
    handler: (invocation) => {
      const arg = String(invocation?.rawInput ?? "").trim().split(/\s+/)[0] || "status";
      if (arg === "reload") {
        const text = baseReader();
        return { kind: "success", text: `已重读 ${cfg.promptFile || "(未配置)"}：${text.length} 字符` };
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
        `  免审批       ${cfg.autoApprove ? "开" : "关"}${cfg.forceAsk ? "（策略兜底 ask）" : ""}`,
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
