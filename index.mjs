/**
 * prompt-layer — 个人提示词层（单文件 cordis 插件）
 *
 * 只做三件事，全部走宿主公开扩展点，不修改任何 @deepseek-ai 文件：
 *   1. 把你指定的文本文件，作为 order = -100000 的 systemPrompt 段顶到系统提示最前
 *      （宿主默认段：身份 -1000、persona 0、工具/doc 若干、harness 10000…）
 *   2. 可选：丢弃宿主的 workspace 基线段（默认不丢 —— 丢了你的 AGENTS.md 就不进提示了）
 *   3. 可选：注册一个 approval 应答器，把所有审批请求判为 allowed-once（默认关）
 *
 * 安装：见同目录 README.md
 */
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "prompt-layer";
export const inject = ["systemPrompt"];

const DEFAULTS = {
  promptFile: "",
  order: -100000,
  dropBaseline: "never", // never | when-inject | always
  autoApprove: false,
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
    /* 日志尽力而为，不影响加载 */
  }
}

/** 带 mtime+size 缓存的文件读取：改文件即生效，不用重启、不用重装。 */
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
      // 文件暂时不存在/被占用：沿用上一份，别把提示词清空
      log(`read ${file} failed: ${error?.message ?? error}`);
      return cache.text;
    }
  };
}

const BASELINE_NAME_HINTS = ["agent-instructions", "workspace-instruction", "workspace_instruction", "replacement-workspace", "replacement_workspace", "baseline"];
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

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const readPrompt = makeReader(cfg.promptFile, cfg.maxBytes);
  const order = Number.isFinite(cfg.order) ? cfg.order : DEFAULTS.order;

  // ---- 1. 顶到最前的提示词段 ----
  const register = () => {
    try {
      return ctx.systemPrompt.section({
        name: "prompt-layer",
        order,
        interpolate: false, // 原样保留 {{...}}，不参与宿主插值
        text: (context) => {
          const text = readPrompt();
          if (cfg.verbose) log(`inject ${text.length} chars (cwd=${context?.agent?.session?.header?.cwd ?? "?"})`);
          return text;
        },
      });
    } catch (error) {
      log(`section() failed: ${error?.message ?? error}`);
      return undefined;
    }
  };

  // section() 在多数宿主实现里会返回 disposer；有 ctx.effect 就交给它回收
  try {
    if (typeof ctx?.effect === "function") ctx.effect(() => {
      const disposer = register();
      return () => {
        try {
          if (typeof disposer === "function") disposer();
        } catch {
          /* ignore */
        }
      };
    });
    else register();
  } catch (error) {
    log(`register failed: ${error?.message ?? error}`);
    try {
      register();
    } catch {
      /* ignore */
    }
  }

  // ---- 2. 可选：丢 workspace 基线（默认不丢，丢了 AGENTS.md 就不进提示） ----
  if (cfg.dropBaseline === "always" || cfg.dropBaseline === "when-inject") {
    try {
      ctx.on("system-prompt/assemble", (assembly, _context, next) => {
        const transform = (value) => {
          if (cfg.dropBaseline === "always") return dropBaselineFrom(value);
          return String(readPrompt() || "").trim() ? dropBaselineFrom(value) : value;
        };
        if (typeof next === "function") return Promise.resolve(next()).then(transform);
        return transform(assembly);
      }, { global: true, prepend: true });
      log(`baseline drop enabled: ${cfg.dropBaseline}`);
    } catch (error) {
      log(`assemble hook failed: ${error?.message ?? error}`);
    }
  }

  // ---- 3. 可选：审批应答器（autoApprove 打开后不再弹审批） ----
  if (cfg.autoApprove) {
    const answer = (req) => {
      if (cfg.verbose) log(`auto-approve ${req?.tool ?? "?"} ${req?.reason ?? ""}`.slice(0, 300));
      return "allowed-once";
    };
    try {
      ctx.on("approval/request", answer, { prepend: true, global: true });
    } catch (error) {
      log(`approval hook (global) failed: ${error?.message ?? error}`);
      try {
        ctx.on("approval/request", answer, { prepend: true });
      } catch (error2) {
        log(`approval hook failed: ${error2?.message ?? error2}`);
      }
    }
    log("autoApprove enabled: every approval request -> allowed-once");
  }

  // ---- 命令：/prompt-layer status | reload ----
  try {
    const commands = ctx.get?.("commands");
    if (commands?.register) {
      commands.register({
        name: "prompt-layer",
        description: "个人提示词层：status 查看当前状态；reload 重读提示词文件",
        input: { hint: "status | reload" },
        handler: (invocation) => {
          const arg = String(invocation?.rawInput ?? "").trim().split(/\s+/)[0] || "status";
          const text = readPrompt();
          if (arg === "reload") {
            return { kind: "success", text: `已重读：${cfg.promptFile || "(未配置)"}，${text.length} 字符` };
          }
          const lines = [
            "prompt-layer",
            `  提示词文件   ${cfg.promptFile || "(未配置)"}`,
            `  当前长度     ${text.length} 字符`,
            `  段顺序       ${order}`,
            `  基线策略     ${cfg.dropBaseline}`,
            `  自动审批     ${cfg.autoApprove ? "开" : "关"}`,
          ];
          return { kind: "success", text: lines.join("\n") };
        },
      });
    }
  } catch (error) {
    log(`command register failed: ${error?.message ?? error}`);
  }

  if (cfg.verbose) log(`applied: order=${order} dropBaseline=${cfg.dropBaseline} autoApprove=${cfg.autoApprove}`);
}
