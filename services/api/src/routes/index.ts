import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { namesRoutes } from './names';
import { ordersRoutes } from './orders';
import { listingsRoutes } from './listings';
import { offersRoutes } from './offers';
import { salesRoutes } from './sales';
import { activityRoutes } from './activity';
import { profilesRoutes } from './profiles';
import { authRoutes } from './auth';
import { usersRoutes } from './users';
import { watchlistRoutes } from './watchlist';
import { notificationsRoutes } from './notifications';
import { websocketRoutes } from './websocket';
import { clubsRoutes } from './clubs';
import { votesRoutes } from './votes';
import { searchRoutes } from './search';
import { verificationRoutes } from './verification';

export function registerRoutes(fastify: FastifyInstance) {
  fastify.register(healthRoutes, { prefix: '/health' });
  fastify.register(authRoutes, { prefix: '/api/v1/auth' });
  fastify.register(usersRoutes, { prefix: '/api/v1/users' });
  fastify.register(verificationRoutes, { prefix: '/api/v1/verification' });
  fastify.register(watchlistRoutes, { prefix: '/api/v1/watchlist' });
  fastify.register(notificationsRoutes, { prefix: '/api/v1/notifications' });
  fastify.register(votesRoutes, { prefix: '/api/v1/votes' });
  fastify.register(searchRoutes, { prefix: '/api/v1/search' });
  fastify.register(namesRoutes, { prefix: '/api/v1/names' });
  fastify.register(ordersRoutes, { prefix: '/api/v1/orders' });
  fastify.register(listingsRoutes, { prefix: '/api/v1/listings' });
  fastify.register(offersRoutes, { prefix: '/api/v1/offers' });
  fastify.register(salesRoutes, { prefix: '/api/v1/sales' });
  fastify.register(activityRoutes, { prefix: '/api/v1/activity' });
  fastify.register(profilesRoutes, { prefix: '/api/v1/profiles' });
  fastify.register(clubsRoutes, { prefix: '/api/v1/clubs' });
  fastify.register(websocketRoutes, { prefix: '/ws' });
}