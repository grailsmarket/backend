import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { config, TIER_RANK } from '../../../shared/src';

export interface JWTPayload {
  sub: string;      // User ID
  address: string;  // Ethereum address
  tier: string;     // 'free' | 'pro' | 'premium'
  tierId: number;   // Contract tier ID (0=free, 1=pro, ...)
  tierExpiresAt: string | null; // ISO string or null
  isAdmin: boolean;
  iat: number;      // Issued at
  exp: number;      // Expires at
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: JWTPayload;
  }
}

/**
 * Generate JWT token for authenticated user
 */
export function generateToken(user: {
  id: number;
  address: string;
  tier?: string;
  tier_id?: number;
  tier_expires_at?: string | null;
  is_admin?: boolean;
}): string {
  const secret = config.jwt.secret;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }

  const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
    sub: user.id.toString(),
    address: user.address.toLowerCase(),
    tier: user.tier || 'free',
    tierId: user.tier_id ?? 0,
    tierExpiresAt: user.tier_expires_at || null,
    isAdmin: user.is_admin || false,
  };

  return jwt.sign(payload, secret, {
    expiresIn: config.jwt.expiresIn as any,
  });
}

/**
 * Verify and decode JWT token
 */
export function verifyToken(token: string): JWTPayload {
  const secret = config.jwt.secret;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }

  try {
    const decoded = jwt.verify(token, secret) as JWTPayload;
    return decoded;
  } catch (error) {
    throw new Error('Invalid token');
  }
}

/**
 * Fastify middleware to require authentication
 * Usage: { preHandler: requireAuth }
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    // Extract token from Authorization header
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'No authorization token provided',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Check Bearer format
    if (!authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid authorization format. Use: Bearer <token>',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Extract and verify token
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const decoded = verifyToken(token);

    // Attach user info to request
    request.user = decoded;
  } catch (error: any) {
    request.log.warn('Authentication failed:', error.message);

    return reply.status(401).send({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
  }
}

/**
 * Optional auth middleware - doesn't fail if no token provided
 * Attaches user if valid token present
 */
export async function optionalAuth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const authHeader = request.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = verifyToken(token);
      request.user = decoded;
    }
  } catch (error: any) {
    // Silently fail for optional auth
    request.log.debug('Optional auth failed:', error?.message || 'Unknown error');
  }
}

/**
 * Middleware to require a specific tier.
 * Checks JWT tier + expiry without DB queries.
 * Usage: { preHandler: [requireAuth, requireTier('pro')] }
 */
export function requireTier(...allowedTiers: string[]) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const { tier, tierExpiresAt } = request.user;

    // Check if tier has expired (server-side check even if JWT is still valid)
    if (tier !== 'free' && tierExpiresAt) {
      const expiresAt = new Date(tierExpiresAt);
      if (expiresAt < new Date()) {
        // Tier expired but JWT hasn't been refreshed yet - treat as free
        if (!allowedTiers.includes('free')) {
          return reply.status(403).send({
            success: false,
            error: {
              code: 'TIER_EXPIRED',
              message: 'Your subscription has expired. Please renew or refresh your session.',
            },
            meta: { timestamp: new Date().toISOString() },
          });
        }
        return; // free is allowed, continue
      }
    }

    if (!allowedTiers.includes(tier)) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'INSUFFICIENT_TIER',
          message: `This feature requires one of: ${allowedTiers.join(', ')}. Your current tier: ${tier}`,
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  };
}

/**
 * Middleware to require a minimum tier level (hierarchical check).
 * Unlike requireTier() which is exact-match, this allows any tier
 * at or above the specified level (e.g., requireMinTier('pro') allows 'pro', 'plus', and 'gold').
 * Usage: { preHandler: [requireAuth, requireMinTier('pro')] }
 */
export function requireMinTier(minimumTier: string) {
  const minRank = TIER_RANK[minimumTier] ?? 0;

  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const { tier, tierExpiresAt } = request.user;

    // Check if tier has expired
    if (tier !== 'free' && tierExpiresAt) {
      const expiresAt = new Date(tierExpiresAt);
      if (expiresAt < new Date()) {
        if (minRank > (TIER_RANK['free'] ?? 0)) {
          return reply.status(403).send({
            success: false,
            error: {
              code: 'TIER_EXPIRED',
              message: 'Your subscription has expired. Please renew or refresh your session.',
            },
            meta: { timestamp: new Date().toISOString() },
          });
        }
        return; // free-level access is allowed
      }
    }

    if ((TIER_RANK[tier] ?? 0) < minRank) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'INSUFFICIENT_TIER',
          message: `This feature requires at least: ${minimumTier}. Your current tier: ${tier}`,
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  };
}

/**
 * Middleware to require admin access.
 * Usage: { preHandler: [requireAuth, requireAdmin] }
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!request.user) {
    return reply.status(401).send({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      },
      meta: { timestamp: new Date().toISOString() },
    });
  }

  if (!request.user.isAdmin) {
    return reply.status(403).send({
      success: false,
      error: {
        code: 'ADMIN_REQUIRED',
        message: 'Admin access required',
      },
      meta: { timestamp: new Date().toISOString() },
    });
  }
}
