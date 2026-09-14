import { query } from '../db/pool.js';
import type { OktaProfile } from './okta-client.interface.js';

export interface User {
  id: string;
  oktaId: string;
  email: string;
  name: string;
  employeeId: string;
}

function rowToUser(row: any): User {
  return {
    id: row.id,
    oktaId: row.okta_id,
    email: row.email,
    name: row.name,
    employeeId: row.employee_id
  };
}

export async function findOrCreateUser(profile: OktaProfile): Promise<User> {
  // A single upsert instead of SELECT-then-branch-into-INSERT-or-UPDATE:
  // the latter raced on okta_id's UNIQUE constraint when two requests for
  // the same brand-new identity (e.g. a double-submitted OAuth callback)
  // both saw no existing row and both attempted the INSERT — the second
  // would throw an unhandled unique_violation instead of completing login.
  const result = await query<any>(
    `INSERT INTO users (okta_id, email, name, employee_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (okta_id) DO UPDATE SET
       name = $3, email = $2, employee_id = $4, updated_at = now()
     RETURNING *`,
    [profile.oktaId, profile.email, profile.name, profile.employeeId]
  );
  return rowToUser(result.rows[0]);
}

export async function getUserById(id: string): Promise<User | null> {
  const result = await query<any>('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows.length > 0 ? rowToUser(result.rows[0]) : null;
}
