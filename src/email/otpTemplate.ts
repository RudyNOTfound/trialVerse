import type { EmailMessage } from './types';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Plain, professional OTP email. The code is the only variable content besides the expiry. */
export function renderOtpEmail(opts: { to: string; code: string; expiresInMinutes: number }): EmailMessage {
  const { code, expiresInMinutes } = opts;
  const subject = 'Your TrialVerse verification code';
  const text = [
    'TrialVerse visit verification',
    '',
    `Your verification code is: ${code}`,
    '',
    `It expires in ${expiresInMinutes} minutes and can be used once.`,
    'Enter it in the TrialVerse participant portal to confirm your visit.',
    '',
    'Do not share this code with anyone. If you did not expect this email, you can ignore it.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#f6f8fb;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f8fb;padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#0b2447;padding:20px 28px;color:#ffffff;font-size:18px;font-weight:600;">TrialVerse</td></tr>
      <tr><td style="padding:28px;">
        <p style="margin:0 0 8px;font-size:16px;font-weight:600;">Your verification code</p>
        <p style="margin:0 0 20px;font-size:14px;color:#475569;">Use this code to confirm your visit in the TrialVerse participant portal.</p>
        <p style="margin:0 0 20px;text-align:center;font-size:34px;font-weight:700;letter-spacing:8px;color:#0b2447;background:#eff6ff;border-radius:10px;padding:16px 8px;">${escapeHtml(code)}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#475569;">This code expires in <b>${expiresInMinutes} minutes</b> and can only be used once.</p>
        <p style="margin:0;font-size:13px;color:#475569;">Never share this code with anyone. If you did not expect this email, you can safely ignore it.</p>
      </td></tr>
      <tr><td style="padding:14px 28px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;">This is an automated message from TrialVerse. Please do not reply.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { to: opts.to, subject, text, html };
}
