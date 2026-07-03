/**
 * models.dev catalog lookups — context windows, output limits, pricing, and
 * capability flags for known models, with conservative id matching.
 */
import type { ModelCost } from "./config.ts";

export interface CatalogInfo {
	ctx?: number;
	max?: number;
	reasoning?: boolean;
	image?: boolean;
	cost?: ModelCost;
}

// Fetched once per server process.
let catalogPromise: Promise<any | undefined> | undefined;

export function getCatalog(): Promise<any | undefined> {
	catalogPromise ??= fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(15000) })
		.then((r) => (r.ok ? r.json() : undefined))
		.catch(() => undefined);
	return catalogPromise;
}

/** Lowercase, drop any vendor prefix ("zai/"), unify separators. */
function normalizeId(id: string): string {
	let s = id.toLowerCase().trim();
	const slash = s.lastIndexOf("/");
	if (slash !== -1) s = s.slice(slash + 1);
	return s.replace(/_/g, "-");
}

// "-0524", ".20260101", "-latest", "-chat" … — but never "-air"/"-mini" style variants.
const VERSION_SUFFIX = /^([-.](\d{2,8}|latest|preview|beta|chat|instruct|exp))+$/;

/**
 * Find catalog entries for a model id. Exact normalized matches win; otherwise
 * accept catalog ids that are a version-boundary prefix of the proxy id
 * (deepseek-v4-pro-0524 → deepseek-v4-pro) — never the reverse, so glm-5.2
 * can't pick up glm-5.2-air or glm-5.1 pricing.
 */
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
