/**
 * Proxy manager web UI (htmx) served from inside the pi extension process,
 * so saves/toggles can register providers in the live pi session.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "proxies.json");
export const PORT = Number(process.env.PI_PROXY_MANAGER_PORT) || 7788;

/** API formats pi supports for proxy providers (see ~/.pi/agent/models.json). */
const API_FORMATS = [
	"openai-completions",
	"anthropic-messages",
	"openai-responses",
	"openai-codex-responses",
] as const;

export interface ProxyModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	image?: boolean;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ProxyEntry {
	name?: string;
	baseUrl: string;
	apiKey: string;
	api?: string;
	enabled: boolean;
	objectToolChoice?: boolean;
	models: ProxyModel[];
}

export type ProxyConfig = Record<string, ProxyEntry>;

export function loadConfig(): ProxyConfig {
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return {};
	}
}

function saveConfig(config: ProxyConfig) {
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

/** Called after any mutation so index.ts can (un)register the provider in pi. */
export type ApplyLive = (id: string, entry: ProxyEntry | null) => void;

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const esc = (s: unknown) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Normalize a pasted base URL: trim, drop trailing slashes, and strip
 * endpoint paths people paste by accident (/chat/completions, /models, …).
 */
function normalizeBaseUrl(raw: string): string {
	let url = raw.trim().replace(/\/+$/, "");
	url = url.replace(/\/(chat\/completions|completions|responses|messages|models)$/, "");
	return url.replace(/\/+$/, "");
}

// models.dev catalog (context, limits, pricing) — fetched once per server process.
let catalogPromise: Promise<any | undefined> | undefined;
function getCatalog(): Promise<any | undefined> {
	catalogPromise ??= fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(15000) })
		.then((r) => (r.ok ? r.json() : undefined))
		.catch(() => undefined);
	return catalogPromise;
}

interface CatalogInfo {
	ctx?: number;
	max?: number;
	reasoning?: boolean;
	image?: boolean;
	cost?: ProxyModel["cost"];
}

/** Lowercase, drop any vendor prefix ("zai/"), unify separators. */
function normalizeId(id: string): string {
	let s = id.toLowerCase().trim();
	const slash = s.lastIndexOf("/");
	if (slash !== -1) s = s.slice(slash + 1);
	return s.replace(/_/g, "-");
}

/**
 * Find catalog entries for a model id. Exact normalized matches win; otherwise
 * accept catalog ids that are a version-boundary prefix of the proxy id
 * (deepseek-v4-pro-0524 → deepseek-v4-pro) — never the reverse, so glm-5.2
 * can't pick up glm-5.2-air or glm-5.1 pricing.
 */
// "-0524", ".20260101", "-latest", "-chat" … — but never "-air"/"-mini" style variants.
const VERSION_SUFFIX = /^([-.](\d{2,8}|latest|preview|beta|chat|instruct|exp))+$/;

function collectMatches(catalog: any, modelId: string): any[] {
	const target = normalizeId(modelId);
	const exact: any[] = [];
	const prefix: any[] = [];
	for (const provider of Object.values<any>(catalog)) {
		for (const [mid, m] of Object.entries<any>(provider?.models ?? {})) {
			if (!m?.limit) continue;
			const cid = normalizeId(mid);
			if (cid === target) exact.push(m);
			else if (target.startsWith(cid) && VERSION_SUFFIX.test(target.slice(cid.length))) prefix.push(m);
		}
	}
	return exact.length > 0 ? exact : prefix;
}

/**
 * Pick trustworthy values from the matches: the (context, max-out) pair most
 * providers agree on wins; price is the median priced entry in that group,
 * so single outlier/reseller entries can't skew the result.
 */
export function lookupModel(catalog: any, modelId: string): CatalogInfo | undefined {
	if (!catalog) return undefined;
	const matches = collectMatches(catalog, modelId);
	if (matches.length === 0) return undefined;

	const groups = new Map<string, any[]>();
	for (const m of matches) {
		const key = `${m.limit.context}:${m.limit.output}`;
		groups.set(key, [...(groups.get(key) ?? []), m]);
	}
	const winner = [...groups.values()].sort((a, b) => b.length - a.length)[0];

	const priced = winner
		.filter((m) => (m.cost?.input ?? 0) > 0)
		.sort((a, b) => a.cost.input - b.cost.input);
	const source = priced[Math.floor(priced.length / 2)] ?? winner[0];

	return {
		ctx: source.limit.context,
		max: source.limit.output,
		reasoning: winner.some((m) => m.reasoning === true),
		image: winner.some(
			(m) => Array.isArray(m.modalities?.input) && m.modalities.input.includes("image"),
		),
		cost: source.cost
			? {
					input: source.cost.input ?? 0,
					output: source.cost.output ?? 0,
					cacheRead: source.cost.cache_read ?? 0,
					cacheWrite: source.cost.cache_write ?? 0,
				}
			: undefined,
	};
}

