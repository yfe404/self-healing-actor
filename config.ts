// Every ID, name, tag and model the demo uses. Actors are addressed by `user/name`, which the Apify API
// accepts everywhere an ID is accepted, so nothing here changes after a redeploy.
export const CONFIG = {
	user: "straightforward_understanding",
	actors: {
		targetSite: "shd-target-site", // Standby Actor serving the product page (variant a or b)
		scraper: "shd-scraper", // the patient: SOURCE_FILES Actor, builds tagged `prod`
		repair: "shd-repair-agent", // the durable agent (repair-actor/, pushed with `apify push`)
		redirector: "shd-repair-link", // Standby Actor at a stable URL that redirects to the live repair run
	},
	/** Named KV store the target site reads its `variant` record from (`a` original, `b` redesign). */
	targetSiteStateStore: "shd-target-site-state",
	/** Prefix of the named KV store holding the agent's memory; the scraper Actor id is appended. */
	agentStorePrefix: "shd-agent-memory-",
	buildTag: "prod",
	scraperVersion: "0.0",
	models: {
		provider: "openrouter",
		narrate: "anthropic/claude-haiku-4.5", // first turn: interpret the diff bundle
		fix: "anthropic/claude-sonnet-4.5", // investigation and fix
		build: "anthropic/claude-sonnet-4.5", // the build session that creates the memory
	},
	budget: { maxToolCalls: 60, maxElapsedMs: 40 * 60_000 },
	/** Scraper fails its own validation below this price fill rate. */
	priceFillRateThreshold: 0.9,
} as const;

export const actorRef = (name: keyof typeof CONFIG.actors): string => `${CONFIG.user}/${CONFIG.actors[name]}`;
/** Standby hostnames use the username with `_` -> `-`, truncated by the platform; `scripts/deploy.ts` verifies this against the API's `standbyUrl`. */
const STANDBY_USER = "straightforward-under";
export const standbyUrl = (name: keyof typeof CONFIG.actors): string => `https://${STANDBY_USER}--${CONFIG.actors[name]}.apify.actor/`;
export const targetSiteUrl = (): string => standbyUrl("targetSite");
export const redirectorUrl = (): string => standbyUrl("redirector");
export const agentStoreName = (scraperActorId: string): string => `${CONFIG.agentStorePrefix}${scraperActorId}`;
