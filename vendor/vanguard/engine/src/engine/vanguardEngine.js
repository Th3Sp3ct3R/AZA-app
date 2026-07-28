import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileJournal } from "../kernel/fileJournal.js";
import { detectProjectVerification } from "../runtime/projectVerification.js";
import { ADAPTIVE_VERIFY_COMMAND } from "../runtime/automaticVerification.js";
import { PublicRunEventPresenter } from "../runtime/publicRunEvents.js";
import { createSessionShell, createSessionShellAt, fingerprintSessionSource, openCodingSession, } from "../runtime/session.js";
import { CliVanguardRunner } from "./cliRunner.js";
import { sanitizePublicEvent } from "./security.js";
import { isCleanGitRepository } from "../runtime/gitTree.js";
import { extensionRuntimeState, resolveExtensions } from "../extensions/config.js";
import { resolveSecurityPolicy } from "../security/policy.js";
import { FileCreateOperationStore, canonicalDigest, createOperationIdDigest, sessionIdFor, } from "./createOperationStore.js";
import { VanguardEngineError, VANGUARD_EXECUTION_TREE_FENCING_CAPABILITY, VANGUARD_IDEMPOTENT_CREATE_CAPABILITY, VANGUARD_PROTOCOL_CAPABILITIES, VANGUARD_WORKER_FENCING_CAPABILITY, } from "./types.js";
export class VanguardEngine {
    #runner;
    #executionTreeFenced;
    #maxReplayEvents;
    #maxReplayBytesPerSession;
    #maxSessions;
    #maxSteeringBytesPerAdvance;
    #shutdownTimeoutMs;
    #logger;
    #createOperationStore;
    #createFaultInjector;
    #ownerToken = randomUUID();
    #ownedLeases = new Map();
    #sessions = new Map();
    #registrationFlights = new Map();
    #pendingSessionReservations = new Map();
    #pendingLifecycleOperations = 0;
    #listeners = new Set();
    #closed = false;
    #shutdownPromise;
    #shutdownComplete;
    constructor(options = {}) {
        this.#runner = options.runner ?? new CliVanguardRunner();
        const executionTreeFencing = this.#runner.executionTreeFencing;
        this.#executionTreeFenced = executionTreeFencing?.version === 1
            && executionTreeFencing.exactTreeClose === true;
        this.#maxSessions = positiveInteger(options.maxSessions ?? 128, "maxSessions", 10_000);
        this.#maxReplayEvents = positiveInteger(options.maxReplayEvents ?? 4_096, "maxReplayEvents", 100_000);
        this.#maxReplayBytesPerSession = positiveInteger(options.maxReplayBytesPerSession ?? 1_048_576, "maxReplayBytesPerSession", 67_108_864);
        if (this.#maxSessions * this.#maxReplayBytesPerSession > 268_435_456) {
            throw new VanguardEngineError("invalid_config", "maxSessions multiplied by maxReplayBytesPerSession may not exceed the 256 MiB engine replay ceiling.");
        }
        this.#maxSteeringBytesPerAdvance = positiveInteger(options.maxSteeringBytesPerAdvance ?? 1_048_576, "maxSteeringBytesPerAdvance", 16_777_216);
        this.#shutdownTimeoutMs = positiveInteger(options.shutdownTimeoutMs ?? 3_000, "shutdownTimeoutMs", 300_000);
        this.#createOperationStore = options.createOperationStore === undefined
            ? undefined
            : new FileCreateOperationStore(options.createOperationStore);
        this.#createFaultInjector = options.createOperationStore?.faultInjector;
        const logger = options.logger ?? (() => { });
        this.#logger = (line) => {
            try {
                logger(line);
            }
            catch { }
        };
    }
    capabilities() {
        return Object.freeze([
            ...VANGUARD_PROTOCOL_CAPABILITIES,
            ...(this.#createOperationStore === undefined
                ? []
                : [VANGUARD_IDEMPOTENT_CREATE_CAPABILITY, VANGUARD_WORKER_FENCING_CAPABILITY]),
            ...(this.#executionTreeFenced
                ? [VANGUARD_EXECUTION_TREE_FENCING_CAPABILITY]
                : []),
        ]);
    }
    async create(config, operationId) {
        this.#assertOpen();
        const snapshot = snapshotConfig(config);
        const operationIdSha256 = operationId === undefined ? undefined : createOperationIdDigest(operationId);
        if (operationIdSha256 !== undefined && this.#createOperationStore === undefined) {
            throw new VanguardEngineError("create_operation_store_required", "Idempotent create requires VanguardEngineOptions.createOperationStore.");
        }
        if (operationIdSha256 !== undefined && snapshot.direct === true) {
            throw new VanguardEngineError("invalid_config", "Idempotent create binds the session to a source fingerprint, which direct mode never computes. Create the direct session without operationId.");
        }
        const deterministicSessionId = operationIdSha256 === undefined ? undefined : sessionIdFor(operationIdSha256);
        const finishLifecycle = this.#beginLifecycleOperation();
        let releaseReservation = () => { };
        try {
            releaseReservation = this.#reserveSessionSlot(deterministicSessionId === undefined ? undefined : `session:${deterministicSessionId}`, deterministicSessionId);
            const normalized = await normalizeWorkspace(snapshot);
            this.#assertOpen();
            if (operationIdSha256 === undefined) {
                const runConfiguration = await resolveRunConfiguration(normalized);
                this.#assertOpen();
                return await this.#createUnkeyed(normalized, runConfiguration);
            }
            return await this.#createIdempotent(operationIdSha256, normalized);
        }
        finally {
            releaseReservation();
            finishLifecycle();
        }
    }
    async #createUnkeyed(config, runConfiguration) {
        const autoDirect = config.inPlace !== true && config.direct !== true
            && await isCleanGitRepository(config.workspace);
        if (autoDirect) {
            this.#logger("clean git repository detected — session runs direct (no copy, no baseline)");
        }
        const session = await createSessionShell(config.workspace, {
            inPlace: config.inPlace === true || config.direct === true || autoDirect,
            direct: config.direct === true || autoDirect,
        });
        const root = path.dirname(session.metadataFile);
        try {
            this.#assertOpen();
            await writeFile(path.join(root, "run-config.json"), JSON.stringify(runConfiguration, null, 2), "utf8");
            this.#assertOpen();
            const managed = this.#newManagedSession(session, root, "idle");
            this.#sessions.set(session.id, managed);
            return this.#status(managed);
        }
        catch (error) {
            await rm(root, { recursive: true, force: true });
            throw error;
        }
    }
    async #createIdempotent(operationIdSha256, normalizedRequest) {
        const store = this.#createOperationStore;
        this.#assertOpen();
        const requestSha256 = canonicalDigest(normalizedRequest);
        const sessionId = `vanguard-session-${operationIdSha256}`;
        const persisted = await store.readClaim(operationIdSha256);
        if (persisted !== undefined && persisted.requestSha256 !== requestSha256) {
            throw new VanguardEngineError("create_operation_conflict", "operationId is already bound to a different normalized session request.", false, { operationIdSha256, requestedRequestSha256: requestSha256, persistedRequestSha256: persisted.requestSha256 });
        }
        let claim = persisted;
        if (claim === undefined) {
            const sourceFingerprintBefore = await fingerprintSessionSource(normalizedRequest.workspace);
            const runConfiguration = await resolveRunConfiguration(normalizedRequest);
            this.#assertOpen();
            const sourceFingerprint = await fingerprintSessionSource(normalizedRequest.workspace);
            this.#assertOpen();
            if (sourceFingerprint !== sourceFingerprintBefore) {
                throw new VanguardEngineError("create_source_changed", "The source workspace changed while Vanguard resolved the effective session configuration.", true);
            }
            const configSha256 = canonicalDigest(runConfiguration);
            const proposed = {
                version: 1,
                operationIdSha256,
                requestSha256,
                configSha256,
                sessionId,
                sourceFingerprint,
                runConfigurationSha256: configSha256,
                runConfiguration,
            };
            claim = (await store.reserve(proposed)).claim;
            this.#assertOpen();
            if (claim.requestSha256 !== requestSha256) {
                throw new VanguardEngineError("create_operation_conflict", "operationId was concurrently bound to a different normalized session request.", false, { operationIdSha256, requestedRequestSha256: requestSha256, persistedRequestSha256: claim.requestSha256 });
            }
        }
        assertClaimMatchesRunConfiguration(claim);
        const configSha256 = claim.configSha256;
        let sessionRoot = await store.validatePersistedClaim(claim);
        const faultContext = Object.freeze({ operationIdSha256, configSha256, sessionId: claim.sessionId, sessionRoot });
        await this.#createFaultInjector?.("claim_persisted", faultContext);
        this.#assertOpen();
        const effective = requiredStoredRunConfiguration(claim.runConfiguration);
        const session = await createSessionShellAt(effective.options.workspace, sessionRoot, async (stagingRoot, stagedSession) => {
            if (stagedSession.sourceFingerprint !== claim.sourceFingerprint) {
                throw new VanguardEngineError("create_source_changed", "The source workspace changed after the durable create claim; recovery is refused.");
            }
            await writeDurableJson(path.join(stagingRoot, "run-config.json"), effective);
            await writeDurableJson(path.join(stagingRoot, "create-operation.json"), {
                version: 1,
                operationIdSha256: claim.operationIdSha256,
                requestSha256: claim.requestSha256,
                configSha256: claim.configSha256,
                sourceFingerprint: claim.sourceFingerprint,
            });
        }, { inPlace: effective.options.inPlace === true });
        this.#assertOpen();
        if (session.id !== claim.sessionId || path.resolve(path.dirname(session.metadataFile)) !== path.resolve(sessionRoot)) {
            throw new VanguardEngineError("create_operation_corrupt", "The durable session does not match its create claim.");
        }
        if (session.sourceRoot !== effective.options.workspace || session.sourceFingerprint !== claim.sourceFingerprint) {
            throw new VanguardEngineError("create_source_changed", "The source workspace no longer matches the durable create claim; recovery is refused.");
        }
        sessionRoot = await store.validatePersistedClaim(claim);
        await validateStoredConfiguration(path.join(sessionRoot, "run-config.json"), claim.runConfigurationSha256);
        await this.#createFaultInjector?.("session_persisted", faultContext);
        this.#assertOpen();
        const expectedReceipt = {
            version: 1,
            operationIdSha256,
            requestSha256,
            configSha256,
            sessionId: claim.sessionId,
            sourceFingerprint: claim.sourceFingerprint,
            runConfigurationSha256: claim.runConfigurationSha256,
        };
        const existingReceipt = await store.readReceipt(operationIdSha256);
        if (existingReceipt !== undefined)
            assertReceiptMatches(existingReceipt, expectedReceipt);
        else
            await store.commitReceipt(expectedReceipt);
        await this.#createFaultInjector?.("receipt_persisted", faultContext);
        await store.validatePersistedClaim(claim);
        this.#assertOpen();
        const ownership = await store.acquireOwnership(operationIdSha256, this.#ownerToken);
        this.#rememberOwnership(ownership);
        await this.#createFaultInjector?.("ownership_acquired", faultContext);
        this.#assertOpen();
        const status = await this.#registerSession(await openCodingSession(sessionRoot), ownership, faultContext);
        this.#assertOpen();
        return status;
    }
    async resume(sessionRoot) {
        this.#assertOpen();
        const registeredSessionId = this.#registeredSessionIdForLocation(sessionRoot);
        const finishLifecycle = this.#beginLifecycleOperation();
        let releaseReservation = () => { };
        try {
            releaseReservation = this.#reserveSessionSlot(registeredSessionId === undefined ? `resume:${reservationPath(sessionRoot)}` : `session:${registeredSessionId}`, registeredSessionId);
            return await this.#resumeReserved(sessionRoot);
        }
        finally {
            releaseReservation();
            finishLifecycle();
        }
    }
    async #resumeReserved(sessionRoot) {
        const session = await openCodingSession(sessionRoot);
        const binding = await readCreateOperationBinding(path.join(path.dirname(session.metadataFile), "create-operation.json"));
        let ownership;
        let faultContext;
        if (binding !== undefined) {
            if (this.#createOperationStore === undefined) {
                throw new VanguardEngineError("create_operation_store_required", "A durable create session may only be resumed through its configured operation store.");
            }
            const claim = await this.#createOperationStore.readClaim(binding.operationIdSha256);
            if (claim === undefined || claim.sessionId !== session.id || claim.requestSha256 !== binding.requestSha256
                || claim.configSha256 !== binding.configSha256 || claim.sourceFingerprint !== binding.sourceFingerprint) {
                throw new VanguardEngineError("create_operation_corrupt", "Durable session binding does not match its operation claim.");
            }
            const expectedRoot = await this.#createOperationStore.validatePersistedClaim(claim);
            if (path.resolve(expectedRoot) !== path.resolve(path.dirname(session.metadataFile))) {
                throw new VanguardEngineError("create_operation_corrupt", "Durable session is outside its claimed operation root.");
            }
            this.#assertOpen();
            ownership = await this.#createOperationStore.acquireOwnership(binding.operationIdSha256, this.#ownerToken);
            this.#rememberOwnership(ownership);
            faultContext = Object.freeze({
                operationIdSha256: binding.operationIdSha256,
                configSha256: binding.configSha256,
                sessionId: session.id,
                sessionRoot: expectedRoot,
            });
            await this.#createFaultInjector?.("ownership_acquired", faultContext);
        }
        this.#assertOpen();
        const status = await this.#registerSession(session, ownership, faultContext);
        this.#assertOpen();
        return status;
    }
    async #registerSession(session, ownership, faultContext) {
        const inFlight = this.#registrationFlights.get(session.id);
        if (inFlight !== undefined) {
            await inFlight;
            const winner = this.#sessions.get(session.id);
            if (winner === undefined)
                throw new VanguardEngineError("session_registration_failed", "Session registration did not publish.");
            return this.#convergedSessionStatus(winner, session, ownership);
        }
        const flight = this.#registerSessionOnce(session, ownership, faultContext);
        this.#registrationFlights.set(session.id, flight);
        try {
            return await flight;
        }
        finally {
            if (this.#registrationFlights.get(session.id) === flight)
                this.#registrationFlights.delete(session.id);
        }
    }
    async #registerSessionOnce(session, ownership, faultContext) {
        this.#assertOpen();
        const existing = this.#sessions.get(session.id);
        if (existing !== undefined)
            return this.#convergedSessionStatus(existing, session, ownership);
        await validateStoredConfiguration(path.join(path.dirname(session.metadataFile), "run-config.json"));
        const managed = this.#newManagedSession(session, path.dirname(session.metadataFile), "idle", ownership);
        const journal = await FileJournal.open(path.join(managed.root, "run.jsonl"), {
            ...(session.journalGenesisHash === undefined ? {} : { genesisHash: session.journalGenesisHash }),
        });
        const presenter = new PublicRunEventPresenter();
        const journalEvents = await journal.readValidated();
        for (const event of journalEvents) {
            for (const publicEvent of presenter.present(event))
                this.#record(managed, publicEvent, false);
        }
        managed.state = restoredState(journalEvents);
        this.#assertOpen();
        this.#assertSessionOwnership(managed);
        if (faultContext !== undefined) {
            await this.#createFaultInjector?.("registration_pre_publish", faultContext);
            this.#assertOpen();
            this.#assertSessionOwnership(managed);
        }
        const winner = this.#sessions.get(session.id);
        if (winner !== undefined)
            return this.#convergedSessionStatus(winner, session, ownership);
        this.#sessions.set(session.id, managed);
        return this.#status(managed);
    }
    #convergedSessionStatus(existing, requested, ownership) {
        if (path.resolve(existing.root) !== path.resolve(path.dirname(requested.metadataFile))) {
            throw new VanguardEngineError("session_id_conflict", "A different session with this ID is already registered.");
        }
        if ((existing.ownership === undefined) !== (ownership === undefined)
            || (ownership !== undefined && (existing.ownership?.ownerToken !== ownership.ownerToken
                || existing.ownership.epoch !== ownership.epoch))) {
            throw new VanguardEngineError("session_ownership_lost", "Registered session ownership does not match.");
        }
        this.#assertSessionOwnership(existing);
        return this.#status(existing);
    }
    advance(sessionId, message) {
        this.#assertOpen();
        if (message !== undefined && (typeof message !== "string" || message.trim().length === 0)) {
            throw new VanguardEngineError("invalid_message", "Advance messages must be non-empty strings.");
        }
        if (message !== undefined && message.length > 16_384) {
            throw new VanguardEngineError("invalid_message", "Advance messages may not exceed 16,384 characters.");
        }
        const session = this.#requiredSession(sessionId);
        this.#assertSessionOwnership(session);
        if (session.workerUncertain) {
            throw new VanguardEngineError("session_worker_uncertain", "A prior worker generation lacks exact close/history proof; this session is permanently fenced.");
        }
        if (session.handle !== undefined || session.startTimer !== undefined
            || session.state === "running" || session.state === "cancelling") {
            throw new VanguardEngineError("session_busy", "The session already has an active advance.", true);
        }
        if (session.state === "completed") {
            throw new VanguardEngineError("session_completed", "A completed session cannot be advanced.");
        }
        session.state = "running";
        session.cancelRequested = false;
        session.terminalStatePending = undefined;
        session.workerGeneration += 1;
        session.steeringBytesThisAdvance = 0;
        session.startTimer = setImmediate(() => {
            session.startTimer = undefined;
            if (this.#closed) {
                session.state = "cancelled";
                return;
            }
            this.#startWorker(session, message);
        });
        return this.#status(session);
    }
    steer(sessionId, message) {
        this.#assertOpen();
        if (typeof message !== "string" || message.trim().length === 0) {
            throw new VanguardEngineError("invalid_message", "Steering messages must be non-empty strings.");
        }
        const session = this.#requiredSession(sessionId);
        this.#assertSessionOwnership(session);
        if (session.state !== "running" && session.state !== "waiting_for_user") {
            throw new VanguardEngineError("session_not_running", "Steering requires an active session.", true);
        }
        if (session.state === "waiting_for_user" && session.handle === undefined && session.startTimer === undefined) {
            session.state = "idle";
            return this.advance(sessionId, message);
        }
        const bytes = Buffer.byteLength(message, "utf8");
        if (bytes > 262_144 || session.steeringBytesThisAdvance + bytes > this.#maxSteeringBytesPerAdvance) {
            throw new VanguardEngineError("steering_queue_full", "The bounded steering allowance for this advance is full.", true);
        }
        session.steeringBytesThisAdvance += bytes;
        if (session.handle === undefined)
            session.pendingSteering.push(message);
        else {
            try {
                session.handle.steer(message);
            }
            catch {
                session.steeringBytesThisAdvance -= bytes;
                throw new VanguardEngineError("steering_backpressure", "The worker steering channel is backpressured.", true);
            }
        }
        if (session.state === "waiting_for_user")
            session.state = "running";
        return this.#status(session);
    }
    cancel(sessionId) {
        this.#assertOpen();
        const session = this.#requiredSession(sessionId);
        this.#assertSessionOwnership(session);
        if (session.handle === undefined && session.startTimer === undefined
            && session.state !== "running" && session.state !== "waiting_for_user" && session.state !== "cancelling") {
            throw new VanguardEngineError("session_not_running", "Cancellation requires an active session.", true);
        }
        session.cancelRequested = true;
        session.state = "cancelling";
        if (session.handle !== undefined)
            this.#cancelWorker(session, "Cancellation delivery failed");
        return this.#status(session);
    }
    async stopAndWait(sessionId, timeoutMs = 3_000) {
        this.#assertOpen();
        positiveInteger(timeoutMs, "timeoutMs", 300_000);
        const session = this.#requiredSession(sessionId);
        const ownershipValid = this.#sessionOwnershipValid(session);
        const generation = session.workerGeneration;
        if (session.startTimer !== undefined) {
            clearImmediate(session.startTimer);
            session.startTimer = undefined;
            session.cancelRequested = true;
            session.terminalStatePending = undefined;
            session.state = "cancelled";
            return this.#stopReceipt(session, generation, ownershipValid);
        }
        if (session.handle === undefined && session.stopBarrier === undefined) {
            return this.#stopReceipt(session, generation, ownershipValid && !session.workerUncertain);
        }
        session.cancelRequested = true;
        session.state = "cancelling";
        this.#cancelWorker(session, "Stop cancellation delivery failed");
        const barrier = session.stopBarrier;
        const stopped = barrier === undefined ? session.handle === undefined : await settleWithin(barrier, timeoutMs);
        return this.#stopReceipt(session, generation, ownershipValid && this.#sessionOwnershipValid(session) && stopped
            && session.workerGeneration === generation
            && session.handle === undefined
            && session.startTimer === undefined
            && session.stopBarrier === undefined
            && !session.workerUncertain);
    }
    status(sessionId) {
        this.#assertOpen();
        const session = this.#requiredSession(sessionId);
        this.#assertSessionOwnership(session);
        return this.#status(session);
    }
    events(sessionId, afterCursor = 0, limit = 500) {
        this.#assertOpen();
        if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
            throw new VanguardEngineError("invalid_cursor", "afterCursor must be a non-negative integer.");
        }
        const boundedLimit = positiveInteger(limit, "limit", 2_000);
        const session = this.#requiredSession(sessionId);
        this.#assertSessionOwnership(session);
        const available = session.events.filter((entry) => entry.cursor > afterCursor);
        return Object.freeze({
            sessionId,
            events: Object.freeze(available.slice(0, boundedLimit)),
            afterCursor,
            latestCursor: session.nextCursor - 1,
            replayFloorCursor: session.replayFloorCursor,
            gap: afterCursor < session.replayFloorCursor - 1,
            hasMore: available.length > boundedLimit,
        });
    }
    subscribe(listener) {
        this.#assertOpen();
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    shutdown() {
        if (this.#shutdownComplete !== undefined)
            return Promise.resolve(this.#shutdownComplete);
        if (this.#shutdownPromise !== undefined)
            return this.#shutdownPromise;
        const pending = this.#performShutdown();
        this.#shutdownPromise = pending;
        void pending.then((receipt) => {
            if (this.#shutdownPromise !== pending)
                return;
            this.#shutdownPromise = undefined;
            if (receipt.complete)
                this.#shutdownComplete = receipt;
        }, () => {
            if (this.#shutdownPromise === pending)
                this.#shutdownPromise = undefined;
        });
        return pending;
    }
    async #performShutdown() {
        this.#closed = true;
        const completions = [];
        for (const session of this.#sessions.values()) {
            if (session.startTimer !== undefined) {
                clearImmediate(session.startTimer);
                session.startTimer = undefined;
                session.cancelRequested = true;
                session.terminalStatePending = undefined;
                session.state = "cancelled";
            }
            if (session.handle !== undefined) {
                session.cancelRequested = true;
                session.state = "cancelling";
                this.#cancelWorker(session, "Shutdown cancellation failed");
                if (session.stopBarrier !== undefined)
                    completions.push(session.stopBarrier);
            }
        }
        await settleWithin(Promise.allSettled(completions).then(() => undefined), this.#shutdownTimeoutMs);
        this.#listeners.clear();
        const unresolvedSessionIds = [...this.#sessions.values()]
            .filter((session) => session.handle !== undefined || session.startTimer !== undefined
            || session.stopBarrier !== undefined || session.workerUncertain)
            .map((session) => session.session.id);
        const unresolved = new Set(unresolvedSessionIds);
        for (const [operationIdSha256, lease] of this.#ownedLeases) {
            const sessionId = sessionIdFor(operationIdSha256);
            if (unresolved.has(sessionId))
                continue;
            try {
                await this.#createOperationStore?.releaseOwnership(lease);
                this.#ownedLeases.delete(operationIdSha256);
            }
            catch (error) {
                unresolved.add(sessionId);
                this.#logger(`Ownership release failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const unresolvedOperations = this.#pendingLifecycleOperations;
        const finalUnresolved = [...unresolved];
        const stoppedSessionIds = [...this.#sessions.keys()].filter((sessionId) => !unresolved.has(sessionId));
        return Object.freeze({
            version: 1,
            complete: finalUnresolved.length === 0 && unresolvedOperations === 0,
            stoppedSessionIds: Object.freeze(stoppedSessionIds),
            unresolvedSessionIds: Object.freeze(finalUnresolved),
            unresolvedOperations,
        });
    }
    #startWorker(session, message) {
        const generation = session.workerGeneration;
        try {
            this.#assertSessionOwnership(session);
        }
        catch (error) {
            session.state = "failed";
            this.#logger(`Worker start fenced: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        let handle;
        let assigned = false;
        const bufferedEvents = [];
        const bufferedLogs = [];
        let bufferedEventOverflow = false;
        const acceptEvent = (event) => {
            try {
                if (!assigned) {
                    if (bufferedEventOverflow)
                        return;
                    if (bufferedEvents.length < 256)
                        bufferedEvents.push(event);
                    else {
                        bufferedEventOverflow = true;
                        bufferedEvents.length = 0;
                    }
                    return;
                }
                if (handle !== undefined)
                    this.#record(session, event, true, generation, handle);
            }
            catch (error) {
                this.#logger(`Worker event rejected: ${error instanceof Error ? error.message : String(error)}`);
            }
        };
        const acceptLog = (line) => {
            try {
                if (!assigned) {
                    if (bufferedLogs.length < 256)
                        bufferedLogs.push(line);
                    return;
                }
                if (session.workerGeneration === generation && session.handle === handle)
                    this.#logger(line);
            }
            catch {
            }
        };
        try {
            handle = this.#runner.start(session.root, message, {
                onEvent: acceptEvent,
                onLog: acceptLog,
            });
        }
        catch (error) {
            session.state = "failed";
            session.pendingSteering.length = 0;
            session.steeringBytesThisAdvance = 0;
            this.#logger(`Worker start failed: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        session.handle = handle;
        assigned = true;
        if (!bufferedEventOverflow) {
            for (const event of bufferedEvents)
                acceptEvent(event);
        }
        for (const line of bufferedLogs)
            acceptLog(line);
        try {
            this.#assertSessionOwnership(session);
        }
        catch (error) {
            session.terminalStatePending = "failed";
            this.#logger(`Worker ownership lost at launch: ${error instanceof Error ? error.message : String(error)}`);
            this.#cancelWorker(session, "Worker cleanup after ownership loss failed");
        }
        const cleanup = handle.done.then(async (exit) => {
            if (session.workerGeneration !== generation || session.handle !== handle)
                return;
            session.handle = undefined;
            try {
                session.session = await openCodingSession(session.root);
            }
            catch {
            }
            if (session.cancelRequested)
                session.state = "cancelled";
            else if (session.terminalStatePending !== undefined)
                session.state = session.terminalStatePending;
            else if (session.state !== "waiting_for_user")
                session.state = exit.code === 0 ? "idle" : "failed";
            session.terminalStatePending = undefined;
        }).catch((error) => {
            if (session.workerGeneration === generation && session.handle === handle) {
                session.terminalStatePending = undefined;
                session.workerUncertain = true;
                session.state = session.cancelRequested ? "cancelled" : "failed";
            }
            this.#logger(`Worker completion failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        const barrier = cleanup.finally(() => {
            if (session.workerGeneration === generation && session.stopBarrier === barrier)
                session.stopBarrier = undefined;
        });
        session.stopBarrier = barrier;
        void barrier;
        if (bufferedEventOverflow) {
            session.workerUncertain = true;
            session.terminalStatePending = "failed";
            session.state = "cancelling";
            this.#logger("Worker emitted more than 256 events before returning its handle; session fenced.");
            this.#cancelWorker(session, "Worker cleanup after synchronous event overflow failed");
            return;
        }
        if (session.cancelRequested) {
            session.pendingSteering.length = 0;
            this.#cancelWorker(session, "Cancellation delivery failed");
            return;
        }
        try {
            for (const steering of session.pendingSteering.splice(0))
                handle.steer(steering);
        }
        catch (error) {
            session.terminalStatePending = "failed";
            session.state = "failed";
            this.#logger(`Queued steering delivery failed: ${error instanceof Error ? error.message : String(error)}`);
            this.#cancelWorker(session, "Worker cleanup after steering failure failed");
            return;
        }
    }
    #cancelWorker(session, context) {
        try {
            session.handle?.cancel();
        }
        catch (error) {
            this.#logger(`${context}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    #record(session, event, notify, generation, handle) {
        if (generation !== undefined && (session.workerGeneration !== generation || session.handle !== handle))
            return;
        if (generation !== undefined && !this.#sessionOwnershipValid(session)) {
            session.terminalStatePending = "failed";
            session.state = "cancelling";
            this.#cancelWorker(session, "Worker fenced after ownership loss");
            return;
        }
        const sanitized = deepFreeze(sanitizePublicEvent(event));
        const envelope = Object.freeze({
            sessionId: session.session.id,
            cursor: session.nextCursor,
            event: sanitized,
        });
        session.nextCursor += 1;
        const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
        session.events.push(envelope);
        session.eventSizes.push(envelopeBytes);
        session.eventBytes += envelopeBytes;
        while (session.events.length > this.#maxReplayEvents || session.eventBytes > this.#maxReplayBytesPerSession) {
            session.events.shift();
            session.eventBytes -= session.eventSizes.shift() ?? 0;
        }
        session.replayFloorCursor = session.events[0]?.cursor ?? session.nextCursor;
        if (sanitized.type === "session.ready" && sanitized.materialized === true) {
            session.session = { ...session.session, materialized: true };
        }
        if (sanitized.type === "run.waiting_for_user")
            session.state = "waiting_for_user";
        else if (sanitized.type === "run.completed" || sanitized.type === "run.failed") {
            const terminal = sanitized.type === "run.completed" ? "completed" : "failed";
            if (session.handle !== undefined || session.startTimer !== undefined || session.state === "running"
                || session.state === "cancelling" || session.state === "waiting_for_user") {
                session.terminalStatePending = terminal;
                session.state = terminal;
            }
            else
                session.state = terminal;
        }
        else if (sanitized.type === "run.contracted" && session.state !== "running")
            session.state = "idle";
        if (!notify)
            return;
        for (const listener of this.#listeners) {
            try {
                listener(envelope);
            }
            catch (error) {
                this.#logger(`Event listener failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    #newManagedSession(session, root, state, ownership) {
        return {
            session,
            root,
            state,
            nextCursor: 1,
            replayFloorCursor: 1,
            events: [],
            eventSizes: [],
            eventBytes: 0,
            handle: undefined,
            startTimer: undefined,
            pendingSteering: [],
            steeringBytesThisAdvance: 0,
            cancelRequested: false,
            workerGeneration: 0,
            terminalStatePending: undefined,
            stopBarrier: undefined,
            ownership,
            workerUncertain: false,
        };
    }
    #requiredSession(sessionId) {
        if (typeof sessionId !== "string" || sessionId.length === 0) {
            throw new VanguardEngineError("invalid_session_id", "sessionId must be a non-empty string.");
        }
        const session = this.#sessions.get(sessionId);
        if (session === undefined)
            throw new VanguardEngineError("session_not_found", "The requested session is not registered.");
        return session;
    }
    #assertSessionOwnership(session) {
        if (session.ownership === undefined)
            return;
        if (this.#createOperationStore === undefined) {
            throw new VanguardEngineError("session_ownership_lost", "Durable session ownership store is unavailable.");
        }
        this.#createOperationStore.assertOwnershipSync(session.ownership);
    }
    #sessionOwnershipValid(session) {
        try {
            this.#assertSessionOwnership(session);
            return true;
        }
        catch {
            return false;
        }
    }
    #status(managed) {
        return Object.freeze({
            sessionId: managed.session.id,
            sessionRoot: managed.root,
            sourceRoot: managed.session.sourceRoot,
            workspaceRoot: managed.session.workspaceRoot,
            materialized: managed.session.materialized,
            state: managed.state,
            workerActive: managed.handle !== undefined || managed.startTimer !== undefined
                || managed.stopBarrier !== undefined || managed.workerUncertain,
            workerGeneration: managed.workerGeneration,
            ...(managed.ownership === undefined ? {} : { ownerEpoch: managed.ownership.epoch }),
            latestCursor: managed.nextCursor - 1,
            replayFloorCursor: managed.replayFloorCursor,
        });
    }
    #assertOpen() {
        if (this.#closed)
            throw new VanguardEngineError("engine_closed", "The Vanguard engine is closed.");
    }
    #stopReceipt(session, generation, stopped) {
        return Object.freeze({
            version: 1,
            sessionId: session.session.id,
            stopped,
            state: session.state,
            workerGeneration: generation,
            ...(session.ownership === undefined ? {} : { ownerEpoch: session.ownership.epoch }),
        });
    }
    #registeredSessionIdForLocation(location) {
        const candidate = reservationPath(location);
        for (const session of this.#sessions.values()) {
            const root = reservationPath(session.root);
            if (root === candidate || root === normalizedPath(path.dirname(candidate)))
                return session.session.id;
        }
        return undefined;
    }
    #rememberOwnership(lease) {
        const held = this.#ownedLeases.get(lease.operationIdSha256);
        if (held !== undefined && (held.ownerToken !== lease.ownerToken || held.epoch !== lease.epoch)) {
            throw new VanguardEngineError("session_ownership_lost", "The engine's durable ownership reference changed during registration.");
        }
        if (held === undefined)
            this.#ownedLeases.set(lease.operationIdSha256, lease);
    }
    #reserveSessionSlot(sharedKey, registeredSessionId) {
        if (registeredSessionId !== undefined && this.#sessions.has(registeredSessionId))
            return () => { };
        const key = sharedKey ?? `create:${randomUUID()}`;
        const current = this.#pendingSessionReservations.get(key);
        if (current !== undefined) {
            this.#pendingSessionReservations.set(key, current + 1);
        }
        else {
            if (this.#sessions.size + this.#pendingSessionReservations.size >= this.#maxSessions) {
                throw new VanguardEngineError("session_capacity", "The engine's bounded session capacity is full.", true);
            }
            this.#pendingSessionReservations.set(key, 1);
        }
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            const references = this.#pendingSessionReservations.get(key);
            if (references === undefined || references <= 1)
                this.#pendingSessionReservations.delete(key);
            else
                this.#pendingSessionReservations.set(key, references - 1);
        };
    }
    #beginLifecycleOperation() {
        this.#pendingLifecycleOperations += 1;
        let finished = false;
        return () => {
            if (finished)
                return;
            finished = true;
            this.#pendingLifecycleOperations -= 1;
        };
    }
}
function reservationPath(location) {
    if (typeof location !== "string" || location.length === 0 || location.includes("\0")) {
        throw new VanguardEngineError("invalid_session_root", "sessionRoot must be a non-empty path string.");
    }
    return normalizedPath(path.resolve(location));
}
function normalizedPath(value) {
    return process.platform === "win32" ? value.toLowerCase() : value;
}
async function resolveRunConfiguration(config) {
    const verificationWasDetected = config.verification === undefined;
    const verification = config.verification
        ?? await detectProjectVerification(config.workspace)
        ?? (config.adaptiveVerification === true
            ? { command: ADAPTIVE_VERIFY_COMMAND, args: ["--mode", "tests"] }
            : undefined);
    if (verification === undefined) {
        throw new VanguardEngineError("verification_not_found", "Could not detect project verification; provide a sealed verification command, or set adaptiveVerification.");
    }
    const resolvedExtensions = await resolveExtensions({ workspaceRoot: config.workspace });
    return deepFreeze({
        version: 1,
        options: storedOptions(config, verification, verificationWasDetected, resolvedExtensions),
    });
}
function storedOptions(config, verification, verificationWasDetected, extensions) {
    const security = resolveSecurityPolicy({
        ...(config.securityProfile === undefined ? {} : { profile: config.securityProfile }),
        ...(config.restrictProcess === undefined ? {} : { restrictProcess: config.restrictProcess }),
        ...(config.exposeRawProcess === undefined ? {} : { exposeRawProcess: config.exposeRawProcess }),
        ...(config.verifierEvidence === undefined ? {} : { verifierEvidence: config.verifierEvidence }),
    });
    return {
        workspace: config.workspace,
        ...(config.inPlace === undefined ? {} : { inPlace: config.inPlace }),
        task: "",
        provider: config.provider,
        model: config.model,
        verification,
        ...(config.auth === undefined ? {} : { auth: config.auth }),
        ...(config.executionEvidence === undefined ? {} : { executionEvidence: config.executionEvidence }),
        ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
        ...(config.credentialVariable === undefined ? {} : { credentialVariable: config.credentialVariable }),
        ...(config.adaptiveVerification === undefined ? {} : { adaptiveVerification: config.adaptiveVerification }),
        allowedCommands: [...(config.allowedCommands ?? [])],
        protectedPaths: [...(config.protectedPaths ?? [])],
        editableRoots: [...(config.editableRoots ?? [])],
        securityProfile: security.profile,
        restrictProcess: security.restrictProcess,
        exposeRawProcess: security.exposeRawProcess,
        verifierEvidence: security.verifierEvidence,
        ...(config.publicCheck !== undefined
            ? { publicCheck: config.publicCheck }
            : verificationWasDetected ? { publicCheck: verification } : {}),
        maxSteps: positiveInteger(config.maxSteps ?? 60, "maxSteps", 100_000),
        maxDurationMs: positiveInteger(config.maxDurationMs ?? 7_200_000, "maxDurationMs", 7 * 24 * 60 * 60 * 1_000),
        commandTimeoutMs: positiveInteger(config.commandTimeoutMs ?? 1_800_000, "commandTimeoutMs", 24 * 60 * 60 * 1_000),
        ...(config.commandIdleTimeoutMs === undefined
            ? {}
            : { commandIdleTimeoutMs: positiveInteger(config.commandIdleTimeoutMs, "commandIdleTimeoutMs", 24 * 60 * 60 * 1_000) }),
        maxContextBytes: positiveInteger(config.maxContextBytes ?? 2_000_000, "maxContextBytes", 100_000_000),
        maxFailedVerificationAttempts: positiveInteger(config.maxFailedVerificationAttempts ?? 3, "maxFailedVerificationAttempts", 100),
        extensions: extensionRuntimeState(extensions),
        ...(extensions.instructions.length === 0 ? {} : { extensionInstructions: extensions.instructions }),
    };
}
function snapshotConfig(config) {
    const raw = ownDataRecord(config, "Session config");
    const allowed = new Set([
        "adaptiveVerification", "allowedCommands", "auth", "commandIdleTimeoutMs", "commandTimeoutMs", "credentialVariable", "direct", "editableRoots", "endpoint", "inPlace",
        "executionEvidence",
        "exposeRawProcess", "maxContextBytes", "maxDurationMs", "maxFailedVerificationAttempts",
        "maxSteps", "model", "protectedPaths", "provider", "publicCheck", "restrictProcess",
        "securityProfile", "verification", "verifierEvidence", "workspace",
    ]);
    for (const key of Object.keys(raw)) {
        if (!allowed.has(key))
            throw new VanguardEngineError("invalid_config", `Unsupported session config field '${key}'.`);
    }
    const workspace = boundedString(raw.workspace, "workspace", 32_768, true);
    if (!["openai", "anthropic", "deepseek", "kimi", "ollama", "openai-compatible", "http"].includes(raw.provider)) {
        throw new VanguardEngineError("invalid_config", "provider is unsupported.");
    }
    const provider = raw.provider;
    const model = boundedString(raw.model, "model", 4_096, true);
    if (raw.auth !== undefined && raw.auth !== "api-key" && raw.auth !== "oauth") {
        throw new VanguardEngineError("invalid_config", "auth must be 'api-key' or 'oauth'.");
    }
    if (raw.auth === "oauth" && provider !== "openai" && provider !== "anthropic" && provider !== "kimi") {
        throw new VanguardEngineError("invalid_config", "auth 'oauth' is supported only for the openai, anthropic, and kimi providers.");
    }
    if (raw.executionEvidence !== undefined && raw.executionEvidence !== "independent" && raw.executionEvidence !== "syntax") {
        throw new VanguardEngineError("invalid_config", "executionEvidence must be 'independent' or 'syntax'.");
    }
    const executionEvidence = raw.executionEvidence;
    const auth = raw.auth;
    if ((provider === "http" || provider === "openai-compatible") && (raw.endpoint === undefined || raw.endpoint === "")) {
        throw new VanguardEngineError("invalid_config", `The ${provider} provider requires endpoint.`);
    }
    const endpoint = raw.endpoint === undefined ? undefined : boundedString(raw.endpoint, "endpoint", 16_384, false);
    if (provider === "openai-compatible" && raw.credentialVariable === undefined) {
        throw new VanguardEngineError("invalid_config", "The openai-compatible provider requires credentialVariable, an environment-variable name like OPENROUTER_API_KEY.");
    }
    if (raw.credentialVariable !== undefined) {
        if (typeof raw.credentialVariable !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(raw.credentialVariable)) {
            throw new VanguardEngineError("invalid_config", "credentialVariable must be an environment-variable name like OPENROUTER_API_KEY.");
        }
        if (raw.auth === "oauth") {
            throw new VanguardEngineError("invalid_config", "credentialVariable cannot be combined with oauth auth.");
        }
        if (provider === "http") {
            throw new VanguardEngineError("invalid_config", "credentialVariable is not supported for the http provider.");
        }
    }
    const credentialVariable = raw.credentialVariable;
    if (raw.securityProfile !== undefined && raw.securityProfile !== "workspace" && raw.securityProfile !== "guarded") {
        throw new VanguardEngineError("invalid_config", "securityProfile must be 'workspace' or 'guarded'.");
    }
    const verification = raw.verification === undefined ? undefined : cloneCommand(raw.verification, "verification");
    const publicCheck = raw.publicCheck === undefined ? undefined : cloneCommand(raw.publicCheck, "publicCheck");
    const allowedCommands = cloneStringArray(raw.allowedCommands, "allowedCommands");
    const protectedPaths = cloneStringArray(raw.protectedPaths, "protectedPaths");
    const editableRoots = cloneStringArray(raw.editableRoots, "editableRoots");
    for (const [field, value] of [
        ["adaptiveVerification", raw.adaptiveVerification],
        ["inPlace", raw.inPlace],
        ["direct", raw.direct],
        ["restrictProcess", raw.restrictProcess],
        ["exposeRawProcess", raw.exposeRawProcess],
    ]) {
        if (value !== undefined && typeof value !== "boolean") {
            throw new VanguardEngineError("invalid_config", `${field} must be boolean.`);
        }
    }
    if (raw.verifierEvidence !== undefined && raw.verifierEvidence !== "full" && raw.verifierEvidence !== "summary") {
        throw new VanguardEngineError("invalid_config", "verifierEvidence must be 'full' or 'summary'.");
    }
    try {
        resolveSecurityPolicy({
            ...(raw.securityProfile === undefined ? {} : { profile: raw.securityProfile }),
            ...(raw.restrictProcess === undefined ? {} : { restrictProcess: raw.restrictProcess }),
            ...(raw.exposeRawProcess === undefined ? {} : { exposeRawProcess: raw.exposeRawProcess }),
            ...(raw.verifierEvidence === undefined ? {} : { verifierEvidence: raw.verifierEvidence }),
        });
    }
    catch (error) {
        throw new VanguardEngineError("invalid_config", error instanceof Error ? error.message : String(error));
    }
    for (const [field, value, maximum] of [
        ["maxSteps", raw.maxSteps, 100_000],
        ["maxDurationMs", raw.maxDurationMs, 7 * 24 * 60 * 60 * 1_000],
        ["commandTimeoutMs", raw.commandTimeoutMs, 24 * 60 * 60 * 1_000],
        ["commandIdleTimeoutMs", raw.commandIdleTimeoutMs, 24 * 60 * 60 * 1_000],
        ["maxContextBytes", raw.maxContextBytes, 100_000_000],
        ["maxFailedVerificationAttempts", raw.maxFailedVerificationAttempts, 100],
    ]) {
        if (value !== undefined)
            positiveInteger(value, field, maximum);
    }
    const result = {
        workspace,
        provider,
        model,
        ...(raw.inPlace === undefined ? {} : { inPlace: raw.inPlace }),
        ...(raw.direct === undefined ? {} : { direct: raw.direct }),
        ...(auth === undefined ? {} : { auth }),
        ...(executionEvidence === undefined ? {} : { executionEvidence }),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(credentialVariable === undefined ? {} : { credentialVariable }),
        ...(verification === undefined ? {} : { verification }),
        ...(publicCheck === undefined ? {} : { publicCheck }),
        ...(raw.adaptiveVerification === undefined ? {} : { adaptiveVerification: raw.adaptiveVerification }),
        ...(allowedCommands === undefined ? {} : { allowedCommands }),
        ...(protectedPaths === undefined ? {} : { protectedPaths }),
        ...(editableRoots === undefined ? {} : { editableRoots }),
        ...(raw.securityProfile === undefined ? {} : { securityProfile: raw.securityProfile }),
        ...(raw.restrictProcess === undefined ? {} : { restrictProcess: raw.restrictProcess }),
        ...(raw.exposeRawProcess === undefined ? {} : { exposeRawProcess: raw.exposeRawProcess }),
        ...(raw.verifierEvidence === undefined ? {} : { verifierEvidence: raw.verifierEvidence }),
        ...(raw.maxSteps === undefined ? {} : { maxSteps: raw.maxSteps }),
        ...(raw.maxDurationMs === undefined ? {} : { maxDurationMs: raw.maxDurationMs }),
        ...(raw.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: raw.commandTimeoutMs }),
        ...(raw.commandIdleTimeoutMs === undefined ? {} : { commandIdleTimeoutMs: raw.commandIdleTimeoutMs }),
        ...(raw.maxContextBytes === undefined ? {} : { maxContextBytes: raw.maxContextBytes }),
        ...(raw.maxFailedVerificationAttempts === undefined
            ? {}
            : { maxFailedVerificationAttempts: raw.maxFailedVerificationAttempts }),
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1_048_576) {
        throw new VanguardEngineError("invalid_config", "Session config exceeds the 1 MiB canonical request limit.");
    }
    return deepFreeze(result);
}
function ownDataRecord(value, field) {
    if (!isPlainObject(value))
        throw new VanguardEngineError("invalid_config", `${field} must be a plain object.`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const cloned = {};
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") {
            throw new VanguardEngineError("invalid_config", `${field} may not contain symbol properties.`);
        }
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !("value" in descriptor)) {
            throw new VanguardEngineError("invalid_config", `${field} may contain only enumerable data properties.`);
        }
        cloned[key] = descriptor.value;
    }
    return cloned;
}
function boundedString(value, field, maximum, nonempty) {
    if (typeof value !== "string" || value.includes("\0") || value.length > maximum || (nonempty && value.length === 0)) {
        throw new VanguardEngineError("invalid_config", `${field} must be ${nonempty ? "a non-empty " : "a "}string of at most ${maximum} characters.`);
    }
    return value;
}
async function normalizeWorkspace(config) {
    const requested = path.resolve(config.workspace);
    let workspace;
    try {
        workspace = await realpath(requested);
        if (!(await stat(workspace)).isDirectory())
            throw new Error("not a directory");
    }
    catch {
        throw new VanguardEngineError("invalid_config", "workspace must name an existing directory.");
    }
    return deepFreeze({ ...config, workspace });
}
function cloneCommand(command, field) {
    const raw = ownDataRecord(command, field);
    if (Object.keys(raw).some((key) => key !== "command" && key !== "args") || raw.args === undefined) {
        throw new VanguardEngineError("invalid_config", `${field} must contain a command and string args.`);
    }
    const executable = boundedString(raw.command, `${field}.command`, 32_768, true);
    const args = cloneRequiredStringArray(raw.args, `${field}.args`, 2_048);
    return Object.freeze({ command: executable, args });
}
function cloneStringArray(value, field) {
    if (value === undefined)
        return undefined;
    return cloneRequiredStringArray(value, field, 4_096);
}
function cloneRequiredStringArray(value, field, maximum) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
        throw new VanguardEngineError("invalid_config", `${field} must be a bounded array of strings.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (key === "length")
            continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)
            || Number(key) >= value.length || !descriptors[key]?.enumerable || !("value" in descriptors[key])) {
            throw new VanguardEngineError("invalid_config", `${field} must contain only indexed string values.`);
        }
    }
    const cloned = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) {
            throw new VanguardEngineError("invalid_config", `${field} may not be sparse or accessor-backed.`);
        }
        cloned.push(boundedString(descriptor.value, `${field}[${index}]`, 32_768, false));
    }
    return Object.freeze(cloned);
}
async function validateStoredConfiguration(file, expectedSha256) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(file, "utf8"));
    }
    catch {
        throw new VanguardEngineError("session_config_invalid", "Session run configuration is missing or malformed.");
    }
    const configuration = requiredStoredRunConfiguration(parsed);
    if (expectedSha256 !== undefined && canonicalDigest(configuration) !== expectedSha256) {
        throw new VanguardEngineError("create_operation_corrupt", "Session run configuration does not match its durable claim.");
    }
    return configuration;
}
async function readCreateOperationBinding(file) {
    let value;
    try {
        value = JSON.parse(await readFile(file, "utf8"));
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return undefined;
        throw new VanguardEngineError("create_operation_corrupt", "Durable session create binding is malformed.");
    }
    if (!isPlainObject(value) || value.version !== 1
        || !hasExactStringKeys(value, ["configSha256", "operationIdSha256", "requestSha256", "sourceFingerprint", "version"])
        || !isSha256(value.operationIdSha256) || !isSha256(value.requestSha256)
        || !isSha256(value.configSha256) || !isSha256(value.sourceFingerprint)) {
        throw new VanguardEngineError("create_operation_corrupt", "Durable session create binding is invalid.");
    }
    return Object.freeze(value);
}
function hasExactStringKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function isSha256(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function requiredStoredRunConfiguration(value) {
    if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.options)) {
        throw new VanguardEngineError("session_config_invalid", "Session run configuration is unsupported.");
    }
    const options = value.options;
    if (typeof options.workspace !== "string" || !path.isAbsolute(options.workspace)
        || typeof options.task !== "string"
        || !["openai", "anthropic", "deepseek", "kimi", "ollama", "openai-compatible", "http"].includes(options.provider)
        || (options.credentialVariable !== undefined && typeof options.credentialVariable !== "string")
        || typeof options.model !== "string" || options.model.length === 0
        || (options.inPlace !== undefined && typeof options.inPlace !== "boolean")
        || (options.auth !== undefined && options.auth !== "api-key" && options.auth !== "oauth")
        || (options.executionEvidence !== undefined && options.executionEvidence !== "independent" && options.executionEvidence !== "syntax")
        || !isCommandSpec(options.verification)
        || !isStringArray(options.allowedCommands)
        || !isStringArray(options.protectedPaths)
        || !isStringArray(options.editableRoots)
        || (options.securityProfile !== "workspace" && options.securityProfile !== "guarded")
        || typeof options.restrictProcess !== "boolean"
        || typeof options.exposeRawProcess !== "boolean"
        || (options.verifierEvidence !== "full" && options.verifierEvidence !== "summary")
        || !isBoundedInteger(options.maxSteps, 100_000)
        || !isBoundedInteger(options.maxDurationMs, 7 * 24 * 60 * 60 * 1_000)
        || !isBoundedInteger(options.commandTimeoutMs, 24 * 60 * 60 * 1_000)
        || (options.commandIdleTimeoutMs !== undefined && !isBoundedInteger(options.commandIdleTimeoutMs, 24 * 60 * 60 * 1_000))
        || !isBoundedInteger(options.maxContextBytes, 100_000_000)
        || !isBoundedInteger(options.maxFailedVerificationAttempts, 100)
        || (options.endpoint !== undefined && typeof options.endpoint !== "string")
        || (options.adaptiveVerification !== undefined && typeof options.adaptiveVerification !== "boolean")
        || (options.publicCheck !== undefined && !isCommandSpec(options.publicCheck))
        || (options.extensionInstructions !== undefined && typeof options.extensionInstructions !== "string")) {
        throw new VanguardEngineError("session_config_invalid", "Session run configuration is unsupported.");
    }
    canonicalDigest(value);
    return deepFreeze(value);
}
function assertClaimMatchesRunConfiguration(claim) {
    const configuration = requiredStoredRunConfiguration(claim.runConfiguration);
    if (canonicalDigest(configuration) !== claim.runConfigurationSha256
        || claim.configSha256 !== claim.runConfigurationSha256) {
        throw new VanguardEngineError("create_operation_corrupt", "Create claim configuration binding is invalid.");
    }
}
function assertReceiptMatches(actual, expected) {
    if (actual.operationIdSha256 !== expected.operationIdSha256
        || actual.requestSha256 !== expected.requestSha256
        || actual.configSha256 !== expected.configSha256
        || actual.sessionId !== expected.sessionId
        || actual.sourceFingerprint !== expected.sourceFingerprint
        || actual.runConfigurationSha256 !== expected.runConfigurationSha256) {
        throw new VanguardEngineError("create_operation_corrupt", "Create receipt conflicts with its durable claim.");
    }
}
async function writeDurableJson(file, value) {
    const handle = await open(file, "wx", 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
function isCommandSpec(value) {
    if (!isPlainObject(value) || typeof value.command !== "string" || value.command.length === 0
        || !Array.isArray(value.args))
        return false;
    for (let index = 0; index < value.args.length; index += 1) {
        if (!Object.hasOwn(value.args, index) || typeof value.args[index] !== "string")
            return false;
    }
    return true;
}
function isStringArray(value) {
    if (!Array.isArray(value))
        return false;
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || typeof value[index] !== "string")
            return false;
    }
    return true;
}
function isBoundedInteger(value, maximum) {
    return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== "object")
        return value;
    if (seen.has(value))
        throw new VanguardEngineError("invalid_config", "Session config may not be cyclic.");
    seen.add(value);
    try {
        for (const child of Object.values(value))
            deepFreeze(child, seen);
        return Object.freeze(value);
    }
    finally {
        seen.delete(value);
    }
}
function restoredState(events) {
    let state = "idle";
    for (const event of events) {
        if (event.type === "run.waiting_for_user")
            state = "waiting_for_user";
        else if (event.type === "run.completed")
            state = "completed";
        else if (event.type === "run.failed")
            state = "failed";
        else if (event.type === "user.message" || event.type === "run.resumed"
            || event.type === "session.restored" || event.type === "session.forked")
            state = "idle";
    }
    return state;
}
function positiveInteger(value, field, maximum) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new VanguardEngineError("invalid_config", `${field} must be a positive integer no greater than ${maximum}.`);
    }
    return value;
}
async function settleWithin(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise.then(() => true, () => false),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
