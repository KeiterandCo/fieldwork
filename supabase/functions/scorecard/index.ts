// Supabase Edge Function: scorecard
//
// Scores a single job description against the stored fw_profile (the "ceiling" — see
// SPEC.md principle #1: every AI action reads the career record from the database and
// nothing generated may exceed it). Accepts POST body { jd_text } and/or { url }.
//
// Flow: read fw_profile + fw_settings first -> liveness check if a url was given (best
// effort) -> extract comp/location/reqs from the JD text -> call Claude for a verdict in
// the order comp -> location -> contract -> blockers -> degree (resume-builder
// methodology) -> return the verdict card JSON.
//
// Model: fw_settings.models.scorecard, falling back to fw_settings.models.default, falling
// back to the hardcoded default 'claude-sonnet-5' (per SPEC.md §2). Never hardcode a
// candidate fact/threshold here — everything candidate-specific comes from fw_profile.
//
// Requires the Supabase secret ANTHROPIC_API_KEY (`supabase secrets set
// ANTHROPIC_API_KEY=sk-ant-...` or set via the dashboard's Edge Function secrets panel).
// The key is read from Deno.env only — never hardcoded, never echoed to the client.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export interface VerdictResult {
  verdict: "yes" | "soft_yes" | "soft_no" | "no";
  comp_min: number | null;
  comp_max: number | null;
  remote_type: string | null;
  location: string | null;
  pain_line: string | null;
  gaps: string[];
  reasoning: string;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface LivenessResult {
  checked: boolean;
  likely_expired: boolean;
  note: string;
  pageText: string | null;
}

/** schema.org JobPosting fields worth trusting over page copy. */
export interface JobPostingMeta {
  validThrough: string | null;
  datePosted: string | null;
}

/** Walks a parsed JSON-LD value (object, array, or @graph wrapper) for the first
 * JobPosting node and returns its date fields. */
function findJobPosting(node: unknown): JobPostingMeta | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;

  const type = obj["@type"];
  const isJobPosting = Array.isArray(type)
    ? type.some((t) => String(t) === "JobPosting")
    : String(type) === "JobPosting";
  if (isJobPosting) {
    return {
      validThrough: typeof obj.validThrough === "string" ? obj.validThrough : null,
      datePosted: typeof obj.datePosted === "string" ? obj.datePosted : null,
    };
  }
  if (obj["@graph"]) return findJobPosting(obj["@graph"]);
  return null;
}

/** Pulls schema.org JobPosting metadata out of a page's ld+json blocks. Job boards (Built
 * In, Greenhouse, Lever, LinkedIn) publish `validThrough` here and then keep serving expired
 * postings at HTTP 200 with no "expired" copy anywhere on the page — so on most listings
 * this is the only honest expiry signal there is.
 *
 * Deliberately loose on the type attribute: Built In serves it HTML-escaped as
 * `application/ld&#x2B;json`, so matching a literal "ld+json" finds nothing. Anything
 * ld…json shaped gets parsed; non-JobPosting blocks are ignored below anyway. */
export function extractJobPostingMeta(rawBody: string): JobPostingMeta | null {
  const blocks = rawBody.matchAll(
    /<script[^>]*type=["'][^"']*ld[^"']*json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of blocks) {
    try {
      const found = findJobPosting(JSON.parse(block[1].trim()));
      if (found) return found;
    } catch {
      // Malformed ld+json block — skip it and try the next.
    }
  }
  return null;
}

/** Best-effort liveness check: a real 404/410, a schema.org `validThrough` already in the
 * past, or common "posting expired" copy. Anything else (including a fetch failure) is
 * reported but never blocks scoring — the JD text the user pasted or the page text we could
 * fetch is still worth scoring. */
