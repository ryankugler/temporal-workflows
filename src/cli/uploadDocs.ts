/** npm run upload-docs -- <workflowId> PAYSTUB[,GOV_ID] */
import { documentsUploadedSignal } from '../workflows/definitions';
import type { DocumentType } from '../shared/types';
import { connectClient, fail, parseArgs, run } from './common';

run(async () => {
  const { positional: [workflowId, docs] } = parseArgs();
  if (!workflowId || !docs) fail('usage: npm run upload-docs -- <workflowId> PAYSTUB[,GOV_ID]');
  const client = await connectClient();
  await client.workflow.getHandle(workflowId).signal(documentsUploadedSignal, { documents: docs.split(',') as DocumentType[], uploadedBy: 'cli' });
  console.log(`Signalled ${workflowId}: uploaded ${docs}`);
});
