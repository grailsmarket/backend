import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';

const UpdateProfileSchema = z.object({
  email: z.string().email().optional(),
  telegram: z.string().max(100).optional(),
  discord: z.string().max(100).optional(),
});

export async function usersRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

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

      // Build dynamic UPDATE query
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (updates.email !== undefined) {
        updateFields.push(`email = $${paramCount}`);
        values.push(updates.email);
        paramCount++;

        // Reset email verification if email changed
        updateFields.push(`email_verified = FALSE`);
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

      const response: APIResponse = {
        success: true,
        data: {
          id: user.id,
          address: user.address,
          email: user.email,
          emailVerified: user.email_verified,
          telegram: user.telegram,
          discord: user.discord,
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
