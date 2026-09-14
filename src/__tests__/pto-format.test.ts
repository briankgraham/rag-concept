import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPtoAnswer } from '../hr/format.js';

test('formatPtoAnswer pluralizes "days" correctly', () => {
  assert.equal(
    formatPtoAnswer({ employeeId: 'E1', accrued: 20, used: 10, remaining: 10, asOf: '2026-09-13' }),
    'You have 10 days of PTO left (accrued 20, used 10, as of 2026-09-13).'
  );
});

test('formatPtoAnswer uses singular "day" for exactly 1 remaining', () => {
  assert.equal(
    formatPtoAnswer({ employeeId: 'E1', accrued: 20, used: 19, remaining: 1, asOf: '2026-09-13' }),
    'You have 1 day of PTO left (accrued 20, used 19, as of 2026-09-13).'
  );
});
