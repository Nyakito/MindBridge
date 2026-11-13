# MindBridge architecture

## Runtime boundaries

- The React client handles presentation, form state, and authenticated Supabase requests.
- Supabase Auth is the source of identity. A database trigger creates each profile and permits only `client` or `therapist` self-selection; administrator access is provisioned by a trusted operator.
- PostgreSQL Row Level Security controls access to profiles, therapist listings, availability, appointments, agreements, and client entitlements.
- Booking and onboarding use database functions so entitlement consumption, current therapist-term/fee validation, accepted-term snapshots, and agreement records are committed on the server.
- M-Pesa quote, STK Push, and status checks use authenticated Edge Functions. The public callback is intentionally unauthenticated, but callback contents alone never activate a booking entitlement.

## Entitlement policy

- Therapist discovery is free after client onboarding; there are no recurring or unlimited access products.
- `single_session` is the only new purchasable entitlement. It costs exactly USD $1 and covers one MindBridge booking platform fee. M-Pesa is the sole current purchase method.
- Therapist session fees are defined by each therapist, shown separately, and paid directly to the therapist under that therapist's terms. MindBridge does not collect them.
- Booking requires a paid single-session entitlement, an explicit consent flag, the exact current session-terms text, and the exact displayed fee. The appointment stores the accepted terms, fee, acceptance timestamp, and $1 platform fee.
- Legacy entitlement kinds and historic payment rows, including Stripe records, are retained for schema compatibility. Existing free-session credits are zeroed, and old weekly/monthly products cannot be purchased or used to book.
- Booking locks both the selected time slot and entitlement before writing.

## Booking terms and fee

- Therapists maintain a 10–5,000 character session-terms text field alongside their independently set session fee.
- The booking UI displays the current session fee and terms and requires review and acceptance. The booking RPC compares the submitted consent, terms, and fee against the therapist's current database values, preventing stale terms/prices from being accepted.
- `appointments.accepted_session_terms`, `accepted_session_fee_cents`, `session_terms_accepted_at`, and `platform_fee_cents` preserve the booking-time audit record. Existing appointments receive empty/zero values and a null acceptance timestamp because their historical consent and fee snapshots are unavailable.
- The client requests an authenticated quote. The quote Edge Function fetches USD/KES from `https://open.er-api.com/v6/latest/USD`, rejects malformed or more-than-24-hour-old data, rounds USD $1 to a whole KES amount, and records the exact rate, source update time, phone, and amount in the payment row.
- The UI displays the whole-KES charge and published-rate timestamp and requires a separate explicit confirmation before STK Push. Phone numbers are normalized to international `254...` format and checked for Kenyan mobile-number shape.
- `initiate-mpesa-stk` verifies ownership, onboarding, quote age and one-time submission, then requests Daraja OAuth and sends the standard STK fields. Consumer credentials, shortcode, passkey, selected environment, and callback URL are read only from Supabase Edge Function secrets.
- `mpesa-callback` has `verify_jwt = false` because Daraja cannot attach a Supabase token. It correlates the stored checkout and merchant request IDs, validates callback amount, phone, receipt and transaction-date formats against the quote, then calls Daraja STK Query before activation. It can only mark a failure after STK Query confirms result code `1032` (customer cancellation); fake failure callbacks cannot cancel payments.
- `mpesa-payment-status` requires an authenticated user and verifies payment ownership. It retries the provider query when callback processing is delayed; query calls are rate-limited per payment. The service-role-only activation RPC checks the stored quote, request IDs, amount, phone and receipt, sets the payment successful, and creates exactly one entitlement atomically. The callback has no provider signature; STK Query is mandatory, and callback-supplied receipt metadata is format-checked and matched to the stored quote.
- Existing Stripe payment records remain visible for administration. The legacy `create-checkout` function is retired with HTTP 410; the historic Stripe webhook may remain deployed for reconciliation of already-created transactions.

## Folder responsibilities

- `src/app`: router, protected routes, and auth state.
- `src/components`: navigation and reusable interface elements.
- `src/pages`: public and role-specific experiences.
- `src/lib`: backend client, shared domain types, and formatting.
- `supabase/migrations`: schema, triggers, RLS policies, and transactional RPCs.
- `supabase/functions`: Daraja integration that runs with server-only secrets; only the callback is public.

The additive `202611130005_mpesa_booking_payments.sql` migration adds M-Pesa quote/audit columns and service-role-only activation, failure, initiation-claim, and query-throttle RPCs. Existing USD-only migrations and historic Stripe payment records are unchanged.

## Therapist verification and administration

- Therapist registration separates the public practice profile from private legal-name, licence/registration, jurisdiction, expiry, qualification and document information.
- Credential files live in a private `therapist-credentials` bucket. Therapists can access their own files; administrators receive five-minute signed links for review. Credential paths are checked against the applicant folder and actual stored objects before approval.
- Therapist status changes are controlled through the administrator review RPC. Rejection requires a reason, review actions are audited, and changes to registration details reopen a rejected application for review.
- Profile photos use a separate public bucket and contain only information the therapist chose to publish.
- The admin workspace provides an overview and searchable sections for accounts, therapist applications, appointments, payments, reviews and support tickets.
- Support requests are private to the requester and administrators. Users are warned not to submit emergency or sensitive clinical information through general support.

## Production readiness

The migrations and screens establish the core flow; this is not a clinical record system or a substitute for legal review. Before launch, confirm professional credential requirements for every operating jurisdiction, ensure therapist payment terms comply with applicable rules, complete the remaining product scope listed in the README, review RLS and Edge Function behavior against a real Supabase project, configure backups and monitoring, and perform security and privacy testing with test accounts for each role.
