# Diagrams

All diagrams are Mermaid and render on GitHub. The ops console's Flow page draws diagram 3 live, with the number of applications in each state.

## 1. System architecture

```mermaid
flowchart LR
  subgraph Channels
    P[Portal<br/>REST submit]
    B[Broker email<br/>inbound webhook]
    A[Aggregator<br/>batch CSV file]
    S[Scenario synthesizer]
  end

  P --> AD[Channel adapters<br/>normalize to LoanApplication]
  B --> AD
  A --> BW[batchIngestWorkflow<br/>one per file, continueAsNew]
  S --> SW[synthesizeWorkflow<br/>rate-limited starts]

  AD -- "start(loan-{channel}-{ref})<br/>REJECT_DUPLICATE" --> T[(Temporal cluster)]
  BW -- "startChild, ABANDON" --> T
  SW -- "startChild, ABANDON" --> T

  subgraph Workers["Workers (one per task queue)"]
    O[loan-orchestration<br/>parent workflows]
    E[enrichment]
    U[underwriting-personal<br/>underwriting-auto<br/>underwriting-debt-consolidation]
    D[disbursement]
    BL[billing]
    PQ[provider-credit-bureau · provider-identity · provider-fraud<br/>provider-vehicle-valuation · provider-debt-verification<br/>each rate limited to its vendor quota]
  end
  T --- O & E & U & D & BL & PQ

  O --> AUD[(Audit log<br/>append-only)]
  BL --> LED[(Billing ledger<br/>one charge per loan)]
  UI[Ops console / CLI] -- "query · update · signal" --> T
  UI -- "Visibility list<br/>(search attributes)" --> T
  UI -- "flow, audit, PDFs" --> AUD
  UI -- "billing, invoices" --> LED
```

## 2. Parent and child workflows

Every interactive wait lives in the parent, so callers only ever address one workflow ID. Children are non-interactive: input in, result out.

```mermaid
flowchart TB
  subgraph Parent["loanApplicationWorkflow (loan-orchestration)"]
    direction TB
    V[validateApplication activity]
    W1{{wait: documentsUploaded signal<br/>reminder, then abandon}}
    W2{{wait: submitReviewDecision update<br/>claimReview lease: remind, then lapse<br/>review timeout, then escalate}}
    W3{{wait: agreementSigned signal<br/>reminder, then offer lapses}}
    SLA{{SLA watchdog timer<br/>at risk, then breached; alerts only}}
    AU[recordAuditEvent on every transition]
  end

  Parent -- "executeChild<br/>{id}/enrichment" --> EN
  Parent -- "executeChild<br/>{id}/underwriting" --> UW
  Parent -- "executeChild<br/>{id}/disbursement" --> DI
  Parent -- "executeChild<br/>{id}/billing (once FUNDED)" --> BI

  subgraph EN["enrichmentWorkflow (enrichment), shared by all products"]
    C1[fetchCreditReport] & C2[verifyIdentity] & C3[checkFraud]
  end
  subgraph UW["one child type per product"]
    UP[personalLoanUnderwriting<br/>rules]
    UA[autoLoanUnderwriting<br/>valueVehicle + rules]
    UD[debtConsolidationUnderwriting<br/>verifyDebts + rules]
  end
  subgraph DI["disbursementWorkflow (disbursement)"]
    D1[bookLoan] --> D2[disburseFunds<br/>idempotent, heartbeat] --> D3[confirmFunding]
  end
  subgraph BI["billingWorkflow (billing), owned by finance"]
    B1[priceFundedLoan<br/>versioned tariff] --> B2[recordCharge<br/>idempotent on application ID]
  end
```

## 3. Application lifecycle

