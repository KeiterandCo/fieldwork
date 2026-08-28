import { useSyncExternalStore } from 'react';
import { buildResumeContent, saveResumeContent, type ResumeContent } from './resume';

/**
 * Module-level store for in-flight resume builds, keyed by application id.
 *
 * The build lifecycle used to live inside the ResumeStudio component, so switching dossier
 * tabs (which unmounts the component) killed the loading bar and orphaned the result. Lifting
 * it here means the fetch keeps running independent of React mount state: the Resume tab, the
 * dossier header button, and the "draft ready" toast all subscribe to the same source, and a
 * build started on one tab is still going (and lands) when you come back.
 */

export type ResumeBuildPhase = 'idle' | 'building' | 'ready' | 'error';

export interface ResumeBuildState {
  phase: ResumeBuildPhase;
  content: ResumeContent | null;
  atsKeywords: string[];
  error: string | null;
  /** Monotonic per-application counter — bumps on each build so consumers can tell a fresh
   * result from one they already pulled into their editor. */
  buildId: number;
  /** True from the moment a build resolves until a consumer acknowledges it — drives the
   * one-shot "Resume draft ready" toast. */
  unseen: boolean;
  /** Epoch ms the current build started; lets the progress bar stay continuous across the
   * component remounts that a tab switch causes. Null when not building. */
  startedAt: number | null;
}

/** The staged labels shown under the progress bar while a resume build is awaited. Shared so
 * the Resume tab and the persistent cross-tab indicator advance through the same copy. */
export const RESUME_BUILD_STAGES = [
  'Reading your career record…',
  'Studying the job description…',
  'Matching experience to the role…',
  'Assembling the resume…',
];

/** Playful rotating status lines for the resume build bar — a little personality for the
 * wait, in the spirit of Claude's thinking verbs. Kept module-level so BuildProgress's
 * rotation timer stays stable across renders. */
export const RESUME_BUILD_PHRASES = [
  'Reading your whole career record…',
  'Digging for the good bits…',
  'Matching you to this exact role…',
  'Picking your strongest wins…',
  'Quantifying the impact…',
  'Tucking your clearance up top…',
  'Trimming three pages down to two…',
  'Polishing the phrasing…',
  'Lining up the bullets just so…',
  'Making it undeniable…',
  'Almost there…',
];

const IDLE: ResumeBuildState = {
  phase: 'idle',
  content: null,
  atsKeywords: [],
  error: null,
  buildId: 0,
  unseen: false,
  startedAt: null,
};

const states = new Map<string, ResumeBuildState>();
const listeners = new Map<string, Set<() => void>>();

function stateFor(applicationId: string): ResumeBuildState {
  return states.get(applicationId) ?? IDLE;
}

function patch(applicationId: string, next: Partial<ResumeBuildState>): void {
  states.set(applicationId, { ...stateFor(applicationId), ...next });
  listeners.get(applicationId)?.forEach((fn) => fn());
}

export function getResumeBuildState(applicationId: string): ResumeBuildState {
  return stateFor(applicationId);
}

function subscribe(applicationId: string, fn: () => void): () => void {
  let set = listeners.get(applicationId);
  if (!set) {
    set = new Set();
    listeners.set(applicationId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}

/**
 * Kick off (or no-op if already running) a resume build for this application. The fetch is
 * owned by the store, so it survives the ResumeStudio component unmounting on a tab switch.
 * On success the content is also persisted to fw_applications.resume_content immediately, so
 * even a full page reload before export keeps the draft.
 */
export function startResumeBuild(applicationId: string): void {
  const current = stateFor(applicationId);
  if (current.phase === 'building') return;

  patch(applicationId, {
    phase: 'building',
    error: null,
    unseen: false,
    startedAt: Date.now(),
    buildId: current.buildId + 1,
  });
  const startedBuildId = stateFor(applicationId).buildId;

  buildResumeContent(applicationId)
    .then((res) => {
      // Guard against a stale resolve if a newer build was kicked off meanwhile.
      if (stateFor(applicationId).buildId !== startedBuildId) return;
      patch(applicationId, {
        phase: 'ready',
        content: res.content,
        atsKeywords: res.ats_keywords,
        error: null,
        unseen: true,
        startedAt: null,
      });
      // Fire-and-forget durability: the export paths save again with any human edits.
      saveResumeContent(applicationId, res.content).catch(() => {});
    })
    .catch((err) => {
      if (stateFor(applicationId).buildId !== startedBuildId) return;
      patch(applicationId, {
        phase: 'error',
        error: err instanceof Error ? err.message : 'Could not build resume content.',
        unseen: false,
        startedAt: null,
      });
    });
}

/** Mark the "draft ready" notification as seen (toast viewed/dismissed, or content pulled
 * into the editor). Leaves the ready content in place so it stays a cache. */
export function acknowledgeResumeBuild(applicationId: string): void {
  if (stateFor(applicationId).unseen) patch(applicationId, { unseen: false });
}

/** React binding — re-renders the caller whenever this application's build state changes. */
export function useResumeBuild(applicationId: string): ResumeBuildState {
  return useSyncExternalStore(
    (fn) => subscribe(applicationId, fn),
    () => stateFor(applicationId),
    () => stateFor(applicationId),
  );
}
