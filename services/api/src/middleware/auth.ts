import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../../../shared/src';

export interface JWTPayload {
  sub: string;      // User ID
  address: string;  // Ethereum address
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
export function generateToken(userId: number, address: string): string {
  const secret = config.jwt.secret;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }

  const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
    sub: userId.toString(),
    address: address.toLowerCase(),
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
