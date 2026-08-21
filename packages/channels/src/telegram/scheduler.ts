// General-purpose scheduled notification system for Telegram.
//
// NOT hardcoded to 9/12/3 — the scheduler runs ANY set of alarms, loaded from
// a persistent JSON file (~/.ares/telegram-schedule.json). Alarms can be:
//   • recurring (every day at a time, or specific weekdays)
//   • one-shot (fire once, then auto-remove)
//
// The agent adds alarms via the Remind tool; the owner can also manage them
// from Telegram (/remind, /alarms, /alarm_rm). Anyone downloading this repo
// gets the same infrastructure — just configure your alarms.
//
// Architecture: tick every 60s, check each alarm against the clock, fire via
// TelegramOutbound, persist after mutations (add/remove/one-shot expiry).

import { promises as fs } from "node:fs";
import path from "node:path";
import { TelegramOutbound } from "./outbound.js";

// ─── Data model ──────────────────────────────────────────────────────────

export interface Alarm {
  id: string;
  /** Human-readable label (shown in the message). */
  label: string;
  /** Hour in 24h local time (0–23). */
  hour: number;
  /** Minute (0–59). */
  minute: number;
  /** Which days to fire: 0=Sun..6=Sat. Empty/absent = every day. */
  days?: number[];
  /** One-shot: fire once then auto-remove. */
  once?: boolean;
  /** Optional extra text to include in the message body. */
  body?: string;
  /** Send to specific chat IDs. Absent = send to all owners. */
  chatIds?: number[];
  /** ISO timestamp when this alarm was created. */
  createdAt: string;
}

export interface ScheduleData {
  alarms: Alarm[];
}

function emptySchedule(): ScheduleData {
  return { alarms: [] };
}

// ─── Persistence ─────────────────────────────────────────────────────────

export function scheduleFile(home: string): string {
  return path.join(home, "telegram-schedule.json");
}

export async function loadSchedule(home: string): Promise<ScheduleData> {
  try {
    const raw = await fs.readFile(scheduleFile(home), "utf8");
    const parsed = JSON.parse(raw) as ScheduleData;
    if (Array.isArray(parsed?.alarms)) return parsed;
  } catch {
    // missing / corrupt → empty
  }
  return emptySchedule();
}

