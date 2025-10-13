import pino from 'pino';
import { config } from '../../../shared/src';

export const logger = pino({
  level: config.monitoring.logLevel,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    },
  },
});
