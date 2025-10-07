import { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { APIResponse } from '../../../shared/src';

export async function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const { statusCode = 500 } = error;

  const response: APIResponse = {
    success: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || 'Internal Server Error',
      details: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: request.id,
    },
  };

  request.log.error({
    err: error,
    request: {
      method: request.method,
      url: request.url,
      params: request.params,
      query: request.query,
    },
  });

  return reply.status(statusCode).send(response);
}