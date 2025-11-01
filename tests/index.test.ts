import {
  env,
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
// Could import any other source file/function here
import worker, {
  decodeBase64,
  enforceRateLimit,
  extractPinnedFacts
} from "../src/index";

declare module "cloudflare:test" {
  // Controls the type of `import("cloudflare:test").env`
  interface ProvidedEnv extends Env {}
}

describe("Chat worker", () => {
  it("responds with structured 404 on unknown route", async () => {
    const request = new Request("http://example.com");
    // Create an empty context to pass to `worker.fetch()`
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    // Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
    await waitOnExecutionContext(ctx);
    const payload = await response.json();
    expect(payload.error).toBe("Not Found");
    expect(response.status).toBe(404);
  });

  it("extracts pinned facts from markdown bullets", () => {
    const summary = `
## Summary
- First actionable detail
- Second item with context
- Third bullet to remember

## Action Items
* Follow up on milestone
    `;
    const facts = extractPinnedFacts(summary);
    expect(facts).toEqual([
      "First actionable detail",
      "Second item with context",
      "Third bullet to remember",
      "Follow up on milestone"
    ]);
  });

  it("decodes base64 strings into byte arrays", () => {
    const encoded = btoa("hello");
    const bytes = decodeBase64(encoded);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("enforces a simple rate limit", async () => {
    const key = `test:${crypto.randomUUID()}`;

    const allowedFirst = await enforceRateLimit(env, key, 2, 1000);
    const allowedSecond = await enforceRateLimit(env, key, 2, 1000);
    const blocked = await enforceRateLimit(env, key, 2, 1000);

    expect(allowedFirst).toBe(true);
    expect(allowedSecond).toBe(true);
    expect(blocked).toBe(false);
  });
});
