import { createHash, randomUUID } from "node:crypto";
import { createSecretRedactor, sanitizePublicEvent } from "../engine/security.js";
import { ARES_ROUTE_CLAIM_CAPABILITY, aresRouteClaimDigest, aresRouteOperationDigest, aresUpstreamIdentityDigest, validateAresDurableRouteClaim, validateAresDurableRouteReceipt, } from "./aresRouteClaimStore.js";
import { ARES_VANGUARD_ADAPTER_VERSION, } from "./aresTypes.js";
import { DEFAULT_ARES_VANGUARD_ROLLOUT, decideAresVanguardRollout, } from "./rollout.js";
const FALLBACK_REASON_TELEMETRY = {
    rollout_ineligible: "rollout",
    kill_switch: "kill_switch",
    vanguard_startup_failure: "startup",
    vanguard_protocol_failure: "protocol",
    vanguard_critical_failure: "critical",
    legacy_protocol_failure: "protocol",
};
const CLAIMED_VANGUARD_PORTS = new WeakSet();
const CLAIMED_LEGACY_PORTS = new WeakSet();
const ROUTE_ARBITRATION_SETTLEMENTS = new WeakMap();
const INVALID_ROLLOUT_POLICY_SHA256 = createHash("sha256")
    .update("VANGUARD_ARES_INVALID_ROLLOUT_POLICY_V1")
    .digest("hex");
