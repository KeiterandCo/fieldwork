# Fieldwork

A job-search cockpit. Every application, contact, deadline, rejection, and lesson in one
place — with AI doing the reading and drafting, and a human doing all of the sending.

I built Fieldwork to run my own 2026 job search, and it worked: the search ended with a
signed offer. The tool is now **shelved but standing** — no active development, but the
code is complete, documented, and yours to run or fork if it's useful to you.

## What it does

- **Today** — an auto-computed action queue. Follow-ups due, silence past the nudge
  window, thank-yous owed. One card, one button each.
- **Pipeline** — a kanban board across the whole search (`to_apply` → `applied` →
  screens → rounds → offer/rejected/ghosted), drag to move, every move logged as a
  timeline event.
- **Intake** — paste a job description or URL and get a scorecard: an AI verdict
  (yes / soft yes / soft no / no) against *your* profile — comp floor, remote
  preferences, target titles, and the gaps it found. File it or pass, nothing enters the
  pipeline without your click.
- **Daily loop** — optional autonomous sourcing: searches the web (Tavily) for live
  postings matching your target titles, dedupes against your pipeline, liveness-checks,
  and scores each one into a verdict card for review.
- **Dossiers** — a per-company view: timeline, stored JD, resume builds, contacts, prep.
- **Resume studio** — builds a tailored two-page resume from your career record, edits in
  place, and exports .docx and PDF in the browser.
- **Drafts** — nudges, thank-yous, cover letters, stay-in-touch notes. The app **never
  sends anything**: every draft ends at a Copy button and a "Mark sent" you click after
  sending it yourself.
- **Insights** — funnel conversion, deaths-by-stage, effectiveness by source and title,
  and the lessons log rendered as evidence.
- **Lessons** — every rejection asks for the stated reason and the real signal, so the
  patterns surface instead of just the bruises.

## Principles

1. **The career record is the ceiling.** Every AI action reads your record from the
   database; nothing generated may claim more than it contains.
2. **Drafts only.** No auto-send, no auto-apply. The human clicks submit, always.
3. **Buttons, not typing.** Anything you'd ask an assistant to do has a control.
4. **No personal facts in code.** Everything lives in the `fw_profile` row and
   `fw_settings` — the onboarding wizard builds them for a fresh user.

## Stack

- **Frontend:** [Astro](https://astro.build) + React islands, Tailwind CSS. Deploys to
  Netlify (adapter included) or anywhere Astro runs.
- **Data:** Supabase Postgres (schema in [`supabase/schema.sql`](supabase/schema.sql)),
  magic-link email auth, RLS on.
- **AI:** Supabase Edge Functions calling the Claude API — scorecards, sourcing, drafts,
  prep docs, resume content. Your API key lives in Supabase secrets, never in the client.

## Setting it up

### 1. Supabase

1. Create a [Supabase](https://supabase.com) project (free tier is plenty for one user).
2. In the SQL Editor, run [`supabase/schema.sql`](supabase/schema.sql).
3. Enable **Email** auth (magic link — no password setup needed).
4. Deploy the edge functions and set their secrets with the
   [Supabase CLI](https://supabase.com/docs/guides/cli):

   ```sh
   supabase link --project-ref <your-project-ref>
   supabase functions deploy scorecard daily_loop draft prep resume_content sweep
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # required for all AI actions
   supabase secrets set TAVILY_API_KEY=tvly-...        # optional: web sourcing in the daily loop
   ```

### 2. The app

```sh
cd app
cp .env.example .env    # fill in your Supabase URL + anon (publishable) key
npm install
npm run dev             # http://localhost:4321
```

Sign in with your email, click the magic link, and walk through the onboarding wizard —
it builds your profile (career record, comp floor, target titles, rules) from nothing.

**After your first sign-in, disable new signups** (Supabase → Authentication →
Sign In / Up) or restrict allowed emails: the RLS policy grants any authenticated user
full access, because Fieldwork is single-user by design.

### 3. Deploy (optional)

`app/netlify.toml` is configured — point Netlify at the `app/` directory and set
`PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` in the site's environment. Any other
Astro-compatible host works too (swap the adapter in `astro.config.mjs`).

## Repository layout

```
app/                  Astro + React frontend
supabase/schema.sql   Full database schema — run once on a fresh project
supabase/functions/   Edge functions (scorecard, daily_loop, draft, prep,
                      resume_content, sweep)
SPEC.md               The original design document, kept for the archaeology
```

## Status & contributions

Fieldwork is in maintenance mode: I'm not adding features, and issues may sit. Forks are
warmly encouraged — it's MIT licensed. If you run a job search with it, I hope it treats
you as well as it treated me.

## License

[MIT](LICENSE) © Olivia Keiter
