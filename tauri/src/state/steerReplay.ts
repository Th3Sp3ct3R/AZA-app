// Desktop-only replay bookkeeping for steering across daemon restarts.
//
// A transport error cannot tell us whether the daemon durably recorded a
// steer before the bridge disappeared. Keep the owner-authored bubble as the
// source of the replay payload and submit the same inputId after the next
// daemon_ready; the daemon's durable idempotency record decides the outcome.

export type ReplayableSteerStatus =
  | "submitting"
  | "interrupting_generation"
  | "waiting_for_action"
  | "waiting_for_boundary";

interface SteerItemSnapshot {
  kind: string;
  inputId?: string;
  text?: string;
  images?: string[];
  status?: string;
}

export interface SteerSessionSnapshot {
  id: string;
  items: SteerItemSnapshot[];
}

export interface SteerReplay {
  sessionId: string;
  inputId: string;
  text: string;
  images?: string[];
}

export interface SteerReplayEpoch {
  sent: Set<string>;
}

const REPLAYABLE_STATUSES = new Set<ReplayableSteerStatus>([
  "submitting",
  "interrupting_generation",
  "waiting_for_action",
  "waiting_for_boundary",
]);

function replayKey(sessionId: string, inputId: string): string {
  return `${sessionId}\u0000${inputId}`;
}

export function createSteerReplayEpoch(): SteerReplayEpoch {
  return { sent: new Set<string>() };
}

/** Start a new daemon-process epoch. Outstanding bubbles may be tried again. */
export function resetSteerReplayEpoch(epoch: SteerReplayEpoch): void {
  epoch.sent.clear();
}

/** Record a normal live submission so duplicate ready frames cannot replay it. */
export function markSteerSentInEpoch(
  epoch: SteerReplayEpoch,
  sessionId: string,
  inputId: string,
): void {
  epoch.sent.add(replayKey(sessionId, inputId));
}

/**
 * Claim every unresolved steer exactly once for the current daemon epoch.
 * Terminal bubbles are deliberately excluded: replaying an applied steer is
 * unnecessary, while replaying a cancelled/rejected one would resurrect input
 * the owner already got back in the composer.
 */
export function claimSteersForDaemonReady(
  sessions: readonly SteerSessionSnapshot[],
  epoch: SteerReplayEpoch,
): SteerReplay[] {
  const claimed: SteerReplay[] = [];
  for (const session of sessions) {
    for (const item of session.items) {
      if (
        item.kind !== "steer" ||
        !item.inputId ||
        !REPLAYABLE_STATUSES.has(item.status as ReplayableSteerStatus)
      ) continue;

      const key = replayKey(session.id, item.inputId);
      if (epoch.sent.has(key)) continue;
      // Claim before any transport work starts. Repeated daemon_ready frames in
      // this process therefore cannot race a second submission of the same ID.
      epoch.sent.add(key);
      claimed.push({
        sessionId: session.id,
        inputId: item.inputId,
        text: item.text ?? "",
        ...(item.images?.length ? { images: [...item.images] } : {}),
      });
    }
  }
  return claimed;
}

/** Rebuild the daemon wire payload without dropping image attachments. */
export function steerReplayWireText(replay: Pick<SteerReplay, "text" | "images">): string {
  return replay.text + (replay.images?.length ? `\n${replay.images.join("\n")}` : "");
}
