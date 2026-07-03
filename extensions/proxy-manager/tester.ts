/**
 * Model tester — runs every check pi needs against a provider endpoint:
 * chat completion, streaming, tool calls, streaming tool calls, and
 * (OpenAI format) tool_choice handling with automatic quirk detection.
 */
import { type ApplyLive, loadConfig, type ProxyEntry, saveConfig } from "./config.ts";

export interface CheckResult {
	label: string;
	ok: boolean;
	note: string;
}

interface CheckOutcome {
	ok: boolean;
	note: string;
}

/** Collects timed check results; failures never throw out of the runner. */
function makeRunner(results: CheckResult[]) {
	return async (label: string, fn: () => Promise<CheckOutcome>) => {
		const started = Date.now();
		try {
			const r = await fn();
			results.push({
				label,
				ok: r.ok,
				note: `${r.note} · ${((Date.now() - started) / 1000).toFixed(1)}s`,
			});
		} catch (error) {
			results.push({ label, ok: false, note: error instanceof Error ? error.message : String(error) });
		}
	};
}

const httpFail = (r: { status: number; text: string }): CheckOutcome => ({
	ok: false,
	note: `HTTP ${r.status}: ${r.text.slice(0, 120)}`,
});

/** Anthropic endpoints live under /v1 whether or not the base URL includes it. */
function anthropicBase(baseUrl: string): string {
	const b = baseUrl.replace(/\/+$/, "");
	return b.endsWith("/v1") ? b : `${b}/v1`;
}

const WEATHER_TOOL = {
	type: "function",
	function: {
		name: "get_weather",
		description: "Get current weather for a city",
		parameters: {
			type: "object",
			properties: { city: { type: "string" } },
			required: ["city"],
		},
	},
};

const ANTHROPIC_WEATHER_TOOL = {
	name: "get_weather",
	description: "Get current weather for a city",
	input_schema: {
		type: "object",
		properties: { city: { type: "string" } },
		required: ["city"],
	},
};

const TOOL_PROMPT = "What is the weather in Paris? Use the get_weather tool.";

