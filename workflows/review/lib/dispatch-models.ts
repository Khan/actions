/**
 * Model-pin routing for the Pi runners (dispatch-runner-pi.ts,
 * judge-prose-runner.ts): which provider a review.md pin resolves against,
 * how a pin becomes a concrete catalog id, the api-proxy base-URL steer, and
 * the one catalog entry Pi's pinned release predates. Split out of
 * dispatch-runner-pi.ts for file size (the same reason dispatch-calls.ts
 * lives apart from dispatch.ts), but the seam is real: everything here is
 * about naming and pricing a model, and nothing here spawns a process or
 * runs a loop.
 */

/**
 * The provider id Pi registers Anthropic models under, and the env var the
 * sandbox uses to steer Anthropic traffic at the firewall api-proxy. The
 * agent container deliberately runs WITHOUT `ANTHROPIC_API_KEY` (the awf
 * invocation passes `--exclude-env ANTHROPIC_API_KEY`); the proxy sidecar
 * holds the credential and injects it. Pi's bundled Anthropic provider
 * hardcodes `https://api.anthropic.com` on every catalog model, so when a
 * steered base URL is present the provider is re-registered with a
 * `getModels` that rewrites each model's own `baseUrl` (the field the API
 * layer actually reads; see {@link rebaseModels}). Without this the runner
 * would bypass the proxy, lose credit metering, and fail auth.
 */
export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";

/**
 * The provider id Pi registers Google (Gemini API) models under. Auth is
 * `GEMINI_API_KEY` from the environment, resolved by Pi's own provider; the
 * eval workflow supplies it alongside `ANTHROPIC_API_KEY`. Production
 * gemini pins are NOT wired: the awf api-proxy meters Anthropic traffic
 * only, so a production pin move to a Google model first needs firewall and
 * proxy work on the consumer side.
 */
export const GOOGLE_PROVIDER_ID = "google";

/**
 * What the routing layer needs from a Pi provider: identity and a catalog.
 * Structural on purpose — the runners register the provider objects Pi's
 * `./providers/*` subpaths build, and this module never looks past these
 * two fields.
 */
export type CatalogProvider = {
    id: string;
    getModels: () => readonly {id: string}[];
};

/**
 * `gemini-3.8-flash` shipped 2026-09-02; the pinned pi-ai 0.83.0 catalog
 * (and 0.84.4, published 2026-08-28) stops at earlier Flash releases, so
 * the entry is supplied here and merged into the provider's catalog at
 * registration. Shaped exactly like the catalog's own Flash entries; cost
 * is the launch intro price ($0.75/$3.75 per MTok, through 2026-12-31),
 * with cacheRead at the catalog's standard 10%-of-input ratio. When a pi-ai
 * bump ships its own entry, the catalog's wins (see
 * {@link withGemini38Flash}).
 */
export const GEMINI_38_FLASH_MODEL = {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    api: "google-generative-ai",
    provider: GOOGLE_PROVIDER_ID,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0},
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: {off: null},
} as const;

/**
 * Append {@link GEMINI_38_FLASH_MODEL} to a Google catalog that does not
 * already carry it. The id check makes a future pi-ai bump's own entry win,
 * so the local pricing shim retires itself.
 */
export const withGemini38Flash = (
    catalog: readonly {id: string}[],
): readonly {id: string}[] =>
    catalog.some((model) => model.id === GEMINI_38_FLASH_MODEL.id)
        ? catalog
        : [...catalog, GEMINI_38_FLASH_MODEL];

/**
 * A provider whose every catalog model is rebased onto `baseUrl` — the
 * api-proxy steer. The override lives on `getModels` because the model's
 * own `baseUrl` is the field Pi's API layer reads; the provider-level field
 * is advisory. (The earlier `createProvider({...provider, baseUrl})` form
 * threw in pi-ai 0.83.0: createProvider wants the provider's INPUT shape,
 * `models` array and `api` streams, neither of which the built provider
 * re-exposes. The eval VM runs unsteered, which is why no run tripped it.)
 */
export const rebaseModels = <T extends CatalogProvider>(
    provider: T,
    baseUrl: string,
): T => ({
    ...provider,
    getModels: () => provider.getModels().map((model) => ({...model, baseUrl})),
});

/**
 * Which provider a review.md model pin resolves against. The pins are tier
 * aliases and the prefix names the family: `gemini-*` is Google's Gemini
 * API, everything else stays Anthropic (the default, so an unknown pin
 * fails inside {@link resolveModelId} with the Anthropic candidates listed
 * rather than silently routing to a provider that cannot serve it).
 */
export const providerForPin = (pin: string): string =>
    pin.startsWith("gemini") ? GOOGLE_PROVIDER_ID : ANTHROPIC_PROVIDER_ID;

/**
 * Resolve a review.md model pin against Pi's catalog for the pin's provider
 * ({@link providerForPin}). The pins are tier aliases (`claude-opus-4-8`,
 * `gemini-3.8-flash`); Pi's catalog may carry dated ids, so an exact miss
 * falls back to the pin's own dated releases — `pin-YYYYMMDD` exactly,
 * latest date first. A bare `startsWith` fallback would let a family pin
 * jump tiers (`claude-sonnet-4` longest-matching `claude-sonnet-4-5-<date>`),
 * and the contract here is "never silently run a different model than the
 * pin claims": an unresolvable pin throws with the candidates listed.
 */
export const resolveModelId = (
    pin: string,
    available: readonly {id: string}[],
): string => {
    const exact = available.find((model) => model.id === pin);
    if (exact !== undefined) {
        return exact.id;
    }
    const dated = available.filter(
        (model) =>
            model.id.startsWith(pin) &&
            /^-\d{8}$/.test(model.id.slice(pin.length)),
    );
    if (dated.length > 0) {
        // Dated suffixes are equal-length, so lexicographic IS chronological.
        return dated.sort((a, b) => b.id.localeCompare(a.id))[0].id;
    }
    throw new Error(
        `model pin "${pin}" is not in Pi's ${providerForPin(
            pin,
        )} catalog (candidates: ${available
            .map((model) => model.id)
            .join(", ")})`,
    );
};
