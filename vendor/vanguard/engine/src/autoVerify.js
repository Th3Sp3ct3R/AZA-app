#!/usr/bin/env node
import { parseVerificationMode, runAutomaticVerification } from "./runtime/automaticVerification.js";
const flag = process.argv.indexOf("--mode");
const mode = parseVerificationMode(flag === -1 ? undefined : process.argv[flag + 1]);
const result = await runAutomaticVerification(process.cwd(), mode);
process.exitCode = result.exitCode;
