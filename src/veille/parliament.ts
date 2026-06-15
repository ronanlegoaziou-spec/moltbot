import { createHmac, createHash } from 'node:crypto';
import type { ParliamentData } from './types';

function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSha256(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

async function r2GetText(
  accountId: string,
  accessKeyId: string,
  secretAccessKey: string,
  bucket: string,
  key: string,
): Promise<string | null> {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = now.toISOString().replace(/[:\-]/g, '').slice(0, 15) + 'Z';

  const canonicalUri = `/${bucket}/${key}`;
  const payloadHash = sha256hex('');
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const canonicalRequest = [
    'GET',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(Buffer.from(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = hmacSha256(kDate, 'auto');
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(`https://${host}/${bucket}/${key}`, {
    headers: { 'x-amz-date': amzDate, Authorization: authorization },
  });

  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`R2 GET ${key}: HTTP ${resp.status}`);
  return resp.text();
}

/**
 * Reads pappers-maison parliamentary results from R2.
 * pappers-maison writes to R2 at 7:30; moltbot reads at 8:10.
 * R2 key: veille/parlement/{client_id}/latest.json
 * Non-fatal: returns null on any error.
 */
export async function readParliamentData(
  clientId: string,
  accountId: string,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<ParliamentData | null> {
  // pappers-maison uses hyphens (bk-bf, france-travail); moltbot uses underscores
  const r2ClientId = clientId.replace(/_/g, '-');
  const key = `veille/parlement/${r2ClientId}/latest.json`;

  try {
    const text = await r2GetText(accountId, accessKeyId, secretAccessKey, 'moltbot-data', key);
    if (!text) return null;
    const data = JSON.parse(text) as ParliamentData;
    // Reject stale data (more than 4 hours old)
    const runAt = new Date(data.run_at_utc);
    const ageHours = (Date.now() - runAt.getTime()) / 3_600_000;
    if (ageHours > 4) {
      console.warn(
        `[veille] parliament data for ${clientId} is ${ageHours.toFixed(1)}h old — skipping`,
      );
      return null;
    }
    return data;
  } catch (err) {
    console.warn(
      `[veille] parliament R2 read failed for ${clientId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
