import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { OpenCodeGoAdapter } from "../lib/adapter.js";

/** The fullwidth vertical bar DSML uses, kept as an escape in source. */
const VB = "\uFF5C";
/** `<｜DSML｜name attrs>` */
const open = (name, attrs = "") => `<${VB}DSML${VB}${name}${attrs}>`;
/** `</｜DSML｜name>` */
const close = (name) => `</${VB}DSML${VB}${name}>`;

/** @param {string} name */
function fixture(name) {
	return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

/** One chat-completions SSE chunk. */
function chunk(delta, finishReason = null) {
	return {
		id: "mock-chunk",
		object: "chat.completion.chunk",
		model: "deepseek-v4.1-flash",
		choices: [{ index: 0, delta, finish_reason: finishReason }]
	};
}

/** Build an SSE body from chunks plus the terminator. */
function sse(...chunks) {
	return chunks.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join("") + "data: [DONE]\n\n";
}

/**
 * Run one stream through the real adapter with a mocked fetch, returning every
 * harness chunk.
 * @param {object} input
 * @param {string} input.body - SSE response body.
 * @param {any[]} [input.tools]
 */
async function run({ body, tools, contextWindow = 262144 }) {
	const adapter = new OpenCodeGoAdapter({
		options: () => ({
			providerRoute: "opencode-go-plus",
			baseURL: "https://relay.example.test/v1",
			apiKeyEnv: "TEST_KEY",
			modelSource: "selected",
			defaultContextWindow: contextWindow,
			defaultMaxTokens: 32768,
			models: [{ id: "deepseek-v4.1-flash", api: "openai-completions", reasoning: true, efforts: ["high"], input: ["text"], contextWindow }]
		}),
		resolveApiKey: async () => "test-key"
	});
	globalThis.fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
	const chunks = [];
	for await (const entry of adapter.stream({
		provider: "opencode-go-plus",
		model: "deepseek-v4.1-flash",
		sessionId: "test-session",
		reasoningEffort: "high",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		...(tools !== undefined ? { tools } : {})
	})) chunks.push(entry);
	return chunks;
}

/** @param {any[]} chunks */
function finishReason(chunks) {
	const finish = chunks.find((entry) => entry.type === "finish");
	return finish === undefined ? undefined : finish.reason;
}

/** @param {any[]} chunks */
function textOf(chunks) {
	return chunks.filter((entry) => entry.type === "text-delta").map((entry) => entry.text).join("");
}

/** @param {any[]} chunks */
function toolCallsOf(chunks) {
	return chunks
		.filter((entry) => entry.type === "block-end" && entry.block?.type === "tool-call")
		.map((entry) => ({ name: entry.block.name, arguments: entry.block.arguments, id: entry.block.id }));
}

const BASH_TOOL = { name: "bash", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } } } };

test("problem B: a thinking-only completion is EMPTY_RESPONSE, not a silent stop", async () => {
	const chunks = await run({
		body: sse(chunk({ role: "assistant", reasoning_content: "\n" }, null), chunk({}, "stop"))
	});
	const reason = finishReason(chunks);
	assert.equal(reason?.kind, "error");
	assert.equal(reason?.failure?.code, "EMPTY_RESPONSE");
	assert.equal(textOf(chunks), "");
});

test("problem B regression: a completion with no content blocks stays EMPTY_RESPONSE", async () => {
	const chunks = await run({ body: sse(chunk({ role: "assistant" }, null), chunk({}, "stop")) });
	const reason = finishReason(chunks);
	assert.equal(reason?.kind, "error");
	assert.equal(reason?.failure?.code, "EMPTY_RESPONSE");
});

test("problem B: a thinking-only completion on a ~300k-token prompt explains what to do", async () => {
	// Observed live: at ~300k prompt tokens the gateway answers with reasoning
	// only, and every retry reproduces it. The message must point at the context
	// size instead of saying "finished without an answer".
	const body = sse(
		chunk({ role: "assistant", reasoning_content: "再想想" }, null),
		{ ...chunk({}, "stop"), usage: { prompt_tokens: 299000, completion_tokens: 12, total_tokens: 299012 } }
	);
	const chunks = await run({ body, contextWindow: 1000000 });
	const reason = finishReason(chunks);
	assert.equal(reason?.failure?.code, "EMPTY_RESPONSE");
	assert.match(reason?.failure?.message ?? "", /299k-token prompt/);
	assert.match(reason?.failure?.message ?? "", /Compact the conversation/);
});

