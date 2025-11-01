import {
  Agent,
  AgentNamespace,
  getAgentByName,
  routeAgentRequest
} from "agents";
import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
  type Ai,
  type DurableObjectState,
  type Workflow
} from "cloudflare:workers";
import { z } from "zod";

type ChatRole = "user" | "assistant";

interface AgentState {
  conversationId?: string;
  summary?: string;
  pinnedFacts: string[];
  lastUpdated?: string;
}

interface ConversationMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

interface ConversationSummary {
  conversationId: string;
  summary: string;
  updatedAt: number;
}

interface ConversationWorkflowParams {
  conversationId: string;
  maxMessages?: number;
}

export interface Env {
  AI: Ai;
  CHAT_AGENT: AgentNamespace<ConversationalAgent>;
  CHAT_WORKFLOW: Workflow;
  CONVERSATION_DB: D1Database;
  RATE_LIMITER: KVNamespace;
  ASSETS: { fetch: typeof fetch };
}

// Workers AI latest Llama 3.1 instruction-tuned model
const CHAT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const SUMMARY_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const TRANSCRIPTION_MODEL = "@cf/openai/whisper";
const MAX_MESSAGE_LENGTH = 2000;
const RATE_LIMIT_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

const AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "audio/ogg"
] as const;

const voiceMimeTypeSchema = z
  .string()
  .transform((value) => value.split(";")[0].toLowerCase())
  .refine(
    (value) =>
      AUDIO_MIME_TYPES.includes(value as (typeof AUDIO_MIME_TYPES)[number]),
    {
      message: `voiceMimeType must be one of: ${AUDIO_MIME_TYPES.join(", ")}`
    }
  );

const chatRequestSchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    message: z
      .string()
      .trim()
      .min(1, "Message cannot be empty")
      .max(
        MAX_MESSAGE_LENGTH,
        `Message cannot be longer than ${MAX_MESSAGE_LENGTH} characters`
      )
      .optional(),
    voice: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9+/=]+$/, "Voice input must be base64 encoded audio")
      .optional(),
    voiceMimeType: voiceMimeTypeSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .refine((value) => value.message || value.voice, {
    message: "Provide either a text message or voice input"
  });

const agentMessageSchema = z.object({
  conversationId: z.string().uuid(),
  message: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const agentStateUpdateSchema = z.object({
  conversationId: z.string().uuid(),
  summary: z.string().optional(),
  pinnedFacts: z.array(z.string()).optional(),
  lastUpdated: z.string().optional()
});

const MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
  )`
];

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0"
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS, POST, GET",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, CF-Connecting-IP"
};

let schemaReady: Promise<void> | null = null;

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  const response = new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers
  });
  return withSecurityHeaders(response);
}

function emptyResponse(init: ResponseInit): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return withSecurityHeaders(new Response(null, { ...init, headers }));
}

async function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        for (const statement of MIGRATION_STATEMENTS) {
          await db.prepare(statement).run();
        }
      } catch (error) {
        schemaReady = null;
        throw error;
      }
    })();
  }
  await schemaReady;
}

async function ensureConversation(
  db: D1Database,
  conversationId: string,
  createdAt: number
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?1, ?2)`
    )
    .bind(conversationId, createdAt)
    .run();
}

async function persistMessage(
  db: D1Database,
  conversationId: string,
  role: ChatRole,
  content: string,
  createdAt: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(crypto.randomUUID(), conversationId, role, content, createdAt)
    .run();
}

async function fetchMessages(
  db: D1Database,
  conversationId: string,
  limit: number
): Promise<ConversationMessage[]> {
  const result = await db
    .prepare(
      `SELECT id, conversation_id as conversationId, role, content, created_at as createdAt
       FROM conversation_messages
       WHERE conversation_id = ?1
       ORDER BY created_at DESC
       LIMIT ?2`
    )
    .bind(conversationId, limit)
    .all<ConversationMessage>();

  return result.results?.reverse() ?? [];
}

