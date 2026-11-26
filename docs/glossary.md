# Glossary

The lending and Temporal terms used in the code, the README and the ops console.

## Lending terms

| Term | Meaning |
|---|---|
| Origination | The whole process from a submitted application to a funded loan. |
| Underwriting | Deciding whether to lend, and on what terms, against the product's rules and risk limits. |
| Credit report and score | A credit bureau's record of the applicant's borrowing; the score summarises risk (roughly 300–850). |
| Identity verification (KYC) | "Know your customer": confirming the applicant is who they say they are. |
| Fraud screening | Signals that an application may be fake or a taken-over identity, such as many applications from one device. |
| DTI (debt-to-income) | Monthly debt payments, including the new loan, divided by monthly income. Higher means stretched. |
| LTV (loan-to-value) | The loan amount divided by the value of what secures it, such as the car in an auto loan. |
| Approve · refer · decline | The three rule outcomes. Refer means the rules can't decide alone, so a person must. |
| Broker | An intermediary who submits applications for clients; here, by email. |
| Aggregator | A comparison site that sends applications in batch files. |
| Debt consolidation | One new loan that pays off several existing debts, such as credit cards. |
| Four-eyes approval | Two different people must approve a high-value or risky decision. |
| Loan agreement and e-signature | The contract the applicant signs electronically before any money moves. |
| Sanctions screening | Checking the borrower against government watchlists (for example OFAC) before payout. |
| Disbursement (funding) | Paying the loan out. The lending team bills on funded loans. |
| Core banking | The bank's system of record that books the loan and moves the money. |
| Billable workflow | A funded loan: the only outcome that is charged, once, by a versioned tariff. |
| SLA at risk | An open application past the warning point (36 of 48 hours) that has not yet breached. |
| Escalation | Handing a case to an operations team with its full context; a terminal state here. |
| Claim (lease) | A reviewer's time-boxed hold on a case, like a web session: renewable, with a reminder before it ends; when it lapses the case returns to the queue. |
| Safe to retry | Repeating the operation can't change the outcome: it's a read, or it carries a key (idempotency key, update ID) that maps a repeat to the same effect. |

## Temporal terms

| Term | Meaning |
|---|---|
| Workflow | Durable code for one long-running process, here one per application. It survives crashes, restarts and deploys. |
| Activity | One step with side effects, such as an API call. Temporal retries it on failure, so it must be safe to repeat. |
| Worker | A process that runs workflow and activity code by polling task queues. Add workers to scale. |
| Task queue | A named queue that workers poll. The unit of routing, scaling and rate limiting. |
| Child workflow | A workflow started by another, with its own ID, history and task queue. |
| Event history | The append-only log of everything a workflow did. It is the source of truth. |
| Replay and determinism | After a crash, workflow code re-runs against its history, so it must make the same decisions every time. |
| Retry policy and timeouts | Backoff, maximum attempts and time budgets that decide how long Temporal keeps trying a step. |
| Signal | A fire-and-forget message into a running workflow, such as "documents uploaded". |
| Query | A read-only look at a workflow's current state, such as `getStatus`. |
| Update | A message that is validated and answered synchronously, such as a reviewer's decision. |
| Durable timer and wait | Waiting minutes or days for a time or a condition, without holding a worker. |
| Search attributes (Visibility) | Indexed fields for listing and filtering workflows, such as `ApplicationStatus`. |
| continueAsNew | Restarting a long workflow with a fresh history, to keep its history small. |
| `patched()` (versioning) | Lets changed code run safely alongside histories recorded by the old code. |
| Idempotency key | An ID that makes repeating an operation safe. Here, the workflow ID per application. |
