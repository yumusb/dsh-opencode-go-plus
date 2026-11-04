// @ts-check
/**
 * Streaming repair state machine.
 *
 * The gateway occasionally hands back control-protocol text on the ordinary
 * text or reasoning channel. Rewriting that needs look-ahead: a marker can be
 * split across any number of deltas, and a marker that never completes must not
 * eat the answer. This class buffers only as much as a marker needs, emits
 * everything else immediately, and reports what it did through {@link evidence}
 * so the finish reason can distinguish "answered", "called a tool" and
 * "produced nothing".
 *
 * Two invariants matter to the caller:
 *
 *   1. No character is lost. Every byte is either emitted as text/reasoning or
 *      converted into a tool call; a marker that fails its gate is emitted
 *      verbatim.
 *   2. The block skeleton stays pi-ai's. This class only decides *text*, never
 *      block indices; `pi-wire` keeps forwarding `block-start`/`block-end` with
 *      the indices pi-ai chose and substitutes the repaired text into them.
 *
 * @module dsh-opencode-go-plus/repair
 */

import {
	DSML_PREFIXES,
	FABRICATED_RESULT_NOTE,
	MAX_BLOCK_BYTES,
	cutRanges,
	findMarker,
	isMarkerPrefix,
	neutralizeFabricatedResults,
	parseToolCalls,
	stripTemplateTokens
} from "./dsml.js";

/** Longest repetition unit considered by the runaway guard. */
const REPEAT_UNIT_MAX = 64;
/** How many times a unit must repeat consecutively to count as degenerate. */
const REPEAT_MIN = 32;
/** Scanned window for the repetition check, kept small to stay cheap. */
const REPEAT_WINDOW = 4096;

/**
 * Counters for one process. They are module-level on purpose: the point is to
 * answer "is this happening at all", which needs to survive across streams.
 */
export const repairCounters = {
	/** Streams where a marker became a tool call. */
	dsmlConverted: 0,
	/** Markers detected but passed through because they failed a gate. */
	dsmlUnparsed: 0,
	/** Literal chat-template tokens removed. */
	specialTokensStripped: 0,
	/** Fabricated tool results replaced with the interception note. */
	fabricatedResults: 0,
	/** Streams stopped by the runaway guard. */
	degenerateAborts: 0,
	/** Completions judged empty (thinking-only or nothing at all). */
	emptyCompletions: 0,
	/** `length` finishes reclassified because the stream clearly ended early. */
	suspectTruncations: 0
};

/** @typedef {"text"|"reasoning"} Channel */

/**
 * Per-channel buffer state.
 * @typedef {{
 *   pending: string,
 *   emitted: string,
 *   blockStart: number,
 *   nonSpace: number,
 *   recentTail: string,
 *   degenerate: boolean
 * }} ChannelState
 */

/**
 * @param {object} input
 * @param {Iterable<string>} [input.toolNames] - names declared for this request.
 * @param {boolean} [input.enabled] - whole layer off (`DSH_OPENCODE_GO_REPAIR=off`).
 * @param {boolean} [input.stripSpecialTokens]
 * @param {boolean} [input.dropFabricated]
 * @param {number} [input.maxBufferBytes]
 * @param {number} [input.maxTotalChars]
 */
export class RepairStream {
	constructor({ toolNames = [], enabled = true, stripSpecialTokens = true, dropFabricated = true, maxBufferBytes = MAX_BLOCK_BYTES, maxTotalChars = 100000 } = {}) {
		this.enabled = enabled;
		this.stripSpecialTokens = stripSpecialTokens;
		this.dropFabricated = dropFabricated;
		this.maxBufferBytes = maxBufferBytes;
		this.maxTotalChars = maxTotalChars;
		/** @type {Set<string>} */
		this.toolNames = new Set(toolNames);
		/** @type {{ name: string, argumentsJson: string, id: string }[]} */
		this.calls = [];
		/** @type {Record<Channel, ChannelState>} */
		this.channels = {
			text: { pending: "", emitted: "", blockStart: 0, nonSpace: 0, recentTail: "", degenerate: false },
			reasoning: { pending: "", emitted: "", blockStart: 0, nonSpace: 0, recentTail: "", degenerate: false }
		};
		this.stats = { converted: 0, unparsed: 0, tokens: 0, fabricated: 0 };
		this.streamId = Math.random().toString(36).slice(2, 10);
		this.callSeq = 0;
	}

	/** @returns {boolean} */
	get degenerate() {
		return this.channels.text.degenerate || this.channels.reasoning.degenerate;
	}