```mermaid
stateDiagram-v2
  [*] --> RECEIVED
  RECEIVED --> VALIDATING
  VALIDATING --> DECLINED: hard validation failure
  VALIDATING --> AWAITING_DOCS: missing documents
  AWAITING_DOCS --> VALIDATING: documentsUploaded
  AWAITING_DOCS --> DECLINED: abandoned after reminder
  VALIDATING --> ENRICHING
  ENRICHING --> UNDERWRITING
  ENRICHING --> HUMAN_REVIEW: permanent provider answer
  ENRICHING --> AWAITING_PROVIDER: provider unavailable
  AWAITING_PROVIDER --> UNDERWRITING: recovered (failed checks re-run)
  AWAITING_PROVIDER --> HUMAN_REVIEW: outage budget spent
  UNDERWRITING --> AWAITING_SIGNATURE: auto-approve
  UNDERWRITING --> DECLINED: auto-decline
  UNDERWRITING --> HUMAN_REVIEW: refer / four-eyes amount
  HUMAN_REVIEW --> AWAITING_SIGNATURE: approve (1 or 2 reviewers)
  HUMAN_REVIEW --> DECLINED: decline
  HUMAN_REVIEW --> AWAITING_DOCS: request info
  HUMAN_REVIEW --> ESCALATED: review timeout
  AWAITING_SIGNATURE --> DISBURSING: agreementSigned
  AWAITING_SIGNATURE --> DECLINED: offer lapsed
  AWAITING_SIGNATURE --> ESCALATED: sanctions potential match (patched step)
  DISBURSING --> FUNDED
  DISBURSING --> ESCALATED: payout rejected
  FUNDED --> [*]
  DECLINED --> [*]
  ESCALATED --> [*]
```

Not drawn, to keep it readable:
- **Withdraw** (signal) leads to DECLINED from any wait or stage boundary before DISBURSING.
- **Escaped Temporal failures** (a failed child, or an activity out of retries) lead to ESCALATED from whatever stage they hit, with the root cause as the reason.

## 4. Human in the loop

```mermaid
sequenceDiagram
  autonumber
  participant P as Parent workflow
  participant UW as Underwriting child
  participant N as notify activity
  participant R as Reviewer (console / CLI)
  participant A as Audit log

  P->>UW: executeChild(product underwriting)
  UW-->>P: REFER (FRAUD_SIGNALS, requiredApprovals=2)
  P->>A: TRANSITION -> HUMAN_REVIEW
  P->>N: REVIEW_REQUESTED (reasons, approvals needed)
  Note over P: await condition(decision or approvals >= 2, reviewTimeout)<br/>durably suspended, no worker resources held
  R->>P: getStatus query (context for the decision)
  R->>P: update submitReviewDecision(APPROVE, alice, reason)
  P->>P: validator: in review? reason given? not a repeat reviewer?
  P->>A: REVIEW_DECISION reviewer:alice
  P-->>R: ack 1/2
  R->>P: update submitReviewDecision(APPROVE, alice, ...)
  P-->>R: rejected: "Four-eyes: alice has already approved"
  R->>P: update submitReviewDecision(APPROVE, bob, reason)
  P->>A: REVIEW_DECISION reviewer:bob
  P-->>R: ack 2/2
  P->>A: TRANSITION -> AWAITING_SIGNATURE (actor reviewer:alice+bob)
  alt REQUEST_INFO
    P->>P: back to AWAITING_DOCS, re-validate,<br/>fresh enrichment-2 / underwriting-2 children
  else no decision before reviewTimeout
    P->>A: TRANSITION -> ESCALATED (REVIEW_TIMEOUT)
  end
```

## 4b. Review claims: a lease, like a web session

A reviewer claims a case before deciding, so two people can't work it at once. The claim is a lease: it lasts a fixed time (30 minutes in production, 3 in the demo), the holder is reminded before it ends, and if nobody extends it, it lapses and the case goes back to the queue. A forgotten browser tab never strands a case. Only the overall review timeout escalates.

```mermaid
sequenceDiagram
  autonumber
  participant R as Reviewer (console)
  participant P as Parent workflow
  participant Q as Review queue
  R->>P: update claimReview(claim, alice)
  P->>P: validator: in review? not claimed by someone else? not a prior approver?
  P-->>R: claim, expires in 3m
  Note over P: condition(decision or claim changed, until the next claim event)
  alt alice decides in time
    R->>P: update submitReviewDecision(APPROVE, alice, reason) [updateId = request ID]
    P-->>R: ack (a retried request with the same ID returns the same ack)
  else alice extends
    R->>P: update claimReview(extend, alice)
    P-->>R: claim, expires in 3m from now
  else alice walks away
    P->>R: notify CLAIM_EXPIRING (shortly before the end)
    P->>P: claim lapses: audit CLAIM_EXPIRED
    P->>Q: REVIEW_REQUESTED, returned to the queue
  end
  Note over P: no decision before reviewTimeout: ESCALATED
```

