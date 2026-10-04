import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePhoto, OcrError } from './ocr-service.mjs';

test('OCR input rejects unsupported formats, malformed or oversized data', () => {
  assert.throws(() => decodePhoto({ mimeType: 'image/svg+xml', base64: 'YWJj' }), OcrError);
  assert.throws(() => decodePhoto({ mimeType: 'image/png', base64: '###' }), OcrError);
  assert.throws(() => decodePhoto({ mimeType: 'image/png', base64: '' }), OcrError);
  assert.throws(() => decodePhoto({ mimeType: 'image/png', base64: Buffer.alloc(12 * 1024 * 1024 + 1).toString('base64') }), error => error.status === 413);
  assert.deepEqual(decodePhoto({ mimeType: 'image/png', base64: 'YWJj' }), Buffer.from('abc'));
});
