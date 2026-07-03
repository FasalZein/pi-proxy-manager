/**
 * Proxy manager — registers OpenAI-compatible proxy providers from
 * ~/.pi/agent/proxies.json and serves an htmx web UI to manage them.
 *
 * `/proxies` in pi opens the UI. Saves/toggles/deletes from the UI call
 * pi.registerProvider/unregisterProvider directly, so they take effect in
 * the running session — no restart or /reload needed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type ProxyEntry, startServer, stopServer } from "./server.ts";

export default function (pi: ExtensionAPI) {
	const registered = new Set<string>();
	const objectToolChoice = new Set<string>();

	function applyLive(id: string, entry: ProxyEntry | null) {
		if (!entry || !entry.enabled) {
			pi.unregisterProvider(id);
			registered.delete(id);
			objectToolChoice.delete(id);
			return;
		}
		pi.registerProvider(id, {
			name: entry.name ?? id,
			baseUrl: entry.baseUrl,
			apiKey: entry.apiKey,
			api: (entry.api ?? "openai-completions") as any,
			models: entry.models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: m.reasoning ?? false,
				input: m.image ? ["text", "image"] : ["text"],
				cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow ?? 128000,
				maxTokens: m.maxTokens ?? 8192,
			})),
		});
		registered.add(id);
		if (entry.objectToolChoice) objectToolChoice.add(id);
		else objectToolChoice.delete(id);
	}

	// Register enabled proxies at startup.
	for (const [id, entry] of Object.entries(loadConfig())) {
		if (entry?.baseUrl && entry?.apiKey && entry.models?.length) applyLive(id, entry);
	}

	// Some proxies (new-api channels) only accept object-style tool_choice.
	pi.on("before_provider_request", (event, ctx) => {
		const provider = ctx.model?.provider;
		if (!provider || !objectToolChoice.has(provider)) return;

		const payload = event.payload as Record<string, unknown> | undefined;
		if (payload && typeof payload.tool_choice === "string") {
			return { ...payload, tool_choice: { type: payload.tool_choice } };
		}
	});

	// Some proxies report finish_reason "stop" on streamed tool calls; a
	// stopped assistant message that contains tool calls is a tool-use turn.
	pi.on("message_end", (event, ctx) => {
		const provider = ctx.model?.provider;
		if (!provider || !registered.has(provider)) return;

		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "stop") return;
		if (!message.content.some((block: any) => block.type === "toolCall")) return;

		return { message: { ...message, stopReason: "toolUse" } };
	});

	// Close the server on quit/reload/session switch so the port never goes stale.
	pi.on("session_shutdown", () => {
		stopServer();
	});

	pi.registerCommand("proxies", {
		description: "Open the proxy manager web UI (restarts the server to pick up code changes)",
		handler: async (_args, ctx) => {
			// startServer stops any previous instance, so /reload + /proxies
			// always serves the currently loaded code.
			const refreshRegistry = () => {
				try {
					ctx.modelRegistry.refresh();
				} catch {
					// models.json changes still apply on next pi start
				}
			};
			const { url } = await startServer(applyLive, refreshRegistry);
			ctx.ui.notify(`Proxy manager at ${url}`, "info");
			await pi.exec("open", [url]).catch(() => {});
		},
	});
}