## 4c. SLA watch and billing

Each application runs a watchdog timer alongside its lifecycle. It alerts and never cancels: a hard stop at 48 hours could interrupt a payout. A funded loan starts the billing child, which retries until the charge is recorded once.

```mermaid
flowchart LR
  subgraph WD["SLA watchdog (inside the parent)"]
    S0([received]) -->|36h of 48h<br/>150s of 4m in the demo| AR[SLA_AT_RISK<br/>audit + notify ops]
    AR -->|48h| BR[SLA_BREACHED<br/>audit + notify ops<br/>SlaBreached search attribute]
    S0 -.->|terminal first| X([timer ends quietly])
  end
  subgraph Board["SLA watch board (ops console)"]
    C1[Breached]
    C2[At risk]
    C3[Stale: no activity<br/>4h, 45s in the demo]
  end
  AR --> C2
  BR --> C1
  F([FUNDED]) --> BW[billingWorkflow] --> CH[(one charge per loan<br/>idempotent on application ID)] --> BT[Billing tab<br/>invoices per account and month]
```

## 5. Third-party failures and downtime

```mermaid
flowchart TB
  subgraph L1["1 · activity retry policy (seconds to minutes)"]
    act[provider activity] -->|200| ok[result durable in history<br/>never re-called]
    act -->|"429 + Retry-After"| rl[nextRetryDelay = hint] --> act
    act -->|"5xx / reset / 503"| tr[exponential backoff] --> act
  end
  subgraph L2["2 · circuit breaker per provider"]
    cb{circuit}
    cb -->|CLOSED| act
    cb -->|OPEN| fast[CircuitOpen<br/>fail fast, non-retryable]
    tr -.->|"5 failures in 30s"| open[open for 10s, then one half-open probe]
  end
  act -->|"SubjectNotFound / InvalidInput"| perm[PERMANENT]
  tr -->|per-act budget spent| unav[UNAVAILABLE]
  fast --> unav
  subgraph L3["3 · parent workflow parking (minutes to hours)"]
    unav --> park[AWAITING_PROVIDER<br/>durable wait, no worker held]
    park -->|"after 5m, 10m, 20m, 30m...<br/>or ops: retryProvidersNow"| retry[fresh enrichment child<br/>failed checks only]
    retry -->|recovered| uw[UNDERWRITING]
    retry -->|still down| park
    park -->|outage budget spent| hr[HUMAN_REVIEW<br/>with partial data]
  end
  perm --> hr
```

Core banking follows layer 1 only, with a long budget: the disbursement child retries an idempotent payout for up to 24h before the parent escalates.

## 6. When Temporal itself is unreachable

```mermaid
sequenceDiagram
  participant C as Channel (portal / broker / batch)
  participant I as Ingest API
  participant O as Outbox (durable)
  participant T as Temporal
  C->>I: submit application
  I->>T: start(loan-{channel}-{ref})
  T--xI: UNAVAILABLE
  I->>T: retry with backoff + jitter
  T--xI: UNAVAILABLE
  I->>O: enqueue
  I-->>C: 202 Accepted, workflowId
  loop every few seconds
    O->>T: drain in order
  end
  T-->>O: started (or already started: idempotent ID)
```

## 7. Sankey construction (ops console)

The Sankey is built from audit transitions, because Visibility only knows the current state. Loops would make the graph cyclic, so states are keyed by round: every loop returns through VALIDATING, which starts round 2 ("rework"). Later rounds fold into round 2, and terminal states are shared.

```mermaid
flowchart LR
  VAL[Validating] --> AD1[Awaiting docs] --> VAL2["Validating (rework)"] --> E2["Enriching (rework)"] --> F[Funded]
  VAL --> E1[Enriching] --> U1[Underwriting] --> H1[Human review] --> AD2["Awaiting docs (rework)"]
  AD1 --> X[Declined]
```
