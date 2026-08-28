import { supabase } from './supabase';
import type { FwApplication, FwEventType, FwStatus } from './types';
import { addDays, localDateString } from './dateUtils';

export async function listApplications(): Promise<FwApplication[]> {
  const { data, error } = await supabase
    .from('fw_applications')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getApplication(id: string): Promise<FwApplication | null> {
  const { data, error } = await supabase
    .from('fw_applications')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertEvent(
  applicationId: string,
  type: FwEventType,
  body: string | null,
  occurredAt: Date = new Date()
): Promise<void> {
  const { error } = await supabase.from('fw_events').insert({
    application_id: applicationId,
    type,
    body,
    occurred_at: occurredAt.toISOString(),
  } as never);
  if (error) throw error;
}

/** Updates status and logs a status_change event in one call — every status transition in
 * the app (Pipeline drag, Today actions) should go through this so the timeline stays true. */
export async function setStatus(
  applicationId: string,
  newStatus: FwStatus,
  previousStatus: FwStatus,
  note?: string
): Promise<void> {
  const { error } = await supabase
    .from('fw_applications')
    .update({ status: newStatus } as never)
    .eq('id', applicationId);
  if (error) throw error;

  await insertEvent(
    applicationId,
    'status_change',
    note ?? `${previousStatus} → ${newStatus}`
  );
}

/** Passing on a role you never applied to. The row stays in fw_applications on purpose:
 * daily_loop dedupes sourced candidates against every row regardless of status, so a passed
 * role is what keeps the same posting from being re-recommended tomorrow. Deleting the row
 * would hand it straight back to the next sourcing run. */
export async function passApplication(app: FwApplication, reason?: string): Promise<void> {
  await setStatus(app.id, 'passed', app.status, reason ?? 'Passed — not pursuing.');
}

export async function markGhosted(app: FwApplication): Promise<void> {
  await setStatus(app.id, 'ghosted', app.status, 'Marked ghosted — energy banked.');
}

/** Bumps next_action_due forward by the given number of days (from the greater of "now" or
 * the existing due date, so repeated snoozes don't stack against the past). */
export async function snoozeNextAction(app: FwApplication, days: number): Promise<void> {
  const base = app.next_action_due && new Date(app.next_action_due) > new Date()
    ? new Date(app.next_action_due)
    : new Date();
  const nextDue = addDays(base, days);
  const { error } = await supabase
    .from('fw_applications')
    .update({ next_action_due: localDateString(nextDue) } as never)
    .eq('id', app.id);
  if (error) throw error;
}

export async function recordRejection(
  app: FwApplication,
  statedReason: string
): Promise<void> {
  await setStatus(app.id, 'rejected', app.status, 'Logged.');

  const { error } = await supabase.from('fw_lessons').insert({
    application_id: app.id,
    company: app.company,
    role: app.title,
    date: localDateString(),
    stage_reached: app.status,
    stated_reason: statedReason,
  } as never);
  if (error) throw error;
}
