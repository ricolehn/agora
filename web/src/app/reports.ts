// Reporting content to the administrators (POST /reports): an AI reply, a mentoring conversation. The person says why
// first (optional); cancelling sends nothing.
import { apiJson } from './api';
import { t } from './i18n';

/** Asks [question] and sends [report] with the answer as its reason; false when the person cancels. A refusal throws. */
export async function sendReport(question: string, report: Record<string, unknown>): Promise<boolean> {
  const reason = window.prompt(question, '');
  if (reason === null) return false;
  await apiJson('/reports', 'POST', { ...report, reason }, t('report_failed', 'Report failed.'));
  return true;
}
