// src/memory/bridge.ts
// Proxy that speaks the same JSON-RPC / MCP-2024-11-05 schema as the Rust
// apex-mem server. When APEXMEM_URL is set, every method is forwarded to
// the Rust binary; otherwise calls go to the local in-process engine.

import { log } from "../log.ts";
import type {
  IngestInput,
  MemoryHealth,
  MemoryHit,
  MemoryRecord,
  MemoryStats,
  SearchInput,
} from "./types.ts";
import type { MemoryStore } from "./store.ts";
import { config } from "../config.ts";

export interface MemoryEngine {
  ingest(input: IngestInput): Promise<MemoryRecord>;
  search(input: SearchInput): Promise<MemoryHit[]>;
  get(id: string): Promise<MemoryRecord | undefined>;
  delete(id: string): Promise<boolean>;
  dream(): Promise<{ decayed: number; merged: number; promoted: number }>;
  stats(): Promise<MemoryStats>;
  health(): Promise<MemoryHealth>;
  graphJson(): Promise<ReturnType<MemoryStore["graphJson"]>>;
  flushFromConversation(text: string, source?: string): Promise<{ extracted: MemoryRecord[] }>;
  relate(src: string, rel: string, dst: string, weight?: number, dim?: string): Promise<void>;
  /** Returns 'local' or 'remote' so /v1/stats can surface it. */
  mode(): "local" | "remote";
}

export class LocalEngine implements MemoryEngine {
  constructor(private store: MemoryStore) {}
  async ingest(i: IngestInput) { return this.store.ingest(i); }
  async search(i: SearchInput) { return this.store.search(i); }
  async get(id: string) { return this.store.get(id); }
  async delete(id: string) { return this.store.delete(id); }
  async dream() { return this.store.dream(); }
  async stats() { return this.store.stats(); }
  async health() { return this.store.health(); }
  async graphJson() { return this.store.graphJson(); }
  async flushFromConversation(text: string, source?: string) { return this.store.flushFromConversation(text, source); }
  async relate(src: string, rel: string, dst: string, weight = 1.0, dim?: string) {
    this.store.relate(src, rel, dst, weight, dim as never);
  }
  mode(): "local" | "remote" { return "local"; }
}

interface JsonRpcReq {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}
interface JsonRpcRes<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export class RemoteEngine implements MemoryEngine {
  private nextId = 1;
  constructor(private url: string) {}

  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const req: JsonRpcReq = { jsonrpc: "2.0", id, method, params };
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`apex-mem HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as JsonRpcRes<T>;
    if (json.error) throw new Error(`apex-mem ${json.error.code}: ${json.error.message}`);
    return json.result as T;
  }

  async ingest(i: IngestInput) { return this.call<MemoryRecord>("apex_ingest", i as unknown as Record<string, unknown>); }
  async search(i: SearchInput) { return this.call<MemoryHit[]>("apex_retrieve", i as unknown as Record<string, unknown>); }
  async get(id: string) { return this.call<MemoryRecord | undefined>("apex_get", { id }); }
  async delete(id: string) { return this.call<boolean>("apex_delete", { id }); }
  async dream() { return this.call<{ decayed: number; merged: number; promoted: number }>("apex_dream"); }
  async stats() { return this.call<MemoryStats>("apex_stats"); }
  async health() { return this.call<MemoryHealth>("apex_apex_diagnose"); }
  async graphJson() { return this.call<ReturnType<MemoryStore["graphJson"]>>("apex_graph"); }
  async flushFromConversation(text: string, source?: string) {
    return this.call<{ extracted: MemoryRecord[] }>("apex_flush", { text, source });
  }
  async relate(src: string, rel: string, dst: string, weight = 1.0, dim?: string) {
    await this.call("apex_relate", { src, rel, dst, weight, dim });
  }
  mode(): "local" | "remote" { return "remote"; }
}

let cached: MemoryEngine | undefined;
export function getMemoryEngine(store: MemoryStore): MemoryEngine {
  if (cached) return cached;
  const url = config().apexMemUrl;
  if (url) {
    log.info("memory.engine.remote", { url });
    cached = new RemoteEngine(url);
  } else {
    log.info("memory.engine.local");
    cached = new LocalEngine(store);
  }
  return cached;
}

/** Test helper: force a re-bind of the cached engine to a new store. */
export function setStoreForMemoryEngine(store: MemoryStore): void {
  cached = new LocalEngine(store);
}

export function resetMemoryEngineForTests(): void {
  cached = undefined;
}
