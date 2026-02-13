import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { APIResponse } from '../../../shared/src';
import { cacheHandler } from '../middleware/cache';
import {
  getNameRoles,
  getManageableNames,
  canUpdateRecords,
  EnsRoles,
  CanManageResult,
} from '../services/ens-roles';
import { buildSearchResults, SearchResult } from '../utils/response-builder';
import { optionalAuth } from '../middleware/auth';

const NameParamsSchema = z.object({
  name: z.string().min(1).refine(
    (val) => val.endsWith('.eth') || val.includes('.'),
    { message: 'Must be a valid ENS name (e.g., name.eth)' }
  ),
});

const AddressParamsSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
});

const NameAddressParamsSchema = z.object({
  name: z.string().min(1),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
});

const ManageableNamesQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

/**
 * SearchResult extended with ENS role information
 */
export interface ManageableNameSearchResult extends SearchResult {
  role: 'owner' | 'manager' | 'both';
}

interface ManageableNamesResponseData {
  address: string;
  names: ManageableNameSearchResult[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export async function ensRolesRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/v1/ens-roles/names/:name/roles
   * Get all roles (owner, manager, ETH address) for a specific ENS name
   */
  fastify.get('/names/:name/roles', { preHandler: cacheHandler }, async (request, reply) => {
    try {
      const { name } = NameParamsSchema.parse(request.params);

      const roles = await getNameRoles(name);

      if (!roles) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'NAME_NOT_FOUND',
            message: `ENS name "${name}" not found on chain`,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const response: APIResponse<EnsRoles> = {
        success: true,
        data: roles,
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error({ error, name: (request.params as any)?.name }, 'Error fetching ENS roles');

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
          message: 'Failed to fetch ENS roles',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/ens-roles/names/:name/can-manage/:address
   * Check if a specific address can update records for an ENS name
   */
  fastify.get('/names/:name/can-manage/:address', { preHandler: cacheHandler }, async (request, reply) => {
    try {
      const { name, address } = NameAddressParamsSchema.parse(request.params);

      const result = await canUpdateRecords(name, address);

      const response: APIResponse<CanManageResult> = {
        success: true,
        data: result,
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error(
        { error, name: (request.params as any)?.name, address: (request.params as any)?.address },
        'Error checking ENS management permission'
      );

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
          message: 'Failed to check management permission',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/ens-roles/users/:address/manageable-names
   * Get all ENS names that an address can manage (update records for)
   * Returns enriched SearchResult objects with role information and pagination
   */
  fastify.get('/users/:address/manageable-names', { preHandler: [optionalAuth, cacheHandler] }, async (request, reply) => {
    try {
      const { address } = AddressParamsSchema.parse(request.params);
      const { page, limit } = ManageableNamesQuerySchema.parse(request.query);

      // Get user ID for enrichment (if authenticated)
      const userId = (request as any).user?.sub;

      // Get manageable names with pagination from The Graph
      const { names: manageableNames, total } = await getManageableNames(address, page, limit);

      // Extract name strings for enrichment
      const nameStrings = manageableNames.map(n => n.name);

      // Build enriched search results from database
      const enrichedResults = await buildSearchResults(nameStrings, userId);

      // Create a map of roles by name for merging
      const roleMap = new Map(manageableNames.map(n => [n.name.toLowerCase(), n.role]));

      // Merge role into each enriched result
      const resultsWithRoles: ManageableNameSearchResult[] = enrichedResults.map(result => ({
        ...result,
        role: roleMap.get(result.name.toLowerCase()) || 'owner',
      }));

      // Calculate pagination
      const totalPages = Math.ceil(total / limit);

      const response: APIResponse<ManageableNamesResponseData> = {
        success: true,
        data: {
          address: address.toLowerCase(),
          names: resultsWithRoles,
          pagination: {
            page,
            limit,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1,
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error({ error, address: (request.params as any)?.address }, 'Error fetching manageable names');

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
          message: 'Failed to fetch manageable names',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
