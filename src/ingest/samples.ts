import type { BrokerEmail, PortalSubmission } from './adapters';

export const samplePortalSubmission = (id: string): PortalSubmission => ({
  submissionId: id,
  product: 'personal',
  applicant: { id: 'cust-88231', name: 'Renee Okafor', dob: '1990-06-11', email: 'renee.okafor@example.com', annualIncome: 98_000, monthlyDebt: 350 },
  loan: { amount: 14_500, termMonths: 48 },
  uploadedDocuments: ['GOV_ID', 'PAYSTUB'],
});

/** A broker email missing the paystub attachment. */
export const sampleBrokerEmail = (messageId: string): BrokerEmail => ({
  messageId,
  from: 'Deals@NorthBrokers.example',
  subject: 'New application: Daniel Wright, auto',
  body: [
    'Product: auto',
    'Applicant: Daniel Wright',
    'DOB: 1984-09-23',
    'Email: daniel.wright@example.com',
    'Income: $104,000',
    'Monthly debt: 520',
    'Amount: 24,000',
    'Term: 60',
    'VIN: 2T1BURHE0JC123456',
    'Purchase price: 27,500',
  ].join('\n'),
  attachments: [{ filename: 'drivers-licence.pdf' }, { filename: 'bill-of-sale.pdf' }],
});
