import pino from 'pino';
import { config } from '../../../shared/src';

export const logger = pino({
  level: config.monitoring.logLevel,
  // Most call sites log `{ error }`; pino only serializes Errors under `err` by default, so without
  // this they print as `{}`.
  serializers: { error: pino.stdSerializers.err },
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    },
  },
});
