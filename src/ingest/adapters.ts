/**
 * Channel adapters: three very different inputs, one normalized LoanApplication. Nothing downstream knows
 * which channel an application came from. Adapters are lenient: a partially parsed broker email still
 * becomes an application, and the gaps surface in the workflow (missing docs, validation) where operators
 * can see them, instead of the email being silently dropped.
 */
import type { DocumentType, LoanApplication, ProductType } from '../shared/types';

const PRODUCTS: Record<string, ProductType> = {
  personal: 'PERSONAL', auto: 'AUTO', car: 'AUTO', vehicle: 'AUTO',
  debt_consolidation: 'DEBT_CONSOLIDATION', 'debt consolidation': 'DEBT_CONSOLIDATION', consolidation: 'DEBT_CONSOLIDATION',
};
export const parseProduct = (s: string | undefined): ProductType => PRODUCTS[(s ?? '').trim().toLowerCase()] ?? 'PERSONAL';
const num = (s: unknown) => { const n = Number(String(s ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };

// ---- portal -------------------------------------------------------------

export interface PortalSubmission {
  submissionId: string;
  product: string;
  applicant: { id: string; name: string; dob: string; email: string; annualIncome: number; monthlyDebt: number };
  loan: { amount: number; termMonths: number };
  uploadedDocuments: DocumentType[];
  vehicle?: { vin: string; purchasePrice: number };
  debts?: { creditor: string; balance: number }[];
}

export function fromPortal(s: PortalSubmission): LoanApplication {
  return {
    externalRef: s.submissionId,
    channel: 'PORTAL',
    productType: parseProduct(s.product),
    applicant: {
      applicantId: s.applicant.id, fullName: s.applicant.name, dateOfBirth: s.applicant.dob, email: s.applicant.email,
      annualIncome: s.applicant.annualIncome, monthlyDebtPayments: s.applicant.monthlyDebt,
    },
    amount: s.loan.amount,
    termMonths: s.loan.termMonths,
    documents: s.uploadedDocuments,
    vehicle: s.vehicle,
    debtsToConsolidate: s.debts,
  };
}

// ---- broker email -------------------------------------------------------

export interface BrokerEmail {
  messageId: string; // RFC 5322 Message-ID: the idempotency key for re-delivered mail
  from: string;
  subject: string;
  body: string; // "Key: value" lines, the brokers' agreed template
  attachments: { filename: string }[];
}

const ATTACHMENT_TYPES: [RegExp, DocumentType][] = [
  [/(passport|licen[cs]e|gov.?id|\bid\b)/i, 'GOV_ID'],
  [/pay.?stub|payslip/i, 'PAYSTUB'],
  [/bank.?statement/i, 'BANK_STATEMENT'],
  [/purchase|bill.?of.?sale/i, 'VEHICLE_PURCHASE_AGREEMENT'],
  [/debt|card.?statement|loan.?statement/i, 'DEBT_STATEMENTS'],
];

export function classifyAttachment(filename: string): DocumentType | undefined {
  return ATTACHMENT_TYPES.find(([re]) => re.test(filename))?.[1];
}

export function fromBrokerEmail(e: BrokerEmail): LoanApplication {
  const fields: Record<string, string> = {};
  for (const line of e.body.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z ]+?)\s*:\s*(.+)$/);
    if (m) fields[m[1].toLowerCase()] = m[2].trim();
  }
  const documents = [...new Set(e.attachments.map((a) => classifyAttachment(a.filename)).filter((d): d is DocumentType => !!d))];
  const ref = e.messageId.replace(/[<>]/g, '').replace(/[^A-Za-z0-9._-]/g, '_');
  return {
    externalRef: ref,
    channel: 'BROKER_EMAIL',
    productType: parseProduct(fields['product']),
    brokerId: e.from.toLowerCase(),
    applicant: {
      applicantId: fields['applicant id'] ?? `broker-${ref}`,
      fullName: fields['applicant'] ?? fields['name'] ?? '',
      dateOfBirth: fields['dob'] ?? fields['date of birth'] ?? '',
      email: fields['email'] ?? '',
      annualIncome: num(fields['income'] ?? fields['annual income']),
      monthlyDebtPayments: num(fields['monthly debt']),
    },
    amount: num(fields['amount']),
    termMonths: num(fields['term']) || 36,
    documents,
    vehicle: fields['vin'] ? { vin: fields['vin'], purchasePrice: num(fields['purchase price']) } : undefined,
    debtsToConsolidate: fields['debts']
      ? fields['debts'].split(';').map((d) => { const [creditor, bal] = d.split('='); return { creditor: creditor.trim(), balance: num(bal) }; })
      : undefined,
  };
}

// ---- aggregator batch (CSV) ---------------------------------------------

export const AGGREGATOR_COLUMNS = [
  'aggregator_id', 'row_ref', 'product', 'applicant_id', 'name', 'dob', 'email', 'annual_income', 'monthly_debt',
  'amount', 'term_months', 'documents', 'vin', 'purchase_price', 'debts',
] as const;

export type AggregatorRowResult = { rowRef: string; application?: LoanApplication; error?: string };

export function fromAggregatorRow(header: string[], line: string, lineNo: number): AggregatorRowResult {
  const cells = line.split(',').map((c) => c.trim());
  const r: Record<string, string> = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  const rowRef = `${r.aggregator_id || 'agg'}-${r.row_ref || `line${lineNo}`}`;
  if (cells.length !== header.length) return { rowRef, error: `expected ${header.length} columns, got ${cells.length}` };
  if (!r.row_ref || !r.aggregator_id) return { rowRef, error: 'missing aggregator_id or row_ref' };
  if (!(num(r.amount) > 0)) return { rowRef, error: `invalid amount "${r.amount}"` };
  return {
    rowRef,
    application: {
      externalRef: rowRef,
      channel: 'AGGREGATOR',
      productType: parseProduct(r.product),
      applicant: {
        applicantId: r.applicant_id, fullName: r.name, dateOfBirth: r.dob, email: r.email,
        annualIncome: num(r.annual_income), monthlyDebtPayments: num(r.monthly_debt),
      },
      amount: num(r.amount),
      termMonths: num(r.term_months) || 36,
      documents: (r.documents ? r.documents.split('|') : []) as DocumentType[],
      vehicle: r.vin ? { vin: r.vin, purchasePrice: num(r.purchase_price) } : undefined,
      debtsToConsolidate: r.debts
        ? r.debts.split('|').map((d) => { const [creditor, bal] = d.split('='); return { creditor, balance: num(bal) }; })
        : undefined,
      simulate: { applicant: { signs: 'auto' } },
    },
  };
}
