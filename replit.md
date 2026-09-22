# Accountability Chat

A private accountability partner that keeps a factual record of commitments, check-ins, predefined consequences, and consent-gated outbound escalation.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/accountability-chat run dev` — run the web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required for live chat: `GEMINI_API_KEY` (stored as a secret)
- Required for Twilio delivery: `TWILIO_FROM_NUMBER`, `ACCOUNTABILITY_USER_PHONE`
- Optional: `ACCOUNTABILITY_USE_CALLS=true` switches reminders from SMS to calls

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
- `artifacts/accountability-chat/src/App.tsx` — web shell and all user-facing routes

## Architecture decisions

- Active goals are server-locked; amendments create a 24-hour edit window and the chatbot cannot bypass it.
- The app stores check-in times as `HH:mm` strings so seeded and newly created goals use the same scheduler format.
- Twilio integration is connected through the Replit connector SDK; outbound contact messages require explicit contact consent.
- Chat uses Google Gemini 2.5 Flash and fails explicitly with HTTP 503 when `GEMINI_API_KEY` is absent instead of returning a fabricated response.

## Product

- Command center with dashboard metrics, today’s check-in, recent facts, and chat
- Proposed goals with explicit confirm-and-lock flow
- Server-enforced 24-hour amendment cooldown for active goals
- Factual event history with filters
- Editable consequence ladder
- Accountability contact setup and separate consent confirmation
- Scheduled Twilio SMS/call reminders and factual contact escalation

## Gotchas

- Run `pnpm --filter @workspace/api-spec run codegen` after changing `lib/api-spec/openapi.yaml`.
- Standalone frontend builds need runtime variables, for example `PORT=4173 BASE_PATH=/ pnpm --filter @workspace/accountability-chat run build`.
- Do not lock seeded goals automatically; they intentionally start as proposed.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
