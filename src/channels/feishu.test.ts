// src/channels/feishu.test.ts — covers Bug #3 (webhook signature +
// encryption) and Bug #1 (Logger.Level / EventDispatcher shims).

import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { createHmac, createCipheriv, createHash, randomBytes } from "node:crypto";
import { createFeishuMom, _resolveLogLevel, FeishuMom } from "./feishu.ts";
import { resetConfigForTests } from "../config.ts";

const originalEnv: Record<string, string | undefined> = {};
const KEYS = [
  "FEISHU_ENABLED",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_VERIFICATION_TOKEN",
  "FEISHU_ENCRYPT_KEY",
  "FEISHU_BOT_NAME",
  "FEISHU_USE_CARD",
  "FEISHU_MAX_REPLY_CHARS",
  "APEX_PI_DATA",
];

beforeAll(() => {
  for (const k of KEYS) originalEnv[k] = process.env[k];
});
afterAll(() => {
  for (const k of KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  resetConfigForTests();
});

beforeEach(() => {
  process.env.FEISHU_ENABLED = "1";
  process.env.FEISHU_APP_ID = "cli_test";
  process.env.FEISHU_APP_SECRET = "secret_test";
  process.env.FEISHU_BOT_NAME = "test-bot";
  process.env.FEISHU_VERIFICATION_TOKEN = "vtoken_abc";
  process.env.FEISHU_ENCRYPT_KEY = "ekey_xyz";
  resetConfigForTests();
});

function sign(token: string, ts: string, nonce: string, body: string): string {
  return createHmac("sha256", token).update(ts + nonce + body).digest("hex");
}

function encryptPayload(json: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(json, "utf-8"), cipher.final()]);
  return Buffer.concat([iv, ct]).toString("base64");
}

test("GET /webhook returns ok (URL verification ping)", async () => {
  const mom = createFeishuMom({ useCard: false, maxReplyChars: 1000 });
  const res = await mom.handleWebhook(new Request("https://x/v1/feishu/webhook", { method: "GET" }));
  expect(res.status).toBe(200);
});

test("POST with valid signature + non-encrypted body is accepted", async () => {
  const mom = createFeishuMom({ useCard: false, maxReplyChars: 1000 });
  const body = JSON.stringify({ type: "event_callback", header: { event_type: "other" } });
  const ts = String(Date.now());
  const nonce = "n-1";
  const sig = sign("vtoken_abc", ts, nonce, body);
  const req = new Request("https://x/v1/feishu/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Lark-Request-Timestamp": ts,
      "X-Lark-Request-Nonce": nonce,
      "Lark-Signature": sig,
    },
    body,
  });
  const res = await mom.handleWebhook(req);
  expect(res.status).toBe(200);
});

test("POST with INVALID signature is rejected (401) — Bug #3", async () => {
  const mom = createFeishuMom({ useCard: false, maxReplyChars: 1000 });
  const body = JSON.stringify({ type: "event_callback", header: { event_type: "other" } });
  const req = new Request("https://x/v1/feishu/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Lark-Request-Timestamp": "1",
      "X-Lark-Request-Nonce": "n",
      "Lark-Signature": "deadbeef".repeat(8),
    },
    body,
  });
  const res = await mom.handleWebhook(req);
  expect(res.status).toBe(401);
});

test("POST without signature headers is rejected (401) when token is set", async () => {
  const mom = createFeishuMom({ useCard: false, maxReplyChars: 1000 });
  const body = JSON.stringify({ type: "event_callback" });
  const req = new Request("https://x/v1/feishu/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const res = await mom.handleWebhook(req);
  expect(res.status).toBe(401);
});

test("POST challenge (URL verification) is echoed back", async () => {
  const mom = createFeishuMom({ useCard: false, maxReplyChars: 1000 });
  const body = JSON.stringify({ challenge: "abc123" });
  const ts = String(Date.now());
  const nonce = "n-2";
  const sig = sign("vtoken_abc", ts, nonce, body);
  const req = new Request("https://x/v1/feishu/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Lark-Request-Timestamp": ts,
      "X-Lark-Request-Nonce": nonce,
      "Lark-Signature": sig,
    },
    body,
  });
  const res = await mom.handleWebhook(req);
  expect(res.status).toBe(200);
  const j = await res.json() as { challenge: string };
  expect(j.challenge).toBe("abc123");
});