async function fetchSummary(
  db: D1Database,
  conversationId: string
): Promise<ConversationSummary | null> {
  const result = await db
    .prepare(
      `SELECT conversation_id as conversationId, summary, updated_at as updatedAt
       FROM conversation_summaries
       WHERE conversation_id = ?1`
    )
    .bind(conversationId)
    .first<ConversationSummary>();

  return result ?? null;
}

async function persistSummary(
  db: D1Database,
  conversationId: string,
  summary: string,
  updatedAt: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO conversation_summaries (conversation_id, summary, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(conversation_id)
       DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`
    )
    .bind(conversationId, summary, updatedAt)
    .run();
}

const normalizeAudioMimeType = (
  value: string | undefined
): (typeof AUDIO_MIME_TYPES)[number] => {
  const base = value?.split(";")[0].toLowerCase();
  if (!base) {
    return "audio/mpeg";
  }

  if (AUDIO_MIME_TYPES.includes(base as (typeof AUDIO_MIME_TYPES)[number])) {
    return base as (typeof AUDIO_MIME_TYPES)[number];
  }

  if (base === "audio/x-wav") {
    return "audio/wav";
  }

  if (base === "audio/mp3") {
    return "audio/mpeg";
  }

  throw new Error(`Unsupported audio MIME type: ${value}`);
};

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function transcribeVoice(
  env: Env,
  base64Audio: string,
  rawMimeType = "audio/mpeg"
): Promise<string> {
  // Validate the MIME type
  normalizeAudioMimeType(rawMimeType);
  const audioBytes = decodeBase64(base64Audio);

  const result = await env.AI.run(TRANSCRIPTION_MODEL, {
    audio: Array.from(audioBytes)
  });

  const text =
    (result as { text?: string; transcription?: string }).text ??
    (result as { transcription?: string }).transcription;

  if (!text) {
    throw new Error("Unable to transcribe audio input");
  }

  return text.trim();
}

async function runChatCompletion(
  env: Env,
  conversationId: string,
  summary: string | null,
  state: AgentState,
  history: ConversationMessage[],
  userMessage: string
): Promise<string> {
  const systemPrompt = [
    "You are an empathetic AI assistant conversing with a human.",
    "Respond with clear, concise answers while acknowledging prior context.",
    summary
      ? `Conversation summary so far:\n${summary}`
      : "No summary is available yet. Ask clarifying questions if required.",
    state.pinnedFacts?.length
      ? `Important facts to retain:\n${state.pinnedFacts.join("\n")}`
      : "No pinned facts recorded yet.",
    "Keep responses under 200 words unless explicitly asked for detail.",
    "Return markdown formatted answers when it improves readability."
  ].join("\n\n");

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((entry) => ({
      role: entry.role,
      content: entry.content
    })),
    { role: "user", content: userMessage }
  ];

  const result = await env.AI.run(CHAT_MODEL, { messages });
  const response =
    (result as { response?: string }).response ??
    (result as { output_text?: string }).output_text ??
    "";

  if (!response) {
    throw new Error("The AI model did not return a response");
  }

  return response.trim();
}

async function enforceRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowMs: number
): Promise<boolean> {
  const now = Date.now();
  const windowEnd = now + windowMs;
  const ttlSeconds = Math.max(Math.ceil(windowMs / 1000), 60);
  const record =
    (await env.RATE_LIMITER.get<{ count: number; reset: number }>(key, {
      type: "json"
    })) ?? null;

  if (!record || record.reset < now) {
    await env.RATE_LIMITER.put(
      key,
      JSON.stringify({ count: 1, reset: windowEnd }),
      { expirationTtl: ttlSeconds }
    );
    return true;
  }

  if (record.count >= limit) {
    return false;
  }

  const remainingMs = record.reset - now;
  const remainingTtl = Math.max(Math.ceil(remainingMs / 1000), 60);

  await env.RATE_LIMITER.put(
    key,
    JSON.stringify({ count: record.count + 1, reset: record.reset }),
    { expirationTtl: remainingTtl }
  );
  return true;
}

export class ConversationalAgent extends Agent<Env, AgentState> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialState = { pinnedFacts: [] };
  }

  private getSafeState(): AgentState {
    const current = this.state;
    if (!current) {
      return { pinnedFacts: [] };
    }
    if (!Array.isArray(current.pinnedFacts)) {
      return { ...current, pinnedFacts: [] };
    }
    return current;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/agent/message") {
      const payload = agentMessageSchema.parse(await request.json());
      return this.handleMessage(payload);
    }

    if (request.method === "POST" && url.pathname === "/agent/state") {
      const update = agentStateUpdateSchema.parse(await request.json());
      const current = this.getSafeState();
      this.setState({
        ...current,
        conversationId: update.conversationId,
        summary: update.summary ?? current.summary,
        pinnedFacts: update.pinnedFacts ?? current.pinnedFacts,
        lastUpdated: update.lastUpdated ?? new Date().toISOString()
      });

      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Agent route not found" }, { status: 404 });
  }

  private async handleMessage(
    payload: z.infer<typeof agentMessageSchema>
  ): Promise<Response> {
    const { conversationId, message, metadata } = payload;
    const createdAt = Date.now();
    const agentState = this.getSafeState();

    await ensureConversation(
      this.env.CONVERSATION_DB,
      conversationId,
      createdAt
    );

    const summaryRecord = await fetchSummary(
      this.env.CONVERSATION_DB,
      conversationId
    );
    const history = await fetchMessages(
      this.env.CONVERSATION_DB,
      conversationId,
      15
    );

    const reply = await runChatCompletion(
      this.env,
      conversationId,
      summaryRecord?.summary ?? null,
      agentState,
      history,
      message
    );

    await persistMessage(
      this.env.CONVERSATION_DB,
      conversationId,
      "user",
      message,
      createdAt
    );
    await persistMessage(
      this.env.CONVERSATION_DB,
      conversationId,
      "assistant",
      reply,
      Date.now()
    );

    this.setState({
      ...agentState,
      conversationId,
      lastUpdated: new Date().toISOString()
    });

    try {
      await this.env.CHAT_WORKFLOW.create({
        params: { conversationId, maxMessages: 25 },
        id: `${conversationId}-${createdAt}`
      });
    } catch (error) {
      console.error(
        `Failed to schedule workflow for conversation ${conversationId}`,
        error
      );
    }

    return jsonResponse({
      conversationId,
      reply,
      summary: summaryRecord?.summary ?? null,
      metadata: {
        messageCount: history.length + 2,
        receivedAt: new Date(createdAt).toISOString(),
        ...(metadata ?? {})
      }
    });
  }
}

export class ConversationWorkflow extends WorkflowEntrypoint<
  Env,
  ConversationWorkflowParams
> {
  async run(
    event: WorkflowEvent<ConversationWorkflowParams>,
    step: WorkflowStep
  ): Promise<void> {
    const { conversationId, maxMessages = 25 } = event.payload;

    const history = await step.do("fetch recent messages", async () => {
      return fetchMessages(
        this.env.CONVERSATION_DB,
        conversationId,
        maxMessages
      );
    });

    if (!history.length) {
      return;
    }

    const concatenated = history
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`)
      .join("\n\n");

    const summary = await step.do("summarize conversation", async () => {
      const systemPrompt = [
        "Summarize the following conversation in 6 sentences or fewer.",
        "Highlight actionable next steps and key facts worth remembering.",
        "Return the summary in markdown with sections: Summary, Action Items, Facts."
      ].join("\n\n");

      const result = await this.env.AI.run(SUMMARY_MODEL, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: concatenated }
        ]
      });

      const text =
        (result as { response?: string }).response ??
        (result as { output_text?: string }).output_text ??
        "";

      if (!text) {
        throw new Error("Summary model returned an empty response");
      }

      return text.trim();
    });

    const updatedAt = Date.now();

    await step.do("persist summary", async () => {
      await persistSummary(
        this.env.CONVERSATION_DB,
        conversationId,
        summary,
        updatedAt
      );
    });

    await step.do("sync agent state", async () => {
      const agent = await getAgentByName(this.env.CHAT_AGENT, conversationId);
      await (
        await agent
      ).fetch("https://internal.agent/agent/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          summary,
          lastUpdated: new Date(updatedAt).toISOString(),
          pinnedFacts: extractPinnedFacts(summary)
        })
      });
    });
  }
}

