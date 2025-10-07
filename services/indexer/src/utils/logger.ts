import pino from 'pino';
import { config } from '../../../shared/src';

export const logger = pino({
  name: 'indexer',
  level: config.monitoring.logLevel,
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    }
  } : undefined,
});