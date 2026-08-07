/**
 * Parser for the Sentry envelope format:
 * https://develop.sentry.dev/sdk/envelopes/
 *
 * An envelope is newline-delimited: one envelope header line, then repeated
 * (item header line, payload) pairs. Item payloads either declare an explicit
 * byte `length` in their header or run until the next newline.
 */

export interface EnvelopeItem {
  header: Record<string, unknown>;
  payload: Buffer;
}

export interface Envelope {
  header: Record<string, unknown>;
  items: EnvelopeItem[];
}

const NL = 0x0a;

function readLine(buf: Buffer, offset: number): { line: Buffer; next: number } {
  const idx = buf.indexOf(NL, offset);
  if (idx === -1) return { line: buf.subarray(offset), next: buf.length };
  return { line: buf.subarray(offset, idx), next: idx + 1 };
}

export function parseEnvelope(buf: Buffer): Envelope {
  let offset = 0;
  const first = readLine(buf, offset);
  const header = JSON.parse(first.line.toString('utf8'));
  offset = first.next;

  const items: EnvelopeItem[] = [];
  while (offset < buf.length) {
    const headerLine = readLine(buf, offset);
    offset = headerLine.next;
    const trimmed = headerLine.line.toString('utf8').trim();
    if (trimmed === '') continue;

    const itemHeader = JSON.parse(trimmed) as Record<string, unknown>;
    let payload: Buffer;

    if (typeof itemHeader.length === 'number') {
      payload = buf.subarray(offset, offset + itemHeader.length);
      offset += itemHeader.length;
      if (buf[offset] === NL) offset += 1;
    } else {
      const payloadLine = readLine(buf, offset);
      payload = payloadLine.line;
      offset = payloadLine.next;
    }
    items.push({ header: itemHeader, payload });
  }
  return { header, items };
}