test("POST with encrypted body is decrypted (Bug #3)", async () => {
  const mom = createFeishuMom({ useCard: false, maxReplyChars: 1000 });
  const inner = JSON.stringify({ type: "event_callback", header: { event_type: "other" } });
  const encrypted = encryptPayload(inner, "ekey_xyz");
  const outer = JSON.stringify({ encrypt: encrypted });
  const ts = String(Date.now());
  const nonce = "n-3";
  const sig = sign("vtoken_abc", ts, nonce, outer);
  const req = new Request("https://x/v1/feishu/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Lark-Request-Timestamp": ts,
      "X-Lark-Request-Nonce": nonce,
      "Lark-Signature": sig,
    },
    body: outer,
  });
  const res = await mom.handleWebhook(req);
  expect(res.status).toBe(200);
});

test("POST with encrypted body but wrong key is rejected (400)", async () => {
  const mom = createFeishuMom({ useCard: false, maxReplyChars: 1000 });
  const inner = JSON.stringify({ type: "event_callback" });
  const encrypted = encryptPayload(inner, "wrong-key");
  const outer = JSON.stringify({ encrypt: encrypted });
  const ts = String(Date.now());
  const nonce = "n-4";
  const sig = sign("vtoken_abc", ts, nonce, outer);
  const req = new Request("https://x/v1/feishu/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Lark-Request-Timestamp": ts,
      "X-Lark-Request-Nonce": nonce,
      "Lark-Signature": sig,
    },
    body: outer,
  });
  const res = await mom.handleWebhook(req);
  expect(res.status).toBe(400);
});

test("POST with encrypted body but no key configured is rejected (400)", async () => {
  delete process.env.FEISHU_ENCRYPT_KEY;
  resetConfigForTests();
  const mom = createFeishuMom({ useCard: false, maxReplyChars: 1000 });
  const outer = JSON.stringify({ encrypt: "anything" });
  const ts = String(Date.now());
  const nonce = "n-5";
  const sig = sign("vtoken_abc", ts, nonce, outer);
  const req = new Request("https://x/v1/feishu/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Lark-Request-Timestamp": ts,
      "X-Lark-Request-Nonce": nonce,
      "Lark-Signature": sig,
    },
    body: outer,
  });
  const res = await mom.handleWebhook(req);
  expect(res.status).toBe(400);
});

test("Bug #1: _resolveLogLevel uses LoggerLevel.WARN when present", () => {
  const sdk = { LoggerLevel: { WARN: 3, INFO: 2, DEBUG: 1, ERROR: 4 } } as never;
  expect(_resolveLogLevel(sdk)).toBe(3);
});

test("Bug #1: _resolveLogLevel falls back to legacy Logger.Level when LoggerLevel missing", () => {
  const sdk = { Logger: { Level: { WARN: 3 } } } as never;
  expect(_resolveLogLevel(sdk)).toBe(3);
});

test("Bug #1: _resolveLogLevel returns 3 (hard fallback) when neither export exists", () => {
  const sdk = {} as never;
  expect(_resolveLogLevel(sdk)).toBe(3);
});

test("Bug #1: FeishuMom._makeDispatcher handles throwing constructor gracefully", () => {
  const mom = createFeishuMom({ useCard: false, maxReplyChars: 1000 }) as FeishuMom & { _makeDispatcher: () => unknown };
  // Throwing named export, no default.
  (mom as unknown as { sdk: { EventDispatcher: new () => unknown } }).sdk = {
    EventDispatcher: function ThrowingCtor(this: unknown) {
      throw new TypeError("__dirname is not defined");
    } as never,
  };
  const r = mom._makeDispatcher();
  expect(r).toBeNull();
});
