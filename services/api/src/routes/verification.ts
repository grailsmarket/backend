import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';
import { getQueueClient } from '../queue';

const VerifyEmailSchema = z.object({
  token: z.string().min(1),
});

export async function verificationRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * POST /api/v1/verification/email
   * Verify email address using token from verification link
   */
  fastify.post('/email', async (request, reply) => {
    try {
      const { token } = VerifyEmailSchema.parse(request.body);

      // Find unused, non-expired token
      const tokenResult = await pool.query(
        `SELECT id, user_id, email
         FROM email_verification_tokens
         WHERE token = $1
           AND used_at IS NULL
           AND expires_at > NOW()`,
        [token]
      );

      if (tokenResult.rows.length === 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Invalid or expired verification token',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { id: tokenId, user_id: userId, email } = tokenResult.rows[0];

      // Update user email_verified
      await pool.query(
        `UPDATE users SET email_verified = true WHERE id = $1 AND email = $2`,
        [userId, email]
      );

      // Mark token as used
      await pool.query(
        `UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1`,
        [tokenId]
      );

      fastify.log.info({ userId, email }, 'Email verified successfully');

      const response: APIResponse = {
        success: true,
        data: { message: 'Email verified successfully' },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error verifying email:', error);

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
          code: 'VERIFICATION_FAILED',
          message: 'Failed to verify email',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * POST /api/v1/verification/resend
   * Resend verification email (requires auth)
   */
  fastify.post('/resend', { preHandler: requireAuth }, async (request, reply) => {
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

      const userId = parseInt(request.user.sub);

      // Get user info
      const userResult = await pool.query(
        'SELECT email, email_verified FROM users WHERE id = $1',
        [userId]
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

      if (!user.email) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'NO_EMAIL',
            message: 'No email address on file',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      if (user.email_verified) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'ALREADY_VERIFIED',
            message: 'Email already verified',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Generate new token
      const token = randomBytes(32).toString('base64url');

      await pool.query(
        `INSERT INTO email_verification_tokens (user_id, token, email, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
        [userId, token, user.email]
      );

      // Publish email job
      const boss = await getQueueClient();
      await boss.send('send-verification-email', {
        userId,
        email: user.email,
        token,
      });

      fastify.log.info({ userId, email: user.email }, 'Verification email resent');

      const response: APIResponse = {
        success: true,
        data: { message: 'Verification email sent' },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error resending verification:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'RESEND_FAILED',
          message: 'Failed to resend verification email',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