function extractPinnedFacts(summary: string): string[] {
  const lines = summary.split("\n");
  const factLines = lines.filter((line) => /^\s*[-*]\s+/u.test(line.trim()));
  return factLines.slice(0, 5).map((line) => line.replace(/^\s*[-*]\s+/u, ""));
}

async function handleChatRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return jsonResponse(
      { error: "Content-Type must be application/json" },
      { status: 415 }
    );
  }

  const body = chatRequestSchema.parse(await request.json());

  const keySeed =
    body.conversationId ??
    request.headers.get("CF-Connecting-IP") ??
    crypto.randomUUID();

  const allowed = await enforceRateLimit(
    env,
    `rate:${keySeed}`,
    RATE_LIMIT_REQUESTS,
    RATE_LIMIT_WINDOW_MS
  );

  if (!allowed) {
    return jsonResponse(
      {
        error: "Rate limit exceeded. Please slow down.",
        retryAfterMs: RATE_LIMIT_WINDOW_MS
      },
      { status: 429 }
    );
  }

  let message = body.message;

  if (!message && body.voice) {
    message = await transcribeVoice(env, body.voice, body.voiceMimeType);
  }

  if (!message) {
    return jsonResponse(
      { error: "No valid message content was provided" },
      { status: 400 }
    );
  }

  const conversationId = body.conversationId ?? crypto.randomUUID();

  const agent = await getAgentByName(env.CHAT_AGENT, conversationId);
  const response = await (
    await agent
  ).fetch("https://internal.agent/agent/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId,
      message,
      metadata: body.metadata ?? {}
    })
  });

  return withSecurityHeaders(response);
}

