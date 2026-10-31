import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

export const MODELS = {
	narrate: { provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" },
	fix: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" },
	build: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" },
} as const;

/** OPENROUTER_API_KEY gives the models access to OpenRouter. Store it as a secret Actor environment variable. */
export function openModels() {
	if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
	const models = createModels();
	models.setProvider(openrouterProvider());
	return models;
}
