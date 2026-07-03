/**
 * All HTML rendering: page shell, home/detail/edit views for both managed
 * proxies and models.json providers, the model picker, and test results.
 */
import {
	API_FORMATS,
	loadModelsJson,
	type ModelCost,
	type ProxyConfig,
	type ProxyEntry,
	scopedModels,
} from "./config.ts";
import type { CheckResult } from "./tester.ts";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const esc = (s: unknown) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const fmt = (n: number) => n.toLocaleString("en-US");

const fmtPrice = (n: number) => `$${+n.toFixed(3)}`;

const maskKey = (key: string) =>
	key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : "•••";

function host(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Out-of-band status banner; append to any fragment response. */
export function flash(kind: "ok" | "error", text: string): string {
	return `<div id="flash" hx-swap-oob="true"><p class="flash flash-${kind}" role="status">${esc(text)}</p></div>`;
}

export function errorBox(html: string): string {
	return `<div class="error-box"><p>${html}</p></div>`;
}

/**
 * Toggle for pi's model scope (settings.json enabledModels).
 * `back` tells the /scope route which detail view to re-render.
 */
function scopeButton(providerId: string, modelId: string, back: string, scope: Set<string>): string {
	const ref = `${providerId}/${modelId}`;
	const inScope = scope.has(ref);
	return `<button class="btn btn-small${inScope ? " scope-on" : ""}" hx-post="/scope"
		hx-vals='{"ref":"${esc(ref)}","back":"${esc(back)}"}'
		hx-target="#view" hx-swap="outerHTML" hx-disabled-elt="this"
		title="${inScope ? "Remove from" : "Add to"} pi's model picker (settings.json enabledModels)">
		${inScope ? "✓ In scope" : "Add to scope"}
	</button>`;
}

// ---------------------------------------------------------------------------
// Model picker (shared by add, edit, and models.json edit forms)
// ---------------------------------------------------------------------------

export interface PickerModel {
	id: string;
	ctx: number;
	max: number;
	reasoning: boolean;
	image: boolean;
	cost?: ModelCost;
	checked: boolean;
}

export function renderModelPicker(models: PickerModel[], enriched = false): string {
	if (models.length === 0) {
		return errorBox(
			`<strong>No models returned.</strong> The endpoint answered but the list was empty. Check that the key has access to models, then fetch again.`,
		);
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

function mjToPickerModels(p: any): PickerModel[] {
	return (p.models ?? []).map((m: any) => ({
		id: m.id,
		ctx: m.contextWindow ?? 128000,
		max: m.maxTokens ?? 8192,
		reasoning: m.reasoning === true,
		image: Array.isArray(m.input) && m.input.includes("image"),
		cost: m.cost
			? {
					input: m.cost.input ?? 0,
					output: m.cost.output ?? 0,
					cacheRead: m.cost.cacheRead ?? 0,
					cacheWrite: m.cost.cacheWrite ?? 0,
				}
			: undefined,
		checked: true,
	}));
}

// ---------------------------------------------------------------------------
// Home view
// ---------------------------------------------------------------------------

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

function renderMjList(): string {
	const providers = loadModelsJson()?.providers ?? {};
	const entries = Object.entries<any>(providers);
	if (entries.length === 0) return "";
	const rows = entries
		.map(([id, p]) => {
			const models = (p.models ?? []).map((m: any) => `<code>${esc(m.id)}</code>`).join(" ");
			return `<li class="proxy">
				<button class="proxy-open" hx-get="/mj/${esc(id)}" hx-target="#view" hx-swap="outerHTML"
					hx-push-url="true" aria-label="View details for ${esc(id)}">
					<span class="dot" aria-hidden="true"></span>
					<span class="proxy-info">
						<span class="proxy-head">
							<strong>${esc(id)}</strong>
							<span class="pid">${esc(p.api ?? "openai-completions")}</span>
						</span>
						<span class="proxy-meta">
							<span class="mono">${esc(host(p.baseUrl ?? ""))}</span>
							<span class="models">${models}</span>
						</span>
					</span>
				</button>
			</li>`;
		})
		.join("\n");
	return `<section aria-labelledby="mj-h">
		<h2 id="mj-h">models.json providers</h2>
		<div><ul class="proxy-rows">${rows}</ul></div>
	</section>`;
}

/** Home view: proxy list + models.json providers + add form. */
export function renderHome(config: ProxyConfig): string {
	return `<div id="view">
	<section aria-labelledby="registered-h">
		<h2 id="registered-h">Registered proxies</h2>
		${renderList(config)}
	</section>

	${renderMjList()}

	<section aria-labelledby="add-h" id="add">
		<h2 id="add-h">Add proxy</h2>
		${renderProxyForm()}
	</section>
</div>`;
}

// ---------------------------------------------------------------------------
// Managed proxy views
// ---------------------------------------------------------------------------

export function renderDetail(id: string, p: ProxyEntry): string {
	const scope = scopedModels();
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
				${scopeButton(id, m.id, `proxy:${id}`, scope)}
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

export function renderEditView(id: string, entry: ProxyEntry): string {
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
// models.json provider views
// ---------------------------------------------------------------------------

export function renderMjDetail(id: string, p: any): string {
	const scope = scopedModels();
	const modelRows = (p.models ?? [])
		.map(
			(m: any) => `<tr>
			<td><code>${esc(m.id)}</code></td>
			<td class="num">${fmt(m.contextWindow ?? 0)}</td>
			<td class="num">${fmt(m.maxTokens ?? 0)}</td>
			<td class="num">${m.cost && (m.cost.input || m.cost.output) ? `${fmtPrice(m.cost.input ?? 0)} · ${fmtPrice(m.cost.output ?? 0)}` : "—"}</td>
			<td class="tag">${m.reasoning ? "✓" : "—"}</td>
			<td class="tag">${Array.isArray(m.input) && m.input.includes("image") ? "✓" : "—"}</td>
			<td class="row-action">
				${scopeButton(id, m.id, `mj:${id}`, scope)}
				<button class="btn btn-small" hx-post="/test-mj/${esc(id)}" hx-vals='{"model":"${esc(m.id)}"}'
					hx-target="#test-area" hx-disabled-elt="this" hx-indicator="this">
					<span class="spinner" aria-hidden="true"></span>
					Test
				</button>
			</td>
		</tr>`,
		)
		.join("\n");

	return `<div id="view">
	<div class="detail">
		<div class="detail-head">
			<button class="btn btn-small" hx-get="/list" hx-target="#view" hx-swap="outerHTML" hx-push-url="/">← All proxies</button>
			<div class="detail-actions">
				<button class="btn btn-small" hx-get="/mj-edit/${esc(id)}" hx-target="#view" hx-swap="outerHTML" hx-push-url="true">Edit</button>
				<button class="btn btn-small btn-danger" hx-post="/mj-delete/${esc(id)}"
					hx-target="#view" hx-swap="outerHTML" hx-disabled-elt="this" hx-push-url="/"
					hx-confirm="Remove ${esc(id)} from models.json? A backup is written to models.json.bak.">
					Delete
				</button>
			</div>
		</div>
		<div class="detail-title">
			<span class="dot" aria-hidden="true"></span>
			<strong>${esc(id)}</strong>
			<span class="badge">models.json</span>
		</div>
		<dl class="detail-grid">
			<dt>Base URL</dt><dd class="mono">${esc(p.baseUrl ?? "")}</dd>
			<dt>API key</dt><dd class="mono">${esc(p.apiKey?.startsWith("$") ? p.apiKey : maskKey(p.apiKey ?? ""))}</dd>
			<dt>API format</dt><dd class="mono">${esc(p.api ?? "openai-completions")}</dd>
		</dl>
		<table class="model-table">
			<thead><tr><th>Model</th><th class="num">Context</th><th class="num">Max out</th><th class="num">$/M in·out</th><th>Reasoning</th><th>Image</th><th></th></tr></thead>
			<tbody>${modelRows}</tbody>
		</table>
		<div id="test-area"></div>
	</div>
</div>`;
}

export function renderMjEditView(id: string, p: any): string {
	return `<div id="view">
	<div class="detail">
		<div class="detail-head">
			<button class="btn btn-small" hx-get="/mj/${esc(id)}" hx-target="#view" hx-swap="outerHTML" hx-push-url="true">← Details</button>
		</div>
		<div class="detail-title">
			<span class="dot" aria-hidden="true"></span>
			<strong>Edit ${esc(id)}</strong>
			<span class="badge">models.json</span>
		</div>
		<form id="mj-form" hx-post="/mj-save/${esc(id)}" hx-target="#view" hx-swap="outerHTML"
			hx-disabled-elt="find button[type=submit]" hx-push-url="/">
			<fieldset>
				<legend>1 · Connection</legend>
				<label class="field"><span>Base URL</span>
					<input name="baseUrl" type="url" required autocomplete="off" class="mono" value="${esc(p.baseUrl ?? "")}">
				</label>
				<label class="field"><span>API key</span>
					<input name="apiKey" type="password" required autocomplete="off" class="mono" value="${esc(p.apiKey ?? "")}">
				</label>
				<label class="field"><span>API format <span class="pid">(fixed — edit models.json to change)</span></span>
					<input class="mono" value="${esc(p.api ?? "openai-completions")}" readonly>
					<input type="hidden" name="api" value="${esc(p.api ?? "openai-completions")}">
				</label>
			</fieldset>
			<fieldset>
				<legend>2 · Models</legend>
				<button type="button" class="btn btn-block" hx-post="/fetch-models"
					hx-include="#mj-form [name='baseUrl'], #mj-form [name='apiKey'], #mj-form [name='api']"
					hx-target="#models-area-mj" hx-disabled-elt="this" hx-indicator="this">
					<span class="spinner" aria-hidden="true"></span>
					Fetch models
				</button>
				<div id="models-area-mj">${renderModelPicker(mjToPickerModels(p))}</div>
			</fieldset>
			<div class="form-actions">
				<button type="submit" class="btn btn-primary btn-block" hx-indicator="this">
					<span class="spinner" aria-hidden="true"></span>
					Save to models.json
				</button>
				<p class="hint form-hint">Applies to the running pi session immediately. Advanced fields (compat, custom headers, model names) are preserved. Backup written to models.json.bak.</p>
			</div>
		</form>
	</div>
</div>`;
}

// ---------------------------------------------------------------------------
// Test results
// ---------------------------------------------------------------------------

export function renderTestResults(modelId: string, results: CheckResult[], apiNote?: string): string {
	if (apiNote) {
		return errorBox(esc(apiNote));
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
// Page shell
// ---------------------------------------------------------------------------

export function page(config: ProxyConfig, content?: string): string {
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
.badge { border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; font-size: 0.6875rem; color: var(--muted); }
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
.model-table .row-action { text-align: right; white-space: nowrap; }
.scope-on { color: var(--accent); border-color: color-mix(in oklch, var(--accent) 40%, var(--border)); }

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
