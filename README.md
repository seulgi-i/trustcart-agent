# TrustCart Agent

**AI chooses. Your rules authorize.** — built for the PayPal AI Hackathon.

TrustCart is an agentic-commerce demo: an AI shopping agent searches a catalog and proposes carts, but only a server-checked cart that a human confirms in the **approval inbox** can be paid through **PayPal Sandbox**. Seller-written product data is treated as untrusted, so prompt injection hidden in a product description cannot make the agent buy, change the budget or pay. The intent/cart model is inspired by the AP2 Intent/Cart Mandate concepts; it does not claim AP2 compliance.

Everything runs against PayPal **Sandbox** (or a labeled mock provider). No real money moves.

## Features

- **English UI and agent.** All pages, agent replies, tool descriptions and error messages are in English; the demo catalog uses the `Camping` and `Household` categories.
- **Two-layer spending policy (`/policy`).**
  - **Layer 1 — system limits (fixed).** Prompt-injection scan and intent-vs-cart match (→ review); server-side price finalization (catalog price, stock, $500 per payment, 20 units per line → deny); velocity limit (default 3 payments per 30 min); split-payment detection (payments for the same product or seller within 60 min may not add up to more than one payment may be); duplicate-payment blocking (same cart and total within 10 min); daily and monthly hard caps (UTC). Server constants plus `LAYER1_*` env; users cannot disable or raise them.
  - **Layer 2 — your settings, inside Layer 1.** Per-order maximum, daily maximum, allowed categories with optional per-category limits, an "always review above" threshold (0 = review everything), allowed hours and weekdays in your IANA time zone (default `America/New_York`; end hour exclusive, overnight windows allowed), and the pre-charge delay (30 s–10 min, default 60 s). Validated with Zod against the Layer-1 bounds; the agent has no tool to change it.
  - **24 h cool-down on loosening.** Tightening applies immediately. Anything that loosens (higher caps or threshold, shorter delay, more categories/hours/days, a removed category limit, a time-zone change while hours or days are restricted) is stored as pending and takes effect 24 hours later, promoted on the next read. A mixed save applies the tightened parts now and holds the rest.
  - The review inbox shows each rule hit as `Layer n · rule` with a message, e.g. *Layer 1 · Split-payment detection*, *Layer 2 · Outside allowed hours*.
