import type { UserRole } from '../models/User';
import type { StoreRole } from '../models/Store';

/** The authenticated principal attached to req.user by the auth middleware. */
export interface AuthUser {
  id: string;
  /** Platform role. `admin` reaches inside every store; it is not a store position. */
  role: UserRole;
  isRoot: boolean;
  /**
   * The store this request acts within, read fresh from the database on every
   * authenticated request rather than carried in the JWT — so removing someone
   * from a store takes effect immediately instead of when their token expires.
   * Undefined for a user who has not yet created or joined one.
   */
  storeId?: string;
  storeRole?: StoreRole;
  name?: string;
  email?: string;
  /** JWT "issued at" (seconds); used to reject tokens minted before a password change. */
  iat?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