async function chatRequest(
	entry: ProxyEntry,
	payload: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
	const res = await fetch(`${entry.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${entry.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(30000),
	});
	return { status: res.status, text: await res.text() };
}

async function messagesRequest(
	entry: ProxyEntry,
	payload: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
	const res = await fetch(`${anthropicBase(entry.baseUrl)}/messages`, {
		method: "POST",
		headers: {
			"x-api-key": entry.apiKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(30000),
	});
	return { status: res.status, text: await res.text() };
}

/**
 * OpenAI-format checks. May persist the object-style tool_choice quirk to
 * proxies.json when the provider id is managed by this extension.
 */
async function runOpenAITests(
	id: string,
	entry: ProxyEntry,
	modelId: string,
	applyLive: ApplyLive,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const timed = makeRunner(results);

	await timed("Chat completion", async () => {
		const r = await chatRequest(entry, {
			model: modelId,
			messages: [{ role: "user", content: "Reply with the word ok." }],
			max_tokens: 16,
		});
		if (r.status !== 200) return httpFail(r);
		const content = JSON.parse(r.text)?.choices?.[0]?.message?.content;
		return typeof content === "string"
			? { ok: true, note: "responded" }
			: { ok: false, note: "200 but no message content" };
	});

	await timed("Streaming", async () => {
		const r = await chatRequest(entry, {
			model: modelId,
			messages: [{ role: "user", content: "Reply with the word ok." }],
			max_tokens: 16,
			stream: true,
		});
		if (r.status !== 200) return httpFail(r);
		return r.text.includes("data:")
			? { ok: true, note: "SSE chunks received" }
			: { ok: false, note: "200 but no SSE data" };
	});

	await timed("Tool call", async () => {
		const r = await chatRequest(entry, {
			model: modelId,
			messages: [{ role: "user", content: TOOL_PROMPT }],
			tools: [WEATHER_TOOL],
			max_tokens: 200,
		});
		if (r.status !== 200) return httpFail(r);
		const toolCalls = JSON.parse(r.text)?.choices?.[0]?.message?.tool_calls;
		return Array.isArray(toolCalls) && toolCalls.length > 0
			? { ok: true, note: `called ${toolCalls[0]?.function?.name ?? "tool"}` }
			: { ok: false, note: "200 but model did not call the tool" };
	});

	await timed("Streaming tool call", async () => {
		const r = await chatRequest(entry, {
			model: modelId,
			messages: [{ role: "user", content: TOOL_PROMPT }],
			tools: [WEATHER_TOOL],
			max_tokens: 200,
			stream: true,
		});
		if (r.status !== 200) return httpFail(r);
		return r.text.includes("tool_calls")
			? { ok: true, note: "tool_calls in stream" }
			: { ok: false, note: "200 but no tool_calls in stream" };
	});

	await timed("tool_choice handling", async () => {
		const base = {
			model: modelId,
			messages: [{ role: "user", content: TOOL_PROMPT }],
			tools: [WEATHER_TOOL],
			max_tokens: 200,
		};
		const asString = await chatRequest(entry, { ...base, tool_choice: "auto" });
		if (asString.status === 200) return { ok: true, note: "standard string form accepted" };

		// Proxy rejected the standard form — check whether object form works.
		const asObject = await chatRequest(entry, { ...base, tool_choice: { type: "auto" } });
		if (asObject.status === 200) {
			if (!entry.objectToolChoice) {
				const config = loadConfig();
				if (config[id]) {
					config[id].objectToolChoice = true;
					saveConfig(config);
					applyLive(id, config[id]);
					entry.objectToolChoice = true;
				}
			}
			return { ok: true, note: "string form rejected — object-style fix enabled automatically" };
		}
		return { ok: false, note: `both forms rejected: HTTP ${asString.status} / ${asObject.status}` };
	});

	return results;
}

/** Anthropic-messages checks: chat, streaming, tool call, streaming tool call. */
async function runAnthropicTests(entry: ProxyEntry, modelId: string): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const timed = makeRunner(results);

	await timed("Chat completion", async () => {
		const r = await messagesRequest(entry, {
			model: modelId,
			max_tokens: 16,
			messages: [{ role: "user", content: "Reply with the word ok." }],
		});
		if (r.status !== 200) return httpFail(r);
		const content = JSON.parse(r.text)?.content;
		return Array.isArray(content) && content.some((b: any) => b.type === "text")
			? { ok: true, note: "responded" }
			: { ok: false, note: "200 but no text content" };
	});

	await timed("Streaming", async () => {
		const r = await messagesRequest(entry, {
			model: modelId,
			max_tokens: 16,
			messages: [{ role: "user", content: "Reply with the word ok." }],
			stream: true,
		});
		if (r.status !== 200) return httpFail(r);
		return r.text.includes("event:") || r.text.includes("data:")
			? { ok: true, note: "SSE chunks received" }
			: { ok: false, note: "200 but no SSE data" };
	});

	await timed("Tool call", async () => {
		const r = await messagesRequest(entry, {
			model: modelId,
			max_tokens: 300,
			messages: [{ role: "user", content: TOOL_PROMPT }],
			tools: [ANTHROPIC_WEATHER_TOOL],
		});
		if (r.status !== 200) return httpFail(r);
		const content = JSON.parse(r.text)?.content;
		return Array.isArray(content) && content.some((b: any) => b.type === "tool_use")
			? { ok: true, note: "called get_weather" }
			: { ok: false, note: "200 but model did not call the tool" };
	});

	await timed("Streaming tool call", async () => {
		const r = await messagesRequest(entry, {
			model: modelId,
			max_tokens: 300,
			messages: [{ role: "user", content: TOOL_PROMPT }],
			tools: [ANTHROPIC_WEATHER_TOOL],
			stream: true,
		});
		if (r.status !== 200) return httpFail(r);
		return r.text.includes("tool_use")
			? { ok: true, note: "tool_use in stream" }
			: { ok: false, note: "200 but no tool_use in stream" };
	});

	return results;
}

/** Dispatch on the provider's API format. `note` set when untestable. */
export async function runTests(
	id: string,
	entry: ProxyEntry,
	modelId: string,
	applyLive: ApplyLive,
): Promise<{ results: CheckResult[]; note?: string }> {
	const api = entry.api ?? "openai-completions";
	if (api === "openai-completions") {
		return { results: await runOpenAITests(id, entry, modelId, applyLive) };
	}
	if (api === "anthropic-messages") {
		return { results: await runAnthropicTests(entry, modelId) };
	}
	return {
		results: [],
		note: `Automated tests cover openai-completions and anthropic-messages — this provider uses ${api}. Test it by running pi with --model ${id}/${modelId}.`,
	};
}
