import test from 'node:test';
import assert from 'node:assert/strict';
import { MockOktaClient, MOCK_EMPLOYEES, encodeMockCode } from '../auth/okta-client.mock.js';

test('MockOktaClient round-trips a profile through the encoded code', async () => {
  const client = new MockOktaClient();
  const profile = MOCK_EMPLOYEES[0];
  const code = encodeMockCode(profile);

  const decoded = await client.exchangeCodeForProfile(code);
  assert.deepEqual(decoded, profile);
});

test('MockOktaClient rejects a malformed code', async () => {
  const client = new MockOktaClient();
  await assert.rejects(() => client.exchangeCodeForProfile('not-valid-base64json'));
});

test('MockOktaClient rejects validly-encoded JSON that is missing required fields', async () => {
  const client = new MockOktaClient();
  const incomplete = Buffer.from(JSON.stringify({ name: 'No Id Or Email' }), 'utf8').toString('base64url');
  await assert.rejects(() => client.exchangeCodeForProfile(incomplete), /Invalid mock authorization code/);
});

test('getAuthorizationUrl points at the local mock login page', () => {
  const client = new MockOktaClient();
  const url = client.getAuthorizationUrl('abc123');
  assert.equal(url, '/auth/mock-login?state=abc123');
});
