/* eslint-disable */
// Updated manually to reflect project bindings.
import type { AgentNamespace } from "agents";
import type { Workflow, Ai } from "cloudflare:workers";
declare namespace Cloudflare {
	interface Env {
		CHAT_AGENT: AgentNamespace<import("./src/index").ConversationalAgent>;
		CHAT_WORKFLOW: Workflow;
		CONVERSATION_DB: D1Database;
		RATE_LIMITER: KVNamespace;
		AI: Ai;
	}
}
interface Env extends Cloudflare.Env {}
