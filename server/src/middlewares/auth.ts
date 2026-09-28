import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import type { AuthUser } from '../types/auth';

export interface JwtPayload {
  sub: string;
  role: 'admin' | 'user';
  isRoot: boolean;
  name?: string;
  email?: string;
  /** Issued-at (seconds), populated by jsonwebtoken on verify. */
  iat?: number;
}

const MIN_SECRET_LENGTH = 32;

const getSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return secret;
};

/**
 * Validates the configured JWT secret. Returns the list of problems found
 * (empty = OK). Pure-ish so it can be unit-tested by passing a secret in.
 */
export const validateJwtSecret = (secret: string | undefined): string[] => {
  const problems: string[] = [];
  if (!secret) {
    problems.push('JWT_SECRET is not set.');
    return problems;
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(`JWT_SECRET is too short (${secret.length} chars); use at least ${MIN_SECRET_LENGTH}.`);
  }
  if (/^(changeme|secret|default|password)/i.test(secret)) {
    problems.push('JWT_SECRET looks like a placeholder value; set a strong random secret.');
  }
  return problems;
};

/**
 * Fail-fast at boot: a missing secret is always fatal; a weak secret is fatal
 * in production and a warning elsewhere.
 */
export const assertJwtSecretAtBoot = (): void => {
  const problems = validateJwtSecret(process.env.JWT_SECRET);
  if (problems.length === 0) return;

  const missing = !process.env.JWT_SECRET;
  const fatal = missing || process.env.NODE_ENV === 'production';
  const prefix = fatal ? '[server][FATAL]' : '[server][WARN]';
  for (const p of problems) console.error(`${prefix} ${p}`);

  if (fatal) {
    console.error('[server][FATAL] Refusing to start with an insecure JWT configuration.');
    process.exit(1);
  }
};

export const signToken = (user: { id: string; role: 'admin' | 'user'; isRoot: boolean; name?: string; email?: string }): string => {
  const payload: JwtPayload = {
    sub: user.id,
    role: user.role,
    isRoot: user.isRoot,
    name: user.name,
    email: user.email,
  };
  return jwt.sign(payload, getSecret(), {
    algorithm: 'HS256',
    expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'],
  });
};

/** Verifies a JWT (pinned to HS256) and returns the decoded payload, or null. */
const verifyToken = (token: string): JwtPayload | null => {
  try {
    return jwt.verify(token, getSecret(), { algorithms: ['HS256'] }) as JwtPayload;
  } catch {
    return null;
  }
};

/**
 * Verifies the Bearer token from the Authorization header and attaches req.user.
 *
 * The token is deliberately NOT read from the query string here: query strings
 * are logged by proxies/servers and land in history/Referer, so a JWT there is
 * a leaked credential. The one place that genuinely needs a query token is the
 * SSE endpoint (EventSource can't set headers) — that uses {@link requireAuthSSE}.
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
  req.user = {
    id: decoded.sub,
    role: decoded.role,
    isRoot: decoded.isRoot,
    name: decoded.name,
    email: decoded.email,
    iat: decoded.iat,
  };
  next();
};

/**
 * Auth for SSE endpoints only. Accepts the token via Authorization header OR a
 * `?token=` query param, because the browser's EventSource API cannot send
 * custom headers. Use this ONLY on streaming routes, never on the general API.
 */
export const requireAuthSSE = (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  let token = header && header.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token && typeof req.query.token === 'string') {
    token = req.query.token;
  }
  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
  req.user = {
    id: decoded.sub,
    role: decoded.role,
    isRoot: decoded.isRoot,
    name: decoded.name,
    email: decoded.email,
    iat: decoded.iat,
  };
  next();
};

/** Ensures the authenticated user's account is still active (not suspended/deleted). */
export const requireActive = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) return res.status(401).json({ message: 'Authentication required' });
    const account = await User.findById(req.user.id).select('name email status role isRoot passwordChangedAt storeId storeRole');
    if (!account) return res.status(401).json({ message: 'Account no longer exists' });
    if (account.status !== 'active') {
      return res.status(403).json({ message: 'Account is not active' });
    }
    // Reject tokens minted before the last password change (reset/change should
    // lock out any previously issued session). 1s slack absorbs clock rounding.
    if (account.passwordChangedAt && req.user.iat) {
      if (req.user.iat * 1000 < account.passwordChangedAt.getTime() - 1000) {
        return res.status(401).json({ message: 'Session expired, please sign in again' });
      }
    }
    // keep req.user in sync with the latest role/isRoot/name/email from DB
    req.user.role = account.role;
    req.user.isRoot = account.isRoot;
    req.user.name = account.name;
    req.user.email = account.email;
    // Tenancy comes from the database, not the token, so a membership change
    // (or removal) applies to the very next request.
    req.user.storeId = account.storeId ? String(account.storeId) : undefined;
    req.user.storeRole = account.storeRole;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ message: 'Authentication required' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Administrator access required' });
  }
  next();
};
