# Loan Disbursement on Temporal

This is a design and working prototype for the loan disbursement case study. Applications arrive from three channels: the portal, broker email and aggregator batch files. Each application is a Temporal workflow that runs validation, third-party enrichment, product underwriting, human review, e-signature and disbursement. Every application ends **FUNDED**, **DECLINED** or **ESCALATED**.

Orchestration is built around **child workflows at isolation seams**: one parent workflow per application owns the lifecycle and every wait on a person, and four kinds of child workflow handle the non-interactive stages (enrichment, underwriting per product, disbursement, billing).

## Case study deliverables

| The brief asks for | Where it is |
|---|---|
| **Workflow definition**: model the workflow in Temporal | [Design](#design) below; [diagrams 1 to 3](docs/diagrams.md); code sample [1](docs/code-samples.md#1-the-parent-workflow-owns-the-lifecycle) and [2](docs/code-samples.md#2-child-workflows-at-isolation-seams) |
| **Activity design**: define activities and how they're used | [Activities](#activities), [Third-party failures](#third-party-failures-rate-limits-and-downtime), [What is safe to retry](#what-is-safe-to-retry); code samples [8 to 12](docs/code-samples.md#8-activity-design-a-retry-policy-for-each-kind-of-call) |
| **Human in the loop**: pause for review, resume seamlessly | [Human in the loop](#human-in-the-loop), [Hand-offs and expiring sessions](#hand-offs-and-expiring-sessions); [diagrams 4 and 4b](docs/diagrams.md#4-human-in-the-loop); code samples [3 to 5](docs/code-samples.md#3-the-external-api-signals-updates-and-a-query) |
| **Diagrams** (required) | [docs/diagrams.md](docs/diagrams.md): nine Mermaid diagrams, rendered on GitHub. The console's Flow page also draws the state machine and a Sankey live. |
| **Code samples** (required), bonus if a workflow runs locally | [docs/code-samples.md](docs/code-samples.md): the 16 pieces of code that define the architecture. The full prototype runs locally with `npm install` then `npm run demo`, and has 69 tests: 40 end-to-end against a real Temporal dev server, 2 replay tests and 27 unit tests. |
| **Documentation** (required) | This README (design and trade-offs), [PLAN.md](PLAN.md) (the Claude plan file, with each iteration), [HOW-TO-USE.md](HOW-TO-USE.md) (a user guide with screenshots) and [docs/glossary.md](docs/glossary.md) (lending and Temporal terms) |
| **UI** (optional) | The ops console, in PocketHealth branding: live Sankey, cases, review queue with claims, SLA watch board, audit trail with CSV and PDF exports, billing with invoices, and a Health tab for simulating outages. See [HOW-TO-USE.md](HOW-TO-USE.md). |
| **Cloud or deployment configs** (optional) | Not built. [Scaling](#scaling-to-50000-applications-a-month) and [What I'd do next](#what-id-do-next) describe the production topology. |
| **Trade-offs** | [Trade-offs](#trade-offs) and [Prototype limits](#prototype-limits) |

The six "things to consider":

| Question | Answered in |
|---|---|
| How do you reliably ingest from three very different input channels? | [Ingesting from three channels](#ingesting-from-three-channels-no-master-queue) · samples [6](docs/code-samples.md#6-one-idempotent-start-path-for-three-channels), [7](docs/code-samples.md#7-aggregator-files-fan-out-with-continueasnew) · diagrams [1](docs/diagrams.md#1-system-architecture), [6](docs/diagrams.md#6-when-temporal-itself-is-unreachable) |
| What does the application lifecycle look like as a state machine? | [Lifecycle as a state machine](#lifecycle-as-a-state-machine) · diagram [3](docs/diagrams.md#3-application-lifecycle) · sample [1](docs/code-samples.md#1-the-parent-workflow-owns-the-lifecycle) |
| How do you handle third-party failures, rate limits, and partial failures mid-workflow? | [Third-party failures, rate limits and downtime](#third-party-failures-rate-limits-and-downtime) · diagram [5](docs/diagrams.md#5-third-party-failures-and-downtime) · samples [8 to 12](docs/code-samples.md#8-activity-design-a-retry-policy-for-each-kind-of-call) |
| How do you isolate loan product logic so one product's behavior doesn't bleed into another? | [Keeping product logic isolated](#keeping-product-logic-isolated) · samples [2](docs/code-samples.md#2-child-workflows-at-isolation-seams), [13](docs/code-samples.md#13-product-logic-behind-one-interface) |
| How do you know when something is broken, and how does an operator investigate? | [Knowing when something is broken](#knowing-when-something-is-broken-and-investigating), [SLA watch](#sla-watch), [Auditability](#auditability) · sample [14](docs/code-samples.md#14-knowing-when-something-is-broken-sla-watchdog-and-audit) |
| How and when does a human enter the loop, and how does the workflow resume after their decision? | [Human in the loop](#human-in-the-loop) · diagrams [4](docs/diagrams.md#4-human-in-the-loop), [4b](docs/diagrams.md#4b-review-claims-a-lease-like-a-web-session) · samples [3 to 5](docs/code-samples.md#3-the-external-api-signals-updates-and-a-query) |

The constraints are covered too: [scaling to 50,000 a month](#scaling-to-50000-applications-a-month), [products with distinct rules](#keeping-product-logic-isolated), [auditable decisions](#auditability), and [billing on disbursed loans](#billable-workflows).

## Run it

> **New here, or not technical?** Read **[HOW-TO-USE.md](HOW-TO-USE.md)**: setup in two commands, a 10-minute tour and every page explained with screenshots.

Requires Node 20+. Nothing else needs installing: no Temporal CLI, Docker or database. The first start downloads the Temporal dev server once.

```bash
npm install
```

```bash
npm run demo
```

`npm run demo` starts the Temporal dev server, all workers and the ops console in one terminal, then loads the Showcase pack. Use `npm start` for an empty console. Ctrl+C stops everything. Ports can be changed with `PORT`, `TEMPORAL_PORT` and `TEMPORAL_UI_PORT`.

```bash
npm test
```

To run the pieces separately (for example, restarting workers while applications are in flight), use `npm run server`, `npm run worker` and `npm run ui`, each in its own terminal.

Then:
1. Open **http://localhost:3000**.
2. **One scenario:** choose it in **Choose a scenario…**, then click **Synthesize**. Choosing alone starts nothing.
3. **Many at once:** click **Synthesize many…**. Pick **Random mix** (for example 200 applications, Realistic) or **Scenario pack** (**Showcase: every path**, 20 scenarios, three left for you to drive), then **Start run**.
4. **Review:** open a case from **Review queue**, **Claim** it, decide. The claim counts down and must be extended, or the case goes back to the queue (see below).
5. **Outages:** on the **Health** tab, switch a provider off (say *fraud*), start a few scenarios, and watch them park in `AWAITING_PROVIDER` while the circuit opens. Switch it back on and they resume.
6. **Billing:** the **Billing** tab lists one charge per funded loan, totals by business line, the billable rate, and an invoice PDF per account and month.
7. **SLA watch:** the **SLA watch** board shows open applications that have breached, are at risk, or have gone stale, least time left first. **Needs a person** narrows it to reviews, documents and signatures. To fill it in about a minute, run the **SLA pressure** pack (Synthesize many… › Scenario pack): 3 applications breach, 3 are flagged at risk and 2 go stale, each on a shortened SLA clock.
8. **Reset:** **Clear synthesized** deletes every application started from a scenario, a pack or the synthesizer, with its child workflows, and starts a fresh audit log (the old one is archived under `audit/archive/`). It asks first and shows exactly what it will delete.

The Temporal UI is at http://localhost:8233. Every case links to its parent and child runs there.

### CLI

```bash
npm run ingest                    # list scenarios and packs
npm run ingest -- showcase        # 20 scenarios started together, one per path (+1 duplicate delivery)
npm run ingest -- sla-pressure    # 10 scenarios that breach, go at risk or go stale within a minute
npm run ingest -- fraud           # -> HUMAN_REVIEW, waits for a person
npm run review -- <id> claim --reviewer alice
npm run review -- <id> approve --reviewer alice --reason "Device change explained"
npm run ingest -- four-eyes       # needs two different approvers
npm run ingest -- missing-docs    # -> AWAITING_DOCS
npm run upload-docs -- <id> PAYSTUB
npm run ingest -- esign           # approved, waits for the signature
npm run sign -- <id>              # simulates the e-sign webhook
npm run ingest -- duplicate       # same broker email twice -> one workflow
npm run ingest -- batch           # aggregator CSV: 4 started, 1 rejected row, 1 duplicate absorbed
npm run synthesize -- --count 200 --mix stress
npm run provider -- fraud down    # simulate a vendor outage (up brings it back and nudges parked apps)
npm run provider                  # provider status and circuit breakers
npm run status                    # by state, from Visibility
npm run status -- <id>            # full view: children, history, decisions
```

The demo uses shortened timers: a 45s docs and signature reminder, a 90s lapse, a 4-minute overall SLA, 10-minute reviews, and provider parking that retries at 4s, 8s and 15s within a 45s outage budget. The production defaults are `DEFAULT_TIMING` in `src/shared/types.ts`. Audit events go to `audit/audit.jsonl`.

## Code map

| Path | What |
|---|---|
| `src/workflows/loanApplication.ts` | Parent: lifecycle, waits on people, SLA watchdog, audit, search attributes |
| `src/workflows/enrichment.ts` | Child: shared credit, identity and fraud fan-out with `allSettled` |
| `src/workflows/underwriting.ts` | Children: one workflow type per product |
| `src/workflows/disbursement.ts` | Child: book, pay out (idempotent), confirm |
| `src/workflows/definitions.ts` | The parent's external API: signals, update and query |
| `src/workflows/batchIngest.ts`, `synthesize.ts` | Aggregator file fan-out and the scenario synthesizer |
| `src/products/` | `ProductPolicy` per product: documents, limits, checks, rules, version |
| `src/activities/` | Validation, rules, mocked providers, banking, audit, notifications, simulated world |
| `src/activities/providerHealth.ts` | Circuit breaker per provider, and the demo's provider outage switch |
| `src/ingest/` | Channel adapters, the single idempotent start path, scenario profiles and packs |
| `src/ingest/outbox.ts` | Start retries with backoff, and the outbox used when Temporal is unreachable |
| `src/workers/createWorkers.ts` | Task queue topology and vendor rate limits |
| `src/billing/`, `src/workflows/billing.ts` | Tariff, billing ledger, and the billing child workflow |
| `src/reports/` | Flow and Sankey aggregation, audit filters and CSV, SLA board, billing summaries, branded PDFs (reports and invoices) |
| `src/cli/` | `start.ts` (`npm start` / `npm run demo`: everything in one process), plus the server, worker, ui and operator commands |
| `src/ui/` | Console API (`server.ts`) and the static app (`public/`, no build step) |
| `test/` | End-to-end tests for every terminal path, replay tests (`versioning.test.ts`, fixtures in `test/fixtures/`), and unit tests for policies, reports, flow, adapters and resilience |

## Design

### Child workflows at isolation seams

A child workflow costs extra history events, some latency and another ID to route signals to. It's worth that cost when it buys reuse, a separate queue or deployment, independent versioning, or failure isolation. So there are four:

| Child | Why it's a child |
|---|---|
| `enrichmentWorkflow` | Reused by every product and any future client. The caller passes the checks it needs. A provider outage is contained and comes back as a partial result. |
| `<product>Underwriting` ×3 | Each product has its own type and queue (`underwriting-auto`, ...), so it can be deployed, scaled, versioned and monitored alone. A bad auto-loan rules deploy can't touch personal loans. |
| `disbursementWorkflow` | One payout path for all products, owned by payments. Money movement is isolated. |
| `billingWorkflow` | Owned by finance, on its own queue. Runs once a loan is funded; a billing problem can never touch lending. |

What isn't a child:
- **Validation:** a single activity.
- **Notifications and audit:** activities.
- **Every wait on a person or outside party:** documents, review, signature and withdraw all stay in the parent. The UI, webhooks and CLI only ever need the application's workflow ID, and they never have to work out which child is active.

Child IDs are deterministic (`{id}/enrichment`, `{id}/underwriting-2`, ...). A request-info loop runs fresh children, and the old runs stay visible in history.

### Activities

Activities hold every side effect and every call to the outside world; workflows only decide. Each one runs on the queue of the team or vendor that owns it, with a retry policy chosen for what a failure means.

| Activity | Queue | What it does | Retry policy |
|---|---|---|---|
| `validateApplication` | `loan-orchestration` | Product limits, required documents, hard failures | 3 attempts |
| `recordAuditEvent` | `loan-orchestration` | Appends one decision to the audit log, deduped on a deterministic key | Unlimited: no decision goes unrecorded |
| `notify` | `loan-orchestration` | Email, SMS, reviewer and ops alerts | 3 attempts, then audited as failed; never blocks the application |
| `sendEnvelope` | `loan-orchestration` | Sends the loan agreement for e-signature, with an envelope ID chosen by the workflow | 3 attempts; a resend is a no-op |
| `screenSanctions` | `loan-orchestration` | Watchlist screen just before payout | 3 attempts |
| `readBatchPage` | `loan-orchestration` | Reads one page of an aggregator file | 3 attempts |
| `fetchCreditReport`, `verifyIdentity`, `checkFraud` | `provider-<vendor>` | Shared third-party checks, run by the enrichment child | Backoff within a time budget; 429s follow Retry-After; business answers aren't retried |
| `valueVehicle`, `verifyDebts` | `provider-<vendor>` | Product-only checks, run by the auto and debt-consolidation underwriting children | Same as the other providers |
| `evaluateRules` | `underwriting-<product>` | Applies that product's versioned policy: approve, refer (with approvals needed) or decline | 3 attempts, then the child fails and the parent escalates |
| `bookLoan`, `disburseFunds`, `confirmFunding` | `disbursement` | Books the loan and moves the money, idempotent on the application ID, heartbeating | Backoff for up to the banking budget (24h); a rejected payout isn't retried |
| `priceFundedLoan`, `recordCharge` | `billing` | Prices the loan with the current tariff and records one charge | Unlimited: a funded loan must never go unbilled |

[What is safe to retry](#what-is-safe-to-retry) explains why each of these can be repeated without harm, and [code sample 8](docs/code-samples.md#8-activity-design-a-retry-policy-for-each-kind-of-call) shows the policies in code.

### Ingesting from three channels (no "master queue")

Each application is its own workflow, so applications already run in parallel, and Temporal's task queues are the work queues. A single master workflow that started every application would hit history and child-count limits and become a bottleneck.

- **Adapters:** each channel's adapter produces the same `LoanApplication`.
- **Idempotency is the workflow ID:** `loan-{channel}-{externalRef}` with `REJECT_DUPLICATE`. The reference is the portal submission ID, the email Message-ID, or the aggregator ID plus row. Re-deliveries collapse into the existing application, and there's no dedupe table.
- **Broker email** is parsed leniently. Gaps become `AWAITING_DOCS` or validation failures that operators can see, rather than dropped mail.
- **Aggregator files** run as one `batchIngestWorkflow` each. It pages through rows, starts each row as an independent workflow (`ABANDON`), rejects bad rows individually, and calls `continueAsNew` to bound history.

### Lifecycle as a state machine

See [diagram 3](docs/diagrams.md#3-application-lifecycle). State lives in the parent and is exposed three ways:
- **Search attributes:** `ApplicationStatus`, `ProductType`, `Channel` and `SlaBreached`, upserted on every transition. The case list and review queue read these.
- **The `getStatus` query:** pending action, reasons, enrichment, underwriting, approvals, children and history.
- **The audit log:** one event per transition and decision.

**Guaranteeing a terminal state:**
- **Escaped failures:** a Temporal failure that escapes a stage (a failed child, or an activity out of retries) is caught at the top and ends as `ESCALATED` with the root cause, for example `SYSTEM_FAILURE_IN_UNDERWRITING: RulesEngineError: ...`.
- **Code bugs are deliberately not caught.** They fail the workflow task, Temporal retries it, and the run resumes after the fix ships instead of being wrongly escalated.
- **Every wait has its own timeout:** documents end abandoned, review ends escalated, and an unsigned offer lapses.

**The 48h SLA alerts and never cancels.** It flags `SlaBreached`, writes an audit event and notifies ops. Killing an application mid-payout because a clock ran out would be worse than being late.

### Third-party failures, rate limits and downtime

See [diagram 5](docs/diagrams.md#5-third-party-failures-and-downtime). Failures are handled in layers, each covering a longer outage than the one before:

| Layer | Covers | How |
|---|---|---|
| 1. Activity retry policy | Blips of seconds to minutes | Exponential backoff inside a per-call `scheduleToCloseTimeout` budget (30m in production). A **429** carries `nextRetryDelay` from Retry-After. **Permanent errors** (`SubjectNotFound`, `InvalidInput`) are non-retryable and return at once. |
| 2. Circuit breaker per provider | A vendor that keeps failing | After 5 failures in 30s the circuit opens. Calls then fail fast with a non-retryable `CircuitOpen` for 10s instead of thousands of workflows hammering a dead API. Then one probe is let through (half-open), and a success closes the circuit. |
| 3. Parking in `AWAITING_PROVIDER` | Outages of minutes to hours | The enrichment child classifies each failure as `UNAVAILABLE` or `PERMANENT`. On `UNAVAILABLE`, the parent parks: a durable wait that holds no worker. It then runs a fresh enrichment child for **only the failed checks**, waiting 5m and doubling up to 30m, within a 4h outage budget. Results that already succeeded are kept, so nothing is re-pulled or re-billed. If the budget runs out, the case goes to human review with what it has. Ops can force a retry (`retryProvidersNow` signal), and switching a provider back on in the console nudges every parked case. |
| 4. Core-banking downtime | Payout system unavailable | The disbursement child retries `bookLoan`/`disburseFunds` with backoff up to 30s, for up to 24h. That's safe because payouts are idempotent on the application ID. Only after that budget does the parent escalate. Money is late rather than bounced to a person. |
| 5. Temporal or ingest-path downtime | The orchestrator itself is unreachable | Ingest retries the start with backoff and jitter on transient gRPC errors. If Temporal stays down, the application goes to a local **outbox** and the caller gets its future workflow ID. A drainer submits it when Temporal is back, and the idempotent ID makes a double submit harmless. The console starts on a lazy connection, retries reads, returns 503 with Retry-After, and shows a banner. Running workflows simply resume. |

**Rate limits:** each vendor has its own task queue with `maxTaskQueueActivitiesPerSecond` set to its quota. The server enforces it across all workers, so scaling out can't exceed the quota. Excess work queues instead of failing.

**Partial failures:** enrichment uses `Promise.allSettled`. Completed results are durable in history, so a failing provider never causes the others to be called again. Tests assert each activity is scheduled once, and that a parked retry child calls only the failed provider.

**Demo notes:**
- The breaker state lives in the worker process and is mirrored to a JSON file for the console. In production it would be shared (Redis, or one entity workflow per provider) so every worker sees the same circuit.
- Per-application simulated faults bypass the breaker, so one scenario can't open it for everyone. Global outages from the Health tab do trip it.

### Scaling to 50,000 applications a month

Measured on the prototype, one funded application is 5 workflow executions (the parent and 4 children), about 230 history events and about 25 activities. At 50,000 applications a month, that is roughly:

| | Per month at 50,000 applications |
|---|---|
| Workflow executions | about 250,000 |
| Activity executions | about 1.25 million |
| History events | about 12 million |
| Average start rate | 0.02 per second (a 20x peak is still under 0.5 per second) |

That is a small load for Temporal (self-hosted or Temporal Cloud). The real limits are elsewhere:

- **Vendor quotas, not Temporal, set the ceiling.** Each vendor has its own rate-limited queue. A 5,000-row aggregator file drains through the credit bureau at its 20 per second quota in about 4 minutes, without touching other vendors' traffic or exceeding anyone's limit.
- **Waiting costs nothing.** Thousands of applications in review, awaiting documents or parked on an outage are durable timers and conditions; they hold no worker or thread.
- **History stays small.** A parent uses about 155 events against Temporal's 51,200 limit; each request-info loop adds about 60. Only the batch workflow can grow large, and it uses `continueAsNew`.
- **Workers scale per queue.** Each queue becomes its own deployment, autoscaled on schedule-to-start latency, so a busy product or vendor scales alone.
- **What would need to change:** the audit log and billing ledger move from JSONL files to insert-only Postgres tables, circuit-breaker state moves to a shared store, and Visibility runs on Elasticsearch (or Temporal Cloud) for operator queries at this volume.

### Scenario packs

A pack is a fixed list of scenarios started together by the synthesizer workflow, one application per path. **Showcase** starts 20:
- happy paths for all three products and channels
- a flaky bureau
- a credit-bureau blip that parks and recovers
- a long identity outage that ends in review
- a core-banking blip
- a permanent identity miss
- missing docs, abandonment and withdrawal
- rules and validation declines
- a request-info loop
- fraud and four-eyes left for you to review
- an e-sign wait left for you
- a lapsed offer
- a rejected payout
- a bad rules deploy

It also re-delivers the first submission, and that duplicate is absorbed. A test runs the whole pack and checks every application terminates with the expected outcome.

### Keeping product logic isolated

- **`ProductPolicy`** (`src/products/`) owns required documents, limits, enrichment checks, rules, the four-eyes threshold and a version string. The version is recorded on every decision, for example `rules:auto-2026.11.1`.
- **Product-specific orchestration** lives in each product's underwriting child: vehicle valuation for auto, debt verification for debt consolidation. The parent stays product-agnostic. It learns which checks to run from `validateApplication`.
- **Rules run in activities,** so changing a threshold can't break replay of in-flight workflows.

### Knowing when something is broken, and investigating

**What to alert on:**
- **SDK metrics:** schedule-to-start latency per queue (workers starved or a vendor throttled), activity failure rate per provider queue (a degrading vendor), and workflow task failures (a bad deploy or non-determinism).
- **Business signals** from search attributes and audit: count and age by status, `SlaBreached`, review queue depth and age, escalation rate, and funding rate per product. Funding rate is the number the lending team bills on.

**How an operator investigates:**
1. The console's Flow page shows where applications pile up and why they ended.
2. Cases filter by state, product and channel. A case shows what it's waiting on, its decisions and its children, with links to each run in the Temporal UI.
3. Temporal's event history shows the exact activity, attempt count and error.
4. To act: decide, upload, sign or withdraw from the console. Or `temporal workflow reset` past a bad step once it's fixed, or terminate with a reason.

### Human in the loop

See [diagram 4](docs/diagrams.md#4-human-in-the-loop).

**When a person comes in:**
- the rules REFER (fraud signals, unverified identity, borderline credit, DTI or LTV)
- the amount needs four-eyes approval
- enrichment failed
- a reviewer asks for more information

**How the pause works:** `await condition(() => decided || approvals >= required, reviewTimeout)`. The workflow is durably suspended, can wait for days, and survives restarts and deploys.

**How the decision arrives:** through the `submitReviewDecision` **Update**. Its validator rejects:
- decisions sent when the application isn't in review
- decisions without a reason (the audit trail needs one)
- `REQUEST_INFO` without a document list
- a second approval from the same reviewer (four-eyes)

The console shows the rejection inline.

**How it resumes:** code continues after the `condition` with full context, and there's no rehydration logic. `REQUEST_INFO` goes back through documents and validation and runs fresh enrichment and underwriting children.

### Hand-offs and expiring sessions

Web sessions die after a while; a loan application must not die with one. So the application and the person's session are decoupled, and only the session-like part expires:

| Who | What can expire | What happens |
|---|---|---|
| Reviewer | Their **claim** on the case: a lease of 30 minutes (3 in the demo), renewable | Reminded 5 minutes before it ends (amber countdown in the console, plus a `CLAIM_EXPIRING` notification). Not renewed: the claim lapses, the case returns to the queue, and anyone can pick it up. The application keeps waiting. |
| Reviewer | The whole review window (8 hours) | The application escalates to ops. This is the only review timeout that ends the automated process. |
| Applicant | A document request or the signature link | A reminder, then the request lapses (abandoned or offer lapsed). A new session simply resumes: the workflow holds the state, not the browser. |

- **Claiming** is the `claimReview` Update (claim, extend, release). While a claim is active, only its holder can decide; another reviewer's decision is rejected with who holds it and until when.
- **Reminder and lapse are durable timers inside the workflow**, not browser timers, so they fire even if every reviewer closed their laptop.
- **Every step is audited:** `CLAIMED`, `CLAIM_EXTENDED`, `CLAIM_EXPIRY_REMINDER`, `CLAIM_EXPIRED`, `CLAIM_RELEASED`.

### Billable workflows

A funded loan is billable; nothing else is. After an application reaches FUNDED, the parent starts a **`billingWorkflow`** child on its own `billing` queue (owned by finance, deployed and versioned alone):

1. `priceFundedLoan` prices it from a **versioned tariff** (`src/billing/tariff.ts`): `fee = clamp(flat + principal × bps, min, cap)`, billed to the business line that owns the product (Personal Lending, Auto Lending, Debt Consolidation). The numbers are illustrative.
2. `recordCharge` writes **exactly one charge per application** to the billing ledger: the write is keyed on the application ID, so a retried activity or a replayed workflow can never bill a loan twice. Both activities retry until they succeed; a funded loan must never go unbilled.
3. The parent audits `BILLED` with the tariff version as the actor. A billing failure is audited and alerted, but never undoes funding.

The step was added while applications were running, so it is gated with `patched('bill-funded-loans')`, like the sanctions screen; the replay tests still pass. The **Billing** tab shows billed revenue, the **billable rate** (funded ÷ closed: declined and escalated applications are the "dead weight" the brief mentions), the pipeline of expected fees from open applications, totals by account, the tariff, and every charge, with a CSV export and an **invoice PDF per account and month**.

### SLA watch

Every open application is checked against the overall SLA (48 hours; 4 minutes in the demo):

- **In the workflow:** at the at-risk point (36 hours; 150 seconds in the demo) the watchdog raises `SLA_AT_RISK`, audits it and notifies ops, then raises `SLA_BREACHED` at the deadline. Neither cancels anything. Also gated with `patched('sla-at-risk-warning')`.
- **On the board:** three columns, least time left first. **Breached** (past the deadline), **At risk** (flagged), and **Stale** (no activity for 4 hours; 45 seconds in the demo, so it catches quiet cases before they're at risk). Each card shows what it's waiting on, how long it's been quiet, who holds the claim, and a live countdown. **Needs a person** filters to reviews, documents and signatures. A **fees at stake** tile totals what those applications would bill if they fund.
- The review queue shows the same SLA status per case, and the nav badge counts breached plus at-risk applications.
- **Demoing it:** the `sla-breach-*`, `sla-at-risk-*` and `sla-stale-review` scenarios carry their own timer overrides (a 40-second or 5-minute SLA, a 20-second at-risk point), merged over the run's timing by `timingFor` in `src/ingest/scenarios.ts`. The **SLA pressure** pack starts ten of them, so the board fills in about a minute without changing the clock for anything else.

### What is safe to retry

A retry is safe when repeating the operation cannot change the outcome: it is a read, or it carries a key that maps a repeat to the same effect. This matters most when a session dies mid-action and the person, or the client, sends it again.

| Operation | Safe to retry? | Why |
|---|---|---|
| Credit, identity, fraud, vehicle, debt checks | Yes, for transient errors | Reads; the workflow ID is the idempotency key, so a vendor never bills twice. **Not** on `SubjectNotFound` or `InvalidInput`: a business answer won't change. |
| Validation and rules | Yes | Pure functions of their inputs. |
| Audit write | Yes, forever | A deterministic event key; the store drops duplicates. |
| Notification | Mostly | At least once: a duplicate email is tolerable, so it is capped at 3 attempts and then audited. |
| E-sign envelope | Yes | The workflow decides the envelope ID before sending. |
| Book loan, disburse, confirm | Yes, **only** because they are keyed on the application ID | The ledger checks the key before paying. A payout without that key must never be retried. `PayoutRejected` is a business answer: not retried. |
| Starting an application | Yes | The workflow ID is channel + external reference with `REJECT_DUPLICATE`; a repeat lands on the same application. Console starts use the request ID as the reference. |
| Reviewer decision | Yes, **with the same request ID** | Sent as the Temporal update ID, which the server deduplicates: a retry returns the first result instead of recording a second decision. A new click without it is checked by the validator (for example, the same reviewer can't approve twice). |
| Claim, extend, release | Yes | Same reviewer, same effect; also sent with an update ID. |
| Documents uploaded, agreement signed, withdraw | Yes | The handlers are idempotent: documents are a set, a signature must match the current envelope, the first withdrawal wins. |
| Price and record a charge | Yes | Pricing is pure; the ledger write is keyed on the application ID. |
| Synthesize, clear synthesized | Yes | The request ID is the synthesizer's workflow ID; deleting an already-deleted run is a no-op. |

**Not safe to retry, by design:** anything after a non-retryable business error; re-running a decision that is already recorded; and any new side-effecting call that has no key. The rule for new code is that every side effect gets an idempotency key before it ships.

The console follows the same rule: it retries reads automatically, and retries a write only when that write carries a request ID. It keeps the same ID until the action gets an answer, so clicking again after a timeout repeats the request rather than making a new one.

### Auditability

- **The decision log:** `recordAuditEvent` writes an append-only business log. Each event records the actor (`system`, `rules:<version>`, `reviewer:<id>`, `applicant:...` or `provider:esign`), the transition, reasons and details. Event keys are deterministic, so an activity retry can't double-write.
- **Retries:** audit writes retry forever. Notifications retry three times, then the failure is audited and the workflow moves on.
- **Temporal history** stays the step-level record. In production it's archived to S3 for retention.
- **Reviewable outside engineering:** the Audit page has two views, with filters kept in the URL:
  - **Cases** (the default): one row per application with its state, latest reason and actor, reviewers, received time, event count and a PDF link. It also has a state-distribution bar whose legend filters the table, and KPIs for open and closed counts, funding rate, funded volume, SLA breaches, manually reviewed, and median time to close.
  - **Events:** every decision and transition, filterable by text, event type, state, product, channel, actor and date.

  Exports follow the current filters: CSV (per case or per event), and a branded PDF report with KPIs, outcomes by reason, the case table and the audit trail. Each case also has its own PDF audit record.

### Changing workflow code while applications are in flight

Loan workflows run for days, so a deploy always meets in-flight runs. The sanctions screen before disbursement was added after applications were already running, as the worked example:
- It is gated with `workflow.patched('sanctions-screen-before-disbursement')`. New runs, and old runs that haven't reached that point yet, get the screen. Runs that already passed it replay without it, so their recorded history still matches the code.
- `test/versioning.test.ts` replays two histories recorded before the change: a plain funded case and a four-eyes review. Both replay cleanly. With the `patched()` guard removed, both fail with Temporal's non-determinism error (`TMPRL1100`), which is what every in-flight application would hit on deploy. I checked that the test fails that way.
- Cleanup once no pre-patch runs remain: switch to `deprecatePatch()`, then remove the branch.
- For frequent changes, the next step is Worker Versioning (pinned deployments per product queue), which keeps version branches out of the code. In CI, the replay test would run against a rolling sample of recent production histories.

### Scenario synthesizer and simulated world

`synthesizeWorkflow` starts N applications from a weighted scenario mix at a bounded rate, each as an independent parent workflow.

The simulated applicant and reviewer react to notifications: a document request, a review page, a sent envelope. They answer later through the **same signals and update a real person uses**, so no simulation code lives in the workflows.

Their timers are in-process and not durable. That's fine for a demo, but a worker restart drops pending simulated answers, and those cases then time out through their normal paths.

## Trade-offs

| Decision | Chose | Alternative |
|---|---|---|
| Child granularity | Children at seams: enrichment, underwriting per product, disbursement, billing | A child per stage is more modular, but adds signal routing and history for little gain |
| Where waits live | Parent only | Waits in children make tidier stage code, but callers must know which child is active |
| Ingestion buffer | Start directly with idempotent IDs | SQS or Kafka in front is extra infrastructure, worth it only if an upstream can't tolerate Temporal being briefly unavailable |
| Review input | Update with a validator | A Signal gives no acknowledgement, and invalid decisions are silently dropped |
| SLA | Alert only | A hard escalation at 48h risks interrupting a payout |
| Rules location | Activity | Inline rules are cheaper, but a threshold change would break replay |
| ESCALATED | Terminal; reopening starts a new linked workflow | A parked, resumable state |
| Status read model | Visibility, query and audit log | A projected database, needed for BI at scale |
| Sankey source | Audit transitions, keyed by round | Visibility only knows the current state, not the path |
| Signature webhook | Signal; stale envelopes ignored | An Update, but the provider can't act on a rejection |
| Adding a stage to a live workflow | `patched()` plus a replay test | Worker Versioning (pinned deployments). Better for frequent changes, but more deployment machinery than one change needs |
| Reviewer leaves mid-review | A renewable claim that lapses back to the queue | Escalating on session expiry would end a fundable application because a browser tab closed |
| Provider outage | Park and retry only the failed checks, then review | Straight to review wastes reviewer time on outages that clear in minutes. Failing the application would lose a fundable loan. |
| Where the breaker lives | Activity side, per worker (demo) | An entity workflow per provider gives one shared circuit without Redis, but adds a signal round trip to every call |
| Core-banking outage | Retry inside the disbursement child for up to 24h | Escalating early bounces a fundable loan to a person for a transient fault |
| Temporal unreachable at ingest | Local outbox plus drainer | A broker in front (SQS or Kafka) is the production version of the same idea: decouple accepting from orchestrating |
| Workers | All in one process, one shared bundle | Production: one deployment and bundle per queue, with Worker Versioning per product |

## Prototype limits

- Providers, core banking, the document store and e-sign are mocked. `application.simulate` exists only to drive scenarios.
- Circuit breakers are per worker process. The outbox is a local file; production would use a transactional outbox table.
- The audit log is a JSONL file read whole by the console. Production would use an insert-only table queried with filters.
- There is no reviewer authentication or role-based approval limits. The update validator is where those checks would go.
- There's no real MIME parsing or SFTP polling. A Temporal Schedule would pick up aggregator files.
- There's no payload encryption codec, metrics exporter or deployment config.

## What I'd do next

1. SSO for the console, and approval limits per reviewer role, enforced in the update validator (claims and four-eyes already are).
2. Worker Versioning per product queue, and the replay test run in CI against a rolling sample of production histories.
3. Prometheus metrics and a dashboard per product for the signals above.
4. A PII payload codec, and a Postgres audit store with insert-only grants.
5. Helm charts: one deployment per queue, autoscaled on schedule-to-start latency.
