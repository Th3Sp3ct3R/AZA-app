export declare class WorkspaceBoundary {
    #private;
    readonly root: string;
    constructor(root: string);
    lexical(relativePath: string): string;
    existing(relativePath: string): Promise<string>;
    writable(relativePath: string): Promise<string>;
}
