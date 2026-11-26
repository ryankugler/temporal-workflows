/** npm run sign -- <workflowId>  (simulates the e-sign provider's "signed" webhook) */
import { agreementSignedSignal, getStatusQuery } from '../workflows/definitions';
import { connectClient, fail, parseArgs, run } from './common';

run(async () => {
  const { positional: [workflowId] } = parseArgs();
  if (!workflowId) fail('usage: npm run sign -- <workflowId>');
  const client = await connectClient();
  const handle = client.workflow.getHandle(workflowId);
  const status = await handle.query(getStatusQuery);
  if (!status.signature) fail(`No agreement has been sent yet (status ${status.status})`);
  await handle.signal(agreementSignedSignal, { envelopeId: status.signature.envelopeId, signerName: status.applicantName, signedAt: new Date().toISOString() });
  console.log(`Signed envelope ${status.signature.envelopeId}`);
});
