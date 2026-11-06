/**
 * Reset an admin password from the server:
 *   npm run admin:password -- admin@binarygroup.dev "new-strong-password"
 * Creates the admin if the email doesn't exist yet.
 */
import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

const [email, password, ...nameParts] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error('Usage: npm run admin:password -- <email> "<password (10+ chars)>" [name]');
  process.exit(1);
}
const hash = await bcrypt.hash(password, 12);
const { rows } = await pool.query(
  `INSERT INTO admins (email, name, password_hash) VALUES ($1, $2, $3)
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING (xmax = 0) AS created`,
  [email.toLowerCase(), nameParts.join(" ") || "Admin", hash],
);
console.log(rows[0].created ? `Admin created: ${email}` : `Password updated: ${email}`);
await pool.end();
