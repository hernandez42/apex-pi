// src/codegraph/singleton.ts
// Process-wide Codegraph instance. We keep a single connection per process
// because SQLite + mmap is cheap to share but the file handle is per-process.
// Tests can call closeCodegraph() to release the lock between runs.

import { Codegraph, type CodegraphOptions } from "./store.ts";
import { config } from "../config.ts";

let cached: Codegraph | undefined;

export function getCodegraph(opts?: CodegraphOptions): Codegraph {
  if (cached) return cached;
  const cfg = config();
  cached = new Codegraph(
    opts ?? {
      dataDir: cfg.dataDir,
      maxFileKb: cfg.codegraph.maxFileKb,
      maxFiles: cfg.codegraph.maxFiles,
    },
  );
  return cached;
}

export function closeCodegraph(): void {
  if (cached) cached.close();
  cached = undefined;
}
