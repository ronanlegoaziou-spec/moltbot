import { ImapFlow } from 'imapflow';
import type { ParsedMail } from 'mailparser';
import type { ParsedEmail } from './types';

// simpleParser is not typed well for ESM — import via require-style workaround
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { simpleParser } = require('mailparser') as { simpleParser: (source: Buffer) => Promise<ParsedMail> };

export async function fetchImapEmails(user: string, appPassword: string): Promise<ParsedEmail[]> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass: appPassword },
    logger: false,
  });

  await client.connect();
  const emails: ParsedEmail[] = [];

  try {
    const lock = await client.getMailboxLock('[Gmail]/All Mail');
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const uids = await client.search({ since }, { uid: true });

      if (!uids || !Array.isArray(uids) || uids.length === 0) {
        return emails;
      }

      let num = 1;
      for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
        if (!msg.source) continue;

        const parsed = await simpleParser(msg.source as Buffer);

        const rawBody = parsed.text ?? (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : '');
        const body = rawBody.replace(/\s+/g, ' ').trim().slice(0, 6000);

        emails.push({
          num: num++,
          date: parsed.date?.toISOString() ?? new Date().toISOString(),
          sender: parsed.from?.text ?? '',
          subject: parsed.subject ?? '',
          body,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return emails;
}
