export interface CommandSpec {
    readonly command: string;
    readonly args: readonly string[];
}
export declare function detectProjectVerification(workspace: string): Promise<CommandSpec | undefined>;
