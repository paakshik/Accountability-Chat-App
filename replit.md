# Accountability Chat

A private accountability partner that keeps a factual record of commitments, check-ins, predefined consequences, and consent-gated outbound escalation.

## Run & Operate

### Locally (any OS)

- `pnpm install` — installs the workspace
- `pnpm run dev` — runs the API server and the web app together
- Open http://localhost:18666 — the Vite dev server proxies `/api` to the API on 8080

Run the halves separately with `pnpm run dev:api` / `pnpm run dev:web`. `PORT` and
`BASE_PATH` are injected by Replit; outside it they fall back to the values in the
`.replit-artifact` configs, so nothing needs exporting first. If port 8080 is taken,
set `PORT` for the API and `API_PORT` for the web app so the proxy follows.

### Other commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

### Configuration

See `.env.example` for every variable. Nothing is required to boot:

- `GEMINI_API_KEY` — required for chat (Google Gemini). Without it `/api/chat` returns
  503 rather than a fabricated reply, and the UI shows that message. The api-server
  loads a repo-root `.env` on start; `.env` is gitignored, `.env.example` is the template.
- **Free-tier quota is 20 chat requests per day, per model.** Chat starts returning 429
  after that. Enable billing on the Google Cloud project, or point `ACCOUNTABILITY_MODEL`
  at a different model to get a separate daily bucket.
- Twilio delivery has two paths. Set `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` for
  direct REST, which works anywhere and is the only way to reach a phone outside Replit;
  otherwise the Replit connector is used inside Replit. Both need `TWILIO_FROM_NUMBER`
  and `ACCOUNTABILITY_USER_PHONE` in E.164 format. With neither configured, delivery is
  skipped and logged while failure/consequence events are still recorded.
  Verify it with Settings -> Outbound delivery, or `POST /api/selftest/message`.
  `GET /api/healthz` reports which path is active.
- `ACCOUNTABILITY_USE_CALLS=true` switches reminders from SMS to calls.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Storage: Node 24 `node:sqlite` single-file store under `.data/`
- Scheduler: in-process timer with Twilio connector delivery
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for the accountability API contract
- `artifacts/api-server/src/lib/accountability-store.ts` — SQLite schema, seed goals, and domain rules
- `artifacts/api-server/src/lib/scheduler.ts` — check-in reminders, grace follow-up, miss detection, and escalation
- `artifacts/api-server/src/lib/twilio.ts` — consent-gated Twilio SMS/call adapter
- `artifacts/api-server/src/routes/accountability.ts` — goals, events, ladder, contact, dashboard, and chat routes
- `artifacts/api-server/src/lib/accountability-partner.ts` — Gemini client and the system prompt
- `artifacts/api-server/src/middlewares/error-handler.ts` — JSON 404/400/500 responses
- `artifacts/accountability-chat/src/App.tsx` — web shell and all user-facing routes

## Architecture decisions

- Active goals are server-locked; amendments create a 24-hour edit window and the chatbot cannot bypass it.
- The app stores check-in times as `HH:mm` strings so seeded and newly created goals use the same scheduler format.
- Twilio integration is connected through the Replit connector SDK; outbound contact messages require explicit contact consent.
- Chat runs on Google Gemini (`generateContent`) via plain `fetch`. The `@google/genai`
  SDK was deliberately not used: one authenticated POST does not justify ~37 transitive
  packages, and its published tarball ships a `prepare` script whose target file is missing.
- The chatbot has three tools: `log_event` (restricted to `check_in`, `note`,
  `consequence_done`), `log_slip` (the only path to a consequence, and it reads the rung
  from the ladder rather than choosing one), and `propose_goal` (creates `proposed` goals
  only, which still need an explicit lock). It cannot change goal status, edit the ladder
  or touch the contact.
- `POST /api/chat` accepts recent `history` turns for conversational continuity. Without
  it a follow-up like "yes, create it" had no referent and once duplicated every seeded
  goal; `propose_goal` also refuses a name that already exists. Stored state stays the
  authority on facts — the system prompt ranks it above anything said in conversation.
- The injected state carries the exact local date, time, weekday and timezone, plus
  per-goal `checkedInToday` / `checkInOverdueNow`. The partner is instructed to correct
  a false premise about time or state in its first sentence rather than play along.
- Chat fails explicitly with HTTP 503 when `GEMINI_API_KEY` is absent instead of returning a fabricated response.

## Product

- Command center with dashboard metrics, today’s check-in, recent facts, and chat
- Proposed goals with explicit confirm-and-lock flow
- Server-enforced 24-hour amendment cooldown for active goals
- Factual event history with filters
- Editable consequence ladder
- Accountability contact setup and separate consent confirmation (confirming with no
  contact saved is rejected with 409 rather than silently succeeding)
- Scheduled Twilio SMS/call reminders and factual contact escalation

## Consequence ladder

- Rungs are `{ slipMinutes, consequence }`, keyed to how long the slip lasted. A slip
  takes the highest rung at or below its duration; a missed check-in takes the top rung.
- `POST /api/slips` (and the chat `log_slip` tool) writes a `failure` row and a
  `consequence_issued` row quoting the rung verbatim. Consequence text is only ever
  copied from the ladder, never composed.
- **Rungs describing physical self-harm are never issued.** `isInjuriousConsequence` in
  `accountability-store.ts` gates every path — API, chat tool and scheduler — at the
  store layer rather than in a prompt. A flagged rung is recorded as withheld, is not
  returned to the model, and the slip itself is still logged in full. The matcher is a
  narrow keyword guard against automating self-harm, not a general classifier.

## Gotchas

- Run `pnpm --filter @workspace/api-spec run codegen` after changing `lib/api-spec/openapi.yaml`.
- Standalone frontend builds accept runtime overrides, for example `PORT=4173 BASE_PATH=/ pnpm --filter @workspace/accountability-chat run build`.
- Do not lock seeded goals automatically; they intentionally start as proposed.
- Check-in times are stored as local `HH:mm`. Do not send an ISO instant from the client —
  converting through UTC shifts the reminder by the timezone offset.
- The scheduler treats a check-in with no `goalId` as satisfying every scheduled goal,
  because the app submits one check-in for the day (spec section 6).
- `artifacts/api-server/.data/` is regenerated runtime state and is gitignored. Seed goals
  and the default ladder are recreated on first boot against an empty directory.
- `lib/db` (Drizzle/Postgres) is unused scaffolding — the store is `node:sqlite`. It still
  needs `DATABASE_URL` if you ever run its `push` scripts.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