const fmtPrice = (n: number) => `$${+n.toFixed(3)}`;

const slug = (s: string) =>
	s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const fmt = (n: number) => n.toLocaleString("en-US");

const maskKey = (key: string) =>
	key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : "•••";

function flash(kind: "ok" | "error", text: string): string {
	return `<div id="flash" hx-swap-oob="true"><p class="flash flash-${kind}" role="status">${esc(text)}</p></div>`;
}

function host(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function renderList(config: ProxyConfig): string {
	const entries = Object.entries(config);
	if (entries.length === 0) {
		return `<div class="empty">
			<p>No proxies yet. Add your first proxy below and its models become selectable in pi right away.</p>
			<a class="btn" href="#add">Add a proxy</a>
		</div>`;
	}

	const rows = entries
		.map(([id, p]) => {
			const models = p.models.map((m) => `<code>${esc(m.id)}</code>`).join(" ");
			return `<li class="proxy${p.enabled ? "" : " proxy-off"}">
				<button class="proxy-open" hx-get="/proxy/${esc(id)}" hx-target="#view" hx-swap="outerHTML"
					hx-push-url="true" aria-label="View details for ${esc(id)}">
					<span class="dot" aria-hidden="true"></span>
					<span class="proxy-info">
						<span class="proxy-head">
							<strong>${esc(id)}</strong>
							<span class="pid">${esc(p.api ?? "openai-completions")}</span>
						</span>
						<span class="proxy-meta">
							<span class="mono">${esc(host(p.baseUrl))}</span>
							<span class="models">${models}</span>
						</span>
					</span>
				</button>
				<div class="proxy-actions">
					<button class="btn btn-small" hx-post="/toggle/${esc(id)}"
						hx-target="#view" hx-swap="outerHTML" hx-disabled-elt="this">
						${p.enabled ? "Disable" : "Enable"}
					</button>
					<button class="btn btn-small btn-danger" hx-post="/delete/${esc(id)}"
						hx-target="#view" hx-swap="outerHTML" hx-disabled-elt="this"
						hx-confirm="Delete ${esc(id)}? Its models will be unregistered from pi.">
						Delete
					</button>
				</div>
			</li>`;
		})
		.join("\n");

	return `<ul class="proxy-rows">${rows}</ul>`;
}

/** Home view: proxy list + add form. Detail/edit views replace this whole region. */
function renderHome(config: ProxyConfig): string {
	return `<div id="view">
	<section aria-labelledby="registered-h">
		<h2 id="registered-h">Registered proxies</h2>
		${renderList(config)}
	</section>

	<section aria-labelledby="add-h" id="add">
		<h2 id="add-h">Add proxy</h2>
		${renderProxyForm()}
	</section>
</div>`;
}

function renderDetail(id: string, p: ProxyEntry): string {
	const modelRows = p.models
		.map(
			(m) => `<tr>
			<td><code>${esc(m.id)}</code></td>
			<td class="num">${fmt(m.contextWindow ?? 128000)}</td>
			<td class="num">${fmt(m.maxTokens ?? 8192)}</td>
			<td class="num">${m.cost && (m.cost.input || m.cost.output) ? `${fmtPrice(m.cost.input)} · ${fmtPrice(m.cost.output)}` : "—"}</td>
			<td class="tag">${m.reasoning ? "✓" : "—"}</td>
			<td class="tag">${m.image ? "✓" : "—"}</td>
			<td class="row-action">
				<button class="btn btn-small" hx-post="/test/${esc(id)}" hx-vals='{"model":"${esc(m.id)}"}'
					hx-target="#test-area" hx-disabled-elt="this" hx-indicator="this">
					<span class="spinner" aria-hidden="true"></span>
					Test
				</button>
			</td>
		</tr>`,
		)
		.join("\n");

	return `<div id="view">
	<div class="detail${p.enabled ? "" : " proxy-off"}">
		<div class="detail-head">
			<button class="btn btn-small" hx-get="/list" hx-target="#view" hx-swap="outerHTML" hx-push-url="/">← All proxies</button>
			<div class="detail-actions">
				<button class="btn btn-small" hx-get="/edit/${esc(id)}" hx-target="#view" hx-swap="outerHTML" hx-push-url="true">Edit</button>
				<button class="btn btn-small" hx-post="/toggle/${esc(id)}"
					hx-target="#view" hx-swap="outerHTML" hx-disabled-elt="this" hx-push-url="/">
					${p.enabled ? "Disable" : "Enable"}
				</button>
				<button class="btn btn-small btn-danger" hx-post="/delete/${esc(id)}"
					hx-target="#view" hx-swap="outerHTML" hx-disabled-elt="this" hx-push-url="/"
					hx-confirm="Delete ${esc(id)}? Its models will be unregistered from pi.">
					Delete
				</button>
			</div>
		</div>
		<div class="detail-title">
			<span class="dot" aria-hidden="true"></span>
			<strong>${esc(id)}</strong>
			<span class="pid">${p.enabled ? "enabled" : "disabled"}</span>
		</div>
		<dl class="detail-grid">
			<dt>Base URL</dt><dd class="mono">${esc(p.baseUrl)}</dd>
			<dt>API key</dt><dd class="mono">${esc(maskKey(p.apiKey))}</dd>
			<dt>API format</dt><dd class="mono">${esc(p.api ?? "openai-completions")}</dd>
			<dt>tool_choice fix</dt><dd>${p.objectToolChoice ? "active — proxy needs object-style tool_choice" : "not needed"}</dd>
		</dl>
		<table class="model-table">
			<thead><tr><th>Model</th><th class="num">Context</th><th class="num">Max out</th><th class="num">$/M in·out</th><th>Reasoning</th><th>Image</th><th></th></tr></thead>
			<tbody>${modelRows}</tbody>
		</table>
		<div id="test-area"></div>
	</div>
</div>`;
}

interface PickerModel {
	id: string;
	ctx: number;
	max: number;
	reasoning: boolean;
	image: boolean;
	cost?: ProxyModel["cost"];
	checked: boolean;
}

function renderModelPicker(models: PickerModel[], enriched = false): string {
	if (models.length === 0) {
		return `<div class="error-box">
			<p><strong>No models returned.</strong> The endpoint answered but the list was empty. Check that the key has access to models, then fetch again.</p>
		</div>`;
	}
	const rows = models
		.map((m) => {
			const id = esc(m.id);
			const matched = Boolean(m.cost && (m.cost.input || m.cost.output));
			const note = matched
				? `<span class="price num">${fmtPrice(m.cost!.input)} in · ${fmtPrice(m.cost!.output)} out /M</span>`
				: enriched
					? `<span class="price">no catalog match — set pricing below</span>`
					: "";
			return `<li class="model-row">
			<div class="model-main">
				<label class="model-pick">
					<input type="checkbox" name="models" value="${id}"${m.checked ? " checked" : ""}>
					<code>${id}</code>
				</label>
				${note}
			</div>
			<div class="model-conf">
				<label class="num-field"><span>Context</span>
					<input type="number" name="ctx__${id}" value="${m.ctx}" min="1" step="any">
				</label>
				<label class="num-field"><span>Max out</span>
					<input type="number" name="max__${id}" value="${m.max}" min="1" step="any">
				</label>
				<label class="num-field"><span>$/M in</span>
					<input type="number" name="ci__${id}" value="${m.cost?.input ?? 0}" min="0" step="any">
				</label>
				<label class="num-field"><span>$/M out</span>
					<input type="number" name="co__${id}" value="${m.cost?.output ?? 0}" min="0" step="any">
				</label>
				<div class="model-flags">
					<label class="flag" title="Model supports extended thinking">
						<input type="checkbox" name="r__${id}"${m.reasoning ? " checked" : ""}> reasoning
					</label>
					<label class="flag" title="Model accepts image input">
						<input type="checkbox" name="img__${id}"${m.image ? " checked" : ""}> image
					</label>
				</div>
				<input type="hidden" name="cr__${id}" value="${m.cost?.cacheRead ?? 0}">
				<input type="hidden" name="cw__${id}" value="${m.cost?.cacheWrite ?? 0}">
			</div>
		</li>`;
		})
		.join("\n");
	const note = enriched
		? "Context, limits, and pricing prefilled from models.dev where known — adjust anything before saving."
		: "Uncheck any you don't want registered.";
	return `<p class="hint">${models.length} model${models.length === 1 ? "" : "s"} found. ${note}</p>
	<ul class="model-list">${rows}</ul>`;
}

function toPickerModels(entry: ProxyEntry): PickerModel[] {
	return entry.models.map((m) => ({
		id: m.id,
		ctx: m.contextWindow ?? 128000,
		max: m.maxTokens ?? 8192,
		reasoning: m.reasoning ?? false,
		image: m.image ?? false,
		cost: m.cost,
		checked: true,
	}));
}

function renderProxyForm(id?: string, entry?: ProxyEntry): string {
	const edit = Boolean(id && entry);
	const formId = edit ? "edit-form" : "add-form";
	const areaId = edit ? "models-area-edit" : "models-area";
	const apiOptions = API_FORMATS.map(
		(a) => `<option value="${a}"${(entry?.api ?? "openai-completions") === a ? " selected" : ""}>${a}</option>`,
	).join("");
	return `<form id="${formId}" hx-post="/proxies" hx-target="#view" hx-swap="outerHTML"
			hx-disabled-elt="find button[type=submit]" ${edit ? 'hx-push-url="/"' : ""}>
			<fieldset>
				<legend>1 · Connection</legend>
				<label class="field"><span>Provider ID</span>
					<input name="provider" required placeholder="my-proxy" autocomplete="off" class="mono" value="${esc(id ?? "")}"${edit ? " readonly" : ""}>
				</label>
				<label class="field"><span>Base URL</span>
					<input name="baseUrl" type="url" required placeholder="https://host.example/v1" autocomplete="off" class="mono" value="${esc(entry?.baseUrl ?? "")}">
				</label>
				<label class="field"><span>API key</span>
					<input name="apiKey" type="password" required placeholder="sk-…" autocomplete="off" class="mono" value="${esc(entry?.apiKey ?? "")}">
				</label>
				<label class="field"><span>API format</span>
					<select name="api">${apiOptions}</select>
				</label>
			</fieldset>

			<fieldset>
				<legend>2 · Models</legend>
				<button type="button" class="btn btn-block" hx-post="/fetch-models"
					hx-include="#${formId} [name='baseUrl'], #${formId} [name='apiKey'], #${formId} [name='api']"
					hx-target="#${areaId}" hx-disabled-elt="this" hx-indicator="this">
					<span class="spinner" aria-hidden="true"></span>
					Fetch models
				</button>
				<div id="${areaId}">${edit ? renderModelPicker(toPickerModels(entry!)) : ""}</div>
			</fieldset>

			<div class="form-actions">
				<button type="submit" class="btn btn-primary btn-block" hx-indicator="this">
					<span class="spinner" aria-hidden="true"></span>
					${edit ? "Save changes" : "Save &amp; register in pi"}
				</button>
				<p class="hint form-hint">${edit ? "Changes re-register the provider in the running pi session immediately." : "Models register as provider-id/model-id. Saving an existing provider updates it."}</p>
			</div>
		</form>`;
}

function renderEditView(id: string, entry: ProxyEntry): string {
	return `<div id="view">
	<div class="detail">
		<div class="detail-head">
			<button class="btn btn-small" hx-get="/proxy/${esc(id)}" hx-target="#view" hx-swap="outerHTML" hx-push-url="true">← Details</button>
		</div>
		<div class="detail-title">
			<span class="dot" aria-hidden="true"></span>
			<strong>Edit ${esc(id)}</strong>
		</div>
		${renderProxyForm(id, entry)}
	</div>
</div>`;
}

// ---------------------------------------------------------------------------
// Model tester
// ---------------------------------------------------------------------------

interface CheckResult {
	label: string;
	ok: boolean;
	note: string;
}

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

/** Runs every check pi needs. May enable the tool_choice quirk in config. */
async function runModelTests(
	id: string,
	entry: ProxyEntry,
	modelId: string,
	applyLive: ApplyLive,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const timed = async (label: string, fn: () => Promise<{ ok: boolean; note: string }>) => {
		const started = Date.now();
		try {
			const r = await fn();
			results.push({ label, ok: r.ok, note: `${r.note} · ${((Date.now() - started) / 1000).toFixed(1)}s` });
		} catch (error) {
			results.push({
				label,
				ok: false,
				note: error instanceof Error ? error.message : String(error),
			});
		}
	};

	await timed("Chat completion", async () => {
		const r = await chatRequest(entry, {
			model: modelId,
			messages: [{ role: "user", content: "Reply with the word ok." }],
			max_tokens: 16,
		});
		if (r.status !== 200) return { ok: false, note: `HTTP ${r.status}: ${r.text.slice(0, 120)}` };
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
		if (r.status !== 200) return { ok: false, note: `HTTP ${r.status}: ${r.text.slice(0, 120)}` };
		return r.text.includes("data:")
			? { ok: true, note: "SSE chunks received" }
			: { ok: false, note: "200 but no SSE data" };
	});

	await timed("Tool call", async () => {
		const r = await chatRequest(entry, {
			model: modelId,
			messages: [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }],
			tools: [WEATHER_TOOL],
			max_tokens: 200,
		});
		if (r.status !== 200) return { ok: false, note: `HTTP ${r.status}: ${r.text.slice(0, 120)}` };
		const toolCalls = JSON.parse(r.text)?.choices?.[0]?.message?.tool_calls;
		return Array.isArray(toolCalls) && toolCalls.length > 0
			? { ok: true, note: `called ${toolCalls[0]?.function?.name ?? "tool"}` }
			: { ok: false, note: "200 but model did not call the tool" };
	});

	await timed("Streaming tool call", async () => {
		const r = await chatRequest(entry, {
			model: modelId,
			messages: [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }],
			tools: [WEATHER_TOOL],
			max_tokens: 200,
			stream: true,
		});
		if (r.status !== 200) return { ok: false, note: `HTTP ${r.status}: ${r.text.slice(0, 120)}` };
		return r.text.includes("tool_calls")
			? { ok: true, note: "tool_calls in stream" }
			: { ok: false, note: "200 but no tool_calls in stream" };
	});

	await timed("tool_choice handling", async () => {
		const base = {
			model: modelId,
			messages: [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }],
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
	const timed = async (label: string, fn: () => Promise<{ ok: boolean; note: string }>) => {
		const started = Date.now();
		try {
			const r = await fn();
			results.push({ label, ok: r.ok, note: `${r.note} · ${((Date.now() - started) / 1000).toFixed(1)}s` });
		} catch (error) {
			results.push({ label, ok: false, note: error instanceof Error ? error.message : String(error) });
		}
	};

	await timed("Chat completion", async () => {
		const r = await messagesRequest(entry, {
			model: modelId,
			max_tokens: 16,
			messages: [{ role: "user", content: "Reply with the word ok." }],
		});
		if (r.status !== 200) return { ok: false, note: `HTTP ${r.status}: ${r.text.slice(0, 120)}` };
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
		if (r.status !== 200) return { ok: false, note: `HTTP ${r.status}: ${r.text.slice(0, 120)}` };
		return r.text.includes("event:") || r.text.includes("data:")
			? { ok: true, note: "SSE chunks received" }
			: { ok: false, note: "200 but no SSE data" };
	});

	await timed("Tool call", async () => {
		const r = await messagesRequest(entry, {
			model: modelId,
			max_tokens: 300,
			messages: [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }],
			tools: [ANTHROPIC_WEATHER_TOOL],
		});
		if (r.status !== 200) return { ok: false, note: `HTTP ${r.status}: ${r.text.slice(0, 120)}` };
		const content = JSON.parse(r.text)?.content;
		return Array.isArray(content) && content.some((b: any) => b.type === "tool_use")
			? { ok: true, note: "called get_weather" }
			: { ok: false, note: "200 but model did not call the tool" };
	});

	await timed("Streaming tool call", async () => {
		const r = await messagesRequest(entry, {
			model: modelId,
			max_tokens: 300,
			messages: [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }],
			tools: [ANTHROPIC_WEATHER_TOOL],
			stream: true,
		});
		if (r.status !== 200) return { ok: false, note: `HTTP ${r.status}: ${r.text.slice(0, 120)}` };
		return r.text.includes("tool_use")
			? { ok: true, note: "tool_use in stream" }
			: { ok: false, note: "200 but no tool_use in stream" };
	});

	return results;
}

