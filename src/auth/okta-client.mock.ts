import type { OktaClient, OktaProfile } from './okta-client.interface.js';

/**
 * Mock employee directory standing in for what Okta would actually assert
 * about a logged-in user. employeeId is what we hand to the ADP client.
 */
export const MOCK_EMPLOYEES: OktaProfile[] = [
  { oktaId: 'mock-okta-1', email: 'jane.doe@example.com', name: 'Jane Doe', employeeId: 'E1001' },
  { oktaId: 'mock-okta-2', email: 'sam.lee@example.com', name: 'Sam Lee', employeeId: 'E1002' },
  { oktaId: 'mock-okta-3', email: 'alex.chen@example.com', name: 'Alex Chen', employeeId: 'E1003' },
  { oktaId: 'mock-okta-4', email: 'priya.patel@example.com', name: 'Priya Patel', employeeId: 'E1004' }
];

/**
 * Mock implementation of OktaClient for local development, since we have
 * no live Okta tenant yet. Instead of redirecting to Okta, it points the
 * browser at a local "pick a user" page (rendered by auth.routes.ts's
 * mock-only route) and encodes the chosen profile directly into a fake
 * "code" (base64 JSON — NOT secure, dev-only) that exchangeCodeForProfile
 * decodes. Everything else (redirect -> callback -> session -> cookie)
 * runs exactly as it will against real Okta.
 */
export class MockOktaClient implements OktaClient {
  getAuthorizationUrl(state: string): string {
    return `/auth/mock-login?state=${encodeURIComponent(state)}`;
  }

  async exchangeCodeForProfile(code: string): Promise<OktaProfile> {
    try {
      const decoded = Buffer.from(code, 'base64url').toString('utf8');
      const profile = JSON.parse(decoded) as OktaProfile;
      if (!profile.oktaId || !profile.email || !profile.employeeId) {
        throw new Error('incomplete profile');
      }
      return profile;
    } catch {
      throw new Error('Invalid mock authorization code');
    }
  }
}

export function encodeMockCode(profile: OktaProfile): string {
  return Buffer.from(JSON.stringify(profile), 'utf8').toString('base64url');
}
