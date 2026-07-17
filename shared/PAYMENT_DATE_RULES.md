# Payment / term date rules (shared)

**Canonical module:** [`paymentDateRules.js`](./paymentDateRules.js)

**Server authority:** API still validates with Zod and `utils/memberPayments.js` `validatePaymentDate`. Clients use these helpers for pickers and client-side checks only.

## Sync checklist

When changing a payment/term date rule, update in the **same PR**:

1. [`vibe/shared/paymentDateRules.js`](./paymentDateRules.js)
2. [`vibe-frontend/src/utils/paymentDateRules.js`](../../vibe-frontend/src/utils/paymentDateRules.js) (mirror)
3. [`vibe-mobile/src/utils/paymentDateRules.ts`](../../vibe-mobile/src/utils/paymentDateRules.ts) (mirror)
4. API `validatePaymentDate` / Zod refine if server message or rule changes

## Rules (ISO `YYYY-MM-DD`)

| Rule | Meaning |
|------|---------|
| Payment on term | `termStart ≤ payment ≤ today` |
| Term start with payment | term start `≤ today` |
| Enroll start (paying) | start `≤ today`; skip-payment allows future |
| Custom report range | `from ≤ to ≤ today` |
