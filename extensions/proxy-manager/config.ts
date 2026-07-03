/**
 * Stores and shared types.
 *
 * - proxies.json: manager-owned proxy providers (this extension's own store)
 * - models.json: pi's native provider config, edited merge-preservingly
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "proxies.json");
export const MODELS_JSON_PATH = join(homedir(), ".pi", "agent", "models.json");
export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
export const PORT = Number(process.env.PI_PROXY_MANAGER_PORT) || 7788;

/** API formats pi supports for proxy providers (see ~/.pi/agent/models.json). */
export const API_FORMATS = [
	"openai-completions",
	"anthropic-messages",
	"openai-responses",
	"openai-codex-responses",
] as const;

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ProxyModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	image?: boolean;
	cost?: ModelCost;
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

/** Called after any mutation so index.ts can (un)register the provider in pi. */
export type ApplyLive = (id: string, entry: ProxyEntry | null) => void;

export function loadConfig(): ProxyConfig {
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return {};
	}
}

export function saveConfig(config: ProxyConfig) {
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export function loadModelsJson(): any | undefined {
	try {
		return JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8"));
	} catch {
		return undefined;
	}
}

/** Rolling single backup next to the file, then write. */
export function saveModelsJson(raw: any) {
	try {
		writeFileSync(`${MODELS_JSON_PATH}.bak`, readFileSync(MODELS_JSON_PATH));
	} catch {}
	writeFileSync(MODELS_JSON_PATH, `${JSON.stringify(raw, null, 2)}\n`);
}

/** pi's settings.json — only `enabledModels` (the model scope) is touched. */
export function loadSettings(): any {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
	} catch {
		return {};
	}
}

export function scopedModels(): Set<string> {
	const list = loadSettings().enabledModels;
	return new Set(Array.isArray(list) ? list : []);
}

/** Add or remove `provider/model` from settings.json enabledModels. */
export function toggleScope(ref: string): boolean {
	const raw = loadSettings();
	const list: string[] = Array.isArray(raw.enabledModels) ? raw.enabledModels : [];
	const inScope = list.includes(ref);
	raw.enabledModels = inScope ? list.filter((m) => m !== ref) : [...list, ref];
	try {
		writeFileSync(`${SETTINGS_PATH}.bak`, readFileSync(SETTINGS_PATH));
	} catch {}
	writeFileSync(SETTINGS_PATH, `${JSON.stringify(raw, null, 2)}\n`);
	return !inScope;
}

/** models.json keys may reference env vars ("$MY_KEY"). */
export const resolveKey = (key: string) =>
	key?.startsWith("$") ? (process.env[key.slice(1)] ?? key) : key;

/**
 * Normalize a pasted base URL: trim, drop trailing slashes, and strip
 * endpoint paths people paste by accident (/chat/completions, /models, …).
 */
export function normalizeBaseUrl(raw: string): string {
	let url = raw.trim().replace(/\/+$/, "");
	url = url.replace(/\/(chat\/completions|completions|responses|messages|models)$/, "");
	return url.replace(/\/+$/, "");
}

export const slug = (s: string) =>
	s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
