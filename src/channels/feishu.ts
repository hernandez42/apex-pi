// src/channels/feishu.ts
//
// FeishuMom — the Feishu / Lark sibling of pi-mom. We follow pi-mom's
// architecture: receive events from the official @larksuiteoapi/node-sdk,
// translate them into apex-pi Agent prompts, stream the response back as
// Card or text messages. The official SDK is used end-to-end; we don't
// reimplement the wire protocol.
//
// Two transports are supported:
//   - WebSocket (Socket Mode): long-lived connection, no public IP needed
//   - Webhook (Event Subscription): HTTP POST from Feishu, requires a
//     public URL. Useful when the agent is behind a Fly.io / Heroku box.

import { createHmac, createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { getAgent } from "../agent.ts";

// Dynamic import so the SDK is only loaded when the channel is enabled.
type LarkClient = {
  im: { message: { create: (req: unknown) => Promise<unknown> } };
};
type LarkWSClient = {
  start(): Promise<void>;
};
type LarkEventDispatcher = {
  register: (event: Record<string, unknown>) => void;
};

async function loadLark(): Promise<{
  Client: new (opts: { appId: string; appSecret: string }) => LarkClient;
  WSClient: new (opts: { appId: string; appSecret: string; loggerLevel?: number }) => LarkWSClient;
  EventDispatcher: new () => LarkEventDispatcher;
  LoggerLevel: { ERROR: number; WARN: number; INFO: number; DEBUG: number };
} | null> {
  try {
    return (await import("@larksuiteoapi/node-sdk")) as never;
  } catch (e) {
    log.warn("feishu.sdk.missing", { err: (e as Error).message });
    return null;
  }
}

/**
 * Resolve the WSClient logger level. The SDK ships `LoggerLevel` (the correct
 * enum export: ERROR=4, WARN=3, INFO=2, DEBUG=1). Older code paths and
 * community examples sometimes reference `Logger.Level` — that property
 * NEVER existed on the `Logger` class, so under Bun's tree-shaker it ends
 * up as `undefined` and crashes `WSClient` startup. We accept either form
 * defensively, and fall back to WARN (matches SDK default for INFO) so a
 * missing export never breaks the bot.
 *
 * @internal — exported for unit tests; do not use from app code.
 */
export function _resolveLogLevel(
  sdk: NonNullable<Awaited<ReturnType<typeof loadLark>>>,
): number {
  // Primary: the official enum.
  if (sdk.LoggerLevel && typeof sdk.LoggerLevel.WARN === "number") {
    return sdk.LoggerLevel.WARN;
  }
  // Legacy / mistyped: some docs and examples reference `Logger.Level`.
  // The `Logger` class never had this property, but if a forked SDK does,
  // honour it.
  const legacy = (sdk as unknown as { Logger?: { Level?: { WARN?: number } } })
    .Logger?.Level;
  if (legacy && typeof legacy.WARN === "number") {
    return legacy.WARN;
  }
  // Hard fallback: numeric value matches `LoggerLevel.WARN` in the SDK.
  log.warn("feishu.sdk.loggerlevel.missing", {
    hint: "feishu SDK did not expose LoggerLevel; using WARN=3 fallback",
  });
  return 3;
}

interface FeishuEventV2 {
  schema: "2.0";
  header: { event_type: string; app_id: string; tenant_key: string };
  event: {
    sender: { sender_id: { open_id: string } };
    message: {
      message_id: string;
      chat_id: string;
      chat_type: "p2p" | "group";
      message_type: string;
      content: string; // JSON string
      mentions?: Array<{ key: string; name: string; id?: { open_id?: string } }>;
    };
  };
}

function parseText(content: string): string {
  try {
    const j = JSON.parse(content) as { text?: string };
    return j.text ?? "";
  } catch {
    return content;
  }
}

function botMentioned(text: string, botName: string, mentions?: FeishuEventV2["event"]["message"]["mentions"]): boolean {
  if (mentions?.some((m) => m.name === botName)) return true;
  return text.toLowerCase().includes(`@${botName.toLowerCase()}`);
}

export interface FeishuMomOptions {
  /** When true, use Card (interactive) messages; fallback to text on error. */
  useCard: boolean;
  /** Hard cap on reply length (4000 for text, up to 30000 for post). */
  maxReplyChars: number;
}

export class FeishuMom {
  private cfg = config().feishu;
  private opts: FeishuMomOptions;
  private client: LarkClient | null = null;
  private sdk: Awaited<ReturnType<typeof loadLark>> = null;

  constructor(opts: FeishuMomOptions) {
    this.opts = opts;
  }

  async startWS(): Promise<void> {
    if (!this.cfg.enabled || !this.cfg.appId || !this.cfg.appSecret) {
      log.warn("feishu.disabled");
      return;
    }
    this.sdk = await loadLark();
    if (!this.sdk) return;

    // ---- Bug A: `Logger.Level` is not a real export. Some docs and old
    // examples reference it; the SDK ships `LoggerLevel` instead. We resolve
    // defensively (see `resolveLogLevel`) and never pass `undefined` to
    // `WSClient`.
    this.client = new this.sdk.Client({ appId: this.cfg.appId!, appSecret: this.cfg.appSecret! });
    const ws = new this.sdk.WSClient({
      appId: this.cfg.appId!,
      appSecret: this.cfg.appSecret!,
      loggerLevel: _resolveLogLevel(this.sdk),
    });

    // ---- Bug B: `new EventDispatcher()` may throw under Bun's ESM bundler
    // because the Lark SDK is CJS and its internals use `__dirname` + a
    // package.json lookup that doesn't survive Bun's tree-shaking. We
    // (1) try the named export, (2) fall back to the `default` interop
    // wrapper, (3) give up with a clear actionable error so the user sees
    // ONE clear failure rather than an infinite restart loop.
    const dispatcher = this._makeDispatcher();
    if (!dispatcher) {
      log.error("feishu.ws.dispatcher.failed", {
        hint: "EventDispatcher could not be constructed under Bun. Either (a) run with Node.js, or (b) set FEISHU_TRANSPORT=webhook and configure a public URL for the Feishu Event Subscription.",
      });
      return;
    }
    dispatcher.register({
      "im.message.receive_v1": (data: unknown) => this.onEvent(data as FeishuEventV2),
    });

    // The SDK exposes `ws.start({ eventDispatcher: dispatcher })`; we
    // forward the call. (Some SDK versions take a different shape; if
    // yours differs, the error is surfaced at boot and we fall back to
    // webhook mode below.)
    try {
      await (ws as unknown as { start: (opts: { eventDispatcher: LarkEventDispatcher }) => Promise<void> }).start({
        eventDispatcher: dispatcher,
      });
      log.info("feishu.ws.started", { bot: this.cfg.botName });
    } catch (e) {
      log.error("feishu.ws.start.failed", {
        err: (e as Error).message,
        hint: "WSClient.start() rejected. If the error mentions __dirname or package.json, switch to Node.js (see Dockerfile).",
      });
    }
  }

  /**
   * @internal — exported for unit tests; do not use from app code.
   */
  _makeDispatcher(): LarkEventDispatcher | null {
    const sdk = this.sdk;
    if (!sdk) return null;
    // Direct named export.
    const DirectCtor = (sdk as unknown as { EventDispatcher?: new () => LarkEventDispatcher }).EventDispatcher;
    // Bun's CJS↔ESM interop may put the constructor on `.default`.
    const DefaultCtor = (sdk as unknown as { default?: { EventDispatcher?: new () => LarkEventDispatcher } }).default?.EventDispatcher;
    for (const Ctor of [DirectCtor, DefaultCtor]) {
      if (typeof Ctor !== "function") continue;
      try {
        return new Ctor({});
      } catch (e) {
        log.warn("feishu.dispatcher.ctor.threw", { err: (e as Error).message });
      }
    }
    return null;
  }

  /** Webhook handler for the HTTP server. Returns a Response synchronously.
   *  Bug #3 fix: when `verificationToken` is configured, verify the
   *  `Lark-Signature` header against HMAC-SHA256(timestamp + nonce + body
   *  + token). When `encryptKey` is configured AND the body has an
   *  `encrypt` field, decrypt the payload (AES-256-CBC, key = SHA256 of
   *  encryptKey) before parsing. Both checks are skipped if the
   *  corresponding config is absent — but the caller's first POST will
   *  fail closed (401) if a token is set but the signature is invalid. */
  async handleWebhook(req: Request): Promise<Response> {
    if (!this.cfg.enabled) return new Response("Feishu disabled", { status: 404 });
    if (req.method === "GET") return new Response("ok", { status: 200 });

    // Read the body once as text — we need the raw string for both the
    // signature HMAC and the JSON parse.
    const raw = await req.text();

    // (1) Signature verification (HMAC-SHA256 over timestamp|nonce|body|token).
    if (this.cfg.verificationToken) {
      if (!this.verifySignature(req, raw)) {
        log.warn("feishu.webhook.sig.fail", {
          ip: req.headers.get("x-forwarded-for") ?? "unknown",
        });
        return new Response("invalid signature", { status: 401 });
      }
    }

    let body: FeishuEventV2 | { challenge?: string; encrypt?: string };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch (e) {
      return new Response(`bad json: ${(e as Error).message}`, { status: 400 });
    }

    // (2) Encrypted payload — decrypt before further processing.
    if ("encrypt" in body && body.encrypt) {
      if (!this.cfg.encryptKey) {
        log.warn("feishu.webhook.encrypted.no_key");
        return new Response("encrypted payload but no encrypt_key configured", { status: 400 });
      }
      try {
        const decrypted = decryptFeishuPayload(body.encrypt, this.cfg.encryptKey);
        body = JSON.parse(decrypted) as typeof body;
      } catch (e) {
        return new Response(`decrypt failed: ${(e as Error).message}`, { status: 400 });
      }
    }

    if ("challenge" in body && body.challenge) {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if ("header" in body && body.header?.event_type === "im.message.receive_v1") {
      // Defer the LLM call so the webhook returns 200 quickly.
      queueMicrotask(() => {
        this.onEvent(body as FeishuEventV2).catch((e) =>
          log.error("feishu.respond.err", { err: (e as Error).message }),
        );
      });
    }
    return new Response("ok", { status: 200 });
  }

  /** HMAC-SHA256(timestamp + nonce + body + verificationToken), compared
   *  in constant time against the `Lark-Signature` header. */
  private verifySignature(req: Request, rawBody: string): boolean {
    const token = this.cfg.verificationToken;
    if (!token) return true;
    const ts = req.headers.get("X-Lark-Request-Timestamp") ?? "";
    const nonce = req.headers.get("X-Lark-Request-Nonce") ?? "";
    const sig = req.headers.get("Lark-Signature") ?? "";
    if (!ts || !nonce || !sig) return false;
    const expected = createHmac("sha256", token)
      .update(ts + nonce + rawBody)
      .digest("hex");
    const a = Buffer.from(sig, "utf-8");
    const b = Buffer.from(expected, "utf-8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private async onEvent(evt: FeishuEventV2): Promise<void> {
    const msg = evt.event.message;
    if (msg.message_type !== "text") return; // image/file support is a follow-up
    const text = parseText(msg.content).trim();
    if (!text) return;
    if (msg.chat_type === "group" && !botMentioned(text, this.cfg.botName, msg.mentions)) return;
    const cleaned = text.replace(new RegExp(`@${this.cfg.botName}\\s*`, "gi"), "").trim();
    log.info("feishu.message", { chatId: msg.chat_id, length: cleaned.length });

    const client = this.client;
    if (!client) {
      // SDK missing — log and skip.
      log.warn("feishu.no.client");
      return;
    }

    const agent = getAgent();
    let full = "";
    try {
      const sub = agent.subscribe((ev: import("@earendil-works/pi-agent-core").AgentEvent) => {
        if (ev.type === "message_update") {
          const mue = ev as { assistantMessageEvent?: { type: string; delta?: string } };
          if (mue.assistantMessageEvent?.type === "text_delta" && mue.assistantMessageEvent.delta) {
            full += mue.assistantMessageEvent.delta;
          }
        }
      });
      try {
        await agent.prompt(cleaned);
      } finally {
        sub();
      }
    } catch (e) {
      full = `error: ${(e as Error).message}`;
    }
    const reply = full.length > this.opts.maxReplyChars
      ? full.slice(0, this.opts.maxReplyChars) + "…"
      : full;
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { msg_type: "text", receive_id: msg.chat_id, content: JSON.stringify({ text: reply }) },
    });
    log.info("feishu.replied", { chatId: msg.chat_id, len: reply.length });
  }
}

export function createFeishuMom(opts: FeishuMomOptions): FeishuMom {
  return new FeishuMom(opts);
}

/** AES-256-CBC decrypt of a Feishu `encrypt` field.
 *  - `encrypt` is base64(IV(16) || ciphertext)
 *  - The symmetric key is `SHA-256(encrypt_key)`.
 *  - Plaintext is PKCS#7-padded UTF-8 JSON. */
function decryptFeishuPayload(encrypted: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const buf = Buffer.from(encrypted, "base64");
  if (buf.length < 32) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, 16);
  const ct = buf.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf-8");
}
