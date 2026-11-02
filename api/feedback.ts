// The only server-side code: a feedback message (and an optional email for a reply) is mailed to the maker through
// Resend. Nothing else reaches it - the document can't be attached, and no IP or account is stored.
declare const process: { env: Record<string, string | undefined> };

const FROM = process.env.FEEDBACK_FROM || 'Fill In My PDF <feedback@fillinmypdf.com>';
const TO = process.env.FEEDBACK_TO || 'ali@convofi.com';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid body' }, 400);
  const { message, email, website } = body;
  if (typeof message !== 'string' || !message.trim() || message.length > 4000) return json({ error: 'Invalid feedback' }, 400);
  const from = typeof email === 'string' ? email.trim() : '';
  if (from && (from.length > 320 || !EMAIL.test(from))) return json({ error: 'Invalid email' }, 400);
  // Honeypot: bots fill the hidden field; pretend success.
  if (typeof website === 'string' && website !== '') return json({ ok: true });

  const text = message.trim();
  const oneLine = text.replace(/\s+/g, ' ');
  const subject = `[Fill In My PDF feedback] ${oneLine.length > 60 ? `${oneLine.slice(0, 60).trimEnd()}…` : oneLine}`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        subject,
        text: [text, '', `From: ${from || 'not given'}`, `Time: ${new Date().toISOString()}`].join('\n'),
        ...(from && { reply_to: from }),
      }),
    });
    if (!res.ok) {
      console.error('feedback send failed', res.status, await res.text());
      return json({ error: 'Send failed' }, 502);
    }
  } catch (err) {
    console.error('feedback send failed', err instanceof Error ? err.message : err);
    return json({ error: 'Send failed' }, 502);
  }
  return json({ ok: true });
}
