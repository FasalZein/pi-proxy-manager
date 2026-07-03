/**
 * Proxy manager web UI server (htmx) — runs inside the pi extension process,
 * so saves/toggles register providers in the live pi session.
 */
import { createServer } from "node:http";
import { getCatalog, lookupModel } from "./catalog.ts";
import {
	API_FORMATS,
	type ApplyLive,
	loadConfig,
	loadModelsJson,
	normalizeBaseUrl,
	PORT,
	type ProxyConfig,
	type ProxyEntry,
	resolveKey,
	saveConfig,
	saveModelsJson,
	setScopeRefs,
	slug,
	toggleScope,
} from "./config.ts";
import { runTests } from "./tester.ts";
import {
	errorBox,
	esc,
	flash,
	page,
	type PickerModel,
	renderDetail,
	renderEditView,
	renderHome,
	renderMjDetail,
	renderMjEditView,
	renderModelPicker,
	renderTestResults,
} from "./views.ts";

export { loadConfig, type ProxyEntry } from "./config.ts";

let server: { close(): void; closeAllConnections?: () => void } | undefined;

/** Close the UI server so reloads/new sessions can rebind the port. */
export function stopServer() {
	// Browser tabs hold keep-alive sockets; close() alone would keep the port
	// bound until they drain. Kill the connections so the port frees instantly.
	server?.closeAllConnections?.();
	server?.close();
	server = undefined;
}

interface Reply {
	status: number;
	body: string;
}

/** Read a model's config fields (ctx/max/flags/cost) from the submitted form. */
function modelFromForm(form: URLSearchParams, mid: string) {
	return {
		contextWindow: Number(form.get(`ctx__${mid}`)) || 128000,
		maxTokens: Number(form.get(`max__${mid}`)) || 8192,
		reasoning: form.get(`r__${mid}`) === "on",
		image: form.get(`img__${mid}`) === "on",
		cost: {
			input: Number(form.get(`ci__${mid}`)) || 0,
			output: Number(form.get(`co__${mid}`)) || 0,
			cacheRead: Number(form.get(`cr__${mid}`)) || 0,
			cacheWrite: Number(form.get(`cw__${mid}`)) || 0,
		},
	};
}