test("problem A: a DSML call written as prose runs as real tool calls", async () => {
	const { text } = fixture("dsml-content-382");
	const third = Math.ceil(text.length / 3);
	const chunks = await run({
		tools: [BASH_TOOL, { name: "cordis_inspect_query", description: "query", parameters: { type: "object" } }],
		body: sse(
			chunk({ role: "assistant", content: text.slice(0, third) }, null),
			chunk({ content: text.slice(third, third * 2) }, null),
			chunk({ content: text.slice(third * 2) }, null),
			chunk({}, "stop")
		)
	});
	const calls = toolCallsOf(chunks);
	assert.deepEqual(calls.map((call) => call.name), ["bash", "cordis_inspect_query"]);
	assert.equal(calls[0].arguments.includes("Get-ChildItem"), true);
	assert.match(calls[0].id, /^call_/);
	assert.equal(new Set(calls.map((call) => call.id)).size, calls.length, "ids are unique");
	assert.equal(textOf(chunks).includes("DSML"), false, "no marker reached the transcript");
	assert.equal(finishReason(chunks)?.kind, "tool-calls");
});

test("problem A: a marker naming an undeclared tool is passed through verbatim", async () => {
	const body = `我需要执行：${open("invoke", ' name="rm_rf"')}${open("parameter", ' name="p" string="true"')}/tmp${close("parameter")}${close("invoke")}`;
	const chunks = await run({ tools: [BASH_TOOL], body: sse(chunk({ role: "assistant", content: body }, null), chunk({}, "stop")) });
	assert.equal(toolCallsOf(chunks).length, 0);
	assert.equal(textOf(chunks), body, "the original bytes are preserved");
	assert.equal(finishReason(chunks)?.kind, "stop");
});

test("problem A: a fabricated tool result is intercepted and never becomes a call", async () => {
	const { text } = fixture("glm-fabricated-result");
	const chunks = await run({ tools: [BASH_TOOL], body: sse(chunk({ role: "assistant", content: text }, null), chunk({}, "stop")) });
	assert.equal(toolCallsOf(chunks).length, 0);
	const emitted = textOf(chunks);
	assert.equal(emitted.includes("drwxr-xr-x"), false, "the invented payload is removed");
	assert.equal(emitted.includes("(已截获"), true, "a visible note replaces it");
	assert.equal(finishReason(chunks)?.kind, "stop");
});

test("negative: native tool calls are passed through untouched", async () => {
	const body = sse(
		chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_native_1", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] }, null),
		chunk({}, "tool_calls")
	);
	const chunks = await run({ tools: [BASH_TOOL], body });
	const calls = toolCallsOf(chunks);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].id, "call_native_1", "the provider's id survives");
	assert.deepEqual(JSON.parse(calls[0].arguments), { command: "ls" });
	assert.equal(finishReason(chunks)?.kind, "tool-calls");
});

test("negative: a genuine output-cap truncation is max-tokens, never an empty response", async () => {
	// A real cap means a lot of text before the budget runs out; the plausibility
	// check must leave that alone.
	const long = "这是一段很长的回答。".repeat(200);
	const chunks = await run({ body: sse(chunk({ role: "assistant", content: long }, null), chunk({}, "length")) });
	assert.equal(finishReason(chunks)?.kind, "max-tokens");
});

test("gateway: an implausibly early length finish is a retryable provider error", async () => {
	// The observed gateway failure: ~100 chars, sub-second, no usage, while the
	// request allowed 32k output tokens. Calling that "too long" hides a cut-off.
	const truncated = "第四轮把最后一个盲点补上了——**根因是测量时机**。\n\n## 真实报告\n\n```\nat=13:13:43  seat=footer  dx=-258";
	const chunks = await run({ body: sse(chunk({ role: "assistant", content: truncated }, null), chunk({}, "length")) });
	const reason = finishReason(chunks);
	assert.equal(reason?.kind, "error");
	assert.equal(reason?.failure?.code, "PROVIDER_ERROR");
	assert.match(reason?.failure?.message ?? "", /ended the stream early/);
});

test("negative: ordinary prose keeps its exact bytes", async () => {
	const body = "这是一段普通回复，包含 < 和 > 以及 & 符号。";
	const chunks = await run({ body: sse(chunk({ role: "assistant", content: body }, null), chunk({}, "stop")) });
	assert.equal(textOf(chunks), body);
	assert.equal(finishReason(chunks)?.kind, "stop");
});
