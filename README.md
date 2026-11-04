# TrustCart Agent

**AI chooses. Your rules authorize.**

An AI shopping assistant that can search and propose carts, while only a server-checked, human-confirmed cart can be paid through PayPal Sandbox. The intent/cart model is inspired by the AP2 Intent/Cart Mandate concepts; it does not claim AP2 compliance.

> Status: early skeleton (Task 001). The full checkout flow, policy engine and chat UI are not finished. Everything runs against PayPal **Sandbox** only.

## Requirements

- Node.js 22 or newer (on Windows you can use `npm.cmd`)
- A PayPal Developer account with a sandbox business (seller) account, a sandbox personal (buyer) account and a sandbox REST app

## Setup

```sh
npm ci                 # or `npm install` if package-lock.json is not present yet
npx prisma generate    # needed if npm skipped install scripts (e.g. allowScripts / --ignore-scripts)
cp .env.example .env   # then fill in values locally
npm run db:setup       # applies prisma/migrations and seeds 30 demo products
npm run dev            # http://localhost:3000
```

## Checks

```sh
npm run typecheck
npm test               # builds a throwaway prisma/test.db from the migrations, then runs tests/*.test.ts
```

## PayPal Sandbox smoke test

Verifies one real sandbox payment end to end: server-priced order → buyer approval → server capture.

1. Fill `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_SANDBOX_MERCHANT_ID` in `.env`.
2. `npm run paypal:smoke -- create` and open the printed approval link.
3. Log in as the **sandbox buyer** and approve.
4. `npm run paypal:smoke -- capture`

The script prints only the order ID, amount, capture status and capture ID. It is a local CLI, not a deployed endpoint. A payment counts as completed only when the capture resource is `COMPLETED` with the expected amount, currency, payee and reference.

## Current limitations

- Single sandbox merchant, USD only, one purchase unit, CAPTURE intent, no refunds.
- Anonymous demo sessions (HttpOnly cookie), no user accounts.
- The 10 prompt-injection fixtures in `data/products.json` carry an `isMalicious` label used for evaluation only; runtime code never reads it.
- SQLite needs a persistent disk in deployment (e.g. one Render service with a disk). Serverless local files are not persistent.

## License

MIT — see [LICENSE](LICENSE).
