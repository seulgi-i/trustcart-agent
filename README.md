# TrustCart Agent

**AI chooses. Your rules authorize.** — built for the PayPal AI Hackathon.

TrustCart is an agentic-commerce demo: an AI shopping agent searches a catalog and proposes carts, but only a server-checked cart that a human confirms in the **approval inbox** can be paid through **PayPal Sandbox**. Seller-written product data is treated as untrusted, so prompt injection hidden in a product description cannot make the agent buy, change the budget or pay. The intent/cart model is inspired by the AP2 Intent/Cart Mandate concepts; it does not claim AP2 compliance.

Everything runs against PayPal **Sandbox** (or a labeled mock provider). No real money moves.

## Architecture

- **Next.js 16 (App Router) + TypeScript.** UI pages in `app/`, API route handlers in `app/api/`, and the demo password gate in `proxy.ts` (Next 16's replacement for `middleware.ts`).
- **Agent** (`lib/agent.ts`, `app/api/chat/route.ts`): Vercel AI SDK `streamText` with three tools: `searchProducts`, `buildCart` and `checkout`. Works with Gemini (default, free tier), OpenAI or Anthropic.
- **Domain** (`src/domain/`): `policy.ts` evaluates a cart against the user's purchase intent (budget, category, quantity, stock) and returns `ALLOW`, `NEEDS_APPROVAL` or `DENY`; `scanner.ts` flags injection-like text in untrusted seller content; `money.ts` does integer-cent math.
- **Server** (`src/server/`): orders and the approval state machine (`orders.ts`), anonymous demo sessions (`session.ts`), the payment provider (`payments/` — PayPal Sandbox REST or mock), chat rate limits (`rate-limit.ts`) and the demo gate (`demo-gate.ts`).
- **Data**: Prisma + PostgreSQL. The catalog is seeded from `data/products.json` (30 products, 10 of them carrying prompt-injection payloads). `AuditLog` is append-only, enforced by database triggers.

Flow: the user saves a purchase intent in a form → the agent searches and builds a cart → the server evaluates it → the order shows up in the approval inbox → the human approves → the server creates the PayPal order at the server-computed price → the buyer approves on PayPal → the server verifies and captures.

## Security model

- **The model never holds authority.** Purchase intent is set only through the UI form. The model cannot approve, set prices or capture payments; checkout re-evaluates the server's copy of the cart, never model-supplied amounts.
- **Prompt-injection defense.** Seller text is wrapped as `<untrusted_data>` and scanned; a turn that read untrusted content cannot also check out (checkout requires a fresh user turn). Off-intent searches are refused before any catalog read.
- **Human approval inbox.** `NEEDS_APPROVAL` orders wait for an explicit human decision; `DENY` can never be approved; reject never touches the payment provider.
- **Payment integrity.** The amount is recomputed from the catalog right before order creation; capture happens only after the PayPal order is fetched fresh and verified (amount, currency, payee, reference). Sandbox host is hard-pinned.
- **Session ownership.** Every order lookup is filtered by the HttpOnly session cookie, so a foreign order ID behaves like a missing one. Mutating routes check `Origin`.
- **Demo gate.** When `DEMO_PASSWORD` is set, `proxy.ts` requires an HMAC-signed `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production) for every page and API route except `/login` and `/api/login`. The password is compared in constant time and login attempts are limited to 10 per IP per 15 minutes.
- **Cost control.** `/api/chat` is rate limited in the database (default 10 requests per session per hour and 30 per IP per day) and answers `429` with a Korean message. Model calls use `maxRetries: 0`, so a provider quota error is shown once as "AI가 잠시 쉬고 있어요..." instead of being retried. Payments and the approval inbox do not depend on the AI and keep working.
- **Audit trail.** Agent tool calls, decisions and payment steps are written to an append-only `AuditLog`.

See `docs/SECURITY.md` for more detail.

## Setup

Requirements: Node.js 22+, a PostgreSQL database (Supabase, Neon or local) and, for real sandbox payments, a PayPal Developer account with a sandbox REST app.

```sh
npm ci                 # runs `prisma generate`
cp .env.example .env   # then fill in values locally (placeholders only in the example)
npm run db:setup       # prisma migrate deploy + seed 30 demo products (the seed reads .env)
npm run dev            # http://localhost:3000
```

Deploying to Vercel: set the environment variables below in the project settings (at least `DATABASE_URL`, `DIRECT_URL`, `APP_BASE_URL`, `DEMO_PASSWORD` and an AI key), run `npm run db:setup` once against the production database, then deploy. `npm run build` does not need a live database.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string used at runtime (pooled URL on Supabase/Neon). |
| `DIRECT_URL` | yes | Direct (non-pooled) Postgres URL used by `prisma migrate`. Same as `DATABASE_URL` for local Postgres. |
| `APP_BASE_URL` | production | Public origin for PayPal return/cancel URLs. Falls back to `https://$VERCEL_URL`, then `http://localhost:3000` outside production. |
| `DEMO_PASSWORD` | no | Enables the password gate. Unset = gate disabled. |
| `SESSION_SECRET` | no | Extra secret for signing the gate cookie. If unset, the key is derived from `DEMO_PASSWORD`. |
| `RATE_LIMIT_SESSION_PER_HOUR` | no | Chat requests per demo session per hour (default `10`). |
| `RATE_LIMIT_GLOBAL_PER_DAY` | no | Chat requests per client IP per day (default `30`). |
| `GOOGLE_GENERATIVE_AI_API_KEY` | one AI key | Google AI Studio key (free tier). |
| `GOOGLE_MODEL` | no | Gemini model override. Default `gemini-3.5-flash`. |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | one AI key | OpenAI key and model (default `gpt-4.1-mini`). Takes precedence if set. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | one AI key | Anthropic key and model (default `claude-sonnet-4-5`). |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | no | Sandbox REST app credentials. Empty = labeled mock provider. |
| `PAYPAL_SANDBOX_MERCHANT_ID` | with PayPal | Merchant ID of the sandbox business account that receives payments. |
| `TEST_DATABASE_URL` | no | Throwaway Postgres for DB integration tests (see Testing). |

**Dev vs demo model.** The default `gemini-3.5-flash` supports tool calling on the free tier and is what the public demo should use. While developing, point `GOOGLE_MODEL` at a cheaper or less contended model (or use a separate key) so day-to-day testing does not spend the demo's free-tier quota. If Gemini returns 404/503 for a model, try another via `GOOGLE_MODEL`.

## PayPal Sandbox

1. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_SANDBOX_MERCHANT_ID` (sandbox app only). Without them the app uses the mock provider.
2. Approve (or confirm) an order in the inbox, click Pay, approve on PayPal, and you return to `/checkout/return`, which verifies and captures.
3. **Sandbox test buyer:** log in on PayPal with a **US Personal** sandbox buyer account, created under *Testing Tools → Sandbox Accounts* at [developer.paypal.com](https://developer.paypal.com). KR Business and KR Personal sandbox buyers are blocked for this flow. No credentials are included in this repository.
4. `npm run paypal:smoke -- create` / `-- capture` runs one manual end-to-end sandbox payment from the CLI. It is never run by `npm test` or in CI.

## Testing

```sh
npm run typecheck
npm test
npm run build
```

Test database strategy:

- **Unit tests** (`tests/*.test.ts`) need no database and always run: policy, scanner, catalog, PayPal request contracts (mocked `fetch`), the demo gate and proxy, rate limiting (against an in-memory fake of the Prisma `rateLimit` delegate), AI error mapping and checkout URL derivation.
- **DB integration tests** (`tests/*.db.test.ts`: sessions, approval inbox, checkout state machine, chat rate limit) run only when `TEST_DATABASE_URL` points at a **throwaway** Postgres database. The runner applies the migrations to it first. Without it they are skipped with a notice, and Prisma is given an unreachable URL so no test can touch your dev or production database.
- Tests never call a live LLM or PayPal: AI keys and PayPal credentials are blanked by `scripts/test.ts`, and payment tests use mock providers or mocked `fetch`.

```sh
TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/trustcart_test" npm test
```

## Current limitations

- Single sandbox merchant, USD only, one purchase unit, CAPTURE intent, no refunds.
- Anonymous demo sessions (HttpOnly cookie), no user accounts.
- The 10 prompt-injection fixtures in `data/products.json` carry an `isMalicious` label used for evaluation only; runtime code never reads it.
- The per-IP rate limit trusts the first `X-Forwarded-For` hop, which Vercel sets. Behind a proxy that passes client-supplied headers through, treat it as a soft limit.

## AI tools used

Built with help from **Claude Code**, **Codex**, **Grok** and **Gemini** (Gemini also powers the in-app agent by default).

## License

MIT — see [LICENSE](LICENSE).
