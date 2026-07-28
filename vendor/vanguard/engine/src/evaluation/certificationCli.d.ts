#!/usr/bin/env node
export declare function runCertificationCli(argv: readonly string[]): Promise<JsonOutput>;
type JsonOutput = {
    readonly [key: string]: unknown;
};
export {};