	/**
	 * Feed one delta of one channel.
	 * @param {Channel} channel
	 * @param {string} delta
	 * @returns {string[]} text segments to forward, in order
	 */
	push(channel, delta) {
		if (typeof delta !== "string" || delta.length === 0) return [];
		const state = this.channels[channel];
		if (!this.enabled) {
			this.#account(state, delta);
			state.emitted += delta;
			return [delta];
		}
		state.pending += delta;
		return this.#drain(channel, state);
	}

	/**
	 * Close a channel: emit whatever is still buffered.
	 * @param {Channel} channel
	 * @returns {string[]}
	 */
	end(channel) {
		const state = this.channels[channel];
		// A degenerate stream was already cut off; flushing the rest would emit
		// exactly the runaway output the guard exists to stop.
		if (state.degenerate) {
			state.pending = "";
			return [];
		}
		if (!this.enabled || state.pending.length === 0) {
			const pending = state.pending;
			state.pending = "";
			if (pending.length === 0) return [];
			state.emitted += pending;
			return [pending];
		}
		const out = [];
		const cleaned = this.stripSpecialTokens ? stripTemplateTokens(state.pending) : { text: state.pending, removed: 0 };
		this.stats.tokens += cleaned.removed;
		state.pending = "";
		if (cleaned.text.length > 0) {
			state.emitted += cleaned.text;
			out.push(cleaned.text);
		}
		return out;
	}

	/**
	 * Mark the start of a new content block on this channel, so {@link blockText}
	 * reports only that block's repaired text.
	 * @param {Channel} channel
	 */
	beginBlock(channel) {
		const state = this.channels[channel];
		state.blockStart = state.emitted.length;
	}

	/**
	 * The repaired text of the block that is currently open.
	 * @param {Channel} channel
	 * @returns {string}
	 */
	blockText(channel) {
		const state = this.channels[channel];
		return state.emitted.slice(state.blockStart);
	}

	/**
	 * The repaired text of a channel in total (all blocks so far).
	 * @param {Channel} channel
	 * @returns {string}
	 */
	textOf(channel) {
		return this.channels[channel].emitted;
	}

	/**
	 * Hand over the tool calls discovered so far and reset the queue.
	 * @returns {{ name: string, argumentsJson: string, id: string }[]}
	 */
	takeCalls() {
		const calls = this.calls;
		this.calls = [];
		return calls;
	}

	/**
	 * The evidence `mapStopReason` needs: was there an answer, or only thinking?
	 * @returns {{ textChars: number, reasoningChars: number, toolCalls: number, converted: number, unparsed: number, strippedTokens: number, fabricated: number, degenerate: boolean }}
	 */
	evidence() {
		return {
			textChars: this.channels.text.nonSpace,
			reasoningChars: this.channels.reasoning.nonSpace,
			toolCalls: this.stats.converted + this.stats.fabricated * 0,
			converted: this.stats.converted,
			unparsed: this.stats.unparsed,
			strippedTokens: this.stats.tokens,
			fabricated: this.stats.fabricated,
			degenerate: this.degenerate
		};
	}

