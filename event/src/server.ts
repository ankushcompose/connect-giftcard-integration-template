import Fastify from 'fastify';
import { config } from './config';
import { handlePubSubEvent } from './handler';
import { log } from './logger';

/**
 * Event application server. Exposes POST /event (the Subscription push target) and
 * a GET / health check. An unexpected throw becomes a 500 so commercetools retries
 * (at-least-once delivery); expected non-actionable cases return 2xx from the
 * handler to acknowledge and drop.
 */
export const setupFastify = async () => {
  const server = Fastify({ logger: { level: config.loggerLevel } });

  server.post('/event', async (request, reply) => {
    try {
      const status = await handlePubSubEvent(request.body);
      return reply.status(status).send();
    } catch (err) {
      log.error('[qantas-event] handler error — will retry', { error: String(err).slice(0, 200) });
      return reply.status(500).send();
    }
  });

  server.get('/', async (_request, reply) => reply.status(200).send({ status: 'ok' }));

  return server;
};
