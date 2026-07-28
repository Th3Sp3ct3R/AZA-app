export type NodePackageManager = "npm" | "npx";
export interface NodePackageManagerAlias {
    readonly executable: string;
    readonly argsPrefix: readonly string[];
}
/** Node 20 uses the experimental spelling; Node 22+ accepts the stable flag. */
export declare function nodePermissionFlag(version?: string): "--experimental-permission" | "--permission";
/**
 * Locate npm's JavaScript entry point without invoking a command shell.
 *
 * npm is normally adjacent to the Node executable, but that is not true for
 * portable Node distributions, version-manager shims, or an `npx node@...`
 * runtime. `npm_execpath` is authoritative when Vanguard itself was launched
 * by npm; the remaining candidates cover the standard bundled/prefix layouts.
 */
export declare function resolveNodePackageManagerAlias(manager: NodePackageManager, environment?: NodeJS.ProcessEnv, nodeExecutable?: string): NodePackageManagerAlias | undefined;
