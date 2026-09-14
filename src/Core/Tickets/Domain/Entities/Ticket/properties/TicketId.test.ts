import { Schema } from 'effect';
import { expect, test } from 'vitest';

import { formatTicketId, parseTicketId, TicketId } from './TicketId';

test('formats and parses a source-namespaced id', () => {
  const folder = formatTicketId('folder', '42');
  const linear = formatTicketId('linear', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');

  expect(folder).toBe('folder:42');
  expect(linear).toBe('linear:a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  expect(parseTicketId(folder)).toEqual({ source: 'folder', native: '42' });
  expect(parseTicketId(linear)).toEqual({
    source: 'linear',
    native: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  });
  expect(formatTicketId(parseTicketId(folder).source, parseTicketId(folder).native)).toBe(folder);
  expect(Schema.decodeSync(TicketId)('folder:42')).toBe(folder);
});

test('rejects an id that is not source-namespaced', () => {
  expect(() => Schema.decodeSync(TicketId)('42')).toThrow(Schema.SchemaError);
  expect(() => Schema.decodeSync(TicketId)('folder:')).toThrow(Schema.SchemaError);
  expect(() => formatTicketId('', '42')).toThrow(Schema.SchemaError);
});
