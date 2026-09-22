import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package publishes DSH-localized Plus metadata", async () => {
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	const en = JSON.parse(await readFile(new URL("../locale/en.json", import.meta.url), "utf8"));
	const zh = JSON.parse(await readFile(new URL("../locale/zh.json", import.meta.url), "utf8"));
	const icon = await readFile(new URL("../assets/opencode-go-plus.svg", import.meta.url), "utf8");
	const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
	const readmeZh = await readFile(new URL("../README.zh.md", import.meta.url), "utf8");

	// Current DSH resolves this resource before loading the plugin. Older DSH
	// ignores it and keeps package.json's English description as its fallback.
	assert.equal(manifest.exports["./locale/*.json"], "./locale/*.json");
	assert.ok(manifest.files.includes("locale/*.json"));
	assert.equal(manifest.icon, "assets/opencode-go-plus.svg");
	assert.ok(manifest.files.includes("assets/*.svg"));
	assert.match(icon, /^<svg\b/);
	assert.ok(Buffer.byteLength(icon, "utf8") <= 256 * 1024);
	assert.equal(manifest.version, "1.1.1");
	assert.equal(typeof manifest.description, "string");
	assert.equal(manifest.engines.node, ">=22.19.0");
	const dshPeerRange = ">=0.1.0-rc.8 <0.2.0 || >=0.1.1-0 <0.2.0 || >=0.1.2-0 <0.2.0 || >=0.1.3-0 <0.2.0 || >=0.1.4-0 <0.2.0 || >=0.1.5-0 <0.2.0 || >=0.1.6-0 <0.2.0 || >=0.1.7-0 <0.2.0";
	for (const peer of [
		"@deepseek-ai/dsh-credentials",
		"@deepseek-ai/dsh-launch-environment",
		"@deepseek-ai/dsh-llm"
	]) {
		assert.equal(manifest.peerDependencies[peer], dshPeerRange);
	}
	assert.equal(en.meta.title, "OpenCode GO Plus");
	assert.equal(zh.meta.description, "将 OpenCode GO 作为独立 LLM 提供商使用；可配置网关、凭据和启用的模型，不会改动 llm-pi-ai。");
	assert.match(import.meta.resolve("dsh-opencode-go-plus/locale/zh.json"), /locale\/zh\.json$/);
	assert.match(readme, /## DSH compatibility/);
	assert.match(readme, /`0\.1\.0-rc\.8`/);
	assert.match(readme, /`0\.1\.7-alpha\.1`/);
	assert.match(readme, /`0\.1\.7-alpha\.2`/);
	assert.match(readme, /Node\.js ≥ 22\.19\.0/);
	assert.match(readmeZh, /## DSH 兼容性/);
	assert.match(readmeZh, /`0\.1\.0-rc\.8`/);
	assert.match(readmeZh, /Node\.js ≥ 22\.19\.0/);
});
