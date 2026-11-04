import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
	FABRICATED_RESULT_NOTE,
	cleanText,
	cutRanges,
	parseToolCalls,
	stripControlTokens
} from "../lib/dsml.js";

/** The fullwidth vertical bar DSML uses, kept as an escape in source. */
const VB = "\uFF5C";
/** `<｜DSML｜name>` */
const marker = (name) => `<${VB}DSML${VB}${name}>`;
/** `</｜DSML｜name>` */
const closeMarker = (name) => `</${VB}DSML${VB}${name}>`;
/** `<｜DSML｜name attrs>` */
const attr = (name, attrs) => `<${VB}DSML${VB}${name}${attrs}>`;

/** @param {string} name */
function fixture(name) {
	return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

test("stripControlTokens removes template tokens and keeps the prose", () => {
	const BLOCK = "\u2581";
	const sentenceToken = `<${VB}begin${BLOCK}of${BLOCK}sentence${VB}>`;
	const input = `<|im_start|>hello<|im_end|> ${sentenceToken}world`;
	const { text, removed } = stripControlTokens(input);
	assert.equal(text, "hello world");
	assert.equal(removed, 3);
});

test("text-channel DSML becomes two calls and leaves no markup in the prose", () => {
	const { text } = fixture("dsml-content-382");
	const parsed = parseToolCalls(text, { toolNames: new Set(["bash", "cordis_inspect_query"]) });
	assert.ok(parsed, "expected the block to parse");
	assert.deepEqual(parsed.calls.map((call) => call.name), ["bash", "cordis_inspect_query"]);

	const items = JSON.parse(parsed.calls[0].argumentsJson);
	assert.equal(typeof items.command, "string");
	const query = JSON.parse(parsed.calls[1].argumentsJson);
	assert.equal(query.query, "llm-opencode-go");
	assert.equal(query.limit, 5, "string=\"false\" parameters are JSON, not text");

	const cut = cutRanges(text, parsed.ranges);
	assert.ok(cut.text.includes("我来看一下这两个问题"));
	assert.equal(cut.text.includes("DSML"), false, "no marker may survive in the prose");
});

test("reasoning-channel DSML becomes two calls and keeps the narration", () => {
	const { text } = fixture("dsml-reasoning-6a908");
	const parsed = parseToolCalls(text, { toolNames: new Set(["bash", "session_search"]) });
	assert.ok(parsed);
	assert.deepEqual(parsed.calls.map((call) => call.name), ["bash", "session_search"]);
	const cut = cutRanges(text, parsed.ranges);
	assert.equal(cut.text.trim(), "先查一下项目结构和相关记录。");
});

test("a fabricated tool result produces no call and is replaced by a note", () => {
	const { text } = fixture("glm-fabricated-result");
	const parsed = parseToolCalls(text, { toolNames: new Set(["bash"]) });
	assert.equal(parsed, null, "a fabricated result must never become a tool call");
	const cleaned = cleanText(text);
	assert.ok(cleaned.text.includes(FABRICATED_RESULT_NOTE));
	assert.equal(cleaned.text.includes("drwxr-xr-x"), false, "the invented payload is gone");
	assert.ok(cleaned.text.includes("目录里一共 5 项"), "surrounding prose is kept");
});

test("unknown tool name is never converted", () => {
	const text = `${attr("invoke", ' name="rm_rf"')}${attr("parameter", ' name="p" string="true"')}x${closeMarker("parameter")}${closeMarker("invoke")}`;
	assert.equal(parseToolCalls(text, { toolNames: new Set(["bash"]) }), null);
});

test("a truncated block is never converted", () => {
	const text = `before ${attr("invoke", ' name="bash"')}${attr("parameter", ' name="command" string="true"')}ls`;
	assert.equal(parseToolCalls(text, { toolNames: new Set(["bash"]) }), null);
});

test("ordinary prose that merely mentions the marker is untouched", () => {
	const text = "文档里写的是 <" + "DSML" + "> 这种标记，但没有完整块。";
	assert.equal(parseToolCalls(text, { toolNames: new Set(["bash"]) }), null);
	const cleaned = cleanText(text);
	assert.equal(cleaned.text, text);
});

test("Qwen JSON tool_call form is converted", () => {
	const text = `<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>`;
	const parsed = parseToolCalls(text, { toolNames: new Set(["bash"]) });
	assert.ok(parsed);
	assert.equal(parsed.calls[0].name, "bash");
	assert.deepEqual(JSON.parse(parsed.calls[0].argumentsJson), { command: "ls" });
});

test("Qwen function/parameter form is converted", () => {
	const text = `<function=bash><parameter=command>ls -la</parameter></function>`;
	const parsed = parseToolCalls(text, { toolNames: new Set(["bash"]) });
	assert.ok(parsed);
	assert.deepEqual(JSON.parse(parsed.calls[0].argumentsJson), { command: "ls -la" });
});

test("GLM name/parameters tool_call form is converted", () => {
	const text = `<tool_call><name>session_search</name><parameters>{"query":"MCP"}</parameters></tool_call>`;
	const parsed = parseToolCalls(text, { toolNames: new Set(["session_search"]) });
	assert.ok(parsed);
	assert.equal(parsed.calls[0].name, "session_search");
	assert.deepEqual(JSON.parse(parsed.calls[0].argumentsJson), { query: "MCP" });
});

test("wrapper tags are cut along with the invokes", () => {
	const text = `${marker("tool_calls")}${attr("invoke", ' name="bash"')}${attr("parameter", ' name="command" string="true"')}ls${closeMarker("parameter")}${closeMarker("invoke")}${closeMarker("tool_calls")}`;
	const parsed = parseToolCalls(text, { toolNames: new Set(["bash"]) });
	assert.ok(parsed);
	const cut = cutRanges(text, parsed.ranges);
	const { text: cleaned } = stripControlTokens(cut.text);
	assert.equal(cleaned.trim(), "", "no wrapper residue may survive");
});
