import type { ParsedEmail } from './types';

export interface GmailApiEnv {
  GMAIL_REFRESH_TOKEN?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
}

export function isGmailApiConfigured(env: GmailApiEnv): boolean {
  return !!(env.GMAIL_REFRESH_TOKEN && env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET);
}

async function getAccessToken(env: GmailApiEnv): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.GMAIL_REFRESH_TOKEN!,
      client_id: env.GMAIL_CLIENT_ID!,
      client_secret: env.GMAIL_CLIENT_SECRET!,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

interface GmailPayload {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: GmailPayload[];
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPayload;
}

function decodeBase64Url(encoded: string): string {
  try {
    return atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return '';
  }
}

function extractPlainText(payload: GmailPayload): string {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return '';
}

function parseGmailMessage(msg: GmailMessage, num: number): ParsedEmail {
  const headers = msg.payload?.headers ?? [];
  const h = (name: string) =>
    headers.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  const date = msg.internalDate
    ? new Date(parseInt(msg.internalDate, 10)).toISOString()
    : '';

  const body = msg.payload ? extractPlainText(msg.payload).trim().slice(0, 6000) : '';

  return { num, date, sender: h('From'), subject: h('Subject'), body };
}

export async function fetchGmailApiEmails(env: GmailApiEnv): Promise<ParsedEmail[]> {
  const token = await getAccessToken(env);

  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox newer_than:2d&maxResults=500',
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!listRes.ok) throw new Error(`Gmail API list: ${listRes.status}`);

  const listData = (await listRes.json()) as { messages?: Array<{ id: string }> };
  const ids = listData.messages ?? [];
  if (ids.length === 0) return [];

  const parsed: ParsedEmail[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const details = await Promise.all(
      batch.map((m) =>
        fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) => r.json() as Promise<GmailMessage>),
      ),
    );
    for (const msg of details) {
      parsed.push(parseGmailMessage(msg, parsed.length + 1));
    }
  }

  return parsed;
}
