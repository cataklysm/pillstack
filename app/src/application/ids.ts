import { randomFillSync } from 'node:crypto';

/**
 * UUIDv7 generator.
 *
 * Time-sortable, so rows cluster by creation order in the primary key index,
 * and stable across JSON export, import and backup restore — which an
 * autoincrementing integer would not be.
 */

const buffer = new Uint8Array(16);
let lastTimestampMs = 0;
let sequence = 0;

const MAX_SEQUENCE = 0x0fff;

export function createId(): string {
  const timestampMs = Date.now();

  if (timestampMs === lastTimestampMs) {
    sequence += 1;
    if (sequence > MAX_SEQUENCE) {
      // More than 4096 ids in one millisecond: borrow from the next one rather
      // than emit a non-monotonic id.
      lastTimestampMs += 1;
      sequence = 0;
    }
  } else if (timestampMs > lastTimestampMs) {
    lastTimestampMs = timestampMs;
    sequence = 0;
  } else {
    // Clock moved backwards; keep issuing monotonic ids.
    sequence += 1;
  }

  randomFillSync(buffer, 8, 8);

  const timestamp = lastTimestampMs;
  buffer[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  buffer[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  buffer[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  buffer[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  buffer[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  buffer[5] = timestamp & 0xff;

  buffer[6] = 0x70 | ((sequence >> 8) & 0x0f);
  buffer[7] = sequence & 0xff;
  buffer[8] = 0x80 | ((buffer[8] as number) & 0x3f);

  return format(buffer);
}

function format(bytes: Uint8Array): string {
  let hex = '';
  for (let index = 0; index < 16; index += 1) {
    hex += (bytes[index] as number).toString(16).padStart(2, '0');
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
