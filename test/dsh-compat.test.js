import assert from "node:assert/strict";
import test from "node:test";

import { legacyResolveImageAttachmentAccess, legacyToolCallId } from "../lib/dsh-compat.js";

test("legacy DSH helper fallbacks preserve plain tool ids and mapped images", () => {
	assert.equal(legacyToolCallId("call_123"), "call_123");
	assert.deepEqual(
		legacyResolveImageAttachmentAccess(
			{ imageHostPath() { return "/host/image.png"; } },
			(hostPath) => `/sandbox${hostPath}`,
			{ attachmentId: "image_1" }
		),
		{ readonlyPath: "/sandbox/host/image.png" }
	);
	assert.equal(
		legacyResolveImageAttachmentAccess({}, () => "/unreachable", { attachmentId: "image_1" }),
		undefined
	);
});
