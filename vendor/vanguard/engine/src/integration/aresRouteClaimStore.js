import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, } from "node:fs/promises";
import path from "node:path";
export const ARES_ROUTE_CLAIM_CAPABILITY = "routes.create.atomic-durable-v1";
const STORE_MARKER = Object.freeze({ version: 1, kind: "vanguard.ares-route-claim-store" });
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_OPERATION_ID_BYTES = 80;
const MAX_UPSTREAM_SESSION_ID_BYTES = 512;
export class AresRouteClaimStoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "AresRouteClaimStoreError";
        this.code = code;
    }
}
export class FileAresRouteClaimStore {
    #configuredRoot;
    #initialization;
    #faultInjector;
    constructor(options) {
        if (!(hasExactDataProperties(options, ["root"])
            || hasExactDataProperties(options, ["faultInjector", "root"]))
            || typeof options.root !== "string" || options.root.length === 0
            || Buffer.byteLength(options.root, "utf8") > 32_000 || !path.isAbsolute(options.root)
            || (options.faultInjector !== undefined && typeof options.faultInjector !== "function")) {
            throw failure("invalid_route_claim_store", "Route-claim store root must be a bounded absolute path.");
        }
        this.#configuredRoot = path.resolve(options.root);
        this.#faultInjector = options.faultInjector;
        this.#initialization = this.#initialize();
        void this.#initialization.catch(() => { });
    }
    capabilities() {
        return Object.freeze([ARES_ROUTE_CLAIM_CAPABILITY]);
    }
    async claim(request) {
        const paths = await this.#validatedPaths();
        const normalized = normalizeClaimRequest(request);
        const operationIdSha256 = aresRouteOperationDigest(normalized.operationId);
        const existing = await readClaimIfPresent(paths.operations, operationIdSha256);
        if (existing !== undefined)
            return claimWinner(existing, normalized, false);
        const proposed = freezeClaim({
            version: 1,
            operationIdSha256,
            inputFingerprintSha256: normalized.inputFingerprintSha256,
            chosenCore: normalized.proposedCore,
            adapterSessionId: aresAdapterSessionIdForOperationDigest(operationIdSha256),
            policySha256: normalized.policySha256,
        });
        const directory = await ensureOwnedRecordDirectory(paths.operations, operationIdSha256);
        const created = await publishImmutableFile(path.join(directory.path, "claim.json"), encodeRecord("route-claim", proposed));
        await assertUnchangedDirectory(directory.path, directory.identity, "route-claim operation directory");
        if (created)
            await syncDirectoryBestEffort(directory.path);
        const persisted = await readRequiredClaim(paths.operations, operationIdSha256);
        await this.#faultInjector?.("claim_published", Object.freeze({
            operationIdSha256,
            recordSha256: aresRouteClaimDigest(persisted),
        }));
        return claimWinner(persisted, normalized, created);
    }
    async read(operationId) {
        const paths = await this.#validatedPaths();
        const operationIdSha256 = aresRouteOperationDigest(operationId);
        return readClaimIfPresent(paths.operations, operationIdSha256);
    }
    async commitReceipt(request) {
        const paths = await this.#validatedPaths();
        const normalized = normalizeReceiptRequest(request);
        const operationIdSha256 = aresRouteOperationDigest(normalized.operationId);
        const claim = await readRequiredClaim(paths.operations, operationIdSha256);
        if (claim.chosenCore !== normalized.source) {
            throw failure("route_receipt_conflict", "Upstream receipt source conflicts with the durable route claim.");
        }
        const claimSha256 = aresRouteClaimDigest(claim);
        const upstreamIdentitySha256 = aresUpstreamIdentityDigest(normalized.source, normalized.upstreamSessionId);
        const expected = freezeReceipt({
            version: 1,
            operationIdSha256,
            claimSha256,
            source: normalized.source,
            upstreamSessionId: normalized.upstreamSessionId,
            upstreamIdentitySha256,
        });
        const current = await readReceiptIfPresent(paths.operations, claim);
        if (current !== undefined) {
            assertSameReceipt(current, expected);
            await this.#assertIdentityBinding(paths, current);
            return Object.freeze({ receipt: current, created: false });
        }
        await this.#reserveIdentity(paths, {
            version: 1,
            upstreamIdentitySha256,
            operationIdSha256,
            claimSha256,
        });
        await this.#faultInjector?.("identity_published", Object.freeze({
            operationIdSha256,
            recordSha256: upstreamIdentitySha256,
        }));
        const operationDirectory = await requiredRecordDirectory(paths.operations, operationIdSha256, "route-claim operation directory");
        const created = await publishImmutableFile(path.join(operationDirectory.path, "receipt.json"), encodeRecord("route-receipt", expected));
        await assertUnchangedDirectory(operationDirectory.path, operationDirectory.identity, "route-claim operation directory");
        if (created)
            await syncDirectoryBestEffort(operationDirectory.path);
        const persisted = await readRequiredReceipt(paths.operations, claim);
        assertSameReceipt(persisted, expected);
        await this.#assertIdentityBinding(paths, persisted);
        await this.#faultInjector?.("receipt_published", Object.freeze({
            operationIdSha256,
            recordSha256: persisted.upstreamIdentitySha256,
        }));
        return Object.freeze({ receipt: persisted, created });
    }
    async readReceipt(operationId) {
        const paths = await this.#validatedPaths();
        const operationIdSha256 = aresRouteOperationDigest(operationId);
        const claim = await readClaimIfPresent(paths.operations, operationIdSha256);
        if (claim === undefined)
            return undefined;
        const receipt = await readReceiptIfPresent(paths.operations, claim);
        if (receipt !== undefined)
            await this.#assertIdentityBinding(paths, receipt);
        return receipt;
    }
    async #reserveIdentity(paths, proposed) {
        validateIdentityBinding(proposed);
        const current = await readIdentityBindingIfPresent(paths.identities, proposed.upstreamIdentitySha256);
        if (current !== undefined) {
            assertSameIdentityBinding(current, proposed);
            return;
        }
        const directory = await ensureOwnedRecordDirectory(paths.identities, proposed.upstreamIdentitySha256);
        const created = await publishImmutableFile(path.join(directory.path, "binding.json"), encodeRecord("upstream-identity", proposed));
        await assertUnchangedDirectory(directory.path, directory.identity, "upstream-identity directory");
        if (created)
            await syncDirectoryBestEffort(directory.path);
        const persisted = await readRequiredIdentityBinding(paths.identities, proposed.upstreamIdentitySha256);
        assertSameIdentityBinding(persisted, proposed);
    }
    async #assertIdentityBinding(paths, receipt) {
        const binding = await readRequiredIdentityBinding(paths.identities, receipt.upstreamIdentitySha256);
        assertSameIdentityBinding(binding, {
            version: 1,
            upstreamIdentitySha256: receipt.upstreamIdentitySha256,
            operationIdSha256: receipt.operationIdSha256,
            claimSha256: receipt.claimSha256,
        });
    }
    async #initialize() {
        await mkdir(this.#configuredRoot, { recursive: true, mode: 0o700 });
        await assertRealDirectory(this.#configuredRoot, "route-claim store root");
        const root = await realpath(this.#configuredRoot);
        if (!samePath(root, this.#configuredRoot)) {
            throw failure("invalid_route_claim_store", "Route-claim store root may not be a symbolic link or junction.");
        }
        const markerFile = path.join(root, "store.json");
        await publishImmutableFile(markerFile, `${canonicalJson(STORE_MARKER)}\n`);
        const marker = await readJsonRecord(markerFile, "route-claim store marker");
        if (!hasExactDataProperties(marker, ["kind", "version"])
            || marker.version !== STORE_MARKER.version || marker.kind !== STORE_MARKER.kind) {
            throw failure("invalid_route_claim_store", "Route-claim store marker is invalid.");
        }
        const operations = path.join(root, "operations");
        const identities = path.join(root, "identities");
        await mkdir(operations, { recursive: true, mode: 0o700 });
        await mkdir(identities, { recursive: true, mode: 0o700 });
        await assertRealDirectory(operations, "route-claim operations directory");
        await assertRealDirectory(identities, "upstream-identities directory");
        if (!samePath(await realpath(operations), operations) || !samePath(await realpath(identities), identities)) {
            throw failure("invalid_route_claim_store", "Route-claim store child directories may not be links or junctions.");
        }
        await syncDirectoryBestEffort(root);
        return {
            root,
            operations,
            identities,
            rootIdentity: await fileIdentity(root),
            operationsIdentity: await fileIdentity(operations),
            identitiesIdentity: await fileIdentity(identities),
        };
    }
    async #validatedPaths() {
        const paths = await this.#initialization;
        await assertUnchangedDirectory(paths.root, paths.rootIdentity, "route-claim store root");
        await assertUnchangedDirectory(paths.operations, paths.operationsIdentity, "route-claim operations directory");
        await assertUnchangedDirectory(paths.identities, paths.identitiesIdentity, "upstream-identities directory");
        return paths;
    }
}
export function aresRouteOperationDigest(operationId) {
    validateOperationId(operationId);
    return digest(`VANGUARD_ARES_ROUTE_OPERATION_V1\n${operationId}`);
}
export function aresAdapterSessionIdForOperationDigest(operationIdSha256) {
    assertSha256(operationIdSha256, "operation digest", "invalid_route_claim_request");
    return `ares-vanguard-${operationIdSha256}`;
}
export function aresRouteClaimDigest(claim) {
    validateAresDurableRouteClaim(claim);
    return digest(`VANGUARD_ARES_ROUTE_CLAIM_V1\n${canonicalJson(claim)}`);
}
export function aresUpstreamIdentityDigest(source, upstreamSessionId) {
    validateCore(source, "receipt source");
    validateUpstreamSessionId(upstreamSessionId);
    return digest(`VANGUARD_ARES_UPSTREAM_IDENTITY_V1\n${source}\n${upstreamSessionId}`);
}
export function validateAresDurableRouteClaim(value) {
    if (!hasExactDataProperties(value, [
        "adapterSessionId", "chosenCore", "inputFingerprintSha256", "operationIdSha256", "policySha256", "version",
    ]))
        throw corrupt("Durable route claim schema is invalid.");
    if (value.version !== 1)
        throw corrupt("Durable route claim version is unsupported.");
    assertSha256(value.operationIdSha256, "operation digest");
    assertSha256(value.inputFingerprintSha256, "input fingerprint");
    assertSha256(value.policySha256, "policy digest");
    validateCore(value.chosenCore, "claimed core");
    if (value.adapterSessionId !== aresAdapterSessionIdForOperationDigest(value.operationIdSha256)) {
        throw corrupt("Durable route claim adapter session identity is invalid.");
    }
}
export function validateAresDurableRouteReceipt(value) {
    if (!hasExactDataProperties(value, [
        "claimSha256", "operationIdSha256", "source", "upstreamIdentitySha256", "upstreamSessionId", "version",
    ]))
        throw corrupt("Durable route receipt schema is invalid.");
    if (value.version !== 1)
        throw corrupt("Durable route receipt version is unsupported.");
    assertSha256(value.operationIdSha256, "receipt operation digest");
    assertSha256(value.claimSha256, "receipt claim digest");
    assertSha256(value.upstreamIdentitySha256, "upstream identity digest");
    validateCore(value.source, "receipt source");
    validateUpstreamSessionId(value.upstreamSessionId);
    if (value.upstreamIdentitySha256 !== aresUpstreamIdentityDigest(value.source, value.upstreamSessionId)) {
        throw corrupt("Durable route receipt upstream identity binding is invalid.");
    }
}
function normalizeClaimRequest(value) {
    assertExactDataObject(value, ["inputFingerprintSha256", "operationId", "policySha256", "proposedCore"], "claim request");
    validateOperationId(value.operationId);
    assertSha256(value.inputFingerprintSha256, "input fingerprint", "invalid_route_claim_request");
    assertSha256(value.policySha256, "policy digest", "invalid_route_claim_request");
    validateCore(value.proposedCore, "proposed core");
    return Object.freeze({
        operationId: value.operationId,
        inputFingerprintSha256: value.inputFingerprintSha256,
        proposedCore: value.proposedCore,
        policySha256: value.policySha256,
    });
}
function normalizeReceiptRequest(value) {
    assertExactDataObject(value, ["operationId", "source", "upstreamSessionId"], "receipt request");
    validateOperationId(value.operationId);
    validateCore(value.source, "receipt source");
    validateUpstreamSessionId(value.upstreamSessionId);
    return Object.freeze({ operationId: value.operationId, source: value.source, upstreamSessionId: value.upstreamSessionId });
}
function claimWinner(claim, request, created) {
    if (claim.inputFingerprintSha256 !== request.inputFingerprintSha256) {
        throw failure("route_claim_conflict", "operationId is already bound to different canonical create input.");
    }
    return Object.freeze({ claim, created });
}
async function readClaimIfPresent(operations, operationIdSha256) {
    const directory = await recordDirectoryIfPresent(operations, operationIdSha256, "route-claim operation directory");
    if (directory === undefined)
        return undefined;
    const raw = await readStoredPayloadIfPresent(path.join(directory.path, "claim.json"), "durable route claim", "route-claim");
    if (raw === undefined)
        return undefined;
    validateAresDurableRouteClaim(raw);
    if (raw.operationIdSha256 !== operationIdSha256)
        throw corrupt("Durable route claim is stored under the wrong operation.");
    return freezeClaim(raw);
}
async function readRequiredClaim(operations, digestValue) {
    const claim = await readClaimIfPresent(operations, digestValue);
    if (claim === undefined)
        throw corrupt("Durable route claim is missing.");
    return claim;
}
async function readReceiptIfPresent(operations, claim) {
    const directory = await requiredRecordDirectory(operations, claim.operationIdSha256, "route-claim operation directory");
    const raw = await readStoredPayloadIfPresent(path.join(directory.path, "receipt.json"), "durable route receipt", "route-receipt");
    if (raw === undefined)
        return undefined;
    validateAresDurableRouteReceipt(raw);
    if (raw.operationIdSha256 !== claim.operationIdSha256 || raw.claimSha256 !== aresRouteClaimDigest(claim)
        || raw.source !== claim.chosenCore)
        throw corrupt("Durable route receipt is detached from its route claim.");
    return freezeReceipt(raw);
}
async function readRequiredReceipt(operations, claim) {
    const receipt = await readReceiptIfPresent(operations, claim);
    if (receipt === undefined)
        throw corrupt("Durable route receipt is missing after publication.");
    return receipt;
}
async function readIdentityBindingIfPresent(identities, upstreamIdentitySha256) {
    const directory = await recordDirectoryIfPresent(identities, upstreamIdentitySha256, "upstream-identity directory");
    if (directory === undefined)
        return undefined;
    const raw = await readStoredPayloadIfPresent(path.join(directory.path, "binding.json"), "upstream identity binding", "upstream-identity");
    if (raw === undefined)
        return undefined;
    validateIdentityBinding(raw);
    if (raw.upstreamIdentitySha256 !== upstreamIdentitySha256)
        throw corrupt("Upstream identity binding is misfiled.");
    return Object.freeze(raw);
}
async function readRequiredIdentityBinding(identities, digestValue) {
    const binding = await readIdentityBindingIfPresent(identities, digestValue);
    if (binding === undefined)
        throw corrupt("Upstream identity binding is missing.");
    return binding;
}
function validateIdentityBinding(value) {
    if (!hasExactDataProperties(value, [
        "claimSha256", "operationIdSha256", "upstreamIdentitySha256", "version",
    ]))
        throw corrupt("Upstream identity binding schema is invalid.");
    if (value.version !== 1)
        throw corrupt("Upstream identity binding version is unsupported.");
    assertSha256(value.claimSha256, "identity claim digest");
    assertSha256(value.operationIdSha256, "identity operation digest");
    assertSha256(value.upstreamIdentitySha256, "upstream identity digest");
}
function assertSameIdentityBinding(actual, expected) {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw failure("upstream_identity_conflict", "Upstream session identity is already bound to another operation.");
    }
}
function assertSameReceipt(actual, expected) {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw failure("route_receipt_conflict", "Operation already has a different upstream session receipt.");
    }
}
function freezeClaim(value) {
    return Object.freeze({ ...value });
}
function freezeReceipt(value) {
    return Object.freeze({ ...value });
}
async function ensureOwnedRecordDirectory(parent, name) {
    const directory = path.join(parent, name);
    try {
        await mkdir(directory, { mode: 0o700 });
        await syncDirectoryBestEffort(parent);
    }
    catch (error) {
        if (!isAlreadyExists(error))
            throw error;
    }
    return requiredRecordDirectory(parent, name, "route-claim record directory");
}
async function recordDirectoryIfPresent(parent, name, label) {
    const directory = path.join(parent, name);
    try {
        await assertRealDirectory(directory, label);
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
    if (!samePath(await realpath(directory), directory))
        throw corrupt(`${label} may not be a symbolic link or junction.`);
    return { path: directory, identity: await fileIdentity(directory) };
}
async function requiredRecordDirectory(parent, name, label) {
    const directory = await recordDirectoryIfPresent(parent, name, label);
    if (directory === undefined)
        throw corrupt(`${label} is missing.`);
    return directory;
}
async function publishImmutableFile(file, contents) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeDurableFile(temporary, contents);
        try {
            await link(temporary, file);
            return true;
        }
        catch (error) {
            if (!isAlreadyExists(error))
                throw error;
            return false;
        }
    }
    finally {
        await rm(temporary, { force: true });
    }
}
async function writeDurableFile(file, contents) {
    const handle = await open(file, "wx", 0o600);
    try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function readJsonIfPresent(file, label) {
    try {
        return await readJsonRecord(file, label);
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
}
async function readStoredPayloadIfPresent(file, label, expectedKind) {
    const raw = await readJsonIfPresent(file, label);
    if (raw === undefined)
        return undefined;
    if (!hasExactDataProperties(raw, ["kind", "payload", "payloadSha256", "version"])
        || raw.version !== 1 || raw.kind !== expectedKind) {
        throw corrupt(`${label} envelope schema is invalid.`);
    }
    assertSha256(raw.payloadSha256, `${label} payload digest`);
    if (raw.payloadSha256 !== storedPayloadDigest(expectedKind, raw.payload)) {
        throw corrupt(`${label} payload failed its integrity check.`);
    }
    return raw.payload;
}
async function readJsonRecord(file, label) {
    await removePublishedAliases(file);
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 2 || metadata.size > MAX_RECORD_BYTES) {
        throw corrupt(`${label} is not a bounded regular file.`);
    }
    assertPrivateMode(metadata.mode, label);
    try {
        return JSON.parse(await readFile(file, "utf8"));
    }
    catch (error) {
        if (isMissing(error))
            throw error;
        throw corrupt(`${label} is malformed JSON.`);
    }
}
async function removePublishedAliases(file) {
    let target;
    try {
        target = await lstat(file, { bigint: true });
    }
    catch (error) {
        if (isMissing(error))
            return;
        throw error;
    }
    if (!target.isFile() || target.isSymbolicLink() || target.ino === 0n)
        return;
    const directory = path.dirname(file);
    const prefix = `${path.basename(file)}.`;
    let removed = false;
    for (const name of await readdir(directory)) {
        if (!name.startsWith(prefix) || !name.endsWith(".tmp"))
            continue;
        const candidate = path.join(directory, name);
        try {
            const metadata = await lstatAfterWindowsDeleteRace(candidate);
            if (metadata === undefined)
                continue;
            if (metadata.isFile() && !metadata.isSymbolicLink()
                && metadata.dev === target.dev && metadata.ino === target.ino) {
                await removeAfterWindowsDeleteRace(candidate);
                removed = true;
            }
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
        }
    }
    if (removed)
        await syncDirectoryBestEffort(directory);
}
async function lstatAfterWindowsDeleteRace(file) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            return await lstat(file, { bigint: true });
        }
        catch (error) {
            if (isMissing(error))
                return undefined;
            if (!isTransientWindowsDeleteRace(error))
                throw error;
            lastError = error;
            await briefDeleteRaceBackoff(attempt);
        }
    }
    throw lastError;
}
async function removeAfterWindowsDeleteRace(file) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await rm(file, { force: true });
            return;
        }
        catch (error) {
            if (isMissing(error))
                return;
            if (!isTransientWindowsDeleteRace(error))
                throw error;
            lastError = error;
            await briefDeleteRaceBackoff(attempt);
        }
    }
    const remaining = await lstatAfterWindowsDeleteRace(file);
    if (remaining === undefined)
        return;
    throw lastError;
}
async function briefDeleteRaceBackoff(attempt) {
    await new Promise((resolve) => setTimeout(resolve, 1 << attempt));
}
async function assertRealDirectory(directory, label) {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw failure("invalid_route_claim_store", `${label} must be a real directory.`);
    }
    assertPrivateMode(metadata.mode, label);
}
async function fileIdentity(directory) {
    const metadata = await lstat(directory, { bigint: true });
    return { dev: metadata.dev, ino: metadata.ino };
}
async function assertUnchangedDirectory(directory, expected, label) {
    try {
        await assertRealDirectory(directory, label);
        const actual = await fileIdentity(directory);
        if (actual.dev !== expected.dev || actual.ino !== expected.ino || !samePath(await realpath(directory), directory)) {
            throw failure("route_claim_store_replaced", `${label} changed after validation.`);
        }
    }
    catch (error) {
        if (error instanceof AresRouteClaimStoreError)
            throw error;
        throw failure("route_claim_store_replaced", `${label} changed after validation.`);
    }
}
function assertPrivateMode(mode, label) {
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
        throw failure("invalid_route_claim_store", `${label} must not be group/world accessible.`);
    }
}
async function syncDirectoryBestEffort(directory) {
    let handle;
    try {
        handle = await open(directory, "r");
        await handle.sync();
    }
    catch (error) {
        if (!isUnsupportedDirectorySync(error))
            throw error;
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
function assertExactDataObject(value, expectedKeys, label) {
    if (!hasExactDataProperties(value, expectedKeys)) {
        throw failure("invalid_route_claim_request", `${label} must use the exact closed schema with enumerable data properties.`);
    }
}
function validateOperationId(value) {
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_OPERATION_ID_BYTES
        || !/^op_[a-f0-9]{32,64}$/u.test(value)) {
        throw failure("invalid_route_claim_request", "operationId must be a bounded durable opaque identifier.");
    }
}
function validateUpstreamSessionId(value) {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value
        || Buffer.byteLength(value, "utf8") > MAX_UPSTREAM_SESSION_ID_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw failure("invalid_route_claim_request", "Upstream session ID must be a bounded opaque string.");
    }
}
function validateCore(value, label) {
    if (value !== "vanguard" && value !== "legacy") {
        throw failure("invalid_route_claim_request", `${label} must be vanguard or legacy.`);
    }
}
function assertSha256(value, label, code = "route_claim_corrupt") {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
        throw failure(code, `${label} must be a lowercase SHA-256 digest.`);
    }
}
function encodeRecord(kind, payload) {
    const envelope = {
        version: 1,
        kind,
        payloadSha256: storedPayloadDigest(kind, payload),
        payload,
    };
    return `${canonicalJson(envelope)}\n`;
}
function storedPayloadDigest(kind, payload) {
    return digest(`VANGUARD_ARES_ROUTE_STORE_RECORD_V1\n${kind}\n${canonicalJson(payload)}`);
}
function canonicalJson(value, seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw corrupt("Durable route record contains a non-finite number.");
        return JSON.stringify(value);
    }
    if (typeof value !== "object")
        throw corrupt("Durable route record contains an unsupported value.");
    if (seen.has(value))
        throw corrupt("Durable route record is cyclic.");
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const entries = [];
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.hasOwn(value, index))
                    throw corrupt("Durable route record contains a sparse array.");
                entries.push(canonicalJson(value[index], seen));
            }
            return `[${entries.join(",")}]`;
        }
        if (!isPlainObject(value))
            throw corrupt("Durable route record contains a non-plain object.");
        const keys = Object.keys(value).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(",")}}`;
    }
    finally {
        seen.delete(value);
    }
}
function digest(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}
function hasExactDataProperties(value, expected) {
    if (!isPlainObject(value) || !hasExactKeys(value, expected) || Reflect.ownKeys(value).length !== expected.length) {
        return false;
    }
    return expected.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
    });
}
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function samePath(left, right) {
    return process.platform === "win32"
        ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
        : path.resolve(left) === path.resolve(right);
}
function failure(code, message) {
    return new AresRouteClaimStoreError(code, message);
}
function corrupt(message) {
    return failure("route_claim_corrupt", message);
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isAlreadyExists(error) {
    return error instanceof Error && "code" in error && ["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error.code));
}
function isTransientWindowsDeleteRace(error) {
    return process.platform === "win32" && error instanceof Error && "code" in error
        && ["EACCES", "EPERM"].includes(String(error.code));
}
function isUnsupportedDirectorySync(error) {
    return error instanceof Error && "code" in error
        && ["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(String(error.code));
}
