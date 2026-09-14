import test from 'node:test';
import assert from 'node:assert/strict';
import { RealOktaClient } from '../auth/okta-client.real.js';

test('RealOktaClient.getAuthorizationUrl throws until implemented', () => {
  const client = new RealOktaClient();
  assert.throws(() => client.getAuthorizationUrl('state'), /not implemented/);
});

test('RealOktaClient.exchangeCodeForProfile throws until implemented', async () => {
  const client = new RealOktaClient();
  await assert.rejects(() => client.exchangeCodeForProfile('code'), /not implemented/);
});
