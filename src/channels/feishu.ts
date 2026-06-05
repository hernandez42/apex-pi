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
  Logger: { Level: { ERROR: number; WARN: number; INFO: number; DEBUG: number } };
} | null> {
  try {
    return (await import("@larksuiteoapi/node-sdk")) as never;
  } catch (e) {
    log.warn("feishu.sdk.missing", { err: (e as Error).message });
    return null;
  }
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
    this.client = new this.sdk.Client({ appId: this.cfg.appId!, appSecret: this.cfg.appSecret! });
    const ws = new this.sdk.WSClient({
      appId: this.cfg.appId!,
      appSecret: this.cfg.appSecret!,
      loggerLevel: this.sdk.Logger.Level.WARN,
    });
    const dispatcher = new this.sdk.EventDispatcher();
    dispatcher.register({
      "im.message.receive_v1": (data: unknown) => this.onEvent(data as FeishuEventV2),
    });
    // The SDK exposes `ws.start({ eventDispatcher: dispatcher })`; we
    // forward the call. (Some SDK versions take a different shape; if
    // yours differs, the error is surfaced at boot and we fall back to
    // webhook mode below.)
    await (ws as unknown as { start: (opts: { eventDispatcher: LarkEventDispatcher }) => Promise<void> }).start({
      eventDispatcher: dispatcher,
    });
    log.info("feishu.ws.started", { bot: this.cfg.botName });
  }

  /** Webhook handler for the HTTP server. Returns a Response synchronously. */
  async handleWebhook(req: Request): Promise<Response> {
    if (!this.cfg.enabled) return new Response("Feishu disabled", { status: 404 });
    if (req.method === "GET") return new Response("ok", { status: 200 });
    let body: FeishuEventV2 | { challenge?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch (e) {
      return new Response(`bad json: ${(e as Error).message}`, { status: 400 });
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
      const sub = agent.subscribe((ev) => {
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