	/**
	 * Drain as much of the pending buffer as is decidable right now.
	 * @param {Channel} channel
	 * @param {ChannelState} state
	 * @returns {string[]}
	 */
	#drain(channel, state) {
		/** @type {string[]} */
		const out = [];
		while (state.pending.length > 0) {
			if (state.degenerate) break;
			const marker = findMarker(state.pending);
			if (marker === null) {
				const { emit, hold } = this.#splitHoldable(state.pending);
				state.pending = hold;
				this.#emit(state, emit, out);
				break;
			}
			// Emit the safe prefix, keeping any partial marker for the next call.
			if (marker.index > 0) {
				const { emit, hold } = this.#splitHoldable(state.pending.slice(0, marker.index));
				state.pending = hold + state.pending.slice(marker.index);
				this.#emit(state, emit, out);
				if (hold.length > 0) break; // a marker prefix straddles the boundary
			}

			const consumed = this.#consumeOne(state, out);
			if (consumed === "wait") {
				if (state.pending.length > this.maxBufferBytes) {
					this.#passthrough(state, out);
				}
				break;
			}
			if (consumed === "passthrough") {
				this.#passthrough(state, out);
				break;
			}
			// "consumed": loop again on what is left.
		}
		return out;
	}

	/**
	 * Strip tokens, account, and emit one run of ordinary text.
	 * @param {ChannelState} state
	 * @param {string} text
	 * @param {string[]} out
	 */
	#emit(state, text, out) {
		if (text.length === 0) return;
		const cleaned = this.stripSpecialTokens ? stripTemplateTokens(text) : { text, removed: 0 };
		this.stats.tokens += cleaned.removed;
		if (cleaned.text.length === 0) return;
		state.emitted += cleaned.text;
		this.#account(state, cleaned.text);
		out.push(cleaned.text);
	}

	/**
	 * Split text into the part safe to emit now and the suffix that could still
	 * grow into a marker or control token.
	 * @param {string} text
	 * @returns {{ emit: string, hold: string }}
	 */
	#splitHoldable(text) {
		let hold = "";
		const limit = Math.min(text.length, REPEAT_UNIT_MAX);
		for (let size = limit; size > 0; size -= 1) {
			const candidate = text.slice(text.length - size);
			if (isMarkerPrefix(candidate)) {
				hold = candidate;
				break;
			}
		}
		return { emit: text.slice(0, text.length - hold.length), hold };
	}

	/**
	 * Try to consume the marker at the head of `state.pending`.
	 * @param {ChannelState} state
	 * @param {string[]} out
	 * @returns {"consumed"|"wait"|"passthrough"}
	 */
	#consumeOne(state, out) {
		const text = state.pending;
		const marker = findMarker(text);
		if (marker === null || marker.index !== 0) return "passthrough";
		const opener = marker.opener;

		// A residual DSML tag (wrapper remnant, attribute shard): consume the tag
		// itself and keep going. It carries no call, so nothing is converted.
		if (DSML_PREFIXES.includes(opener)) {
			const tagEnd = text.indexOf(">");
			if (tagEnd < 0) return text.length > this.maxBufferBytes ? "passthrough" : "wait";
			state.pending = text.slice(tagEnd + 1);
			this.stats.tokens += 1;
			return "consumed";
		}

		// A wrapper tag carries no information of its own; drop it and continue.
		if (opener.endsWith("tool_calls") || opener.endsWith("calls") || opener.endsWith("tool_call")) {
			const tagEnd = text.indexOf(">");
			if (tagEnd < 0) return "wait";
			state.pending = text.slice(tagEnd + 1);
			this.stats.tokens += 1;
			return "consumed";
		}

		if (opener.endsWith("tool_result")) {
			if (!this.dropFabricated) return "passthrough";
			return this.#consumeFabricated(state, out);
		}

		return this.#consumeToolCalls(state);
	}

	/**
	 * Consume a fabricated `tool_result` block, replacing it with the note.
	 * @param {ChannelState} state
	 * @param {string[]} out
	 * @returns {"consumed"|"wait"|"passthrough"}
	 */
	#consumeFabricated(state, out) {
		const text = state.pending;
		// The marker itself may still be arriving; a half tag is not a failure.
		if (text.indexOf(">") < 0) return text.length > this.maxBufferBytes ? "passthrough" : "wait";
		const neutralized = neutralizeFabricatedResults(text);
		// An undelimited payload is only an error once the buffer is already
		// absurd; otherwise the rest of the block is still arriving.
		if (!neutralized.complete) {
			return text.length > this.maxBufferBytes ? "passthrough" : "wait";
		}
		if (neutralized.removed === 0) return "passthrough";
		state.pending = neutralized.text;
		// The note is emitted as text so the reader sees what was intercepted.
		if (state.pending.startsWith(FABRICATED_RESULT_NOTE)) {
			state.pending = state.pending.slice(FABRICATED_RESULT_NOTE.length);
			this.#emit(state, FABRICATED_RESULT_NOTE, out);
		}
		this.stats.fabricated += 1;
		return "consumed";
	}

	/**
	 * Consume one or more complete tool-call blocks at the head of the buffer.
	 * @param {ChannelState} state
	 * @returns {"consumed"|"wait"|"passthrough"}
	 */
	#consumeToolCalls(state) {
		const text = state.pending;
		if (!this.#isClosed(text)) {
			return text.length > this.maxBufferBytes ? "passthrough" : "wait";
		}
		const parsed = parseToolCalls(text, { toolNames: this.toolNames });
		if (parsed === null) {
			// A null parse usually means the remaining block is still arriving: only
			// the first invoke has closed so far. Wait for the rest instead of
			// emitting a half-converted turn.
			if (this.#openBlocksRemain(text) && text.length <= this.maxBufferBytes) return "wait";
			this.stats.unparsed += 1;
			return "passthrough";
		}
		const cut = cutRanges(text, parsed.ranges);
		state.pending = cut.text;
		for (const call of parsed.calls) {
			this.callSeq += 1;
			this.calls.push({
				name: call.name,
				argumentsJson: call.argumentsJson,
				id: `call_${this.streamId}_${this.callSeq}`
			});
		}
		this.stats.converted += parsed.calls.length;
		return "consumed";
	}

	/**
	/**
	 * Whether the buffer still contains an unclosed block.
	 *
	 * Counting is used rather than "does a closer exist": a response with two
	 * invokes has its first closer long before the second invoke finishes, and
	 * treating that as "closed" is exactly how a half-converted turn got emitted.
	 * @param {string} text
	 * @returns {boolean}
	 */
	#openBlocksRemain(text) {
		const bar = "(?:\\uFF5C|\\|)";
		/** @param {RegExp} re */
		const count = (re) => (text.match(re) ?? []).length;
		const opens = count(new RegExp(`<(?:${bar})DSML(?:${bar})invoke\\b`, "g"));
		const closes = count(new RegExp(`</(?:${bar})DSML(?:${bar})invoke>`, "g"));
		if (opens > closes) return true;
		if (count(/<tool_call>/g) > count(/<\/tool_call>/g)) return true;
		if (count(/<function=/g) > count(/<\/function>/g)) return true;
		return false;
	}

	/**
	 * Whether every block in `text` is closed.
	 * @param {string} text
	 * @returns {boolean}
	 */
	#isClosed(text) {
		return !this.#openBlocksRemain(text);
	}

	/**
	 * Give up on the buffered marker: emit it verbatim.
	 * @param {ChannelState} state
	 * @param {string[]} out
	 */
	#passthrough(state, out) {
		const raw = this.stripSpecialTokens
			? stripTemplateTokens(state.pending)
			: { text: state.pending, removed: 0 };
		this.stats.tokens += raw.removed;
		state.pending = "";
		if (raw.text.length > 0) {
			state.emitted += raw.text;
			this.#account(state, raw.text);
			out.push(raw.text);
		}
	}

	/**
	 * Track volume and runaway repetition.
	 * @param {ChannelState} state
	 * @param {string} chunk
	 */
	#account(state, chunk) {
		state.nonSpace += chunk.replace(/\s+/g, "").length;
		const tail = (state.recentTail + chunk).slice(-REPEAT_WINDOW);
		state.recentTail = tail;
		if (state.nonSpace > this.maxTotalChars) state.degenerate = true;
		if (!state.degenerate && tail.length >= REPEAT_MIN * 2) {
			const repeated = new RegExp(`(.{1,${REPEAT_UNIT_MAX}}?)\\1{${REPEAT_MIN - 1},}`, "u");
			if (repeated.test(tail)) state.degenerate = true;
		}
	}
}

