import type { FwApplication, FwEvent } from './types';
import type { TimingSettings } from './settings';
import { daysBetween, hoursBetween } from './dateUtils';

export type QueueItemKind = 'thank_you' | 'ghost' | 'nudge' | 'stale_to_apply';

export interface QueueItem {
  kind: QueueItemKind;
  application: FwApplication;
  headline: string;
  detail: string;
}

const TERMINAL_STATUSES = new Set(['rejected', 'withdrawn', 'accepted', 'ghosted']);
const ACTIVE_INTERVIEW_STATUSES = new Set([
  'applied',
  'phone_screen',
  'interviewing',
  'final_round',
]);
const THANK_YOU_EVENT_TYPES = new Set(['screen', 'round', 'debrief']);

/** Builds the Today action queue from live applications + events + the user's own timing
 * rules (never hardcoded — always passed in from `fw_settings`). Pure function so it's easy
 * to test and reason about; all Supabase I/O happens in the caller. */
export function buildTodayQueue(
  applications: FwApplication[],
  events: FwEvent[],
  timing: TimingSettings
): QueueItem[] {
  const now = new Date();
  const eventsByApp = new Map<string, FwEvent[]>();
  for (const ev of events) {
    const list = eventsByApp.get(ev.application_id) ?? [];
    list.push(ev);
    eventsByApp.set(ev.application_id, list);
  }
  for (const list of eventsByApp.values()) {
    list.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  }

  const items: QueueItem[] = [];

  for (const app of applications) {
    if (TERMINAL_STATUSES.has(app.status)) continue;

    const appEvents = eventsByApp.get(app.id) ?? [];
    const lastEvent = appEvents[0];
    const lastThankableEvent = appEvents.find((e) => THANK_YOU_EVENT_TYPES.has(e.type));
    const thankYouSent = appEvents.some(
      (e) =>
        e.type === 'thank_you' &&
        lastThankableEvent &&
        new Date(e.occurred_at) > new Date(lastThankableEvent.occurred_at)
    );

    // 1. Thank-you needed — highest priority, time-sensitive.
    if (lastThankableEvent && !thankYouSent) {
      const hoursSince = hoursBetween(now, new Date(lastThankableEvent.occurred_at));
      if (hoursSince >= timing.thankyou_hours) {
        items.push({
          kind: 'thank_you',
          application: app,
          headline: `Thank-you due — ${app.company}`,
          detail: `${app.title ?? 'Role'} · last touch ${Math.floor(hoursSince)}h ago`,
        });
        continue;
      }
    }

    // 2. Ghost candidate — long silence on an active application.
    const referenceDate = lastEvent
      ? new Date(lastEvent.occurred_at)
      : app.date_applied
        ? new Date(app.date_applied)
        : new Date(app.created_at);
    const daysSinceContact = daysBetween(now, referenceDate);
    const ghostThresholdDays = timing.ghost_weeks * 7;

    if (ACTIVE_INTERVIEW_STATUSES.has(app.status) && daysSinceContact >= ghostThresholdDays) {
      items.push({
        kind: 'ghost',
        application: app,
        headline: `Gone quiet — ${app.company}`,
        detail: `${app.title ?? 'Role'} · ${Math.floor(daysSinceContact)} days since last contact`,
      });
      continue;
    }

    // 3. Stale to_apply — sourced but never sent.
    if (app.status === 'to_apply') {
      const daysSinceCreated = daysBetween(now, new Date(app.created_at));
      if (daysSinceCreated >= timing.nudge_days_max) {
        items.push({
          kind: 'stale_to_apply',
          application: app,
          headline: `Still sitting in To Apply — ${app.company}`,
          detail: `${app.title ?? 'Role'} · queued ${Math.floor(daysSinceCreated)} days ago`,
        });
        continue;
      }
    }

    // 4. Nudge — the stored next_action_due has arrived.
    if (app.next_action_due) {
      const due = new Date(app.next_action_due);
      if (due.getTime() <= now.getTime()) {
        items.push({
          kind: 'nudge',
          application: app,
          headline: `Nudge due — ${app.company}`,
          detail: app.next_action ?? `${app.title ?? 'Role'} · follow up`,
        });
      }
    }
  }

  return items;
}
