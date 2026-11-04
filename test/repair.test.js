import assert from "node:assert/strict";
import test from "node:test";

import { RepairStream } from "../lib/repair.js";
import { FABRICATED_RESULT_NOTE } from "../lib/dsml.js";

/** The fullwidth vertical bar DSML uses, kept as an escape in source. */
const VB = "\uFF5C";
/** `<｜DSML｜name>` */
const marker = (name) => `<${VB}DSML${VB}${name}>`;
/** `</｜DSML｜name>` */
const closeMarker = (name) => `</${VB}DSML${VB}${name}>`;
/** `<｜DSML｜name attrs>` */
const attr = (name, attrs) => `<${VB}DSML${VB}${name}${attrs}>`;

/** Feed a string in fixed-size pieces, collecting every emitted segment. */
function feed(stream, channel, text, size) {
	const out = [];
	for (let index = 0; index < text.length; index += size) {
		out.push(...stream.push(channel, text.slice(index, index + size)));
	}
	out.push(...stream.end(channel));
	return out;
}

const TOOLS = new Set(["bash", "session_search"]);

test("plain text is forwarded unchanged, byte for byte", () => {
	const stream = new RepairStream({ toolNames: TOOLS });
	const text = "这是一段普通回复，里面没有任何标记。\n第二行。";
	const out = feed(stream, "text", text, 3);
	assert.equal(out.join(""), text);
	assert.equal(stream.textOf("text"), text);
	assert.equal(stream.takeCalls().length, 0);
});

test("a marker split across deltas is still converted", () => {
	const stream = new RepairStream({ toolNames: TOOLS });
	const block = `我先跑一下。\n${attr("invoke", ' name="bash"')}${attr("parameter", ' name="command" string="true"')}ls${closeMarker("parameter")}${closeMarker("invoke")}\n`;
	const out = feed(stream, "text", block, 1);
	const emitted = out.join("");
	assert.equal(emitted.includes("DSML"), false, "no marker may leak into the text");
	assert.equal(stream.textOf("text").trim(), "我先跑一下。");
	const calls = stream.takeCalls();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "bash");
	assert.deepEqual(JSON.parse(calls[0].argumentsJson), { command: "ls" });
	assert.match(calls[0].id, /^call_/);
});

test("the reasoning channel converts too, and keeps its narration", () => {
	const stream = new RepairStream({ toolNames: TOOLS });
	const block = `先查记录。\n${attr("invoke", ' name="session_search"')}${attr("parameter", ' name="query" string="true"')}MCP${closeMarker("parameter")}${closeMarker("invoke")}`;
	const out = feed(stream, "reasoning", block, 2);
	assert.equal(out.join("").includes("DSML"), false);
	assert.equal(stream.textOf("reasoning").trim(), "先查记录。");
	assert.deepEqual(stream.takeCalls().map((call) => call.name), ["session_search"]);
});

test("an unknown tool name passes through verbatim", () => {
	const stream = new RepairStream({ toolNames: TOOLS });
	const block = `${attr("invoke", ' name="rm_rf"')}${attr("parameter", ' name="p" string="true"')}x${closeMarker("parameter")}${closeMarker("invoke")}`;
	const out = feed(stream, "text", block, 4).join("");
	assert.equal(stream.takeCalls().length, 0);
	assert.ok(out.includes("rm_rf"), "the original marker text is preserved");
	assert.equal(stream.evidence().unparsed > 0, true, "and it is counted as unparsed");
});

test("a fabricated result becomes a note and never a call", () => {
	const stream = new RepairStream({ toolNames: TOOLS });
	const block = `我执行一下。\n${marker("tool_result")}\n{"status":"success","output":"drwxr-xr-x"}\n${closeMarker("tool_result")}\n完成。`;
	const out = feed(stream, "text", block, 5).join("");
	assert.equal(stream.takeCalls().length, 0);
	assert.ok(out.includes(FABRICATED_RESULT_NOTE));
	assert.equal(out.includes("drwxr-xr-x"), false);
	assert.ok(out.includes("完成。"));
});

test("runaway repetition trips the guard", () => {
	const stream = new RepairStream({ toolNames: TOOLS });
	const text = "(Output.)".repeat(400);
	feed(stream, "text", text, 16);
	assert.equal(stream.degenerate, true);
	assert.ok(stream.textOf("text").length < text.length, "emission stops early");
});

test("switching the layer off restores the passthrough behavior", () => {
	const stream = new RepairStream({ toolNames: TOOLS, enabled: false });
	const block = `${attr("invoke", ' name="bash"')}${attr("parameter", ' name="command" string="true"')}ls${closeMarker("parameter")}${closeMarker("invoke")}`;
	const out = feed(stream, "text", block, 7).join("");
	assert.equal(out, block);
	assert.equal(stream.takeCalls().length, 0);
});

test("an empty completion is reported as no text and no calls", () => {
	const stream = new RepairStream({ toolNames: TOOLS });
	stream.push("reasoning", "\n");
	stream.end("reasoning");
	const evidence = stream.evidence();
	assert.equal(evidence.textChars, 0);
	assert.equal(evidence.toolCalls, 0);
});
