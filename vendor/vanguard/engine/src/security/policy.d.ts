export type SecurityProfile = "workspace" | "guarded";
export interface SecurityPolicyInput {
    readonly profile?: SecurityProfile;
    readonly restrictProcess?: boolean;
    readonly exposeRawProcess?: boolean;
    readonly verifierEvidence?: "full" | "summary";
}
export interface EffectiveSecurityPolicy {
    readonly schemaVersion: 1;
    readonly profile: SecurityProfile;
    readonly restrictProcess: boolean;
    readonly exposeRawProcess: boolean;
    readonly verifierEvidence: "full" | "summary";
    /** Provider credentials are removed from child-process environments. */
    readonly forwardsProviderCredentialsToTools: false;
    /** Fixed checks still execute as the current OS user unless the host supplies isolation. */
    readonly fixedChecksRequireExternalIsolationForUntrustedCode: true;
    readonly limitations: readonly string[];
}
/**
 * Resolves one named, auditable runtime posture. `guarded` is deliberately
 * fail-closed: callers cannot quietly re-enable the escape hatches that the
 * profile promises to remove.
 *
 * Neither profile claims an OS sandbox. Workspace boundaries constrain
 * Vanguard's own file tools; a fixed build/test command can execute project
 * code with the authority of the host process. Truly untrusted repositories
 * therefore require a container/VM boundary supplied by the embedding host.
 */
export declare function resolveSecurityPolicy(input?: SecurityPolicyInput): EffectiveSecurityPolicy;