export async function saveSchedule(home: string, data: ScheduleData): Promise<void> {
  const file = scheduleFile(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

// ─── Alarm CRUD ──────────────────────────────────────────────────────────

let idSeq = 0;
export function generateAlarmId(): string {
  return `a${Date.now().toString(36)}${(idSeq++).toString(36)}`;
}

export function addAlarm(data: ScheduleData, alarm: Omit<Alarm, "id" | "createdAt">): { data: ScheduleData; alarm: Alarm } {
  const full: Alarm = { ...alarm, id: generateAlarmId(), createdAt: new Date().toISOString() };
  return { data: { alarms: [...data.alarms, full] }, alarm: full };
}

export function removeAlarm(data: ScheduleData, id: string): { data: ScheduleData; removed?: Alarm } {
  const removed = data.alarms.find((a) => a.id === id);
  if (!removed) return { data };
  return { data: { alarms: data.alarms.filter((a) => a.id !== id) }, removed };
}

export function listAlarms(data: ScheduleData): Alarm[] {
  return [...data.alarms].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
}

export function renderAlarms(data: ScheduleData): string {
  const sorted = listAlarms(data);
  if (sorted.length === 0) return "No alarms set.";
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const lines = ["⏰ Scheduled alarms:"];
  for (const a of sorted) {
    const time = `${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")}`;
    const days = a.days?.length ? a.days.map((d) => dayNames[d]).join(",") : "daily";
    const once = a.once ? " (one-shot)" : "";
    lines.push(`  ${a.id} — ${time} ${days}${once}: ${a.label}`);
  }
  return lines.join("\n");
}

// ─── Check-in message builder ────────────────────────────────────────────

export interface CheckInContext {
  alarm: Alarm;
  now: Date;
}

export type CheckInBuilder = (ctx: CheckInContext) => string | Promise<string>;

function defaultBuilder(ctx: CheckInContext): string {
  const time = ctx.now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const lines = [`🜂 ${ctx.alarm.label} — ${time}`];
  if (ctx.alarm.body) lines.push("", ctx.alarm.body);
  return lines.join("\n");
}

// ─── The scheduler ───────────────────────────────────────────────────────

export interface SchedulerOptions {
  outbound: TelegramOutbound;
  home: string;
  /** Override the message builder. */
  buildMessage?: CheckInBuilder;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Check interval in ms. Default 60_000 (1 minute). */
  tickMs?: number;
  log?: (line: string) => void;
}

export class TelegramScheduler {
  private readonly outbound: TelegramOutbound;
  private readonly home: string;
  private readonly buildMessage: CheckInBuilder;
  private readonly now: () => Date;
  private readonly tickMs: number;
  private readonly log: (line: string) => void;

  private schedule: ScheduleData = emptySchedule();
  private timer?: ReturnType<typeof setInterval>;
  /** Track which alarms already fired today so we don't double-send. */
  private readonly firedToday = new Set<string>();
  private lastDay = -1;

  constructor(opts: SchedulerOptions) {
    this.outbound = opts.outbound;
    this.home = opts.home;
    this.buildMessage = opts.buildMessage ?? defaultBuilder;
    this.now = opts.now ?? (() => new Date());
    this.tickMs = opts.tickMs ?? 60_000;
    this.log = opts.log ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.schedule = await loadSchedule(this.home);
    this.lastDay = this.now().getDate();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // A forgotten/failed caller must not pin a daemon or test worker forever.
    // The scheduler is ambient maintenance; active sessions/process owners keep
    // the runtime alive, not this minute tick.
    this.timer.unref?.();
    this.log(`scheduler started with ${this.schedule.alarms.length} alarm(s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Add an alarm at runtime (from the Remind tool or /remind command). */
  async addAlarm(input: Omit<Alarm, "id" | "createdAt">): Promise<Alarm> {
    this.schedule = await loadSchedule(this.home);
    const { data, alarm } = addAlarm(this.schedule, input);
    this.schedule = data;
    await saveSchedule(this.home, data);
    this.log(`alarm added: ${alarm.id} "${alarm.label}" at ${alarm.hour}:${String(alarm.minute).padStart(2, "0")}`);
    return alarm;
  }

  /** Remove an alarm at runtime. */
  async removeAlarm(id: string): Promise<Alarm | undefined> {
    this.schedule = await loadSchedule(this.home);
    const { data, removed } = removeAlarm(this.schedule, id);
    if (removed) {
      this.schedule = data;
      await saveSchedule(this.home, data);
      this.log(`alarm removed: ${id}`);
    }
    return removed;
  }

  /** List alarms (for the Remind tool or /alarms command). */
  async listAlarms(): Promise<Alarm[]> {
    this.schedule = await loadSchedule(this.home);
    return listAlarms(this.schedule);
  }

  /** Human-readable alarm list. */
  async renderAlarms(): Promise<string> {
    this.schedule = await loadSchedule(this.home);
    return renderAlarms(this.schedule);
  }

  /** Reload the schedule from disk (picks up external edits). */
  async reload(): Promise<void> {
    this.schedule = await loadSchedule(this.home);
  }

  private tick(): void {
    const now = this.now();
    if (now.getDate() !== this.lastDay) {
      this.firedToday.clear();
      this.lastDay = now.getDate();
    }
    const h = now.getHours();
    const m = now.getMinutes();
    const dow = now.getDay();

    for (const alarm of this.schedule.alarms) {
      if (this.firedToday.has(alarm.id)) continue;
      // Day filter: if days specified, only fire on those days.
      if (alarm.days?.length && !alarm.days.includes(dow)) continue;
      // Time match: fire in the alarm's minute or up to 2 minutes late (jitter).
      if (h === alarm.hour && m >= alarm.minute && m <= alarm.minute + 2) {
        this.firedToday.add(alarm.id);
        this.fireAlarm(alarm, now);
      }
    }
  }

  private fireAlarm(alarm: Alarm, now: Date): void {
    const ctx: CheckInContext = { alarm, now };
    Promise.resolve(this.buildMessage(ctx))
      .then((text) => {
        if (alarm.chatIds?.length) {
          return this.outbound.sendToChats(alarm.chatIds, text);
        }
        return this.outbound.sendToOwners(text);
      })
      .then((res) => {
        this.log(`alarm "${alarm.label}" sent to ${res.sent} chat(s)`);
        if (alarm.once) {
          const { data } = removeAlarm(this.schedule, alarm.id);
          this.schedule = data;
          void saveSchedule(this.home, data).catch(() => {});
          this.log(`one-shot alarm "${alarm.id}" auto-removed`);
        }
      })
      .catch((err) => this.log(`alarm "${alarm.label}" failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

// ─── Legacy compat ───────────────────────────────────────────────────────

export interface CheckInSlot {
  hour: number;
  minute?: number;
  label: string;
}

export const DEFAULT_SLOTS: CheckInSlot[] = [
  { hour: 9, minute: 0, label: "Morning check-in" },
  { hour: 12, minute: 0, label: "Midday check-in" },
  { hour: 15, minute: 0, label: "Afternoon check-in" },
];

/** Convert legacy slots to alarms for seeding. */
export function slotsToAlarms(slots: CheckInSlot[]): Omit<Alarm, "id" | "createdAt">[] {
  return slots.map((s) => ({ label: s.label, hour: s.hour, minute: s.minute ?? 0 }));
}
