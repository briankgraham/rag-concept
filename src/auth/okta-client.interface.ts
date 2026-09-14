export interface OktaProfile {
  oktaId: string;
  email: string;
  name: string;
  /** Maps to the employee's identifier in ADP, used for PTO lookups. */
  employeeId: string;
}

/**
 * Abstraction over Okta OIDC so the rest of the app (routes, sessions,
 * user records) never depends on whether we're talking to real Okta or a
 * local mock. Swapping okta-client.mock.ts for okta-client.real.ts should
 * require no changes anywhere else.
 */
export interface OktaClient {
  /** Where to send the browser to start the login flow. */
  getAuthorizationUrl(state: string): string;

  /** Exchange the callback's authorization code for a verified profile. */
  exchangeCodeForProfile(code: string): Promise<OktaProfile>;
}
