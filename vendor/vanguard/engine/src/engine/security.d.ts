import type { PublicRunEvent } from "../runtime/publicRunEvents.js";
/**
 * The protocol only accepts the deliberately small PublicRunEvent surface.
 * Provider payloads, continuations, reasoning blocks, and arbitrary object
 * properties are dropped here even if a future producer accidentally adds
 * them upstream.
 */
export declare function sanitizePublicEvent(value: PublicRunEvent, environment?: NodeJS.ProcessEnv): PublicRunEvent;
export declare function createSecretRedactor(environment?: NodeJS.ProcessEnv): (text: string) => string;
/**
 * Produces the default environment for model-invoked and verifier child
 * processes. Build-relevant non-secret values remain available, while common
 * credential variables and interpreter preload/option injection are removed.
 * A host that needs another value must pass it deliberately to ProcessTool.
 */
export declare function sanitizedChildEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