export async function startServer(
	applyLive: ApplyLive,
	refreshRegistry?: () => void,
): Promise<{ url: string }> {
	stopServer(); // always serve the currently loaded code

	const ok = (body: string): Reply => ({ status: 200, body });

	const handler = async (
		method: string,
		pathname: string,
		form: URLSearchParams,
		isHtmx: boolean,
	): Promise<Reply> => {
		// Direct loads and history restores get the full page; htmx swaps get fragments.
		const wrap = (config: ProxyConfig, content: string) => (isHtmx ? content : page(config, content));
		const missing = (config: ProxyConfig, what: string) =>
			ok(wrap(config, renderHome(config)) + (isHtmx ? flash("error", what) : ""));
		const renderBack = (config: ProxyConfig, back: string) => {
			const [kind, id] = back.split(":");
			if (kind === "proxy" && config[id]) return renderDetail(id, config[id]);
			const p = loadModelsJson()?.providers?.[id];
			if (kind === "mj" && p) return renderMjDetail(id, p);
			return renderHome(config);
		};

		// -- pages ------------------------------------------------------------

		if (method === "GET" && pathname === "/") {
			return ok(page(loadConfig()));
		}

		if (method === "GET" && pathname === "/list") {
			const config = loadConfig();
			return ok(wrap(config, renderHome(config)));
		}

		const detailMatch = pathname.match(/^\/proxy\/([a-z0-9-]+)$/);
		if (method === "GET" && detailMatch) {
			const config = loadConfig();
			const entry = config[detailMatch[1]];
			if (!entry) return missing(config, "That proxy no longer exists.");
			return ok(wrap(config, renderDetail(detailMatch[1], entry)));
		}

		const editMatch = pathname.match(/^\/edit\/([a-z0-9-]+)$/);
		if (method === "GET" && editMatch) {
			const config = loadConfig();
			const entry = config[editMatch[1]];
			if (!entry) return missing(config, "That proxy no longer exists.");
			return ok(wrap(config, renderEditView(editMatch[1], entry)));
		}

		const mjDetailMatch = pathname.match(/^\/mj\/([A-Za-z0-9_-]+)$/);
		if (method === "GET" && mjDetailMatch) {
			const config = loadConfig();
			const p = loadModelsJson()?.providers?.[mjDetailMatch[1]];
			if (!p) return missing(config, "That provider is no longer in models.json.");
			return ok(wrap(config, renderMjDetail(mjDetailMatch[1], p)));
		}

		const mjEditMatch = pathname.match(/^\/mj-edit\/([A-Za-z0-9_-]+)$/);
		if (method === "GET" && mjEditMatch) {
			const config = loadConfig();
			const p = loadModelsJson()?.providers?.[mjEditMatch[1]];
			if (!p) return missing(config, "That provider is no longer in models.json.");
			return ok(wrap(config, renderMjEditView(mjEditMatch[1], p)));
		}

		// -- shared fragments ---------------------------------------------------

		if (method === "POST" && pathname === "/fetch-models") {
			const baseUrl = normalizeBaseUrl(String(form.get("baseUrl") ?? ""));
			const apiKey = String(form.get("apiKey") ?? "");
			const api = String(form.get("api") ?? "openai-completions");
			if (!baseUrl || !apiKey) {
				return ok(
					errorBox(
						`<strong>Base URL and API key are required.</strong> Fill in the connection fields above, then fetch again.`,
					),
				);
			}
			try {
				const anthropic = api === "anthropic-messages";
				const v1 = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
				const res = await fetch(anthropic ? `${v1}/models` : `${baseUrl}/models`, {
					headers: anthropic
						? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
						: { authorization: `Bearer ${apiKey}` },
					signal: AbortSignal.timeout(15000),
				});
				const body: any = await res.json();
				if (!res.ok || !Array.isArray(body?.data)) {
					const msg = body?.error?.message ?? `HTTP ${res.status}`;
					return ok(
						errorBox(
							`<strong>Couldn't fetch models.</strong> The proxy said: ${esc(msg)}. Check the base URL and key, then try again.`,
						),
					);
				}
				const ids: string[] = body.data.map((m: any) => String(m.id)).filter(Boolean);
				const catalog = await getCatalog();
				const models: PickerModel[] = ids.map((mid) => {
					const info = lookupModel(catalog, mid) ?? {};
					return {
						id: mid,
						ctx: info.ctx ?? 128000,
						max: info.max ?? 8192,
						reasoning: info.reasoning ?? false,
						image: info.image ?? false,
						cost: info.cost,
						checked: true,
					};
				});
				return ok(renderModelPicker(models, Boolean(catalog)));
			} catch (error) {
				return ok(
					errorBox(
						`<strong>Couldn't reach the proxy.</strong> ${esc(error instanceof Error ? error.message : String(error))}. Check the base URL, then try again.`,
					),
				);
			}
		}

		// -- managed proxies (proxies.json) --------------------------------------

		if (method === "POST" && pathname === "/proxies") {
			const provider = String(form.get("provider") ?? "").trim();
			const baseUrl = normalizeBaseUrl(String(form.get("baseUrl") ?? ""));
			const apiKey = String(form.get("apiKey") ?? "").trim();
			const api = String(form.get("api") ?? "openai-completions");
			const modelIds = form.getAll("models").map(String);

			const config = loadConfig();
			const fail = (msg: string): Reply => ok(renderHome(config) + flash("error", msg));

			if (!provider || !baseUrl || !apiKey) return fail("Provider ID, base URL, and API key are all required.");
			const id = slug(provider);
			if (!id) return fail("Provider ID must contain at least one letter or number.");
			if (!API_FORMATS.includes(api as any)) return fail("Unknown API format.");
			if (modelIds.length === 0) return fail("Select at least one model — fetch models first, then save.");

			const existed = id in config;
			const entry: ProxyEntry = {
				baseUrl,
				apiKey,
				api,
				enabled: true,
				objectToolChoice: config[id]?.objectToolChoice ?? false,
				models: modelIds.map((mid) => ({ id: mid, name: mid, ...modelFromForm(form, mid) })),
			};
			config[id] = entry;
			saveConfig(config);
			applyLive(id, entry);
			return ok(
				renderHome(config) +
					flash("ok", `${existed ? "Updated" : "Added"} ${id} — ${modelIds.length} model${modelIds.length === 1 ? "" : "s"} registered in pi as ${id}/…`),
			);
		}

		const toggleMatch = pathname.match(/^\/toggle\/([a-z0-9-]+)$/);
		if (method === "POST" && toggleMatch) {
			const id = toggleMatch[1];
			const back = String(form.get("back") ?? "");
			const config = loadConfig();
			const entry = config[id];
			if (!entry) return ok(renderHome(config) + flash("error", "That proxy no longer exists."));
			entry.enabled = !entry.enabled;
			saveConfig(config);
			applyLive(id, entry);
			return ok(
				renderBack(config, back) +
					flash("ok", entry.enabled ? `${id} enabled — models registered in pi.` : `${id} disabled — models unregistered from pi.`),
			);
		}

		const deleteMatch = pathname.match(/^\/delete\/([a-z0-9-]+)$/);
		if (method === "POST" && deleteMatch) {
			const id = deleteMatch[1];
			const config = loadConfig();
			if (!config[id]) return ok(renderHome(config) + flash("error", "That proxy no longer exists."));
			delete config[id];
			saveConfig(config);
			applyLive(id, null);
			return ok(renderHome(config) + flash("ok", `${id} deleted and unregistered from pi.`));
		}

		const testMatch = pathname.match(/^\/test\/([a-z0-9-]+)$/);
		if (method === "POST" && testMatch) {
			const id = testMatch[1];
			const modelId = String(form.get("model") ?? "");
			const entry = loadConfig()[id];
			if (!entry || !modelId) return ok(errorBox("Proxy or model not found. Go back and try again."));
			const { results, note } = await runTests(id, entry, modelId, applyLive);
			return ok(renderTestResults(modelId, results, note));
		}

		// -- models.json providers (merge-preserving edits) ----------------------

		const mjSaveMatch = pathname.match(/^\/mj-save\/([A-Za-z0-9_-]+)$/);
		if (method === "POST" && mjSaveMatch) {
			const id = mjSaveMatch[1];
			const config = loadConfig();
			const raw = loadModelsJson();
			const prov = raw?.providers?.[id];
			if (!prov) return ok(renderHome(config) + flash("error", "That provider is no longer in models.json."));

			const baseUrl = normalizeBaseUrl(String(form.get("baseUrl") ?? ""));
			const apiKey = String(form.get("apiKey") ?? "").trim();
			const modelIds = form.getAll("models").map(String);
			if (!baseUrl || !apiKey) return ok(renderHome(config) + flash("error", "Base URL and API key are required."));
			if (modelIds.length === 0) return ok(renderHome(config) + flash("error", "Keep at least one model selected."));

			// Merge-preserve: only touch fields the form owns; keep everything else.
			const oldById = new Map<string, any>((prov.models ?? []).map((m: any) => [m.id, m]));
			prov.baseUrl = baseUrl;
			prov.apiKey = apiKey;
			prov.models = modelIds.map((mid) => {
				const old = oldById.get(mid) ?? {};
				const fields = modelFromForm(form, mid);
				return {
					...old,
					id: mid,
					name: old.name ?? mid,
					contextWindow: fields.contextWindow || old.contextWindow || 128000,
					maxTokens: fields.maxTokens || old.maxTokens || 8192,
					reasoning: fields.reasoning,
					input: fields.image ? ["text", "image"] : ["text"],
					cost: fields.cost,
				};
			});
			saveModelsJson(raw);
			refreshRegistry?.();
			return ok(renderHome(config) + flash("ok", `Updated ${id} in models.json — applied to the running pi session.`));
		}

		const mjDeleteMatch = pathname.match(/^\/mj-delete\/([A-Za-z0-9_-]+)$/);
		if (method === "POST" && mjDeleteMatch) {
			const id = mjDeleteMatch[1];
			const config = loadConfig();
			const raw = loadModelsJson();
			if (!raw?.providers?.[id]) return ok(renderHome(config) + flash("error", "That provider is no longer in models.json."));
			delete raw.providers[id];
			saveModelsJson(raw);
			refreshRegistry?.();
			return ok(renderHome(config) + flash("ok", `${id} removed from models.json (backup in models.json.bak).`));
		}

		const mjTestMatch = pathname.match(/^\/test-mj\/([A-Za-z0-9_-]+)$/);
		if (method === "POST" && mjTestMatch) {
			const id = mjTestMatch[1];
			const modelId = String(form.get("model") ?? "");
			const p = loadModelsJson()?.providers?.[id];
			if (!p || !modelId) return ok(errorBox("Provider or model not found. Go back and try again."));
			const entry: ProxyEntry = {
				baseUrl: p.baseUrl,
				apiKey: resolveKey(p.apiKey),
				api: p.api,
				enabled: true,
				models: [],
			};
			const { results, note } = await runTests(id, entry, modelId, applyLive);
			return ok(renderTestResults(modelId, results, note));
		}

		// -- model scope (settings.json enabledModels) ---------------------------

		if (method === "POST" && pathname === "/scope") {
			const ref = String(form.get("ref") ?? "");
			const back = String(form.get("back") ?? "");
			if (!/^[A-Za-z0-9_-]+\/.+$/.test(ref)) return ok(errorBox("Invalid model reference."));

			const added = toggleScope(ref);
			refreshRegistry?.();
			const note = flash(
				"ok",
				added
					? `${ref} enabled in the model scope (settings.json).`
					: `${ref} disabled in the model scope (settings.json).`,
			);

			const config = loadConfig();
			return ok(renderBack(config, back) + note);
		}

		if (method === "POST" && pathname === "/scope-provider") {
			const refs = form.getAll("refs").map(String).filter((ref) => /^[A-Za-z0-9_-]+\/.+$/.test(ref));
			const back = String(form.get("back") ?? "");
			const enabled = form.get("enabled") === "true";
			if (refs.length === 0) return ok(errorBox("No provider models found to update."));

			const changed = setScopeRefs(refs, enabled);
			refreshRegistry?.();
			const provider = refs[0]?.split("/")[0] ?? "provider";
			const note = flash(
				"ok",
				`${provider} ${enabled ? "enabled" : "disabled"} in the model scope (${changed} model${changed === 1 ? "" : "s"} changed).`,
			);

			const config = loadConfig();
			return ok(renderBack(config, back) + note);
		}

		return { status: 404, body: "Not found" };
	};

	const nodeServer = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", async () => {
			try {
				const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
				const isHtmx =
					req.headers["hx-request"] === "true" && req.headers["hx-history-restore-request"] !== "true";
				const reply = await handler(req.method ?? "GET", pathname, new URLSearchParams(body), isHtmx);
				res.writeHead(reply.status, { "content-type": "text/html; charset=utf-8" });
				res.end(reply.body);
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end(error instanceof Error ? error.message : String(error));
			}
		});
	});

	// A stale server (old reload, another pi session) may still hold the base
	// port — walk forward to the next free one so /proxies always serves the
	// code that is loaded right now.
	for (let port = PORT; port < PORT + 10; port++) {
		const bound = await new Promise<boolean>((resolve, reject) => {
			const onError = (error: NodeJS.ErrnoException) => {
				if (error.code === "EADDRINUSE") resolve(false);
				else reject(error);
			};
			nodeServer.once("error", onError);
			nodeServer.listen(port, "127.0.0.1", () => {
				nodeServer.removeListener("error", onError);
				resolve(true);
			});
		});
		if (bound) {
			server = nodeServer;
			return { url: `http://127.0.0.1:${port}` };
		}
	}
	throw new Error(`No free port between ${PORT} and ${PORT + 9}. Close other proxy manager instances.`);
}