function renderTestResults(modelId: string, results: CheckResult[], apiNote?: string): string {
	if (apiNote) {
		return `<div class="error-box"><p>${esc(apiNote)}</p></div>`;
	}
	const passed = results.filter((r) => r.ok).length;
	const rows = results
		.map(
			(r) => `<li class="check-row ${r.ok ? "check-pass" : "check-fail"}">
			<span class="check-mark" aria-hidden="true">${r.ok ? "✓" : "✗"}</span>
			<span class="check-label">${esc(r.label)}</span>
			<span class="check-note">${esc(r.note)}</span>
		</li>`,
		)
		.join("\n");
	const verdict =
		passed === results.length
			? `All ${results.length} checks passed — <code>${esc(modelId)}</code> is ready for pi.`
			: `${passed}/${results.length} checks passed for <code>${esc(modelId)}</code>. Failing checks may be proxy instability — run the test again to confirm.`;
	return `<div class="test-results">
		<p class="hint">${verdict}</p>
		<ul class="checks">${rows}</ul>
	</div>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function page(config: ProxyConfig, content?: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi · proxy manager</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
<style>
:root {
	color-scheme: dark;
	--bg: oklch(17% 0.006 250);
	--surface: oklch(21% 0.008 250);
	--surface-2: oklch(25% 0.009 250);
	--border: oklch(30% 0.01 250);
	--text: oklch(93% 0.005 250);
	--muted: oklch(64% 0.012 250);
	--accent: oklch(78% 0.14 155);
	--accent-ink: oklch(22% 0.05 155);
	--danger: oklch(70% 0.15 25);
	--radius: 8px;
	--radius-sm: 6px;
	--ease-out: cubic-bezier(0.25, 1, 0.5, 1);
}
* { box-sizing: border-box; }
body {
	margin: 0;
	background: var(--bg);
	color: var(--text);
	font: 400 0.9375rem/1.5 "Instrument Sans", system-ui, sans-serif;
	font-weight: 380;
	-webkit-font-smoothing: antialiased;
}
main { max-width: 44rem; margin: 0 auto; padding: 48px 24px 96px; }
header { margin-bottom: 40px; }
h1 { font-size: 1.375rem; font-weight: 600; line-height: 1.2; margin: 0 0 8px; text-wrap: balance; }
h2 { font-size: 0.8125rem; font-weight: 600; line-height: 1.3; margin: 0 0 16px; color: var(--muted); text-transform: uppercase; }
header p { margin: 0; color: var(--muted); max-width: 45ch; text-wrap: pretty; }
section { margin-bottom: 48px; }
code, .mono { font-family: ui-monospace, "SF Mono", monospace; font-size: 0.8125rem; }
input[type="number"], .num { font-variant-numeric: tabular-nums; }

/* flash */
.flash { border-radius: var(--radius-sm); padding: 12px 16px; margin: 0 0 24px; animation: rise 200ms var(--ease-out) backwards; }
@keyframes rise { from { opacity: 0; transform: translateY(4px); } }
.flash-ok { background: color-mix(in oklch, var(--accent) 12%, transparent); color: var(--accent); }
.flash-error { background: color-mix(in oklch, var(--danger) 12%, transparent); color: var(--danger); }

/* proxy rows */
.proxy-rows { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); }
.proxy { display: flex; align-items: center; gap: 16px; padding: 8px 16px 8px 0; }
.proxy + .proxy { border-top: 1px solid var(--border); }
.proxy-open {
	display: flex; align-items: center; gap: 16px; flex: 1; min-width: 0;
	background: none; border: 0; color: inherit; font: inherit; text-align: left;
	padding: 8px 0 8px 16px; cursor: pointer; border-radius: 4px;
	transition: background-color 150ms var(--ease-out);
}
.proxy-open:hover { background: var(--surface); }
.proxy-open:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.dot { width: 8px; height: 8px; border-radius: 9999px; background: var(--accent); flex-shrink: 0; }
.proxy-off .dot { background: var(--muted); }
.proxy-off .proxy-info, .proxy-off .detail-grid, .proxy-off .model-table { opacity: 0.55; }
.proxy-info { flex: 1; min-width: 0; display: block; }
.proxy-head { display: flex; align-items: baseline; gap: 8px; }
.pid { color: var(--muted); font-size: 0.8125rem; }
.proxy-meta { display: flex; gap: 16px; color: var(--muted); margin-top: 4px; flex-wrap: wrap; }
.models code { background: var(--surface-2); border-radius: 4px; padding: 1px 6px; }
.proxy-actions { display: flex; gap: 8px; flex-shrink: 0; }

/* detail view */
.detail { border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; }
.detail-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.detail-actions { display: flex; gap: 8px; }
.detail-title { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
.detail-title strong { font-size: 1.0625rem; }
.detail-grid { display: grid; grid-template-columns: auto 1fr; gap: 8px 24px; margin: 0 0 24px; }
.detail-grid dt { color: var(--muted); font-size: 0.8125rem; }
.detail-grid dd { margin: 0; overflow-wrap: anywhere; }
.model-table { width: 100%; border-collapse: collapse; }
.model-table th { text-align: left; font-size: 0.75rem; font-weight: 500; color: var(--muted); padding: 8px; border-bottom: 1px solid var(--border); }
.model-table td { padding: 8px; border-bottom: 1px solid var(--border); }
.model-table tr:last-child td { border-bottom: 0; }
.model-table th.num, .model-table td.num { text-align: right; }
.model-table .tag { color: var(--muted); }
.model-table .row-action { text-align: right; }

/* test results */
.test-results { margin-top: 16px; }
.checks { list-style: none; margin: 8px 0 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.check-row { display: flex; align-items: baseline; gap: 12px; padding: 8px 16px; }
.check-row + .check-row { border-top: 1px solid var(--border); }
.check-mark { flex-shrink: 0; }
.check-pass .check-mark { color: var(--accent); }
.check-fail .check-mark { color: var(--danger); }
.check-label { font-weight: 500; min-width: 11rem; }
.check-note { color: var(--muted); font-size: 0.8125rem; }

/* empty state */
.empty { border: 1px dashed var(--border); border-radius: var(--radius); padding: 32px 24px; text-align: center; }
.empty p { margin: 0 0 16px; color: var(--muted); max-width: 45ch; margin-inline: auto; text-wrap: pretty; }

/* form */
form { border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; background: var(--surface); }
fieldset { border: 0; margin: 0 0 24px; padding: 0; }
legend { font-size: 0.8125rem; font-weight: 600; color: var(--muted); padding: 0; margin-bottom: 12px; }
.field { display: block; margin-bottom: 16px; }
.field span { display: block; font-size: 0.8125rem; font-weight: 500; margin-bottom: 4px; }
.field input, .field select {
	width: 100%; min-height: 44px; padding: 8px 12px;
	background: var(--bg); color: var(--text);
	border: 1px solid var(--border); border-radius: var(--radius-sm);
	font: inherit;
}
.field input:hover, .field select:hover { border-color: var(--muted); }
.field input:focus-visible, .field select:focus-visible,
.model-pick input:focus-visible, .flag input:focus-visible, .num-field input:focus-visible {
	outline: 2px solid var(--accent); outline-offset: 2px;
}
.hint { color: var(--muted); font-size: 0.8125rem; margin: 0 0 8px; }

/* models picker */
.model-list { list-style: none; margin: 0; padding: 0; }
.model-row { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--border); animation: rise 200ms var(--ease-out) backwards; }
.model-main { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.price { color: var(--muted); font-size: 0.8125rem; white-space: nowrap; }
.model-conf { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: 8px 12px; align-items: end; padding-inline-start: 24px; }
.model-flags { display: flex; align-items: center; gap: 16px; padding-bottom: 12px; white-space: nowrap; }
.model-row:nth-child(2) { animation-delay: 40ms; }
.model-row:nth-child(3) { animation-delay: 80ms; }
.model-row:nth-child(4) { animation-delay: 120ms; }
.model-row:nth-child(5) { animation-delay: 160ms; }
.model-row:nth-child(n+6) { animation-delay: 200ms; }
.model-row:last-child { border-bottom: 0; }
.model-pick { display: flex; align-items: center; gap: 8px; min-width: 0; }
.model-pick input, .flag input { width: 16px; height: 16px; accent-color: var(--accent); }
.flag { display: flex; align-items: center; gap: 6px; font-size: 0.75rem; color: var(--muted); }
.num-field { display: flex; flex-direction: column; gap: 4px; font-size: 0.75rem; color: var(--muted); font-weight: 500; }
.num-field input {
	width: 100%; min-height: 36px; padding: 4px 8px;
	background: var(--bg); color: var(--text);
	border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit;
}
.num-field input:hover { border-color: var(--muted); }
.error-box { background: color-mix(in oklch, var(--danger) 10%, transparent); border-radius: var(--radius-sm); padding: 12px 16px; margin-top: 12px; }
.error-box p { margin: 0; color: var(--danger); }

/* buttons */
.btn {
	display: inline-flex; align-items: center; justify-content: center; gap: 8px;
	min-height: 44px; padding: 8px 20px;
	border: 1px solid var(--border); border-radius: var(--radius-sm);
	background: var(--surface-2); color: var(--text);
	font: inherit; font-weight: 500; cursor: pointer; white-space: nowrap;
	transition: background-color 150ms var(--ease-out), transform 100ms var(--ease-out);
	text-decoration: none;
}
.btn:hover { background: color-mix(in oklch, var(--surface-2) 85%, white); }
.btn:active { transform: scale(0.96); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn:disabled { opacity: 0.5; pointer-events: none; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn-primary:hover { background: color-mix(in oklch, var(--accent) 88%, white); }
.btn-small { min-height: 36px; padding: 4px 12px; font-size: 0.8125rem; }
.btn-block { width: 100%; }
.btn-danger { color: var(--danger); }
.btn-danger:hover { background: color-mix(in oklch, var(--danger) 12%, transparent); }
.form-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; margin-top: 8px; }
.form-hint { margin: 0; max-width: 45ch; text-wrap: pretty; }

/* confirm dialog */
dialog.confirm { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; max-width: 24rem; }
dialog.confirm::backdrop { background: rgb(0 0 0 / 0.55); }
dialog.confirm p { margin: 0; text-wrap: pretty; }
.dialog-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 24px; }
.detail form { border: 0; padding: 0; background: none; }

/* loading indicator */
.spinner { display: none; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 9999px; animation: spin 600ms linear infinite; }
.htmx-request .spinner, .htmx-request.spinner { display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
	*, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
</style>
</head>
<body>
<main>
	<header>
		<h1>Proxy manager</h1>
		<p>OpenAI-compatible proxies for pi. Saves, toggles, and deletes apply to the running pi session immediately — no restart.</p>
	</header>

	<div id="flash"></div>

	${content ?? renderHome(config)}
</main>

<dialog class="confirm" id="confirm">
	<p id="confirm-msg"></p>
	<div class="dialog-actions">
		<button type="button" class="btn btn-small" id="confirm-cancel">Cancel</button>
		<button type="button" class="btn btn-small btn-danger" id="confirm-ok">Delete</button>
	</div>
</dialog>
<script>
(function () {
	var dlg = document.getElementById("confirm");
	var issue = null;
	document.addEventListener("htmx:confirm", function (e) {
		if (!e.detail.question) return;
		e.preventDefault();
		document.getElementById("confirm-msg").textContent = e.detail.question;
		issue = function () { e.detail.issueRequest(true); };
		dlg.showModal();
	});
	document.getElementById("confirm-cancel").addEventListener("click", function () { dlg.close(); });
	document.getElementById("confirm-ok").addEventListener("click", function () {
		dlg.close();
		if (issue) issue();
	});
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

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

export async function startServer(applyLive: ApplyLive): Promise<{ url: string }> {
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
			if (!entry) return ok(wrap(config, renderHome(config)) + (isHtmx ? flash("error", "That proxy no longer exists.") : ""));
			return ok(wrap(config, renderDetail(detailMatch[1], entry)));
		}

		const editMatch = pathname.match(/^\/edit\/([a-z0-9-]+)$/);
		if (method === "GET" && editMatch) {
			const config = loadConfig();
			const entry = config[editMatch[1]];
			if (!entry) return ok(wrap(config, renderHome(config)) + (isHtmx ? flash("error", "That proxy no longer exists.") : ""));
			return ok(wrap(config, renderEditView(editMatch[1], entry)));
		}

		if (method === "POST" && pathname === "/fetch-models") {
			const baseUrl = normalizeBaseUrl(String(form.get("baseUrl") ?? ""));
			const apiKey = String(form.get("apiKey") ?? "");
			const api = String(form.get("api") ?? "openai-completions");
			if (!baseUrl || !apiKey) {
				return ok(
					`<div class="error-box"><p><strong>Base URL and API key are required.</strong> Fill in the connection fields above, then fetch again.</p></div>`,
				);
			}
			try {
				const modelsUrl =
					api === "anthropic-messages" ? `${anthropicBase(baseUrl)}/models` : `${baseUrl}/models`;
				const headers: Record<string, string> =
					api === "anthropic-messages"
						? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
						: { authorization: `Bearer ${apiKey}` };
				const res = await fetch(modelsUrl, {
					headers,
					signal: AbortSignal.timeout(15000),
				});
				const body: any = await res.json();
				if (!res.ok || !Array.isArray(body?.data)) {
					const msg = body?.error?.message ?? `HTTP ${res.status}`;
					return ok(
						`<div class="error-box"><p><strong>Couldn't fetch models.</strong> The proxy said: ${esc(msg)}. Check the base URL and key, then try again.</p></div>`,
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
					`<div class="error-box"><p><strong>Couldn't reach the proxy.</strong> ${esc(error instanceof Error ? error.message : String(error))}. Check the base URL, then try again.</p></div>`,
				);
			}
		}

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
				models: modelIds.map((mid) => ({
					id: mid,
					name: mid,
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
				})),
			};
			config[id] = entry;
			saveConfig(config);
			applyLive(id, entry);
			return ok(
				renderHome(config) +
					flash("ok", `${existed ? "Updated" : "Added"} ${id} — ${modelIds.length} model${modelIds.length === 1 ? "" : "s"} registered in pi as ${id}/…`),
			);
		}

		const testMatch = pathname.match(/^\/test\/([a-z0-9-]+)$/);
		if (method === "POST" && testMatch) {
			const id = testMatch[1];
			const modelId = String(form.get("model") ?? "");
			const config = loadConfig();
			const entry = config[id];
			if (!entry || !modelId) return ok(`<div class="error-box"><p>Proxy or model not found. Go back and try again.</p></div>`);
			const api = entry.api ?? "openai-completions";
			if (api === "openai-completions") {
				return ok(renderTestResults(modelId, await runModelTests(id, entry, modelId, applyLive)));
			}
			if (api === "anthropic-messages") {
				return ok(renderTestResults(modelId, await runAnthropicTests(entry, modelId)));
			}
			return ok(renderTestResults(modelId, [], `Automated tests cover openai-completions and anthropic-messages — this proxy uses ${api}. Test it by running pi with --model ${id}/${modelId}.`));
		}

		const toggleMatch = pathname.match(/^\/toggle\/([a-z0-9-]+)$/);
		if (method === "POST" && toggleMatch) {
			const id = toggleMatch[1];
			const config = loadConfig();
			const entry = config[id];
			if (!entry) return ok(renderHome(config) + flash("error", "That proxy no longer exists."));
			entry.enabled = !entry.enabled;
			saveConfig(config);
			applyLive(id, entry);
			return ok(
				renderHome(config) +
					flash("ok", entry.enabled ? `${id} enabled — models registered in pi.` : `${id} disabled — models unregistered from pi.`),
			);
		}

		const deleteMatch = pathname.match(/^\/delete\/([a-z0-9-]+)$/);
		if (method === "POST" && deleteMatch) {
			const id = deleteMatch[1];
			const config = loadConfig();
			const entry = config[id];
			if (!entry) return ok(renderHome(config) + flash("error", "That proxy no longer exists."));
			delete config[id];
			saveConfig(config);
			applyLive(id, null);
			return ok(renderHome(config) + flash("ok", `${id} deleted and unregistered from pi.`));
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
