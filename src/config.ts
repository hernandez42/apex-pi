// src/config.ts — env-driven config. All defaults are tuned for the
// Fly.io free tier (256 MB RAM). No magic numbers anywhere else; every
// cap, timeout, retry, and model selection lives here.

export interface Config {
  http: { port: number; host: string };
  /** LLM is selected via @earendil-works/pi-ai's getModel(provider, id). */
  llm: {
    provider: string;
    model: string;
    maxTokens: number;
    temperature: number;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  };
  dataDir: string;
  webUi: boolean;
  apexMemUrl?: string;
  feishu: {
    enabled: boolean;
    appId?: string;
    appSecret?: string;
    verificationToken?: string;
    encryptKey?: string;
    botName: string;
    useCard: boolean;
    maxReplyChars: number;
    maxSteps: number;
  };
  memory: { cap: number; dreamIntervalMin: number; dedupThreshold: number };
  codegraph: { maxFiles: number; maxFileKb: number };
  tools: {
    bashTimeoutMs: number;
    bashMaxTimeoutMs: number;
    readMaxBytes: number;
    readHardLimitBytes: number;
    toolResultMaxChars: number;
    maxRetries: number;
    bashPolicy: "allow" | "deny" | "sandbox";
    sandboxPaths: string[];
  };
  agent: {
    maxSteps: number;
    selfRepair: boolean;
  };
  mcp: { enabled: boolean; mountPath: string };
  skills: { dir?: string };
}

function envBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function envInt(v: string | undefined, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function envNum(v: string | undefined, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function envStr(v: string | undefined, dflt: string): string {
  return v === undefined || v === "" ? dflt : v;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function envThinking(v: string | undefined, dflt: ThinkingLevel): ThinkingLevel {
  if (!v) return dflt;
  return (THINKING_LEVELS as readonly string[]).includes(v) ? (v as ThinkingLevel) : dflt;
}

export function loadConfig(): Config {
  return {
    http: {
      port: envInt(process.env.PORT, 8080),
      host: envStr(process.env.HOST, "0.0.0.0"),
    },
    llm: {
      provider: envStr(process.env.LLM_PROVIDER, "openai"),
      model: envStr(process.env.LLM_MODEL, "gpt-4o-mini"),
      maxTokens: envInt(process.env.LLM_MAX_TOKENS, 4096),
      temperature: envNum(process.env.LLM_TEMPERATURE, 0.3),
      thinkingLevel: envThinking(process.env.LLM_THINKING, "off"),
    },
    dataDir: envStr(process.env.APEX_PI_DATA, "/data"),
    webUi: envBool(process.env.WEB_UI, true),
    apexMemUrl: process.env.APEXMEM_URL,
    feishu: {
      enabled: envBool(process.env.FEISHU_ENABLED, false),
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY,
      botName: envStr(process.env.FEISHU_BOT_NAME, "apex-pi"),
      useCard: envBool(process.env.FEISHU_USE_CARD, true),
      maxReplyChars: envInt(process.env.FEISHU_MAX_REPLY_CHARS, 4000),
      maxSteps: envInt(process.env.FEISHU_MAX_STEPS, 12),
    },
    memory: {
      cap: envInt(process.env.APEXMEM_CAP, 5000),
      dreamIntervalMin: envInt(process.env.APEXMEM_DREAM_MIN, 30),
      dedupThreshold: envNum(process.env.APEXMEM_DEDUP, 0.92),
    },
    codegraph: {
      maxFiles: envInt(process.env.CODEGRAPH_MAX_FILES, 4000),
      maxFileKb: envInt(process.env.CODEGRAPH_MAX_FILE_KB, 256),
    },
    tools: {
      bashTimeoutMs: envInt(process.env.TOOL_BASH_TIMEOUT_MS, 15_000),
      bashMaxTimeoutMs: envInt(process.env.TOOL_BASH_MAX_TIMEOUT_MS, 120_000),
      readMaxBytes: envInt(process.env.TOOL_READ_MAX_BYTES, 32_000),
      readHardLimitBytes: envInt(process.env.TOOL_READ_HARD_LIMIT_BYTES, 5 * 1024 * 1024),
      toolResultMaxChars: envInt(process.env.TOOL_RESULT_MAX_CHARS, 24_000),
      maxRetries: envInt(process.env.TOOL_MAX_RETRIES, 1),
      bashPolicy: (process.env.TOOL_BASH_POLICY === "deny" || process.env.TOOL_BASH_POLICY === "sandbox" || process.env.TOOL_BASH_POLICY === "allow")
        ? process.env.TOOL_BASH_POLICY
        : "allow",
      sandboxPaths: (process.env.TOOL_SANDBOX_PATHS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    agent: {
      maxSteps: envInt(process.env.AGENT_MAX_STEPS, 24),
      selfRepair: envBool(process.env.AGENT_SELF_REPAIR, true),
    },
    mcp: {
      enabled: envBool(process.env.MCP_ENABLED, false),
      mountPath: envStr(process.env.MCP_MOUNT_PATH, "/mcp"),
    },
    skills: { dir: process.env.SKILLS_DIR },
  };
}

let cached: Config | undefined;
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: reset the cached config so a new env is picked up. */
export function resetConfigForTests(): void {
  cached = undefined;
}
