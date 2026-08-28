import { supabase } from './supabase';
import { invokeFn } from './functions';
import type { FwVerdict } from './types';

/** Shape returned by the `scorecard` edge function (and, per-candidate, by `daily_loop`). */
export interface VerdictCard {
  verdict: FwVerdict;
  comp_min: number | null;
  comp_max: number | null;
  remote_type: string | null;
  location: string | null;
  pain_line: string | null;
  gaps: string[];
  reasoning: string;
  jd_text: string;
  live_checked_at: string | null;
  liveness_note: string | null;
}

export interface DailyLoopCandidateInput {
  company: string;
  title?: string;
  jd_text?: string;
  url?: string;
}

/** One row of the `daily_loop` response. Duplicates, provably-expired postings, and scoring
 * failures all come back without full verdict fields — check `duplicate`, `expired` and
 * `error` before reading them. */
export interface DailyLoopResult extends Partial<VerdictCard> {
  company: string;
  title: string | null;
  url: string | null;
  duplicate: boolean;
  /** Skipped before scoring: a 404/410, or a schema.org validThrough already past. */
  expired?: boolean;
  error?: string;
}

export async function runScorecard(input: { jd_text?: string; url?: string }): Promise<VerdictCard> {
  return invokeFn<VerdictCard>('scorecard', input);
}

export async function runDailyLoop(candidates: DailyLoopCandidateInput[]): Promise<DailyLoopResult[]> {
  const res = await invokeFn<{ results: DailyLoopResult[] }>('daily_loop', { candidates });
  return res.results;
}

/** Autonomous sourcing mode: the edge function searches the web (Tavily) for live roles
 * matching the profile's target titles, triages, dedupes, and scores them. Requires the
 * TAVILY_API_KEY Supabase secret; the function returns a clear error naming it if unset. */
export async function runSourcedDailyLoop(count = 10): Promise<DailyLoopResult[]> {
  const res = await invokeFn<{ results: DailyLoopResult[] }>('daily_loop', { source: true, count });
  return res.results;
}

/** Records a discarded candidate as a `passed` row so it stops coming back. daily_loop
 * dedupes sourced candidates against fw_applications by company+title with no status
 * filter, so this row is the only thing that suppresses a re-recommend — a purely
 * client-side discard leaves the posting free to resurface on the next sourcing run.
 * Deliberately writes no fw_jds row: a pass isn't worth keeping the JD text for. */
export async function recordPass(params: {
  company: string;
  title: string | null;
  verdict?: FwVerdict | null;
  source?: string;
}): Promise<void> {
  const { error } = await supabase.from('fw_applications').insert({
    company: params.company,
    title: params.title,
    status: 'passed',
    verdict: params.verdict ?? null,
    source: params.source ?? 'intake',
    notes: 'Passed at intake — discarded from a verdict card.',
  } as never);
  if (error) throw error;
}

/** Files a reviewed verdict card as a new `to_apply` application + its JD row. Used by both
 * the single-scorecard flow and each daily-loop card once the user reviews and accepts it —
 * nothing is written to the pipeline until this is explicitly called from a click. */
export async function fileAsToApply(params: {
  company: string;
  title: string | null;
  card: Pick<
    VerdictCard,
    'verdict' | 'comp_min' | 'comp_max' | 'remote_type' | 'pain_line' | 'gaps' | 'jd_text' | 'live_checked_at'
  >;
  url?: string | null;
  source?: string;
}): Promise<void> {
  const { company, title, card, url, source } = params;

  const { data: app, error: appErr } = await supabase
    .from('fw_applications')
    .insert({
      company,
      title,
      status: 'to_apply',
      verdict: card.verdict,
      comp_min: card.comp_min,
      comp_max: card.comp_max,
      remote_type: card.remote_type,
      source: source ?? 'intake',
    } as never)
    .select()
    .single();
  if (appErr) throw appErr;

  const { error: jdErr } = await supabase.from('fw_jds').insert({
    application_id: (app as { id: string }).id,
    url: url ?? null,
    raw_text: card.jd_text,
    pain_line: card.pain_line,
    gaps: card.gaps,
    live_checked_at: card.live_checked_at,
    source: source ?? 'intake',
  } as never);
  if (jdErr) throw jdErr;
}
