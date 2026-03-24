import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { getPostgresPool, type APIResponse, config } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';
import { getQueueClient } from '../queue';
import { fetchBalances } from '../services/balances';
import { fetchUnclaimedDeposits } from '../services/unclaimed-deposits';

const UpdateProfileSchema = z.object({
  email: z.string().email().optional(),
  telegram: z.string().max(100).optional(),
  discord: z.string().max(100).optional(),
  notify_on_offer_received: z.boolean().optional(),
  notify_on_listing_sold: z.boolean().optional(),
  min_offer_threshold: z.number().min(0).nullable().optional(),
});

const AddressParamsSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
});

export async function usersRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/users/:address/badges
   * Get POAP badges for an address (queries all configured collections)
   */
  fastify.get('/:address/badges', async (request, reply) => {
    try {
      const { address } = AddressParamsSchema.parse(request.params);

      if (!config.poap.apiKey) {
        return reply.status(503).send({
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'POAP API key not configured',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Fetch badges from all configured collections in parallel
      const badgePromises = config.poap.collectionIds.map(async (collectionId) => {
        try {
          const response = await fetch(
            `https://api.poap.tech/actions/scan/${address}/${collectionId}`,
            {
              method: 'GET',
              headers: {
                'X-API-Key': config.poap.apiKey!,
                'Content-Type': 'application/json',
              },
            }
          );

          if (response.status === 404) {
            return null; // No badge for this collection
          }

          if (!response.ok) {
            fastify.log.warn({ status: response.status, address, collectionId }, 'POAP API error for collection');
            return null;
          }

          return await response.json();
        } catch (error) {
          fastify.log.error({ error, address, collectionId }, 'Failed to fetch POAP badge for collection');
          return null;
        }
      });

      const badgeResults = await Promise.all(badgePromises);
      const badges = badgeResults.filter((badge): badge is NonNullable<typeof badge> => badge !== null);

      const apiResponse: APIResponse = {
        success: true,
        data: {
          address,
          badges,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(apiResponse);
    } catch (error: any) {
      fastify.log.error('Error fetching POAP badges:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid address format',
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
          message: 'Failed to fetch badges',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/users/:address/balances
   * Get token balances for an address (ETH, WETH, USDC, ENS)
   */
  fastify.get('/:address/balances', async (request, reply) => {
    try {
      const { address } = AddressParamsSchema.parse(request.params);

      const balances = await fetchBalances(address);

      const response: APIResponse = {
        success: true,
        data: {
          address: address.toLowerCase(),
          balances,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error({ error, address: (request.params as any)?.address }, 'Error fetching balances');

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid address format',
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
          message: 'Failed to fetch balances',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/users/:address/unclaimed-deposits
   * Check for unclaimed ENS old registrar deposits (Vickrey auction deeds)
   */
  fastify.get('/:address/unclaimed-deposits', async (request, reply) => {
    try {
      const { address } = AddressParamsSchema.parse(request.params);

      const result = await fetchUnclaimedDeposits(address);

      const response: APIResponse = {
        success: true,
        data: result,
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error({ error, address: (request.params as any)?.address }, 'Error fetching unclaimed deposits');

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid address format',
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
          message: 'Failed to fetch unclaimed deposits',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * PATCH /api/v1/users/me
   * Update current user's profile
   */
  fastify.patch('/me', { preHandler: requireAuth }, async (request, reply) => {
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

      const updates = UpdateProfileSchema.parse(request.body);
      const userId = parseInt(request.user.sub);

      // Get current user data to check if email changed
      const currentUserResult = await pool.query(
        'SELECT email FROM users WHERE id = $1',
        [userId]
      );

      if (currentUserResult.rows.length === 0) {
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

      const currentEmail = currentUserResult.rows[0].email;
      const emailChanged = updates.email !== undefined && updates.email !== currentEmail;

      // Build dynamic UPDATE query
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (updates.email !== undefined) {
        updateFields.push(`email = $${paramCount}`);
        values.push(updates.email);
        paramCount++;

        // Reset email verification if email changed
        if (emailChanged) {
          updateFields.push(`email_verified = FALSE`);
        }
      }

      if (updates.telegram !== undefined) {
        updateFields.push(`telegram = $${paramCount}`);
        values.push(updates.telegram);
        paramCount++;
      }

      if (updates.discord !== undefined) {
        updateFields.push(`discord = $${paramCount}`);
        values.push(updates.discord);
        paramCount++;
      }

      if (updates.notify_on_offer_received !== undefined) {
        updateFields.push(`notify_on_offer_received = $${paramCount}`);
        values.push(updates.notify_on_offer_received);
        paramCount++;
      }

      if (updates.notify_on_listing_sold !== undefined) {
        updateFields.push(`notify_on_listing_sold = $${paramCount}`);
        values.push(updates.notify_on_listing_sold);
        paramCount++;
      }

      if (updates.min_offer_threshold !== undefined) {
        updateFields.push(`min_offer_threshold = $${paramCount}`);
        values.push(updates.min_offer_threshold);
        paramCount++;
      }

      if (updateFields.length === 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'NO_UPDATES',
            message: 'No fields to update',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Add user ID for WHERE clause
      values.push(userId);

      const query = `
        UPDATE users
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      `;

      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
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

      const user = result.rows[0];

      // If email changed, generate verification token and send email
      if (emailChanged && updates.email) {
        try {
          // Generate cryptographically secure token
          const token = randomBytes(32).toString('base64url');

          // Insert verification token
          await pool.query(
            `INSERT INTO email_verification_tokens (user_id, token, email, expires_at)
             VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
            [userId, token, updates.email]
          );

          // Send verification email via queue
          const boss = await getQueueClient();
          await boss.send('send-verification-email', {
            userId,
            email: updates.email,
            token,
          });

          fastify.log.info({ userId, email: updates.email }, 'Verification email queued');
        } catch (emailError) {
          fastify.log.error({ error: emailError, userId }, 'Failed to send verification email');
          // Don't fail the request if email sending fails
        }
      }

      const response: APIResponse = {
        success: true,
        data: {
          id: user.id,
          address: user.address,
          email: user.email,
          emailVerified: user.email_verified,
          telegram: user.telegram,
          discord: user.discord,
          notifyOnOfferReceived: user.notify_on_offer_received,
          notifyOnListingSold: user.notify_on_listing_sold,
          minOfferThreshold: user.min_offer_threshold != null ? parseFloat(user.min_offer_threshold) : null,
          updatedAt: user.updated_at,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error updating profile:', error);

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
          message: 'Failed to update profile',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
