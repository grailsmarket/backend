import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { namesRoutes } from './names';
import { ordersRoutes } from './orders';
import { listingsRoutes } from './listings';
import { offersRoutes } from './offers';
import { activityRoutes } from './activity';
import { profilesRoutes } from './profiles';
import { authRoutes } from './auth';
import { usersRoutes } from './users';
import { watchlistRoutes } from './watchlist';
import { websocketRoutes } from './websocket';

export function registerRoutes(fastify: FastifyInstance) {
  fastify.register(healthRoutes, { prefix: '/health' });
  fastify.register(authRoutes, { prefix: '/api/v1/auth' });
  fastify.register(usersRoutes, { prefix: '/api/v1/users' });
  fastify.register(watchlistRoutes, { prefix: '/api/v1/watchlist' });
  fastify.register(namesRoutes, { prefix: '/api/v1/names' });
  fastify.register(ordersRoutes, { prefix: '/api/v1/orders' });
  fastify.register(listingsRoutes, { prefix: '/api/v1/listings' });
  fastify.register(offersRoutes, { prefix: '/api/v1/offers' });
  fastify.register(activityRoutes, { prefix: '/api/v1/activity' });
  fastify.register(profilesRoutes, { prefix: '/api/v1/profiles' });
  fastify.register(websocketRoutes, { prefix: '/ws' });
}