export async function checkLiveness(url: string): Promise<LivenessResult> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const status = res.status;
    const rawBody = await res.text();
    const pageText = stripHtml(rawBody).slice(0, 15000);
    if (status === 404 || status === 410) {
      return { checked: true, likely_expired: true, note: `HTTP ${status} — posting likely removed.`, pageText };
    }

    const meta = extractJobPostingMeta(rawBody);
    if (meta?.validThrough) {
      const expiry = new Date(meta.validThrough);
      if (!Number.isNaN(expiry.getTime()) && expiry.getTime() < Date.now()) {
        return {
          checked: true,
          likely_expired: true,
          note: `Posting expired ${meta.validThrough.slice(0, 10)} (schema.org validThrough)${
            meta.datePosted ? `, posted ${meta.datePosted.slice(0, 10)}` : ""
          }.`,
          pageText,
        };
      }
    }

    const lower = pageText.toLowerCase();
    const expiredSignals = [
      "no longer accepting applications",
      "position has been filled",
      "job is no longer available",
      "posting has expired",
      "job not found",
      "position is no longer",
      "this position has been closed",
      "page not found",
    ];
    const hit = expiredSignals.find((s) => lower.includes(s));
    if (hit) {
      return { checked: true, likely_expired: true, note: `Page text suggests expired: "${hit}"`, pageText };
    }
    return {
      checked: true,
      likely_expired: false,
      note: `HTTP ${status}, no expiry signals found (best effort check).`,
      pageText,
    };
  } catch (err) {
    return {
      checked: false,
      likely_expired: false,
      note: `Liveness check failed: ${err instanceof Error ? err.message : String(err)}`,
      pageText: null,
    };
  }
}

const VERDICT_TOOL = {
  name: "emit_verdict",
  description: "Emit the structured scorecard verdict for this job description.",
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["yes", "soft_yes", "soft_no", "no"] },
      comp_min: { type: ["number", "null"] },
      comp_max: { type: ["number", "null"] },
      remote_type: { type: ["string", "null"] },
      location: {
        type: ["string", "null"],
        description:
          "The posting's stated location(s)/city, e.g. \"San Francisco, CA\" or \"San Francisco or New York (onsite)\" or \"Remote (US)\"; null if truly unspecified.",
      },
      pain_line: {
        type: ["string", "null"],
        description: "One sentence naming the real pain behind this requisition.",
      },
      gaps: { type: "array", items: { type: "string" } },
      reasoning: {
        type: "string",
        description:
          "Short paragraph walking through comp -> location -> contract -> blockers -> degree, in that order.",
      },
    },
    required: ["verdict", "gaps", "reasoning"],
  },
};

/** Runs the actual scorecard call against the Claude API. Shared verbatim (by design, not
 * import — edge functions deploy as independent bundles) with daily_loop's inline scoring
 * loop, so keep the two in sync if this changes. */