async function handleHistoryRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) {
    return jsonResponse(
      { error: "conversationId query parameter is required" },
      { status: 400 }
    );
  }
  const summary = await fetchSummary(env.CONVERSATION_DB, conversationId);
  const messages = await fetchMessages(env.CONVERSATION_DB, conversationId, 50);

  return jsonResponse({
    conversationId,
    summary: summary?.summary ?? null,
    lastUpdated: summary ? new Date(summary.updatedAt).toISOString() : null,
    messages
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    await ensureSchema(env.CONVERSATION_DB);

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return emptyResponse({ status: 204 });
    }

    if (url.pathname === "/health") {
      return jsonResponse({
        status: "ok",
        timestamp: new Date().toISOString()
      });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        return await handleChatRequest(request, env);
      } catch (error) {
        console.error("Chat handler error", error);
        return jsonResponse(
          {
            error: "Unable to process chat request",
            details: error instanceof Error ? error.message : "Unknown error"
          },
          { status: 500 }
        );
      }
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      try {
        return await handleHistoryRequest(request, env);
      } catch (error) {
        console.error("History handler error", error);
        return jsonResponse(
          {
            error: "Unable to load conversation history",
            details: error instanceof Error ? error.message : "Unknown error"
          },
          { status: 500 }
        );
      }
    }

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return withSecurityHeaders(agentResponse);
    }

    // For the root path and other paths, serve the static assets
    // This allows Cloudflare Workers Assets to handle the frontend
    if (url.pathname === "/" || !url.pathname.startsWith("/api")) {
      // Return a pass-through response to let Workers Assets handle it
      // Assets are configured in wrangler.jsonc
      return env.ASSETS.fetch(request);
    }

    return jsonResponse(
      {
        error: "Not Found",
        message:
          "Route not handled. Use /api/chat, /api/history, or the Agents endpoints."
      },
      { status: 404 }
    );
  }
} satisfies ExportedHandler<Env>;

export {
  chatRequestSchema,
  decodeBase64,
  enforceRateLimit,
  extractPinnedFacts
};