- **Pre-charge countdown.** When the buyer returns from PayPal, nothing is captured yet: a notice says *"Payment scheduled: $X to &lt;merchant&gt; for &lt;items&gt;. Capture in N seconds — Cancel"*, where N is your Layer-2 pre-charge delay. The server refuses the capture until that delay has passed on its own clock, and refuses it for good after Cancel.
- **Post-payment protection (`/orders`).**
  - **Signed intent mandate.** Every successful capture writes, in the same transaction, a certificate inspired by the AP2 Mandate concept: your intent (budget, quantity, category), the approved cart (items, quantities, unit prices, shipping, total, merchant), why each item was picked (the agent's own note, marked untrusted, plus server checks), the applied policy (Layer-1 limits, effective Layer-2 values, decision reasons), timestamps and the PayPal order and capture IDs. It is canonical JSON (sorted keys) signed with **Ed25519** (`node:crypto`) using `MANDATE_SIGNING_KEY`; the fingerprint is the sha256 of the public key's SPKI DER. Without the key, development uses a public dev key with a warning and production refuses to capture. `GET /api/mandate/public-key` publishes the key; each order page has **Verify signature**.
  - **Billing mismatch check (demo).** Simulate the merchant's billing (`none`, `extra_quantity`, `hidden_fee`, `price_change`) and compare it with the mandate; differences are listed as `{ field, expected, actual }` and shown in red.
  - **Refunds.** A mismatch creates a refund draft with the evidence (mandate + diff) and a suggested partial amount (the overcharge). On your click the server calls PayPal `POST /v2/payments/captures/{id}/refund` (partial with an amount, full without) with a `PayPal-Request-Id` derived from the order and mismatch. The server checks ownership, `0 < amount <= captured - already refunded`, and allows one refund per mismatch (unique constraint + idempotency key). Drafts and results are audited.
  - **Evidence package.** JSON or PDF download (mandate, verification result, diffs, order and capture IDs, audit trail). The PDF is written by a small built-in generator. No dispute is opened.
- **Human approval inbox, prompt-injection defense and verified PayPal Sandbox capture** (see Security model).

## Architecture

- **Next.js 16 (App Router) + TypeScript.** UI pages in `app/`, API route handlers in `app/api/`, and the demo password gate in `proxy.ts` (Next 16's replacement for `middleware.ts`).
- **Agent** (`lib/agent.ts`, `app/api/chat/route.ts`): Vercel AI SDK `streamText` with three tools: `searchProducts`, `buildCart` and `checkout`. Works with Gemini (default, free tier), a local Ollama model, an offline mock model, OpenAI or Anthropic (see AI providers).
- **Domain** (`src/domain/`): `policy.ts` evaluates a cart against the Layer-1 rules (intent, price finalization, payment history) and the Layer-2 settings and returns `ALLOW`, `NEEDS_APPROVAL` or `DENY` with `{ layer, ruleId, message }` reasons; `layer1.ts` holds the system limits and their env parsing; `spending-policy.ts` holds the Layer-2 defaults, the Zod schema, the time-window helpers and the cool-down classifier; `rule-labels.ts` maps rule IDs to labels; `scanner.ts` flags injection-like text in untrusted seller content; `money.ts` does integer-cent math.
- **Server** (`src/server/`): orders, the approval state machine, the session spending policy and the pre-charge schedule (`orders.ts`), anonymous demo sessions (`session.ts`), the payment provider (`payments/` — PayPal Sandbox REST or mock), chat rate limits (`rate-limit.ts`) and the demo gate (`demo-gate.ts`).
- **Data**: Prisma + PostgreSQL. The catalog is seeded from `data/products.json` (30 products, 10 of them carrying prompt-injection payloads). `SessionPolicy` stores the effective Layer-2 policy per session (no row = defaults) plus a pending loosening and its `pendingEffectiveAt`; `Order.captureScheduledAt` / `captureCanceled` drive the pre-charge notice. `Mandate` (1:1 with a paid order; immutable via a trigger) holds the signed payload, signature and key fingerprint; `RefundRequest` holds one draft per order and mismatch scenario with its evidence and refund result. `AuditLog` is append-only, enforced by database triggers.

Flow: the user saves a purchase intent (and optionally a spending policy) → the agent searches and builds a cart → the server evaluates it → the order shows up in the approval inbox → the human approves → the server creates the PayPal order at the server-computed price → the buyer approves on PayPal → the pre-charge notice counts down (cancellable) → the server verifies and captures.

## Security model

- **The model never holds authority.** Purchase intent is set only through the UI form. The model cannot approve, set prices or capture payments; checkout re-evaluates the server's copy of the cart, never model-supplied amounts.
- **Prompt-injection defense.** Seller text is wrapped as `<untrusted_data>` and scanned; a turn that read untrusted content cannot also check out (checkout requires a fresh user turn). Off-intent searches are refused before any catalog read.
- **Human approval inbox.** `NEEDS_APPROVAL` orders wait for an explicit human decision; `DENY` can never be approved; reject never touches the payment provider.
- **Two-layer spending policy.** One evaluation (`evaluateCheckout` in `orders.ts`, which loads the effective policy and this session's payment history and calls the pure `evaluateCart`) runs at cart preview, at order creation and again right before the payment is created, so a cart cannot pass the preview and slip past a rule at payment time. Layer-1 velocity, split-payment, duplicate and daily/monthly caps count orders in `PAYMENT_CREATING`, `AWAITING_PAYMENT`, `CAPTURING` or `PAID` by their last payment step, so approving a stack of old orders counts as paying now. Layer-1 money rules and Layer-2 caps and time windows are `DENY`; the scanner, intent match, approval threshold and categories outside the allowed list are `NEEDS_APPROVAL`. Layer 2 is edited only by the session owner on `/policy` (strict Zod validation against the Layer-1 bounds, audited as `setPolicy` with outcome `APPLIED`, `PENDING` or `PROMOTED`); there is no agent tool for it.
- **Payment integrity.** The amount is recomputed from the catalog right before order creation; capture happens only after the PayPal order is fetched fresh and verified (amount, currency, payee, reference). Sandbox host is hard-pinned.
- **Pre-charge notice.** Capture returns `409` unless the notice was scheduled (`captureScheduledAt`), the session's effective `prechargeDelaySeconds` have passed on the server clock and the buyer did not cancel (`captureCanceled`). The schedule and cancel are audited (`prechargeSchedule`, `prechargeCancel`); no in-memory timer is trusted.
- **Session ownership.** Every order lookup is filtered by the HttpOnly session cookie, so a foreign order ID behaves like a missing one. Mutating routes check `Origin`.
- **Demo gate.** When `DEMO_PASSWORD` is set, `proxy.ts` requires an HMAC-signed `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production) for every page and API route except `/login` and `/api/login`. The password is compared in constant time and login attempts are limited to 10 per IP per 15 minutes.
- **Cost control.** `/api/chat` is rate limited in the database (default 10 requests per session per hour and 30 per IP per day) and answers `429` with a friendly English message. Model calls use `maxRetries: 0`, so a provider quota error is shown once as "AI is taking a short break..." instead of being retried. Payments and the approval inbox do not depend on the AI and keep working.
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
| `MANDATE_SIGNING_KEY` | production | Base64 of a PKCS8 PEM **Ed25519** private key that signs intent mandates. Unset outside production = a public development key (with a warning); unset in production = captures are refused. Generate with `node -e "const{generateKeyPairSync:g}=require('crypto');console.log(Buffer.from(g('ed25519').privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'))"`. |
| `DEMO_PASSWORD` | no | Enables the password gate. Unset = gate disabled. |
| `SESSION_SECRET` | no | Extra secret for signing the gate cookie. If unset, the key is derived from `DEMO_PASSWORD`. |
| `RATE_LIMIT_SESSION_PER_HOUR` | no | Chat requests per demo session per hour (default `10`). |
| `RATE_LIMIT_GLOBAL_PER_DAY` | no | Chat requests per client IP per day (default `30`). |
| `LAYER1_VELOCITY_MAX` / `LAYER1_VELOCITY_WINDOW_MINUTES` | no | Layer 1: at most N payments per session within M minutes (default `3` / `30`). |
| `LAYER1_SPLIT_SINGLE_LIMIT_CENTS` / `LAYER1_SPLIT_WINDOW_MINUTES` | no | Layer 1: payments for the same product or seller within the window may not exceed this total (default `50000` = the hard cap, its maximum / `60`). |
| `LAYER1_DUPLICATE_WINDOW_MINUTES` | no | Layer 1: same cart and total within this window is a duplicate (default `10`). |
| `LAYER1_DAILY_HARD_CAP_CENTS` / `LAYER1_MONTHLY_HARD_CAP_CENTS` | no | Layer 1: committed money per UTC day / month (default `500000` / `2000000`; monthly is never below daily). The user's daily maximum must fit under the daily cap. |
| `AI_PROVIDER` | no | `mock`, `ollama` or `gemini` (see AI providers). Leave unset on Vercel. |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | with ollama | Ollama's OpenAI-compatible endpoint and model (default `http://localhost:11434/v1`, `qwen2.5:7b`). |
| `AI_RECORD` | no | `1` = record ollama/gemini turns as mock replay fixtures (local only). |
| `GOOGLE_GENERATIVE_AI_API_KEY` | one AI key | Google AI Studio key (free tier). |
| `GOOGLE_MODEL` | no | Gemini model override. Default `gemini-3.5-flash`. |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | one AI key | OpenAI key and model (default `gpt-4.1-mini`). Takes precedence if set. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | one AI key | Anthropic key and model (default `claude-sonnet-4-5`). |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | no | Sandbox REST app credentials. Empty = labeled mock provider. |
| `PAYPAL_SANDBOX_MERCHANT_ID` | with PayPal | Merchant ID of the sandbox business account that receives payments. |
| `TEST_DATABASE_URL` | no | Throwaway Postgres for DB integration tests (see Testing). |

**Dev vs demo model.** The default `gemini-3.5-flash` supports tool calling on the free tier and is what the public demo should use. While developing, point `GOOGLE_MODEL` at a cheaper or less contended model (or use a separate key) so day-to-day testing does not spend the demo's free-tier quota. If Gemini returns 404/503 for a model, try another via `GOOGLE_MODEL`.

### AI providers

`/api/chat` picks its model in `src/server/ai/provider.ts`:

- **`AI_PROVIDER=gemini`**: Gemini via `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_MODEL`. This is what deployments use: when `AI_PROVIDER` is unset and `VERCEL=1`, `VERCEL_ENV` or `NODE_ENV=production` is set, the app always uses Gemini (and fails with a clear error if the Google key is missing), so do not set `AI_PROVIDER` on Vercel.
- **`AI_PROVIDER=ollama`**: a local model through Ollama's OpenAI-compatible Chat Completions API (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`, default `qwen2.5:7b`, which supports tool calling). Run `ollama pull qwen2.5:7b` first.
- **`AI_PROVIDER=mock`**: an offline, deterministic model (`src/server/ai/mock-model.ts`) that still runs the real `streamText` loop, the real shopping tools, the scanner and the policy. It replays fixtures from `tests/fixtures/ai/*.json` keyed by the system prompt's first sentence, the last user message and the saved intent; without a matching fixture it follows a small script (search, then build a cart with the named or cheapest unflagged product, then summarize; checkout only when the user asks). `npm test` always uses it.
- **Unset, locally**: the old precedence by key (OpenAI, then Anthropic, then Google). An explicit `AI_PROVIDER` always wins over any key.

To record new fixtures, run locally with `AI_PROVIDER=ollama` (or `gemini`) and `AI_RECORD=1`; each chat turn is written to `tests/fixtures/ai/<hash>.json` (tool names, tool inputs and the model's text; tool results are recomputed on replay). Commit the files you want `AI_PROVIDER=mock` to replay.

## PayPal Sandbox

1. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_SANDBOX_MERCHANT_ID` (sandbox app only). Without them the app uses the mock provider.
2. Approve (or confirm) an order in the inbox, click Pay, approve on PayPal, and you return to `/checkout/return`, which shows the pre-charge countdown (with Cancel) and then verifies and captures.
3. **Sandbox test buyer:** log in on PayPal with a **US Personal** sandbox buyer account, created under *Testing Tools → Sandbox Accounts* at [developer.paypal.com](https://developer.paypal.com). KR Business and KR Personal sandbox buyers are blocked for this flow. No credentials are included in this repository.
4. `npm run paypal:smoke -- create` / `-- capture` runs one manual end-to-end sandbox payment from the CLI. It is never run by `npm test` or in CI.
5. `npm run paypal:refund-smoke` then refunds $1.00 of that capture (rerunning returns the same refund), and `npm run paypal:disputes-check` checks that the app can reach `GET /v1/customer/disputes`. Both are local-only and print only statuses, IDs and amounts.

## Testing

```sh
npm run typecheck
npm test
npm run build
```

Test database strategy:

- **Unit tests** (`tests/*.test.ts`) need no database and always run: policy, scanner, catalog, PayPal request contracts (mocked `fetch`), the demo gate and proxy, rate limiting (against an in-memory fake of the Prisma `rateLimit` delegate), AI error mapping and checkout URL derivation.
- **DB integration tests** (`tests/*.db.test.ts`: sessions, approval inbox, checkout state machine, chat rate limit, mandates and refunds) run only when `TEST_DATABASE_URL` points at a **throwaway** Postgres database. The runner applies the migrations to it first. Without it they are skipped with a notice, and Prisma is given an unreachable URL so no test can touch your dev or production database.
- Tests never call a live LLM or PayPal: AI keys and PayPal credentials are blanked and `AI_PROVIDER=mock` is forced by `scripts/test.ts`, and payment tests use mock providers or mocked `fetch`. `tests/ai-provider.test.ts` covers provider resolution and runs the mock model through `streamText` with in-memory tools (happy path, a flagged red-team product, an intent mismatch, record/replay).

```sh
TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/trustcart_test" npm test
```

## Current limitations

- Single sandbox merchant, USD only, one purchase unit, CAPTURE intent. Refunds are tied to a (simulated) billing mismatch; there is no free-form refund and no dispute creation.
- The billing check simulates the merchant's fulfillment data; a real integration would compare the mandate with the merchant's actual invoice.
- Anonymous demo sessions (HttpOnly cookie), no user accounts.
- The 10 prompt-injection fixtures in `data/products.json` carry an `isMalicious` label used for evaluation only; runtime code never reads it.
- The per-IP rate limit trusts the first `X-Forwarded-For` hop, which Vercel sets. Behind a proxy that passes client-supplied headers through, treat it as a soft limit.

## AI tools used

Built with help from **Claude Code**, **Codex**, **Grok** and **Gemini** (Gemini also powers the in-app agent by default).

## License

MIT — see [LICENSE](LICENSE).