/**
 * Read the repair switches once per stream. The defaults are the fixed
 * behavior; each switch exists for a specific diagnosis:
 *
 *   - `DSH_OPENCODE_GO_REPAIR=off` restores the pre-fix passthrough byte-for-byte;
 *   - `DSH_OPENCODE_GO_KEEP_SPECIAL_TOKENS=1` keeps literal template tokens so
 *     they can be inspected instead of silently disappearing;
 *   - `DSH_OPENCODE_GO_REPAIR_DEBUG=1` logs one counter line per stream.
 * @returns {{ enabled: boolean, stripSpecialTokens: boolean, dropFabricated: boolean, debug: boolean }}
 */
export function repairSwitches() {
	const env = /** @type {Record<string, string|undefined>} */ (process.env);
	return {
		enabled: env.DSH_OPENCODE_GO_REPAIR !== "off",
		stripSpecialTokens: env.DSH_OPENCODE_GO_KEEP_SPECIAL_TOKENS !== "1",
		dropFabricated: env.DSH_OPENCODE_GO_REPAIR !== "off",
		debug: env.DSH_OPENCODE_GO_REPAIR_DEBUG === "1"
	};
}

/**
 * Fold one stream's statistics into the process counters.
 * @param {{ converted: number, unparsed: number, strippedTokens: number, fabricated: number, degenerate: boolean }} stream
 * @param {boolean} emptyCompletion
 */
export function recordStream(stream, emptyCompletion) {
	if (stream.converted > 0) repairCounters.dsmlConverted += 1;
	if (stream.unparsed > 0) repairCounters.dsmlUnparsed += stream.unparsed;
	repairCounters.specialTokensStripped += stream.strippedTokens;
	repairCounters.fabricatedResults += stream.fabricated;
	if (stream.degenerate) repairCounters.degenerateAborts += 1;
	if (emptyCompletion) repairCounters.emptyCompletions += 1;
}
