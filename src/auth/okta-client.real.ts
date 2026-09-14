import type { OktaClient, OktaProfile } from './okta-client.interface.js';

/**
 * Real Okta OIDC implementation — NOT built yet. This phase has no live
 * Okta tenant/credentials, so integration is deferred. When ready, wire
 * this up with the `openid-client` package (authorization code flow) and
 * swap it in wherever MockOktaClient is currently constructed. No other
 * code should need to change.
 */
export class RealOktaClient implements OktaClient {
  getAuthorizationUrl(_state: string): string {
    throw new Error('RealOktaClient is not implemented yet. Set OKTA_MOCK=true.');
  }

  async exchangeCodeForProfile(_code: string): Promise<OktaProfile> {
    throw new Error('RealOktaClient is not implemented yet. Set OKTA_MOCK=true.');
  }
}