export class AresVanguardAdapter {
    #vanguard;
    #legacy;
    #routeClaims;
    #rollout;
    #telemetry;
    #maxReplayEvents;
    #maxPendingPushEvents;
    #maxSessions;
    #barrierTimeoutMs;
    #foreignOperationTimeoutMs;
    #logger;
    #now;
    #sessions = new Map();
    #byVanguardId = new Map();
    #byLegacyId = new Map();
    #listeners = new Set();
    #pendingStarts = new Set();
    #uncertainForeignOperations = new Set();
    #createOperations = new Map();
    #unsubscribe;
    #sessionReservations = 0;
    #uncontainedForeignOperations = 0;
    #closed = false;
    #unsubscribed = false;
    #portsReleased = false;
    #shutdownInFlight;
    constructor(options) {
        this.#vanguard = options.vanguard;
        this.#legacy = options.legacy;
        this.#routeClaims = options.routeClaims;
        assertLifecycleCapabilities(this.#vanguard.capabilities(), "Vanguard");
        assertLifecycleCapabilities(this.#legacy.capabilities(), "Legacy core");
        assertRouteClaimCapabilities(this.#routeClaims?.capabilities());
        const rollout = options.rollout;
        this.#rollout = typeof rollout === "function"
            ? rollout
            : () => rollout ?? DEFAULT_ARES_VANGUARD_ROLLOUT;
        this.#telemetry = options.telemetry;
        this.#maxReplayEvents = boundedInteger(options.maxReplayEvents ?? 4_096, 1, 100_000, "maxReplayEvents");
        this.#maxPendingPushEvents = boundedInteger(options.maxPendingPushEvents ?? 1_024, 1, 100_000, "maxPendingPushEvents");
        this.#maxSessions = boundedInteger(options.maxSessions ?? 128, 1, 10_000, "maxSessions");
        this.#barrierTimeoutMs = boundedInteger(options.barrierTimeoutMs ?? 3_000, 1, 60_000, "barrierTimeoutMs");
        this.#foreignOperationTimeoutMs = boundedInteger(options.foreignOperationTimeoutMs ?? 30_000, 1, 300_000, "foreignOperationTimeoutMs");
        if (options.logger !== undefined && typeof options.logger !== "function")
            throw new Error("logger must be a function.");
        if (options.now !== undefined && typeof options.now !== "function")
            throw new Error("now must be a function.");
        this.#logger = options.logger ?? (() => { });
        this.#now = options.now ?? Date.now;
        if (CLAIMED_VANGUARD_PORTS.has(this.#vanguard) || CLAIMED_LEGACY_PORTS.has(this.#legacy)) {
            throw protocolError("A core port is already owned by another live Ares adapter.");
        }
        CLAIMED_VANGUARD_PORTS.add(this.#vanguard);
        CLAIMED_LEGACY_PORTS.add(this.#legacy);
        try {
            const unsubscribe = this.#vanguard.subscribe((envelope) => this.#acceptVanguardPush(envelope));
            if (typeof unsubscribe !== "function")
                throw protocolError("Vanguard subscribe did not return an unsubscribe function.");
            this.#unsubscribe = unsubscribe;
        }
        catch (error) {
            CLAIMED_VANGUARD_PORTS.delete(this.#vanguard);
            CLAIMED_LEGACY_PORTS.delete(this.#legacy);
            throw error;
        }
    }
    create(input) {
        this.#assertOpen();
        const snapshot = normalizeCreateInput(input);
        const fingerprint = createHash("sha256").update(stableJson(snapshot)).digest("hex");
        const existing = this.#createOperations.get(snapshot.operationId);
        if (existing !== undefined) {
            if (existing.fingerprint !== fingerprint) {
                return Promise.reject(new Error("operationId was already consumed by different create input."));
            }
            return existing.result;
        }
        const result = this.#createOnce(snapshot, fingerprint);
        this.#createOperations.set(snapshot.operationId, { fingerprint, result });
        void result.catch((error) => {
            const settlement = routeArbitrationSettlement(error);
            if (settlement !== undefined) {
                void settlement.then(() => {
                    if (this.#createOperations.get(snapshot.operationId)?.result === result) {
                        this.#createOperations.delete(snapshot.operationId);
                    }
                }, () => { });
            }
            else if (this.#createOperations.get(snapshot.operationId)?.result === result) {
                this.#createOperations.delete(snapshot.operationId);
            }
        });
        return result;
    }
    async #createOnce(input, fingerprint) {
        this.#reserveCapacity();
        const finishStart = this.#trackPendingStart();
        try {
            const policy = this.#rolloutSnapshot(input.actorId, input.optedIn);
            const proposedCore = policy.decision.useVanguard ? "vanguard" : "legacy";
            const claimResult = await this.#routeStoreOperation(this.#routeClaims.claim({
                operationId: input.operationId,
                inputFingerprintSha256: fingerprint,
                proposedCore,
                policySha256: policy.policySha256,
            }));
            const claim = assertRouteClaimResult(claimResult, input.operationId, fingerprint, proposedCore, policy.policySha256);
            const priorReceipt = assertRouteReceipt(await this.#routeStoreOperation(this.#routeClaims.readReceipt(input.operationId)), claim);
            this.#assertOpen();
            const session = this.#newSession(input.actorId, input.operationId, input.legacy, undefined, claim.adapterSessionId, claim.chosenCore);
            if (claim.chosenCore === "legacy") {
                if (!policy.decision.useVanguard) {
                    session.fallbackReason = policy.decision.reason === "kill_switch" ? "kill_switch" : "rollout_ineligible";
                }
                try {
                    await this.#startLegacy(session);
                    await this.#sealRouteReceipt(session, claim, priorReceipt);
                    await this.#assertOpenAfterStart(session);
                }
                catch (error) {
                    if (isAdapterClosedError(error))
                        throw error;
                    return this.#containCreateFailure(session, "legacy_protocol_failure", "Legacy startup failed", error);
                }
                this.#emitRoute(session, session.fallbackReason);
                this.#metric(session, "session_routed", undefined, session.fallbackReason);
                this.#sessions.set(session.id, session);
                return this.#snapshot(session);
            }
            const currentBeforeDispatch = this.#rolloutDecision(input.actorId, input.optedIn);
            if (!currentBeforeDispatch.useVanguard && priorReceipt === undefined) {
                const reason = currentBeforeDispatch.reason === "kill_switch" ? "kill_switch" : "rollout_ineligible";
                this.#uncontainedForeignOperations += 1;
                this.#requireManualRecovery(session, reason);
                this.#sessions.set(session.id, session);
                return this.#snapshot(session);
            }
            try {
                const status = await this.#withForeignDeadline(this.#vanguard.create(input.vanguard, input.operationId), (late) => this.#containLateVanguardStart(session, late));
                assertVanguardStatus(status, "create");
                if (!this.#claimVanguardId(session, status.sessionId)) {
                    this.#uncontainedForeignOperations += 1;
                    this.#requireManualRecovery(session, "vanguard_protocol_failure");
                    this.#sessions.set(session.id, session);
                    return this.#snapshot(session);
                }
                this.#applyVanguardStatus(session, status, "create");
                session.vanguardCursor = 0;
                await this.#sealRouteReceipt(session, claim, priorReceipt);
                await this.#assertOpenAfterStart(session);
                if (!currentBeforeDispatch.useVanguard) {
                    const reason = currentBeforeDispatch.reason === "kill_switch" ? "kill_switch" : "rollout_ineligible";
                    if (!await this.#stopRouteAndWait(session, true))
                        this.#uncontainedForeignOperations += 1;
                    this.#requireManualRecovery(session, reason);
                    this.#sessions.set(session.id, session);
                    return this.#snapshot(session);
                }
                if (status.state !== "idle" || status.materialized) {
                    session.mutationRisk = true;
                    if (!await this.#stopRouteAndWait(session, true))
                        this.#uncontainedForeignOperations += 1;
                    this.#requireManualRecovery(session, "vanguard_protocol_failure");
                    this.#sessions.set(session.id, session);
                    return this.#snapshot(session);
                }
                await this.#withControl(session, () => this.#reconcileVanguardUntilPushesStable(session));
                if (session.route !== "vanguard" || session.mutationRisk || session.state !== "idle") {
                    if (!await this.#stopRouteAndWait(session, true))
                        this.#uncontainedForeignOperations += 1;
                    this.#requireManualRecovery(session, "vanguard_protocol_failure");
                    this.#sessions.set(session.id, session);
                    return this.#snapshot(session);
                }
                await this.#assertOpenAfterStart(session);
                const currentDecision = this.#rolloutDecision(input.actorId, input.optedIn);
                if (!currentDecision.useVanguard) {
                    const reason = currentDecision.reason === "kill_switch" ? "kill_switch" : "rollout_ineligible";
                    if (!await this.#stopRouteAndWait(session, true))
                        this.#uncontainedForeignOperations += 1;
                    this.#requireManualRecovery(session, reason);
                    this.#sessions.set(session.id, session);
                    return this.#snapshot(session);
                }
                this.#emitRoute(session);
                this.#metric(session, "session_routed");
                this.#sessions.set(session.id, session);
                return this.#snapshot(session);
            }
            catch (error) {
                if (isAdapterClosedError(error))
                    throw error;
                const reason = classifyThrownFailure(error, "vanguard_startup_failure");
                return this.#containCreateFailure(session, reason, "Vanguard startup failed", error);
            }
        }
        finally {
            finishStart();
            this.#sessionReservations -= 1;
        }
    }
    async resume(input) {
        this.#assertOpen();
        input = normalizeResumeInput(input);
        this.#reserveCapacity();
        const finishStart = this.#trackPendingStart();
        try {
            const decision = this.#rolloutDecision(input.actorId, input.optedIn);
            const session = this.#newSession(input.actorId, undefined, undefined, input.legacy);
            if (!decision.useVanguard) {
                const reason = decision.reason === "kill_switch" ? "kill_switch" : "rollout_ineligible";
                this.#requireManualRecovery(session, reason);
                this.#sessions.set(session.id, session);
                return this.#snapshot(session);
            }
            try {
                const status = await this.#withForeignDeadline(this.#vanguard.resume(input.vanguardSessionRoot), (late) => this.#containLateVanguardStart(session, late));
                if (status !== null && typeof status === "object"
                    && typeof status.sessionId === "string" && status.sessionId.length > 0) {
                    if (!this.#claimVanguardId(session, status.sessionId)) {
                        this.#requireManualRecovery(session, "vanguard_protocol_failure");
                        this.#sessions.set(session.id, session);
                        return this.#snapshot(session);
                    }
                }
                await this.#assertOpenAfterStart(session);
                this.#applyVanguardStatus(session, status, "resume");
                await this.#withControl(session, () => this.#reconcileVanguardUntilPushesStable(session));
                if (session.route !== "vanguard") {
                    this.#sessions.set(session.id, session);
                    return this.#snapshot(session);
                }
                await this.#assertOpenAfterStart(session);
                const currentDecision = this.#rolloutDecision(input.actorId, input.optedIn);
                if (!currentDecision.useVanguard) {
                    const reason = currentDecision.reason === "kill_switch" ? "kill_switch" : "rollout_ineligible";
                    if (!await this.#stopRouteAndWait(session, true)) {
                        this.#uncontainedForeignOperations += 1;
                        this.#cancelVanguardBestEffort(session);
                    }
                    this.#requireManualRecovery(session, reason);
                    this.#sessions.set(session.id, session);
                    return this.#snapshot(session);
                }
                this.#emitRoute(session);
                this.#metric(session, "session_routed");
                this.#sessions.set(session.id, session);
                return this.#snapshot(session);
            }
            catch (error) {
                if (isAdapterClosedError(error))
                    throw error;
                this.#diagnostic("Vanguard resume failed", error);
                const reason = classifyThrownFailure(error, "vanguard_startup_failure");
                session.mutationRisk = true;
                if (session.vanguardSessionId === undefined) {
                    this.#uncontainedForeignOperations += 1;
                }
                else if (!await this.#stopRouteAndWait(session, true)) {
                    this.#uncontainedForeignOperations += 1;
                    this.#cancelVanguardBestEffort(session);
                }
                this.#requireManualRecovery(session, reason);
                this.#sessions.set(session.id, session);
                return this.#snapshot(session);
            }
        }
        finally {
            finishStart();
            this.#sessionReservations -= 1;
        }
    }
    async send(sessionId, message) {
        this.#assertOpen();
        validateAdvanceMessage(message);
        const session = this.#required(sessionId);
        return this.#withControl(session, async () => {
            this.#assertOpen();
            await this.#enforceKillSwitchFor(session);
            if (session.route === "vanguard" && this.#killSwitchActive()) {
                await this.#enforceKillSwitchFor(session);
            }
            if (session.route === "manual_recovery")
                throw manualRecoveryError();
            if (session.route === "legacy") {
                await this.#invokeLegacy(session, "send", () => this.#legacy.send(requiredLegacyId(session), message), true);
                return this.#snapshot(session);
            }
            if (session.state === "completed") {
                throw new Error("The Vanguard session is completed; create a new session for follow-up work.");
            }
            if (session.state === "running" || session.state === "waiting_for_user" || session.state === "cancelling") {
                throw new Error("The Vanguard session already has an active turn; use steer or wait for it to finish.");
            }
            session.pendingMessage = message;
            session.turnStartedAt = this.#now();
            try {
                const status = this.#vanguard.advance(requiredVanguardId(session), message);
                this.#applyVanguardStatus(session, status, "advance");
                this.#metric(session, "turn_started");
            }
            catch (error) {
                session.pendingMessage = undefined;
                session.turnStartedAt = undefined;
                this.#diagnostic("Vanguard advance failed", error);
                this.#cancelVanguardBestEffort(session);
                this.#requireManualRecovery(session, classifyThrownFailure(error, "vanguard_protocol_failure"));
            }
            return this.#snapshot(session);
        });
    }
    async steer(sessionId, message) {
        this.#assertOpen();
        validateSteeringMessage(message);
        const session = this.#required(sessionId);
        return this.#withControl(session, async () => {
            this.#assertOpen();
            await this.#enforceKillSwitchFor(session);
            if (session.route === "vanguard" && this.#killSwitchActive()) {
                await this.#enforceKillSwitchFor(session);
            }
            if (session.route === "manual_recovery")
                throw manualRecoveryError();
            if (session.route === "legacy") {
                await this.#invokeLegacy(session, "steer", () => this.#legacy.steer(requiredLegacyId(session), message), true);
                return this.#snapshot(session);
            }
            if (session.state !== "running" && session.state !== "waiting_for_user") {
                throw new Error("Steering requires an active Vanguard turn.");
            }
            try {
                const status = this.#vanguard.steer(requiredVanguardId(session), message);
                this.#applyVanguardStatus(session, status, "steer");
            }
            catch (error) {
                if (isNonFatalVanguardControlError(error)) {
                    try {
                        await this.#reconcileVanguard(session);
                    }
                    catch (replayError) {
                        this.#handleIngestionFailure(session, replayError);
                        throw manualRecoveryError();
                    }
                    throw safeControlError(error);
                }
                const reason = classifyThrownFailure(error, "vanguard_protocol_failure");
                const original = session.pendingMessage;
                await this.#fallback(session, reason, original);
            }
            return this.#snapshot(session);
        });
    }
    async interrupt(sessionId) {
        this.#assertOpen();
        const session = this.#required(sessionId);
        return this.#withControl(session, async () => {
            this.#assertOpen();
            if (session.route === "manual_recovery")
                throw manualRecoveryError();
            if (session.route === "legacy") {
                await this.#invokeLegacy(session, "interrupt", () => this.#legacy.interrupt(requiredLegacyId(session)), true);
                return this.#snapshot(session);
            }
            if (session.state !== "running" && session.state !== "waiting_for_user" && session.state !== "cancelling") {
                return this.#snapshot(session);
            }
            try {
                const status = this.#vanguard.cancel(requiredVanguardId(session));
                this.#applyVanguardStatus(session, status, "cancel");
            }
            catch (error) {
                this.#diagnostic("Vanguard interrupt failed", error);
                this.#requireManualRecovery(session, classifyThrownFailure(error, "vanguard_protocol_failure"));
            }
            return this.#snapshot(session);
        });
    }
    async status(sessionId) {
        this.#assertOpen();
        const session = this.#required(sessionId);
        return this.#withControl(session, async () => {
            this.#assertOpen();
            await this.#enforceKillSwitchFor(session);
            if (session.route === "vanguard") {
                try {
                    const status = this.#vanguard.status(requiredVanguardId(session));
                    this.#applyVanguardStatus(session, status, "status");
                }
                catch (error) {
                    this.#diagnostic("Vanguard status failed", error);
                    session.mutationRisk = true;
                    this.#cancelVanguardBestEffort(session);
                    this.#requireManualRecovery(session, classifyThrownFailure(error, "vanguard_protocol_failure"));
                }
            }
            else if (session.route === "legacy") {
                await this.#invokeLegacy(session, "status", () => this.#legacy.status(requiredLegacyId(session)), false);
            }
            return this.#snapshot(session);
        });
    }
    async events(sessionId, afterCursor = 0, limit = 500) {
        this.#assertOpen();
        if (!Number.isSafeInteger(afterCursor) || afterCursor < 0)
            throw new Error("afterCursor must be non-negative.");
        const boundedLimit = boundedInteger(limit, 1, 2_000, "limit");
        const session = this.#required(sessionId);
        return this.#withControl(session, async () => {
            this.#assertOpen();
            await this.#enforceKillSwitchFor(session);
            try {
                if (session.route === "vanguard")
                    await this.#reconcileVanguard(session);
                else if (session.route === "legacy")
                    await this.#reconcileLegacy(session);
            }
            catch (error) {
                if (session.route === "vanguard") {
                    this.#diagnostic("Vanguard replay failed", error);
                    this.#requireManualRecovery(session, classifyThrownFailure(error, "vanguard_protocol_failure"));
                }
                else {
                    throw error;
                }
            }
            const available = session.events.filter((event) => event.cursor > afterCursor);
            return deepFreeze({
                sessionId,
                events: available.slice(0, boundedLimit),
                afterCursor,
                latestCursor: session.nextCursor - 1,
                replayFloorCursor: session.replayFloorCursor,
                gap: afterCursor < session.replayFloorCursor - 1,
                hasMore: available.length > boundedLimit,
            });
        });
    }
    subscribe(listener) {
        this.#assertOpen();
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    async enforceKillSwitch() {
        this.#assertOpen();
        if (!this.#killSwitchActive()) {
            return { complete: true, unresolvedStarts: 0, unresolvedSessions: 0, unresolvedForeignOperations: 0 };
        }
        const unresolvedStarts = await unsettledAfter([...this.#pendingStarts], this.#barrierTimeoutMs);
        let rejectedBarriers = 0;
        const barriers = [...this.#sessions.values()].map((session) => (this.#withControl(session, async () => {
            this.#assertOpen();
            await this.#enforceKillSwitchFor(session);
        }).catch(() => { rejectedBarriers += 1; })));
        const unresolvedSessions = await unsettledAfter(barriers, this.#barrierTimeoutMs) + rejectedBarriers;
        const unresolvedForeignOperations = await this.#settleUncertainForeignOperations();
        return {
            complete: unresolvedStarts === 0 && unresolvedSessions === 0 && unresolvedForeignOperations === 0,
            unresolvedStarts,
            unresolvedSessions,
            unresolvedForeignOperations,
        };
    }
    shutdown() {
        if (this.#shutdownInFlight !== undefined)
            return this.#shutdownInFlight;
        const attempt = this.#performShutdown();
        this.#shutdownInFlight = attempt;
        void attempt.then((report) => {
            if (report.complete)
                this.#releasePortClaims();
            else if (this.#shutdownInFlight === attempt)
                this.#shutdownInFlight = undefined;
        }, () => {
            if (this.#shutdownInFlight === attempt)
                this.#shutdownInFlight = undefined;
        });
        return attempt;
    }
    async #performShutdown() {
        this.#closed = true;
        if (!this.#unsubscribed) {
            this.#unsubscribed = true;
            try {
                this.#unsubscribe();
            }
            catch (error) {
                this.#diagnostic("Vanguard unsubscribe failed", error);
            }
        }
        const unresolvedStarts = await unsettledAfter([...this.#pendingStarts], this.#barrierTimeoutMs);
        let rejectedStops = 0;
        const stops = [...this.#sessions.values()].map((session) => (this.#stopSessionForShutdown(session).catch(() => { rejectedStops += 1; })));
        const unresolvedSessions = await unsettledAfter(stops, this.#barrierTimeoutMs) + rejectedStops;
        const unresolvedForeignOperations = await this.#settleUncertainForeignOperations();
        this.#listeners.clear();
        return {
            complete: unresolvedStarts === 0 && unresolvedSessions === 0 && unresolvedForeignOperations === 0,
            unresolvedStarts,
            unresolvedSessions,
            unresolvedForeignOperations,
        };
    }
    #releasePortClaims() {
        if (this.#portsReleased)
            return;
        this.#portsReleased = true;
        CLAIMED_VANGUARD_PORTS.delete(this.#vanguard);
        CLAIMED_LEGACY_PORTS.delete(this.#legacy);
    }
    async #stopSessionForShutdown(session) {
        const initiallyRequiresStop = this.#routeMayOwnLiveWorker(session);
        const [initial] = await Promise.allSettled([this.#stopRouteAndWait(session), session.stateTail]);
        if (initiallyRequiresStop && (initial.status === "rejected" || !initial.value)) {
            throw new Error("Initial shutdown interrupt was not acknowledged.");
        }
        const finallyRequiresStop = this.#routeMayOwnLiveWorker(session);
        const final = await this.#stopRouteAndWait(session);
        if (finallyRequiresStop && !final)
            throw new Error("Final shutdown interrupt was not acknowledged.");
    }
    async #settleUncertainForeignOperations() {
        const deadline = Date.now() + this.#barrierTimeoutMs;
        while (this.#uncertainForeignOperations.size > 0 && Date.now() < deadline) {
            await unsettledAfter([...this.#uncertainForeignOperations], remainingMs(deadline));
            await Promise.resolve();
            if (this.#uncertainForeignOperations.size === 0)
                return this.#uncontainedForeignOperations;
        }
        return this.#uncertainForeignOperations.size + this.#uncontainedForeignOperations;
    }
    async #awaitStopReceipt(invoke, sessionId, workerGeneration, ownerEpoch, deadline) {
        if (Date.now() >= deadline)
            throw new Error("Worker-stop barrier exceeded its total deadline.");
        const timeoutMs = remainingMs(deadline);
        const operation = invoke(timeoutMs);
        const receipt = await this.#withForeignDeadline(operation, (late) => assertWorkerStopReceipt(late, sessionId, workerGeneration, ownerEpoch), timeoutMs);
        assertWorkerStopReceipt(receipt, sessionId, workerGeneration, ownerEpoch);
    }
    #trackLateStopReceipt(invoke, sessionId, workerGeneration, ownerEpoch, context) {
        let operation;
        try {
            operation = invoke(this.#barrierTimeoutMs);
        }
        catch (error) {
            this.#uncontainedForeignOperations += 1;
            this.#diagnostic(`${context} stop dispatch failed`, error);
            return;
        }
        this.#uncertainForeignOperations.add(operation);
        void operation.then((receipt) => {
            this.#uncertainForeignOperations.delete(operation);
            try {
                assertWorkerStopReceipt(receipt, sessionId, workerGeneration, ownerEpoch);
            }
            catch (error) {
                this.#uncontainedForeignOperations += 1;
                this.#diagnostic(`${context} did not produce a valid stop receipt`, error);
            }
        }, (error) => {
            this.#uncertainForeignOperations.delete(operation);
            this.#uncontainedForeignOperations += 1;
            this.#diagnostic(`${context} stop failed`, error);
        });
    }
    async #stopRouteAndWait(session, requireLifecycleReceipt = false) {
        const deadline = Date.now() + this.#barrierTimeoutMs;
        if (session.route === "manual_recovery") {
            const stops = [];
            if (session.vanguardSessionId !== undefined
                && (requireLifecycleReceipt || session.vanguardWorkerActive !== false)) {
                const fence = this.#requiredVanguardFence(session);
                stops.push((async () => {
                    await this.#awaitStopReceipt((timeoutMs) => this.#vanguard.stopAndWait(session.vanguardSessionId, timeoutMs), session.vanguardSessionId, fence.workerGeneration, fence.ownerEpoch, deadline);
                    this.#markVanguardWorkerStopped(session, fence);
                })());
            }
            if (session.legacySessionId !== undefined
                && (requireLifecycleReceipt || session.legacyWorkerActive !== false)) {
                const fence = this.#requiredLegacyFence(session);
                stops.push((async () => {
                    await this.#awaitStopReceipt((timeoutMs) => this.#legacy.stopAndWait(session.legacySessionId, timeoutMs), session.legacySessionId, fence.workerGeneration, fence.ownerEpoch, deadline);
                    this.#markLegacyWorkerStopped(session, fence);
                })());
            }
            if (stops.length === 0)
                return true;
            const settled = await Promise.allSettled(stops);
            return settled.every((result) => result.status === "fulfilled");
        }
        if (session.route === "vanguard") {
            if (session.vanguardSessionId === undefined)
                return !requireLifecycleReceipt;
            if (!requireLifecycleReceipt && session.vanguardWorkerActive === false)
                return true;
            try {
                const sessionId = requiredVanguardId(session);
                const fence = this.#requiredVanguardFence(session);
                await this.#awaitStopReceipt((timeoutMs) => this.#vanguard.stopAndWait(sessionId, timeoutMs), sessionId, fence.workerGeneration, fence.ownerEpoch, deadline);
                this.#markVanguardWorkerStopped(session, fence);
                return true;
            }
            catch {
                return false;
            }
        }
        else if (session.route === "legacy") {
            if (session.legacySessionId === undefined)
                return !requireLifecycleReceipt;
            if (!requireLifecycleReceipt && session.legacyWorkerActive === false)
                return true;
            try {
                const sessionId = requiredLegacyId(session);
                const fence = this.#requiredLegacyFence(session);
                await this.#awaitStopReceipt((timeoutMs) => this.#legacy.stopAndWait(sessionId, timeoutMs), sessionId, fence.workerGeneration, fence.ownerEpoch, deadline);
                this.#markLegacyWorkerStopped(session, fence);
                return true;
            }
            catch {
                return false;
            }
        }
        return false;
    }
    #routeMayOwnLiveWorker(session) {
        if (session.route === "vanguard") {
            return session.vanguardSessionId !== undefined && session.vanguardWorkerActive !== false;
        }
        if (session.route === "legacy") {
            return session.legacySessionId !== undefined && session.legacyWorkerActive !== false;
        }
        return (session.vanguardSessionId !== undefined && session.vanguardWorkerActive !== false)
            || (session.legacySessionId !== undefined && session.legacyWorkerActive !== false);
    }
    #markVanguardWorkerStopped(session, fence) {
        if (session.vanguardWorkerGeneration === fence.workerGeneration
            && session.vanguardOwnerEpoch === fence.ownerEpoch) {
            session.vanguardWorkerActive = false;
        }
    }
    #markLegacyWorkerStopped(session, fence) {
        if (session.legacyWorkerGeneration === fence.workerGeneration
            && session.legacyOwnerEpoch === fence.ownerEpoch) {
            session.legacyWorkerActive = false;
        }
    }
    #acceptVanguardPush(envelope) {
        if (envelope === null || typeof envelope !== "object" || typeof envelope.sessionId !== "string") {
            this.#diagnostic("Vanguard pushed an invalid envelope", protocolError("invalid envelope"));
            return;
        }
        const session = this.#byVanguardId.get(envelope.sessionId);
        if (session === undefined || this.#closed)
            return;
        session.pushGeneration += 1;
        if (session.pendingPushEvents >= this.#maxPendingPushEvents) {
            if (!session.pushReconcileScheduled) {
                session.pushReconcileScheduled = true;
                session.stateTail = session.stateTail
                    .then(() => this.#reconcileVanguardUntilPushesStable(session))
                    .catch((error) => this.#handleIngestionFailure(session, error))
                    .finally(() => { session.pushReconcileScheduled = false; });
            }
            return;
        }
        session.pendingPushEvents += 1;
        session.stateTail = session.stateTail
            .then(() => this.#ingestVanguardEnvelope(session, envelope))
            .catch((error) => this.#handleIngestionFailure(session, error))
            .finally(() => { session.pendingPushEvents -= 1; });
    }
    async #ingestVanguardEnvelope(session, envelope) {
        assertVanguardEnvelope(envelope, requiredVanguardId(session));
        if (envelope.cursor <= session.vanguardCursor)
            return;
        if (envelope.cursor > session.vanguardCursor + 1)
            await this.#reconcileVanguard(session);
        if (envelope.cursor <= session.vanguardCursor)
            return;
        if (envelope.cursor > session.vanguardCursor + 1) {
            this.#emitReplayGap(session, session.vanguardCursor, envelope.cursor);
            throw protocolError("Vanguard push history contains a cursor gap.");
        }
        await this.#ingestOneVanguard(session, envelope);
    }
    async #reconcileVanguard(session) {
        const vanguardId = requiredVanguardId(session);
        let pages = 0;
        while (pages < 100) {
            const page = this.#vanguard.events(vanguardId, session.vanguardCursor, 500);
            assertVanguardPage(page, vanguardId, session.vanguardCursor);
            if (page.gap) {
                this.#emitReplayGap(session, session.vanguardCursor, page.replayFloorCursor);
                throw protocolError("Vanguard replay history contains a gap.");
            }
            for (const envelope of page.events) {
                if (envelope.cursor <= session.vanguardCursor)
                    continue;
                if (envelope.cursor > session.vanguardCursor + 1) {
                    this.#emitReplayGap(session, session.vanguardCursor, envelope.cursor);
                    throw protocolError("Vanguard replay history contains a cursor gap.");
                }
                await this.#ingestOneVanguard(session, envelope);
            }
            pages += 1;
            if (!page.hasMore)
                break;
        }
        if (pages === 100) {
            const page = this.#vanguard.events(vanguardId, session.vanguardCursor, 1);
            assertVanguardPage(page, vanguardId, session.vanguardCursor);
            if (page.hasMore || page.events.length > 0) {
                throw protocolError("Vanguard replay exceeded the bounded 100-page reconciliation window.");
            }
        }
    }
    async #reconcileVanguardUntilPushesStable(session) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const generation = session.pushGeneration;
            await this.#reconcileVanguard(session);
            await Promise.resolve();
            if (session.pushGeneration === generation)
                return;
        }
        throw protocolError("Vanguard push ingress remained unstable during bounded replay reconciliation.");
    }
    async #ingestOneVanguard(session, envelope) {
        session.vanguardCursor = envelope.cursor;
        const publicEvent = sanitizePublicEvent(envelope.event);
        if (publicEvent.type === "tool.started")
            session.mutationRisk = true;
        const mapped = mapVanguardEvent(session.id, envelope.cursor, publicEvent);
        this.#record(session, mapped);
        if (session.route !== "vanguard")
            return;
        if (publicEvent.type === "run.waiting_for_user")
            session.state = "waiting_for_user";
        else if (publicEvent.type === "run.completed") {
            session.state = "completed";
            this.#metric(session, "turn_completed", "success");
            session.pendingMessage = undefined;
            session.turnStartedAt = undefined;
        }
        else if (publicEvent.type === "run.failed") {
            session.state = "failed";
            this.#metric(session, "turn_failed", "failure", "vanguard_critical_failure");
            if (session.pendingMessage !== undefined)
                await this.#fallback(session, "vanguard_critical_failure", session.pendingMessage);
        }
    }
    async #reconcileLegacy(session) {
        try {
            await this.#reconcileLegacyUnchecked(session);
        }
        catch (error) {
            if (session.route === "legacy") {
                this.#requireManualRecovery(session, "legacy_protocol_failure");
            }
            throw error;
        }
    }
    async #reconcileLegacyUnchecked(session) {
        const redact = createSecretRedactor();
        const deadline = Date.now() + this.#foreignOperationTimeoutMs;
        let pages = 0;
        while (pages < 100) {
            if (Date.now() >= deadline)
                throw protocolError("Legacy replay exceeded its total deadline.");
            const page = await this.#withForeignDeadline(this.#legacy.events(requiredLegacyId(session), session.legacyCursor, 500), undefined, remainingMs(deadline), false);
            assertLegacyPage(page, session.legacyCursor);
            if (page.gap) {
                this.#emitReplayGap(session, session.legacyCursor, page.replayFloorCursor);
                throw protocolError("Legacy replay history contains a gap.");
            }
            for (const event of page.events) {
                if (event.cursor <= session.legacyCursor)
                    continue;
                if (event.cursor > session.legacyCursor + 1) {
                    this.#emitReplayGap(session, session.legacyCursor, event.cursor);
                    throw protocolError("Legacy replay history contains a cursor gap.");
                }
                session.legacyCursor = event.cursor;
                this.#record(session, {
                    version: 1,
                    sessionId: session.id,
                    cursor: 0,
                    source: "legacy",
                    kind: event.kind,
                    status: event.status ?? "info",
                    upstreamCursor: event.cursor,
                    ...(event.title === undefined ? {} : { title: bounded(redact(event.title), 300) }),
                    ...(event.message === undefined ? {} : { message: bounded(redact(event.message), 8_000) }),
                    ...(event.detail === undefined ? {} : { detail: bounded(redact(event.detail), 2_000) }),
                    ...(event.tool === undefined ? {} : { tool: bounded(redact(event.tool), 200) }),
                });
            }
            pages += 1;
            if (!page.hasMore)
                break;
        }
        if (pages === 100) {
            if (Date.now() >= deadline)
                throw protocolError("Legacy replay exceeded its total deadline.");
            const page = await this.#withForeignDeadline(this.#legacy.events(requiredLegacyId(session), session.legacyCursor, 1), undefined, remainingMs(deadline), false);
            assertLegacyPage(page, session.legacyCursor);
            if (page.hasMore || page.events.length > 0) {
                throw protocolError("Legacy replay exceeded the bounded 100-page reconciliation window.");
            }
        }
    }
    async #fallback(session, reason, message) {
        if (session.recoveryInFlight !== undefined)
            return session.recoveryInFlight;
        session.recoveryInFlight = this.#performFallback(session, reason, message).finally(() => {
            session.recoveryInFlight = undefined;
        });
        return session.recoveryInFlight;
    }
    async #performFallback(session, reason, message) {
        session.fallbackReason = reason;
        if (session.vanguardSessionId !== undefined || session.mutationRisk) {
            this.#cancelVanguardBestEffort(session);
            this.#requireManualRecovery(session, reason);
            return;
        }
        this.#metric(session, "fallback_started", undefined, reason);
        try {
            await this.#startLegacy(session);
            await this.#assertOpenAfterStart(session);
            this.#emitRoute(session, reason);
            if (message !== undefined) {
                const status = await this.#legacy.send(requiredLegacyId(session), message);
                this.#applyLegacyStatus(session, status);
                await this.#reconcileLegacy(session);
            }
            session.pendingMessage = undefined;
            this.#metric(session, "fallback_completed", "success", reason);
        }
        catch (error) {
            this.#diagnostic("Legacy fallback failed", error);
            this.#requireManualRecovery(session, reason);
        }
    }
    async #enforceKillSwitchFor(session) {
        if (!this.#killSwitchActive())
            return;
        if (session.route === "manual_recovery") {
            if ((session.vanguardSessionId !== undefined || session.legacySessionId !== undefined)
                && !await this.#stopRouteAndWait(session)) {
                throw new Error("Kill-switch worker stop was not proven.");
            }
            return;
        }
        if (session.route !== "vanguard")
            return;
        const requiresStop = session.vanguardSessionId !== undefined;
        session.fallbackReason = "kill_switch";
        this.#metric(session, "kill_switch_applied", undefined, "kill_switch");
        await this.#fallback(session, "kill_switch", session.pendingMessage);
        if (requiresStop && !await this.#stopRouteAndWait(session)) {
            throw new Error("Kill-switch worker stop was not proven.");
        }
    }
    async #startLegacy(session) {
        const operation = session.legacyResume !== undefined
            ? this.#legacy.resume(session.legacyResume)
            : this.#legacy.create(requiredLegacyCreate(session), requiredOperationId(session));
        const status = await this.#withForeignDeadline(operation, (late) => this.#containLateLegacyStart(session, late));
        assertLegacyStatus(status);
        const existing = this.#byLegacyId.get(status.sessionId);
        if (existing !== undefined && existing !== session) {
            this.#poisonIdentityCollision(existing, "legacy", status.sessionId, "Legacy core returned a duplicate session identity");
            throw protocolError("Legacy core returned a session ID already owned by another adapter session.");
        }
        session.route = "legacy";
        session.legacySessionId = status.sessionId;
        this.#byLegacyId.set(status.sessionId, session);
        session.state = status.state;
        session.legacyWorkerActive = status.workerActive;
        session.legacyWorkerGeneration = status.workerGeneration;
        session.legacyOwnerEpoch = status.ownerEpoch;
        session.legacyCursor = 0;
    }
    async #sealRouteReceipt(session, claim, priorReceipt) {
        const source = claim.chosenCore;
        const upstreamSessionId = source === "vanguard"
            ? requiredVanguardId(session)
            : requiredLegacyId(session);
        if (priorReceipt !== undefined && priorReceipt.upstreamSessionId !== upstreamSessionId) {
            this.#uncontainedForeignOperations += 1;
            throw protocolError("A durable route receipt conflicts with the keyed core response.");
        }
        const commitOperation = this.#routeClaims.commitReceipt({
            operationId: requiredOperationId(session),
            source,
            upstreamSessionId,
        });
        let committed;
        try {
            committed = await this.#routeStoreOperation(commitOperation);
        }
        catch (error) {
            if (isDurableIdentityConflict(error)) {
                this.#uncontainedForeignOperations += 1;
            }
            else if (routeArbitrationSettlement(error) !== undefined) {
                const audited = commitOperation.then((late) => { assertRouteReceiptResult(late, claim, upstreamSessionId); }, (lateError) => {
                    if (isDurableIdentityConflict(lateError))
                        throw lateError;
                }).catch((auditError) => {
                    this.#uncontainedForeignOperations += 1;
                    throw auditError;
                });
                ROUTE_ARBITRATION_SETTLEMENTS.set(error, audited);
                void audited.catch(() => { });
            }
            throw error;
        }
        try {
            assertRouteReceiptResult(committed, claim, upstreamSessionId);
        }
        catch (error) {
            this.#uncontainedForeignOperations += 1;
            throw error;
        }
    }
    async #containCreateFailure(session, reason, context, error) {
        this.#diagnostic(context, error);
        const hasKnownWorker = session.vanguardSessionId !== undefined || session.legacySessionId !== undefined;
        if (hasKnownWorker) {
            if (!await this.#stopRouteAndWait(session, true))
                this.#uncontainedForeignOperations += 1;
        }
        else {
            this.#uncontainedForeignOperations += 1;
        }
        if (this.#closed)
            throw adapterClosedError();
        session.mutationRisk ||= hasKnownWorker;
        this.#requireManualRecovery(session, reason);
        this.#sessions.set(session.id, session);
        return this.#snapshot(session);
    }
    async #assertOpenAfterStart(session) {
        if (!this.#closed)
            return;
        if (!await this.#stopRouteAndWait(session, true))
            this.#uncontainedForeignOperations += 1;
        throw adapterClosedError();
    }
    #cancelVanguardBestEffort(session) {
        if (session.vanguardSessionId === undefined)
            return;
        try {
            this.#vanguard.cancel(session.vanguardSessionId);
        }
        catch {
        }
    }
    #requireManualRecovery(session, reason) {
        session.route = "manual_recovery";
        session.state = "manual_recovery";
        session.fallbackReason = reason;
        session.pendingMessage = undefined;
        this.#record(session, {
            version: 1,
            sessionId: session.id,
            cursor: 0,
            source: "adapter",
            kind: "turn.failed",
            status: "failed",
            title: "Manual recovery required",
            detail: "An engine may have crossed a mutation or dispatch boundary; automatic replay was blocked.",
        });
        this.#metric(session, "manual_recovery_required", "failure", reason);
    }
    #emitReplayGap(session, requestedAfterCursor, availableFromCursor) {
        session.mutationRisk = true;
        this.#record(session, {
            version: 1,
            sessionId: session.id,
            cursor: 0,
            source: "adapter",
            kind: "replay.gap",
            status: "failed",
            title: "Event replay gap",
            detail: "Some upstream events are no longer available.",
            replay: { requestedAfterCursor, availableFromCursor },
        });
        this.#metric(session, "replay_gap", "failure", "vanguard_critical_failure", "replay_gap");
        if (session.route === "vanguard") {
            this.#cancelVanguardBestEffort(session);
            this.#requireManualRecovery(session, "vanguard_protocol_failure");
        }
    }
    #claimVanguardId(session, sessionId) {
        const existing = this.#byVanguardId.get(sessionId);
        if (existing !== undefined && existing !== session) {
            this.#poisonIdentityCollision(existing, "vanguard", sessionId, "Vanguard returned a duplicate session identity");
            return false;
        }
        session.route = "vanguard";
        session.vanguardSessionId = sessionId;
        this.#byVanguardId.set(sessionId, session);
        return true;
    }
    #containLateVanguardStart(session, status) {
        try {
            assertVanguardStatus(status, "late create/resume");
            const existing = this.#byVanguardId.get(status.sessionId);
            if (existing !== undefined && existing !== session) {
                this.#poisonIdentityCollision(existing, "vanguard", status.sessionId, "Late Vanguard start returned a duplicate session identity");
                return;
            }
            session.vanguardSessionId = status.sessionId;
            this.#byVanguardId.set(status.sessionId, session);
            session.vanguardWorkerGeneration = status.workerGeneration;
            session.vanguardOwnerEpoch = status.ownerEpoch;
            session.vanguardWorkerActive = status.workerActive;
            this.#trackLateStopReceipt((timeoutMs) => this.#vanguard.stopAndWait(status.sessionId, timeoutMs), status.sessionId, status.workerGeneration, status.ownerEpoch, "Late Vanguard start");
        }
        catch (error) {
            this.#uncontainedForeignOperations += 1;
            this.#diagnostic("Late Vanguard start could not be contained", error);
        }
    }
    #containLateLegacyStart(session, status) {
        try {
            assertLegacyStatus(status);
            const existing = this.#byLegacyId.get(status.sessionId);
            if (existing !== undefined && existing !== session) {
                this.#poisonIdentityCollision(existing, "legacy", status.sessionId, "Late legacy start returned a duplicate session identity");
                return;
            }
            session.legacySessionId = status.sessionId;
            this.#byLegacyId.set(status.sessionId, session);
            session.legacyWorkerGeneration = status.workerGeneration;
            session.legacyOwnerEpoch = status.ownerEpoch;
            session.legacyWorkerActive = status.workerActive;
            this.#trackLateStopReceipt((timeoutMs) => this.#legacy.stopAndWait(status.sessionId, timeoutMs), status.sessionId, status.workerGeneration, status.ownerEpoch, "Late legacy start");
        }
        catch (error) {
            this.#uncontainedForeignOperations += 1;
            this.#diagnostic("Late legacy start could not be contained", error);
        }
    }
    #poisonIdentityCollision(existing, provider, sessionId, context) {
        this.#uncontainedForeignOperations += 1;
        existing.mutationRisk = true;
        this.#requireManualRecovery(existing, provider === "vanguard"
            ? "vanguard_protocol_failure"
            : "legacy_protocol_failure");
        const fence = provider === "vanguard"
            ? this.#requiredVanguardFence(existing)
            : this.#requiredLegacyFence(existing);
        this.#trackLateStopReceipt(provider === "vanguard"
            ? (timeoutMs) => this.#vanguard.stopAndWait(sessionId, timeoutMs)
            : (timeoutMs) => this.#legacy.stopAndWait(sessionId, timeoutMs), sessionId, fence.workerGeneration, fence.ownerEpoch, context);
    }
    #emitRoute(session, reason) {
        this.#record(session, {
            version: 1,
            sessionId: session.id,
            cursor: 0,
            source: "adapter",
            kind: "route.changed",
            status: "info",
            title: session.route === "vanguard" ? "Vanguard selected" : "Legacy core selected",
            ...(reason === undefined ? {} : { detail: safeReasonText(reason) }),
        });
    }
    #record(session, event) {
        const finalized = deepFreeze({ ...event, cursor: session.nextCursor });
        session.nextCursor += 1;
        session.events.push(finalized);
        while (session.events.length > this.#maxReplayEvents)
            session.events.shift();
        session.replayFloorCursor = session.events[0]?.cursor ?? session.nextCursor;
        for (const listener of this.#listeners) {
            try {
                listener(finalized);
            }
            catch (error) {
                this.#diagnostic("Ares adapter listener failed", error);
            }
        }
    }
    #metric(session, name, outcome, fallbackReason, explicitReason) {
        try {
            this.#telemetry?.emit({
                name,
                actorId: session.actorId,
                sessionId: session.id,
                route: session.route,
                ...(outcome === undefined ? {} : { outcome }),
                ...(explicitReason === undefined && fallbackReason === undefined
                    ? {}
                    : { reason: explicitReason ?? FALLBACK_REASON_TELEMETRY[fallbackReason] }),
                ...(session.turnStartedAt === undefined ? {} : { durationMs: this.#now() - session.turnStartedAt }),
            });
        }
        catch (error) {
            this.#diagnostic("Ares beta telemetry failed", error);
        }
    }
    #applyLegacyStatus(session, status) {
        assertLegacyStatus(status, requiredLegacyId(session));
        session.state = status.state;
        session.legacyWorkerActive = status.workerActive;
        session.legacyWorkerGeneration = status.workerGeneration;
        session.legacyOwnerEpoch = status.ownerEpoch;
    }
    #applyVanguardStatus(session, status, operation) {
        assertVanguardStatus(status, operation, requiredVanguardId(session));
        session.state = mapVanguardState(status.state);
        session.vanguardWorkerActive = status.workerActive;
        session.vanguardWorkerGeneration = status.workerGeneration;
        session.vanguardOwnerEpoch = status.ownerEpoch;
    }
    #requiredVanguardFence(session) {
        if (session.vanguardWorkerGeneration === undefined || session.vanguardOwnerEpoch === undefined) {
            throw protocolError("Vanguard worker fence is unavailable.");
        }
        return { workerGeneration: session.vanguardWorkerGeneration, ownerEpoch: session.vanguardOwnerEpoch };
    }
    #requiredLegacyFence(session) {
        if (session.legacyWorkerGeneration === undefined || session.legacyOwnerEpoch === undefined) {
            throw protocolError("Legacy worker fence is unavailable.");
        }
        return { workerGeneration: session.legacyWorkerGeneration, ownerEpoch: session.legacyOwnerEpoch };
    }
    async #invokeLegacy(session, operation, invoke, reconcile) {
        try {
            this.#applyLegacyStatus(session, await this.#withForeignDeadline(invoke(), reconcile ? (late) => this.#containLateLegacyControl(session, late, operation) : undefined, this.#foreignOperationTimeoutMs, reconcile));
            if (reconcile)
                await this.#reconcileLegacy(session);
        }
        catch (error) {
            this.#diagnostic(`Legacy ${operation} failed`, error);
            if (session.route === "legacy")
                this.#requireManualRecovery(session, "legacy_protocol_failure");
            throw manualRecoveryError();
        }
    }
    #containLateLegacyControl(session, status, operation) {
        assertLegacyStatus(status, requiredLegacyId(session));
        this.#trackLateStopReceipt((timeoutMs) => this.#legacy.stopAndWait(status.sessionId, timeoutMs), status.sessionId, status.workerGeneration, status.ownerEpoch, `Late legacy ${operation}`);
    }
    async #routeStoreOperation(operation) {
        try {
            return await this.#withForeignDeadline(operation, undefined, this.#foreignOperationTimeoutMs, false);
        }
        catch (error) {
            if (isForeignOperationTimeout(error)) {
                const tagged = Object.assign(new Error("Durable route arbitration exceeded its deadline."), {
                    code: "route_arbitration_pending",
                });
                ROUTE_ARBITRATION_SETTLEMENTS.set(tagged, operation.then(() => undefined, () => undefined));
                throw tagged;
            }
            throw error;
        }
    }
    #withForeignDeadline(promise, onLate, timeoutMs = this.#foreignOperationTimeoutMs, dispatchUncertain = true) {
        return new Promise((resolve, reject) => {
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                this.#uncertainForeignOperations.add(promise);
                reject(Object.assign(new Error("Foreign operation exceeded its deadline."), {
                    code: "foreign_operation_timeout",
                }));
            }, timeoutMs);
            promise.then((value) => {
                if (timedOut) {
                    this.#uncertainForeignOperations.delete(promise);
                    if (onLate === undefined && dispatchUncertain)
                        this.#uncontainedForeignOperations += 1;
                    else {
                        try {
                            onLate?.(value);
                        }
                        catch {
                            this.#uncontainedForeignOperations += 1;
                        }
                    }
                    return;
                }
                clearTimeout(timer);
                resolve(value);
            }, (error) => {
                if (timedOut) {
                    this.#uncertainForeignOperations.delete(promise);
                    if (dispatchUncertain)
                        this.#uncontainedForeignOperations += 1;
                    return;
                }
                clearTimeout(timer);
                reject(error);
            });
        });
    }
    #snapshot(session) {
        return deepFreeze({
            sessionId: session.id,
            route: session.route,
            state: session.state,
            latestCursor: session.nextCursor - 1,
            replayFloorCursor: session.replayFloorCursor,
            ...(session.fallbackReason === undefined ? {} : { fallbackReason: session.fallbackReason }),
            requiresManualRecovery: session.route === "manual_recovery",
        });
    }
    #newSession(actorId, operationId, legacyCreate, legacyResume, sessionId = `ares-vanguard-${randomUUID()}`, initialRoute = "legacy") {
        return {
            id: sessionId,
            actorId,
            operationId,
            route: initialRoute,
            state: "idle",
            events: [],
            nextCursor: 1,
            replayFloorCursor: 1,
            ...(legacyCreate === undefined ? {} : { legacyCreate }),
            ...(legacyResume === undefined ? {} : { legacyResume }),
            vanguardCursor: 0,
            legacyCursor: 0,
            vanguardWorkerGeneration: undefined,
            vanguardOwnerEpoch: undefined,
            vanguardWorkerActive: undefined,
            legacyWorkerGeneration: undefined,
            legacyOwnerEpoch: undefined,
            legacyWorkerActive: undefined,
            mutationRisk: false,
            vanguardSessionId: undefined,
            legacySessionId: undefined,
            pendingMessage: undefined,
            turnStartedAt: undefined,
            fallbackReason: undefined,
            recoveryInFlight: undefined,
            stateTail: Promise.resolve(),
            pendingPushEvents: 0,
            pushReconcileScheduled: false,
            pushGeneration: 0,
        };
    }
    async #withControl(session, operation) {
        const admitted = session.stateTail.then(operation);
        session.stateTail = admitted.then(() => undefined, () => undefined);
        return admitted;
    }
    #rolloutDecision(actorId, optedIn) {
        try {
            if (typeof optedIn !== "boolean")
                throw new Error("optedIn must be a boolean.");
            return decideAresVanguardRollout(this.#rollout(), actorId, optedIn);
        }
        catch (error) {
            this.#diagnostic("Vanguard rollout config was unavailable", error);
            return { useVanguard: false, reason: "disabled", bucket: 0 };
        }
    }
    #rolloutSnapshot(actorId, optedIn) {
        try {
            const config = normalizeRolloutSnapshot(this.#rollout());
            return {
                decision: decideAresVanguardRollout(config, actorId, optedIn),
                policySha256: createHash("sha256")
                    .update("VANGUARD_ARES_ROLLOUT_POLICY_V1\n")
                    .update(stableJson(config))
                    .digest("hex"),
            };
        }
        catch (error) {
            this.#diagnostic("Vanguard rollout config was unavailable", error);
            return {
                decision: { useVanguard: false, reason: "disabled", bucket: 0 },
                policySha256: INVALID_ROLLOUT_POLICY_SHA256,
            };
        }
    }
    #killSwitchActive() {
        try {
            const config = this.#rollout();
            decideAresVanguardRollout(config, "control-plane-probe", false);
            return config.killSwitch;
        }
        catch (error) {
            this.#diagnostic("Vanguard rollout config was unavailable", error);
            return true;
        }
    }
    #handleIngestionFailure(session, error) {
        this.#diagnostic("Vanguard event ingestion failed", error);
        if (session.route === "vanguard") {
            session.mutationRisk = true;
            this.#cancelVanguardBestEffort(session);
            this.#requireManualRecovery(session, classifyThrownFailure(error, "vanguard_protocol_failure"));
        }
    }
    #required(sessionId) {
        const session = this.#sessions.get(sessionId);
        if (session === undefined)
            throw new Error("Ares adapter session was not found.");
        return session;
    }
    #assertOpen() {
        if (this.#closed)
            throw new Error("Ares Vanguard adapter is closed.");
    }
    #reserveCapacity() {
        if (this.#sessions.size + this.#sessionReservations >= this.#maxSessions) {
            throw new Error("Ares Vanguard adapter session capacity is full.");
        }
        this.#sessionReservations += 1;
    }
    #trackPendingStart() {
        let release;
        const pending = new Promise((resolve) => { release = resolve; });
        this.#pendingStarts.add(pending);
        return () => {
            this.#pendingStarts.delete(pending);
            release();
        };
    }
    #diagnostic(prefix, error) {
        try {
            this.#logger(`${prefix} (${errorCategory(error)})`);
        }
        catch { }
    }
}
function mapVanguardEvent(sessionId, upstreamCursor, raw) {
    const typeMap = {
        "agent.delta": "assistant.delta",
        "agent.message": "assistant.message",
        "tool.started": "tool.started",
        "tool.completed": "tool.completed",
        "tool.failed": "tool.failed",
        "verification.completed": "verification.completed",
        "run.contracted": "turn.contracted",
        "run.waiting_for_user": "turn.waiting_for_user",
        "run.completed": "turn.completed",
        "run.failed": "turn.failed",
        "recovery.scheduled": "recovery.scheduled",
        "recovery.exhausted": "recovery.exhausted",
        "context.compacted": "context.compacted",
    };
    return {
        version: ARES_VANGUARD_ADAPTER_VERSION,
        sessionId,
        cursor: 0,
        source: "vanguard",
        kind: typeMap[raw.type] ?? "adapter.notice",
        status: raw.status ?? "info",
        upstreamCursor,
        agentId: raw.agentId,
        title: raw.title,
        ...(raw.message === undefined ? {} : { message: raw.message }),
        ...(raw.detail === undefined ? {} : { detail: raw.detail }),
        ...(raw.tool === undefined ? {} : { tool: raw.tool }),
    };
}
function mapVanguardState(state) {
    if (!(new Set([
        "idle", "running", "waiting_for_user", "cancelling", "cancelled", "completed", "failed",
    ])).has(state)) {
        throw protocolError("Vanguard returned an invalid session state.");
    }
    return state;
}
function assertVanguardStatus(status, operation, expectedSessionId) {
    if (status === null || typeof status !== "object"
        || typeof status.sessionId !== "string" || status.sessionId.length === 0
        || (expectedSessionId !== undefined && status.sessionId !== expectedSessionId)
        || typeof status.sessionRoot !== "string" || status.sessionRoot.length === 0
        || typeof status.sourceRoot !== "string" || status.sourceRoot.length === 0
        || typeof status.workspaceRoot !== "string" || status.workspaceRoot.length === 0
        || typeof status.materialized !== "boolean"
        || typeof status.workerActive !== "boolean"
        || typeof status.workerGeneration !== "number"
        || !Number.isSafeInteger(status.workerGeneration) || status.workerGeneration < 0
        || typeof status.ownerEpoch !== "number"
        || !Number.isSafeInteger(status.ownerEpoch) || status.ownerEpoch < 1
        || !Number.isSafeInteger(status.latestCursor) || status.latestCursor < 0
        || !Number.isSafeInteger(status.replayFloorCursor) || status.replayFloorCursor < 1
        || status.replayFloorCursor > status.latestCursor + 1) {
        throw protocolError(`Vanguard ${operation} returned an invalid status.`);
    }
    mapVanguardState(status.state);
}
function assertWorkerStopReceipt(receipt, expectedSessionId, expectedWorkerGeneration, expectedOwnerEpoch) {
    if (receipt === null || typeof receipt !== "object"
        || receipt.version !== 1
        || receipt.sessionId !== expectedSessionId
        || receipt.stopped !== true
        || receipt.workerGeneration !== expectedWorkerGeneration
        || receipt.ownerEpoch !== expectedOwnerEpoch) {
        throw protocolError("Worker stop was not proven by a valid lifecycle receipt.");
    }
}
function assertLifecycleCapabilities(capabilities, provider) {
    if (!Array.isArray(capabilities) || capabilities.length > 100
        || capabilities.some((capability) => typeof capability !== "string" || capability.length > 200)
        || new Set(capabilities).size !== capabilities.length
        || !capabilities.includes("sessions.create.idempotent")
        || !capabilities.includes("sessions.stopAndWait")
        || !capabilities.includes("sessions.workerFenced")
        || !capabilities.includes("sessions.executionTreeFenced")) {
        throw protocolError(`${provider} does not attest durable create, worker-stop, and execution-tree containment.`);
    }
}
function assertRouteClaimCapabilities(capabilities) {
    if (!Array.isArray(capabilities) || capabilities.length > 100
        || capabilities.some((capability) => typeof capability !== "string" || capability.length > 200)
        || new Set(capabilities).size !== capabilities.length
        || !capabilities.includes(ARES_ROUTE_CLAIM_CAPABILITY)) {
        throw protocolError("Route-claim store does not attest atomic durable arbitration.");
    }
}
function assertRouteClaimResult(result, operationId, inputFingerprintSha256, proposedCore, policySha256) {
    if (!hasExactDataShape(result, ["claim", "created"]) || typeof result.created !== "boolean") {
        throw protocolError("Route-claim store returned an invalid claim result.");
    }
    try {
        validateAresDurableRouteClaim(result.claim);
    }
    catch {
        throw protocolError("Route-claim store returned an invalid durable claim.");
    }
    const expectedOperation = aresRouteOperationDigest(operationId);
    if (result.claim.operationIdSha256 !== expectedOperation
        || result.claim.inputFingerprintSha256 !== inputFingerprintSha256
        || (result.created && (result.claim.chosenCore !== proposedCore || result.claim.policySha256 !== policySha256))) {
        throw protocolError("Route-claim store returned a detached or conflicting claim.");
    }
    return result.claim;
}
function assertRouteReceipt(receipt, claim) {
    if (receipt === undefined)
        return undefined;
    try {
        validateAresDurableRouteReceipt(receipt);
    }
    catch {
        throw protocolError("Route-claim store returned an invalid durable receipt.");
    }
    if (receipt.operationIdSha256 !== claim.operationIdSha256
        || receipt.claimSha256 !== aresRouteClaimDigest(claim)
        || receipt.source !== claim.chosenCore) {
        throw protocolError("Route-claim store returned a receipt detached from its claim.");
    }
    return receipt;
}
function assertRouteReceiptResult(result, claim, upstreamSessionId) {
    if (!hasExactDataShape(result, ["receipt", "created"]) || typeof result.created !== "boolean") {
        throw protocolError("Route-claim store returned an invalid receipt result.");
    }
    const receipt = assertRouteReceipt(result.receipt, claim);
    if (receipt === undefined || receipt.upstreamSessionId !== upstreamSessionId
        || receipt.upstreamIdentitySha256 !== aresUpstreamIdentityDigest(claim.chosenCore, upstreamSessionId)) {
        throw protocolError("Route-claim store committed a conflicting upstream identity.");
    }
}
function hasExactDataShape(value, keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
        return false;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key)))
        return false;
    return keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable === true
            && descriptor.get === undefined && descriptor.set === undefined;
    });
}
function assertVanguardEnvelope(envelope, sessionId) {
    if (envelope === null || typeof envelope !== "object"
        || envelope.sessionId !== sessionId
        || !Number.isSafeInteger(envelope.cursor) || envelope.cursor < 1
        || envelope.event === null || typeof envelope.event !== "object"
        || typeof envelope.event.type !== "string"
        || typeof envelope.event.agentId !== "string"
        || typeof envelope.event.title !== "string") {
        throw protocolError("Vanguard returned an invalid or cross-session event envelope.");
    }
}
function assertVanguardPage(page, sessionId, requestedAfterCursor) {
    if (page === null || typeof page !== "object"
        || page.sessionId !== sessionId
        || page.afterCursor !== requestedAfterCursor
        || !Array.isArray(page.events)
        || !Number.isSafeInteger(page.latestCursor) || page.latestCursor < 0
        || page.latestCursor < requestedAfterCursor
        || !Number.isSafeInteger(page.replayFloorCursor) || page.replayFloorCursor < 1
        || page.replayFloorCursor > page.latestCursor + 1
        || typeof page.gap !== "boolean" || typeof page.hasMore !== "boolean"
        || page.gap !== (requestedAfterCursor < page.replayFloorCursor - 1)
        || (page.hasMore && page.events.length === 0)) {
        throw protocolError("Vanguard returned an invalid replay page.");
    }
    const cursors = new Set();
    let previousCursor = page.gap ? page.replayFloorCursor - 1 : requestedAfterCursor;
    for (const event of page.events) {
        assertVanguardEnvelope(event, sessionId);
        if (event.cursor < page.replayFloorCursor || event.cursor <= previousCursor
            || event.cursor > page.latestCursor || cursors.has(event.cursor)) {
            throw protocolError("Vanguard event cursor is invalid for the replay page.");
        }
        cursors.add(event.cursor);
        previousCursor = event.cursor;
    }
    const effectiveBase = page.gap ? page.replayFloorCursor - 1 : requestedAfterCursor;
    const finalCursor = page.events.at(-1)?.cursor ?? effectiveBase;
    if (!page.hasMore && finalCursor !== page.latestCursor) {
        throw protocolError("Vanguard replay page was truncated below its latest cursor.");
    }
}
function assertLegacyStatus(status, expectedSessionId) {
    if (status === null || typeof status !== "object"
        || typeof status.sessionId !== "string" || status.sessionId.length === 0
        || (expectedSessionId !== undefined && status.sessionId !== expectedSessionId)
        || typeof status.workerActive !== "boolean"
        || !Number.isSafeInteger(status.workerGeneration) || status.workerGeneration < 0
        || !Number.isSafeInteger(status.ownerEpoch) || status.ownerEpoch < 1
        || !Number.isSafeInteger(status.latestCursor) || status.latestCursor < 0
        || !Number.isSafeInteger(status.replayFloorCursor) || status.replayFloorCursor < 1
        || status.replayFloorCursor > status.latestCursor + 1
        || !(new Set([
            "idle", "running", "waiting_for_user", "cancelling", "cancelled", "completed", "failed",
        ])).has(status.state)) {
        throw protocolError("Legacy core returned an invalid status.");
    }
}
const ARES_EVENT_KINDS = new Set([
    "assistant.delta", "assistant.message", "tool.started", "tool.completed", "tool.failed",
    "verification.completed", "turn.contracted", "turn.waiting_for_user", "turn.completed", "turn.failed",
    "recovery.scheduled", "recovery.exhausted", "context.compacted", "route.changed", "replay.gap",
    "adapter.notice",
]);
const ARES_EVENT_STATUSES = new Set(["pending", "passed", "failed", "info"]);
function assertLegacyPage(page, requestedAfterCursor) {
    if (page === null || typeof page !== "object"
        || !Array.isArray(page.events)
        || !Number.isSafeInteger(page.latestCursor) || page.latestCursor < 0
        || page.latestCursor < requestedAfterCursor
        || !Number.isSafeInteger(page.replayFloorCursor) || page.replayFloorCursor < 1
        || page.replayFloorCursor > page.latestCursor + 1
        || typeof page.gap !== "boolean" || typeof page.hasMore !== "boolean"
        || page.gap !== (requestedAfterCursor < page.replayFloorCursor - 1)
        || (page.hasMore && page.events.length === 0)) {
        throw protocolError("Legacy core returned an invalid replay page.");
    }
    const cursors = new Set();
    let previousCursor = page.gap ? page.replayFloorCursor - 1 : requestedAfterCursor;
    for (const event of page.events) {
        if (event === null || typeof event !== "object"
            || !Number.isSafeInteger(event.cursor) || event.cursor < page.replayFloorCursor
            || event.cursor <= previousCursor || event.cursor > page.latestCursor
            || cursors.has(event.cursor)
            || !ARES_EVENT_KINDS.has(event.kind)
            || (event.status !== undefined && !ARES_EVENT_STATUSES.has(event.status))
            || !optionalString(event.title) || !optionalString(event.message)
            || !optionalString(event.detail) || !optionalString(event.tool)) {
            throw protocolError("Legacy core returned an invalid event.");
        }
        cursors.add(event.cursor);
        previousCursor = event.cursor;
    }
    const effectiveBase = page.gap ? page.replayFloorCursor - 1 : requestedAfterCursor;
    const finalCursor = page.events.at(-1)?.cursor ?? effectiveBase;
    if (!page.hasMore && finalCursor !== page.latestCursor) {
        throw protocolError("Legacy replay page was truncated below its latest cursor.");
    }
}
function optionalString(value) {
    return value === undefined || typeof value === "string";
}
function classifyThrownFailure(error, fallback) {
    const code = error !== null && typeof error === "object" && "code" in error
        ? String(error.code ?? "")
        : "";
    return /protocol|handshake|version|frame|connection|transport/i.test(code)
        ? "vanguard_protocol_failure"
        : fallback;
}
function errorCategory(error) {
    if (error !== null && typeof error === "object" && "code" in error) {
        const code = String(error.code ?? "unknown");
        return /^[a-z0-9_.-]{1,80}$/i.test(code) ? code : "invalid_code";
    }
    return error instanceof TypeError ? "type_error" : "unknown";
}
function requiredVanguardId(session) {
    if (session.vanguardSessionId === undefined)
        throw new Error("Vanguard session is unavailable.");
    return session.vanguardSessionId;
}
function requiredLegacyId(session) {
    if (session.legacySessionId === undefined)
        throw new Error("Legacy session is unavailable.");
    return session.legacySessionId;
}
function requiredLegacyCreate(session) {
    if (session.legacyCreate === undefined)
        throw new Error("Legacy create fallback is unavailable.");
    return session.legacyCreate;
}
function safeReasonText(reason) {
    switch (reason) {
        case "rollout_ineligible": return "Vanguard was not selected by the staged rollout policy.";
        case "kill_switch": return "The Vanguard emergency kill switch is active.";
        case "vanguard_startup_failure": return "Vanguard could not start before workspace mutation.";
        case "vanguard_protocol_failure": return "The Vanguard protocol failed before a safe handoff.";
        case "vanguard_critical_failure": return "Vanguard stopped before a safe handoff.";
        case "legacy_protocol_failure": return "The legacy engine response was uncertain; automatic retry was blocked.";
    }
}
function requiredOperationId(session) {
    if (session.operationId === undefined)
        throw new Error("Durable create operation ID is unavailable.");
    return session.operationId;
}
function validateActor(actorId) {
    if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId.length > 500) {
        throw new Error("actorId must be a non-empty string of at most 500 characters.");
    }
}
function validateOperationId(operationId) {
    if (typeof operationId !== "string" || !/^op_[a-f0-9]{32,64}$/.test(operationId)) {
        throw new Error("operationId must be a durable opaque op_ identifier.");
    }
}
function adapterClosedError() {
    return Object.assign(new Error("Ares Vanguard adapter is closed."), { code: "adapter_closed" });
}
function isAdapterClosedError(error) {
    return error !== null && typeof error === "object" && "code" in error
        && error.code === "adapter_closed";
}
function isForeignOperationTimeout(error) {
    return error !== null && typeof error === "object" && "code" in error
        && error.code === "foreign_operation_timeout";
}
function routeArbitrationSettlement(error) {
    return error !== null && typeof error === "object"
        ? ROUTE_ARBITRATION_SETTLEMENTS.get(error)
        : undefined;
}
function isDurableIdentityConflict(error) {
    if (error === null || typeof error !== "object" || !("code" in error))
        return false;
    const code = error.code;
    return code === "route_receipt_conflict" || code === "upstream_identity_conflict";
}
function validateAdvanceMessage(message) {
    if (typeof message !== "string" || message.trim().length === 0 || message.length > 16_384) {
        throw new Error("advance message must be non-empty and at most 16,384 characters.");
    }
}
function validateSteeringMessage(message) {
    if (typeof message !== "string" || message.trim().length === 0 || message.length > 262_144) {
        throw new Error("steering message must be non-empty and at most 262,144 characters.");
    }
}
function bounded(value, max) {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
function boundedInteger(value, min, max, name) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`${name} is out of bounds.`);
    return value;
}
function manualRecoveryError() {
    return new Error("Session requires manual recovery; automatic fallback was intentionally blocked.");
}
async function unsettledAfter(promises, timeoutMs) {
    if (promises.length === 0)
        return 0;
    const pending = new Set(promises);
    for (const promise of promises)
        void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    let timer;
    await Promise.race([
        Promise.allSettled(promises),
        new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    if (timer !== undefined)
        clearTimeout(timer);
    return pending.size;
}
function remainingMs(deadline) {
    return Math.max(1, deadline - Date.now());
}
function normalizeRolloutSnapshot(raw) {
    const record = requirePlainRecord(raw, undefined, "rollout config");
    const required = [
        "cohortPercent", "cohortSalt", "enabled", "killSwitch", "requireExplicitOptIn", "stage",
    ];
    const allowed = [...required, "allowActorIds"];
    const keys = Object.keys(record);
    if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.includes(key))) {
        throw new Error("Rollout config contains missing or extra fields.");
    }
    if (typeof record.enabled !== "boolean" || typeof record.killSwitch !== "boolean"
        || typeof record.requireExplicitOptIn !== "boolean")
        throw new Error("Rollout flags must be booleans.");
    if (typeof record.stage !== "string" || typeof record.cohortPercent !== "number"
        || typeof record.cohortSalt !== "string" || record.cohortSalt.length > 4_096) {
        throw new Error("Rollout config contains invalid scalar fields.");
    }
    let allowActorIds;
    if (record.allowActorIds !== undefined) {
        const rawIds = record.allowActorIds;
        if (!Array.isArray(rawIds) || rawIds.length > 4_096)
            throw new Error("Rollout allowlist is invalid.");
        const own = Reflect.ownKeys(rawIds);
        if (own.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)))) {
            throw new Error("Rollout allowlist contains forbidden keys.");
        }
        const normalized = [];
        for (let index = 0; index < rawIds.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(rawIds, String(index));
            if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
                || descriptor.enumerable !== true || typeof descriptor.value !== "string"
                || descriptor.value.trim().length === 0 || descriptor.value.length > 500) {
                throw new Error("Rollout allowlist contains an invalid entry.");
            }
            normalized.push(descriptor.value);
        }
        allowActorIds = Object.freeze([...new Set(normalized)].sort());
    }
    const snapshot = Object.freeze({
        enabled: record.enabled,
        killSwitch: record.killSwitch,
        stage: record.stage,
        cohortPercent: record.cohortPercent,
        cohortSalt: record.cohortSalt,
        ...(allowActorIds === undefined ? {} : { allowActorIds }),
        requireExplicitOptIn: record.requireExplicitOptIn,
    });
    decideAresVanguardRollout(snapshot, "policy-validation-probe", false);
    return snapshot;
}
function stableJson(value) {
    if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error("Create input contains a non-finite number.");
    }
    if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (typeof value !== "object")
        throw new Error("Create input contains an unsupported value.");
    return `{${Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
        .join(",")}}`;
}
function normalizeCreateInput(raw) {
    const top = requirePlainRecord(raw, ["operationId", "actorId", "optedIn", "vanguard", "legacy"], "create input");
    validateActor(dataString(top, "actorId", 500));
    validateOperationId(dataString(top, "operationId", 80));
    const cloned = boundedClone(raw, newBudget(), 0);
    validateActor(cloned.actorId);
    validateOperationId(cloned.operationId);
    if (typeof cloned.optedIn !== "boolean")
        throw new Error("optedIn must be a boolean.");
    validateVanguardInput(cloned.vanguard);
    requirePlainRecord(cloned.legacy, ["workspace"], "legacy create input");
    boundedString(cloned.legacy.workspace, 1, 32_768, "legacy workspace");
    return deepFreeze(cloned);
}
function normalizeResumeInput(raw) {
    const top = requirePlainRecord(raw, ["actorId", "optedIn", "vanguardSessionRoot", "legacy"], "resume input");
    validateActor(dataString(top, "actorId", 500));
    dataString(top, "vanguardSessionRoot", 32_768);
    const cloned = boundedClone(raw, newBudget(), 0);
    validateActor(cloned.actorId);
    if (typeof cloned.optedIn !== "boolean")
        throw new Error("optedIn must be a boolean.");
    boundedString(cloned.vanguardSessionRoot, 1, 32_768, "vanguardSessionRoot");
    requirePlainRecord(cloned.legacy, ["sessionRoot"], "legacy resume input");
    boundedString(cloned.legacy.sessionRoot, 1, 32_768, "legacy sessionRoot");
    return deepFreeze(cloned);
}
function validateVanguardInput(config) {
    const allowed = [
        "workspace", "provider", "model", "auth", "endpoint", "verification", "publicCheck", "adaptiveVerification",
        "allowedCommands", "protectedPaths", "editableRoots", "securityProfile", "restrictProcess",
        "exposeRawProcess", "verifierEvidence", "maxSteps", "maxDurationMs", "commandTimeoutMs",
        "maxContextBytes", "maxFailedVerificationAttempts",
    ];
    requirePlainRecord(config, allowed, "Vanguard config", true);
    boundedString(config.workspace, 1, 32_768, "workspace");
    if (!["openai", "anthropic", "deepseek", "kimi", "ollama", "openai-compatible", "http"].includes(config.provider)) {
        throw new Error("Vanguard provider is invalid.");
    }
    if (config.provider === "openai-compatible" && config.endpoint === undefined) {
        throw new Error("openai-compatible provider requires endpoint.");
    }
    boundedString(config.model, 1, 4_096, "model");
    if (config.auth !== undefined && config.auth !== "api-key" && config.auth !== "oauth")
        throw new Error("Vanguard auth is invalid.");
    if (config.endpoint !== undefined)
        boundedString(config.endpoint, 1, 16_384, "endpoint");
    if (config.provider === "http" && config.endpoint === undefined)
        throw new Error("http provider requires endpoint.");
    if (config.verification !== undefined)
        validateCommandInput(config.verification, "verification");
    if (config.publicCheck !== undefined)
        validateCommandInput(config.publicCheck, "publicCheck");
    for (const [name, values] of [
        ["allowedCommands", config.allowedCommands],
        ["protectedPaths", config.protectedPaths],
        ["editableRoots", config.editableRoots],
    ]) {
        if (values === undefined)
            continue;
        if (!Array.isArray(values) || values.length > 4_096)
            throw new Error(`${name} is invalid.`);
        for (const value of values)
            boundedString(value, 0, 32_768, name);
    }
    for (const [name, value] of [
        ["adaptiveVerification", config.adaptiveVerification],
        ["restrictProcess", config.restrictProcess],
        ["exposeRawProcess", config.exposeRawProcess],
    ])
        if (value !== undefined && typeof value !== "boolean")
            throw new Error(`${name} must be boolean.`);
    if (config.securityProfile !== undefined && config.securityProfile !== "workspace" && config.securityProfile !== "guarded") {
        throw new Error("securityProfile is invalid.");
    }
    if (config.verifierEvidence !== undefined && config.verifierEvidence !== "full" && config.verifierEvidence !== "summary") {
        throw new Error("verifierEvidence is invalid.");
    }
    for (const [name, value] of [
        ["maxSteps", config.maxSteps], ["maxDurationMs", config.maxDurationMs],
        ["commandTimeoutMs", config.commandTimeoutMs], ["maxContextBytes", config.maxContextBytes],
        ["maxFailedVerificationAttempts", config.maxFailedVerificationAttempts],
    ]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
            throw new Error(`${name} is invalid.`);
    }
}
function validateCommandInput(command, name) {
    requirePlainRecord(command, ["command", "args"], `${name} command`);
    boundedString(command.command, 1, 4_096, `${name}.command`);
    if (!Array.isArray(command.args) || command.args.length > 2_048)
        throw new Error(`${name}.args is invalid.`);
    for (const argument of command.args)
        boundedString(argument, 0, 32_768, `${name}.args`);
}
function newBudget() {
    return { seen: new WeakSet(), nodes: 0, keys: 0, bytes: 0 };
}
function boundedClone(value, budget, depth) {
    if (depth > 12)
        throw new Error("Adapter input exceeds the maximum nesting depth.");
    budget.nodes += 1;
    if (budget.nodes > 20_000)
        throw new Error("Adapter input contains too many values.");
    if (typeof value === "string") {
        budget.bytes += Buffer.byteLength(value, "utf8");
        if (budget.bytes > 1_048_576)
            throw new Error("Adapter input exceeds one MiB.");
        return value;
    }
    if (value === null || typeof value === "boolean")
        return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error("Adapter input contains a non-finite number.");
        return value;
    }
    if (typeof value !== "object")
        throw new Error("Adapter input contains an unsupported value.");
    if (budget.seen.has(value))
        throw new Error("Adapter input contains a cycle or shared mutable reference.");
    budget.seen.add(value);
    if (Array.isArray(value)) {
        if (value.length > 10_000)
            throw new Error("Adapter input array is too large.");
        const own = Reflect.ownKeys(value);
        if (own.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)))) {
            throw new Error("Adapter input array contains forbidden keys.");
        }
        const output = [];
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
                || descriptor.enumerable !== true)
                throw new Error("Adapter input contains a sparse or accessor array.");
            output.push(boundedClone(descriptor.value, budget, depth + 1));
        }
        return output;
    }
    const record = requirePlainRecord(value, undefined, "adapter input object", true);
    const output = {};
    for (const key of Object.keys(record)) {
        budget.keys += 1;
        budget.bytes += Buffer.byteLength(key, "utf8");
        if (budget.keys > 20_000 || budget.bytes > 1_048_576)
            throw new Error("Adapter input is too large.");
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        output[key] = boundedClone(descriptor.value, budget, depth + 1);
    }
    return output;
}
function requirePlainRecord(value, allowed, name, optionalKeys = false) {
    if (value === null || typeof value !== "object" || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new Error(`${name} must be a plain object.`);
    }
    const own = Reflect.ownKeys(value);
    if (own.some((key) => typeof key !== "string"))
        throw new Error(`${name} contains a symbol key.`);
    const keys = own;
    if (allowed !== undefined && (keys.some((key) => !allowed.includes(key))
        || (!optionalKeys && allowed.some((key) => !keys.includes(key))))) {
        throw new Error(`${name} contains missing or extra fields.`);
    }
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
            || descriptor.enumerable !== true)
            throw new Error(`${name} contains an accessor or hidden field.`);
    }
    return value;
}
function dataString(record, key, maximum) {
    const value = Object.getOwnPropertyDescriptor(record, key)?.value;
    if (typeof value !== "string" || value.length > maximum)
        throw new Error(`${key} is invalid.`);
    return value;
}
function boundedString(value, minimum, maximum, name) {
    if (typeof value !== "string" || value.length < minimum || value.length > maximum)
        throw new Error(`${name} is invalid.`);
}
function deepFreeze(value) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value))
        return value;
    for (const child of Object.values(value))
        deepFreeze(child);
    return Object.freeze(value);
}
function protocolError(message) {
    return Object.assign(new Error(message), { code: "protocol_invalid_response" });
}
function isNonFatalVanguardControlError(error) {
    const code = error !== null && typeof error === "object" && "code" in error
        ? String(error.code ?? "")
        : "";
    return code === "steering_queue_full" || code === "steering_backpressure" || code === "session_not_running";
}
function safeControlError(error) {
    const code = error !== null && typeof error === "object" && "code" in error
        ? String(error.code ?? "control_rejected")
        : "control_rejected";
    const safeCode = /^[a-z0-9_.-]{1,80}$/i.test(code) ? code : "control_rejected";
    return new Error(`Vanguard control message was not accepted (${safeCode}).`);
}
