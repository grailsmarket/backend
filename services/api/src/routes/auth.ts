import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { SiweMessage } from 'siwe';
import { verifyMessage } from 'viem';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { generateToken, requireAuth } from '../middleware/auth';

const NonceQuerySchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
});

const VerifyBodySchema = z.object({
  message: z.string(),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, 'Invalid signature format'),
});

export async function authRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/auth/nonce
   * Request a nonce for SIWE authentication
   */
  fastify.get('/nonce', async (request, reply) => {
    try {
      const { address } = NonceQuerySchema.parse(request.query);
      const normalizedAddress = address.toLowerCase();

      // Generate cryptographically secure nonce (alphanumeric only, as per EIP-4361)
      const nonce = crypto.randomBytes(16).toString('hex');

      // Delete any existing unused nonces for this address
      await pool.query(
        'DELETE FROM nonces WHERE address = $1 AND used = FALSE',
        [normalizedAddress]
      );

      // Store nonce in database with 5-minute expiration (using PostgreSQL NOW() for consistent timezone)
      const insertResult = await pool.query(
        `INSERT INTO nonces (nonce, address, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '5 minutes')
         RETURNING *`,
        [nonce, normalizedAddress]
      );

      fastify.log.info({
        nonce,
        address: normalizedAddress,
        expiresAt: insertResult.rows[0].expires_at,
        inserted: insertResult.rows[0]
      }, 'Nonce created');

      const response: APIResponse = {
        success: true,
        data: {
          nonce,
          expiresAt: insertResult.rows[0].expires_at,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error generating nonce:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request parameters',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to generate nonce',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * POST /api/v1/auth/verify
   * Verify SIWE signature and create session
   */
  fastify.post('/verify', async (request, reply) => {
    try {
      const { message, signature } = VerifyBodySchema.parse(request.body);

      // Parse SIWE message first (without verifying signature yet)
      let siweMessage: SiweMessage;
      try {
        siweMessage = new SiweMessage(message);
      } catch (error: any) {
        fastify.log.error('SIWE parsing error:', error?.message || 'Unknown error');
        return reply.status(401).send({
          success: false,
          error: {
            code: 'INVALID_SIWE_MESSAGE',
            message: 'Invalid SIWE message format',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Validate message fields
      if (!siweMessage.address || !siweMessage.nonce) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_MESSAGE',
            message: 'SIWE message missing required fields',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Check nonce exists and hasn't been used or expired
      const normalizedAddress = siweMessage.address.toLowerCase();

      fastify.log.info({
        nonce: siweMessage.nonce,
        address: normalizedAddress
      }, 'Verifying nonce');

      const nonceResult = await pool.query(
        `SELECT * FROM nonces
         WHERE nonce = $1 AND address = $2 AND used = FALSE`,
        [siweMessage.nonce, normalizedAddress]
      );

      fastify.log.info({
        found: nonceResult.rows.length,
        rows: nonceResult.rows
      }, 'Nonce query result');

      if (nonceResult.rows.length === 0) {
        // Check if nonce exists at all
        const allNoncesResult = await pool.query(
          'SELECT * FROM nonces WHERE nonce = $1',
          [siweMessage.nonce]
        );

        fastify.log.warn({
          nonce: siweMessage.nonce,
          address: normalizedAddress,
          existsWithDifferentAddress: allNoncesResult.rows.length > 0,
          actualNonce: allNoncesResult.rows[0]
        }, 'Nonce not found or already used');

        return reply.status(401).send({
          success: false,
          error: {
            code: 'INVALID_NONCE',
            message: 'Nonce not found or already used',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const nonceRecord = nonceResult.rows[0];

      // Check if nonce has expired
      if (new Date(nonceRecord.expires_at) < new Date()) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'NONCE_EXPIRED',
            message: 'Nonce has expired',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Now verify the signature
      try {
        const verifyResult = await siweMessage.verify({ signature });

        if (!verifyResult.success) {
          return reply.status(401).send({
            success: false,
            error: {
              code: 'SIGNATURE_VERIFICATION_FAILED',
              message: verifyResult.error?.type || 'Signature verification failed',
            },
            meta: {
              timestamp: new Date().toISOString(),
            },
          });
        }
      } catch (error: any) {
        fastify.log.error('Signature verification error:', error?.message || 'Unknown error');
        return reply.status(401).send({
          success: false,
          error: {
            code: 'INVALID_SIGNATURE',
            message: 'Failed to verify signature',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Mark nonce as used
      await pool.query(
        'UPDATE nonces SET used = TRUE WHERE nonce = $1',
        [siweMessage.nonce]
      );

      // Upsert user record
      const userResult = await pool.query(
        `INSERT INTO users (address, last_sign_in)
         VALUES ($1, NOW())
         ON CONFLICT (address)
         DO UPDATE SET last_sign_in = NOW()
         RETURNING *`,
        [normalizedAddress]
      );

      const user = userResult.rows[0];

      // Generate JWT
      const token = generateToken(user.id, user.address);

      const response: APIResponse = {
        success: true,
        data: {
          token,
          user: {
            id: user.id,
            address: user.address,
            email: user.email,
            emailVerified: user.email_verified,
            telegram: user.telegram,
            discord: user.discord,
            createdAt: user.created_at,
            lastSignIn: user.last_sign_in,
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error verifying signature:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to verify signature',
          details: error.message,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/auth/me
   * Get current authenticated user
   */
  fastify.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Fetch user from database
      const userResult = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [parseInt(request.user.sub)]
      );

      if (userResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const user = userResult.rows[0];

      const response: APIResponse = {
        success: true,
        data: {
          id: user.id,
          address: user.address,
          email: user.email,
          emailVerified: user.email_verified,
          telegram: user.telegram,
          discord: user.discord,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
          lastSignIn: user.last_sign_in,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error fetching user:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch user',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * POST /api/v1/auth/logout
   * Logout user (client-side token removal, could add blacklist later)
   */
  fastify.post('/logout', { preHandler: requireAuth }, async (request, reply) => {
    const response: APIResponse = {
      success: true,
      data: {
        message: 'Logged out successfully',
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });
}
