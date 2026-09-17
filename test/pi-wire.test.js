import assert from "node:assert/strict";
import test from "node:test";

import { OpenCodeGoAdapter } from "../lib/adapter.js";

/** Feed the real pi-ai decoder a successful, local-only SSE response. */
function successStream(api, model) {
	if (api === "openai-completions") {
		const chunk = {
			id: "mock-chat", object: "chat.completion.chunk", model,
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
		};
		return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
	}
	const item = {
		id: "mock-message", type: "message", role: "assistant", status: "completed",
		content: [{ type: "output_text", text: "ok", annotations: [] }]
	};
	return [
		{ type: "response.created", response: { id: "mock-response", status: "in_progress", output: [] } },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: "mock-response", status: "completed", output: [item],
				usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 }
			}
		}
	].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

// Exercise the actual adapter -> pi-ai -> HTTP body path. Descriptor-only
// tests miss pi-ai's automatic system-to-developer conversion for reasoning
// models, especially when a relay URL hides the opencode.ai provider identity.
for (const api of ["openai-completions", "openai-responses"]) {
	for (const baseURL of ["https://console-go.example.test/v1", "https://opencode.ai/zen/go"]) {
		test(`${api} preserves system instructions through ${baseURL}`, async (t) => {
			const modelId = api === "openai-completions" ? "deepseek-v4.1-flash" : "grok-4.6";
			const requests = [];
			t.mock.method(globalThis, "fetch", async (input, init) => {
				const request = new Request(input, init);
				const body = await request.json();
				requests.push({ url: request.url, body, session: request.headers.get("x-opencode-session") });
				const messages = body.messages ?? body.input;
				if (messages.some(message => message.role === "developer")) {
					return new Response(JSON.stringify({ error: {
						type: "invalid_request_error",
						message: "messages[0].role: unknown variant `developer`"
					} }), { status: 400, headers: { "content-type": "application/json" } });
				}
				return new Response(successStream(api, modelId), { headers: { "content-type": "text/event-stream" } });
			});
			const adapter = new OpenCodeGoAdapter({
				options: () => ({
					providerRoute: "opencode-go-plus", baseURL, apiKeyEnv: "TEST_KEY",
					modelSource: "selected", defaultContextWindow: 262144, defaultMaxTokens: 32768,
					models: [{ id: modelId, api, reasoning: true, efforts: ["high"], input: ["text"] }]
				}),
				resolveApiKey: async () => "local-mock-key"
			});
			const chunks = [];
			for await (const chunk of adapter.stream({
				provider: "opencode-go-plus", model: modelId, sessionId: "test-session", reasoningEffort: "high",
				system: "Keep the system instruction.",
				messages: [
					{ role: "system", content: [{ type: "text", text: "Keep the additional instruction." }] },
					{ role: "user", content: [{ type: "text", text: "hello" }] }
				]
			})) chunks.push(chunk);
			assert.equal(requests.length, 1);
			const { url, body, session } = requests[0];
			assert.ok(url.endsWith(api === "openai-completions" ? "/v1/chat/completions" : "/v1/responses"));
			const messages = body.messages ?? body.input;
			assert.equal(messages[0].role, "system");
			assert.equal(messages.some(message => message.role === "developer"), false);
			const content = messages[0].content;
			const systemText = typeof content === "string" ? content : content.map(part => part.text).join("");
			assert.equal(systemText, "Keep the system instruction.\n\nKeep the additional instruction.");
			assert.equal(session, "test-session");
			assert.equal(api === "openai-completions" ? body.reasoning_effort : body.reasoning?.effort, "high");
			assert.deepEqual(chunks.find(chunk => chunk.type === "finish")?.reason, { kind: "stop" });
			assert.ok(chunks.some(chunk => chunk.type === "block-end" && chunk.block.type === "text" && chunk.block.text === "ok"));
		});
	}
}


test("a call without a sessionId still carries a routable session header", async () => {
	const { OpenCodeGoAdapter } = await import("../lib/adapter.js");
	const { toPiModel, toPiContext } = await import("../lib/pi-wire.js");
	const modelId = "test-completions";
	const requests = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const body = await request.json();
		requests.push({ url: request.url, body, session: request.headers.get("x-opencode-session") });
		const messages = body.messages ?? body.input;
		if (messages.some(message => message.role === "developer")) {
			return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "messages[0].role: unknown variant `developer`" } }), { status: 400, headers: { "content-type": "application/json" } });
		}
		return new Response(successStream("openai-completions", modelId), { headers: { "content-type": "text/event-stream" } });
	};
	try {
		const adapter = new OpenCodeGoAdapter({
			options: () => ({ providerRoute: "opencode-go-plus", baseURL: "https://gateway.example.test/v1", apiKeyEnv: "K", modelSource: "selected", retries: 0, timeoutMs: 5000, defaultContextWindow: 4096, defaultMaxTokens: 512, models: [{ id: modelId, api: "openai-completions", reasoning: false, input: ["text"] }] }),
			resolveApiKey: async () => "sk-test"
		});
		const options = {
			provider: "opencode-go-plus", model: modelId, // deliberately NO sessionId
			messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }]
		};
		for await (const _chunk of adapter.stream(options)) { /* drain */ }
	} finally {
		globalThis.fetch = original;
	}
	assert.equal(requests.length, 1);
	// the gateway 400s MissingSessionID, so an unset sessionId must fall back to
	// a route-stable sentinel rather than omit the header entirely
	assert.equal(requests[0].session, "dsh-opencode-go-plus");
});