export async function scoreJd(opts: {
  jdText: string;
  livenessNote: string | null;
  profile: Record<string, unknown>;
  model: string;
  apiKey: string;
}): Promise<VerdictResult> {
  const { jdText, livenessNote, profile, model, apiKey } = opts;

  const systemPrompt = `You are screening a job description against a candidate's stored career record for Fieldwork, a job-search cockpit. The career record is the absolute ceiling: never claim anything for the candidate beyond what is in it, and never suggest claiming anything listed in "do not claim". Never mention anything listed in "never mention".

Candidate career record (markdown):
${String(profile.career_record ?? "(none on file)")}

Comp floor: ${profile.comp_floor ?? "(not set)"}
Target band strategy: ${profile.target_band_strategy ?? "(not set)"}
Remote preferences: ${profile.remote_prefs ?? "(not set)"}
Target titles: ${Array.isArray(profile.target_titles) ? (profile.target_titles as string[]).join(", ") : "(none set)"}
Avoid titles: ${Array.isArray(profile.avoid_titles) ? (profile.avoid_titles as string[]).join(", ") : "(none set)"}
Do not claim: ${Array.isArray(profile.do_not_claim) ? (profile.do_not_claim as string[]).join(", ") : "(none)"}
Never mention: ${Array.isArray(profile.never_mention) ? (profile.never_mention as string[]).join(", ") : "(none)"}

Evaluate the job description strictly in this order, per the resume-builder methodology:
1. Comp — does the posted or inferable range clear the comp floor and target band strategy?
2. Location / remote fit — does it match remote preferences?
3. Contract type — full-time vs. contract/temp, and any red flags there.
4. Blockers — anything that conflicts with do-not-claim / never-mention, or an obvious dealbreaker.
5. Degree / education requirements the candidate may not meet.

Extract comp_min/comp_max (numbers, annual USD, null if not determinable), remote_type (the working arrangement — e.g. "remote", "hybrid", "onsite"; null if unclear), and location (the specific place the posting states — the city or cities, e.g. "San Francisco, CA" or "San Francisco or New York (onsite)" or "Remote (US)"; null if truly unspecified) from the JD text itself. remote_type is the arrangement; location is the actual where — fill both.

Return a verdict: "yes" (clearly good, apply now), "soft_yes" (worth applying, some caveats), "soft_no" (a stretch, borderline), or "no" (skip). List concrete gaps as short strings. Write one pain_line naming the real pain behind this requisition, if inferable. Call the emit_verdict tool with your result — do not respond in plain text.`;

  const userMessage = livenessNote
    ? `Liveness check note: ${livenessNote}\n\nJob description:\n${jdText}`
    : `Job description:\n${jdText}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools: [VERDICT_TOOL],
      tool_choice: { type: "tool", name: "emit_verdict" },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude API error (${res.status}): ${detail.slice(0, 500)}`);
  }

  const payload = await res.json();
  const toolUse = (payload.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude did not return a structured verdict.");
  }
  const input = toolUse.input as Partial<VerdictResult>;
  return {
    verdict: input.verdict ?? "soft_no",
    comp_min: input.comp_min ?? null,
    comp_max: input.comp_max ?? null,
    remote_type: input.remote_type ?? null,
    location: input.location ?? null,
    pain_line: input.pain_line ?? null,
    gaps: Array.isArray(input.gaps) ? input.gaps : [],
    reasoning: input.reasoning ?? "",
  };
}

/** Reads models map from fw_settings, applying the scorecard -> default -> hardcoded
 * fallback chain described in the file header. */
export function resolveModel(settings: Record<string, unknown>, action: string): string {
  const models = (settings.models ?? {}) as Record<string, string>;
  return models[action] ?? models.default ?? "claude-sonnet-5";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error:
            "Missing Supabase secret ANTHROPIC_API_KEY. Set it with `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...` (or via the dashboard's Edge Function secrets panel), then retry.",
        }),
        { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => ({}));
    const { jd_text, url } = body as { jd_text?: string; url?: string };

    if (!jd_text && !url) {
      return new Response(JSON.stringify({ error: "Provide jd_text or url." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
      });
    }

    const [{ data: profile }, { data: settingsRows }] = await Promise.all([
      supabase.from("fw_profile").select("*").limit(1).maybeSingle(),
      supabase.from("fw_settings").select("key, value"),
    ]);

    const settings: Record<string, unknown> = {};
    for (const row of (settingsRows ?? []) as { key: string; value: unknown }[]) {
      settings[row.key] = row.value;
    }
    const model = resolveModel(settings, "scorecard");

    let livenessNote: string | null = null;
    let liveCheckedAt: string | null = null;
    let effectiveJdText = jd_text ?? "";

    if (url) {
      const liveness = await checkLiveness(url);
      livenessNote = liveness.note;
      liveCheckedAt = new Date().toISOString();
      if (!effectiveJdText && liveness.pageText) {
        effectiveJdText = liveness.pageText;
      }
    }

    if (!effectiveJdText) {
      return new Response(
        JSON.stringify({
          error: "Could not obtain job description text from that URL — paste the JD text directly instead.",
        }),
        { status: 400, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
      );
    }

    const verdict = await scoreJd({
      jdText: effectiveJdText,
      livenessNote,
      profile: (profile ?? {}) as Record<string, unknown>,
      model,
      apiKey,
    });

    return new Response(
      JSON.stringify({
        ...verdict,
        jd_text: effectiveJdText,
        live_checked_at: liveCheckedAt,
        liveness_note: livenessNote,
      }),
      { headers: { ...CORS_HEADERS, "content-type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error in scorecard." }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
    );
  }
});
