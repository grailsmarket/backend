import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { config, getPostgresPool } from '../../shared/src';
import { registerRoutes } from './routes';
import { errorHandler } from './middleware/error-handler';
import { logger } from './utils/logger';
import { ActivityNotifier } from './services/activity-notifier';
import { ActivityLogger } from './services/activity-logger';
import { mutelistService } from './services/mutelist';

const activityNotifier = new ActivityNotifier();
let activityLogger: ActivityLogger | null = null;

async function start() {
  const fastify = Fastify({
    logger: logger as any,
    requestIdLogLabel: 'reqId',
    disableRequestLogging: false,
    trustProxy: true,
    maxParamLength: 500, // Increase from default 100 to handle long ENS names (max ENS length is ~255 chars)
  });

  await fastify.register(cors, {
    origin: config.api.corsOrigins,
    credentials: true,
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: false,
  });

  await fastify.register(rateLimit, {
    max: config.api.rateLimitMax,
    timeWindow: config.api.rateLimitWindow,
  });

  await fastify.register(websocket);

  fastify.setErrorHandler(errorHandler as any);

  registerRoutes(fastify as any);

  // Initialize activity logger for tracking authenticated API usage
  activityLogger = new ActivityLogger(getPostgresPool());

  fastify.addHook('onResponse', (request, reply, done) => {
    if (request.user && activityLogger) {
      activityLogger.log({
        userId: parseInt(request.user.sub),
        address: request.user.address,
        method: request.method,
        route: request.routeOptions?.url || request.url,
        path: request.url,
        queryParams: (request.query && Object.keys(request.query as object).length > 0)
          ? request.query as Record<string, unknown>
          : null,
      });
    }
    done();
  });

  try {
    await fastify.listen({
      port: config.api.port,
      host: config.api.host
    });
    console.log(`Server listening on http://${config.api.host}:${config.api.port}`);

    // Initialize mutelist service
    await mutelistService.initialize();

    // Start activity notifier for real-time WebSocket broadcasts
    await activityNotifier.start();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    if (activityLogger) await activityLogger.shutdown();
    await activityNotifier.stop();
    await fastify.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    if (activityLogger) await activityLogger.shutdown();
    await activityNotifier.stop();
    await fastify.close();
    process.exit(0);
  });
}

start().catch(console.error);