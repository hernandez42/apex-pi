// src/log.ts — single-line JSON logger, < 1 KB
// We deliberately avoid pino/winston to keep memory & install size down.

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = ((process.env.LOG_LEVEL as Level) ?? "info") in ORDER
  ? ((process.env.LOG_LEVEL as Level) ?? "info")
  : "info";

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
  child(fields: Record<string, unknown>) {
    return {
      debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, { ...fields, ...f }),
      info: (m: string, f?: Record<string, unknown>) => emit("info", m, { ...fields, ...f }),
      warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, { ...fields, ...f }),
      error: (m: string, f?: Record<string, unknown>) => emit("error", m, { ...fields, ...f }),
    };
  },
};
