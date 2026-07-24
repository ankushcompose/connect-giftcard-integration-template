import {
  SessionHeaderAuthenticationHook,
  SessionQueryParamAuthenticationHook,
} from '@commercetools/connect-payments-sdk';
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { MockGiftCardService } from '../services/mock-giftcard.service';
import {
  BalanceRequestSchemaDTO,
  BalanceResponseSchema,
  BalanceResponseSchemaDTO,
  RedeemRequestDTO,
  RedeemResponseSchema,
} from '../dtos/mock-giftcards.dto';
import { Type } from '@sinclair/typebox';
import { AmountSchema } from '../dtos/operations/payment-intents.dto';

type RoutesOptions = {
  giftCardService: MockGiftCardService;
  sessionHeaderAuthHook: SessionHeaderAuthenticationHook;
  sessionQueryParamAuthHook: SessionQueryParamAuthenticationHook;
};

/**
 * MockGiftCardServiceRoutes is used to expose endpoints for giftcard management. Since the required requests/responses/parameters may vary among different gift card service providers, here we provide sample routes for further customization.
 */
export const mockGiftCardServiceRoutes = async (
  fastify: FastifyInstance,

  opts: FastifyPluginOptions & RoutesOptions,
) => {
  fastify.post<{
    Reply: BalanceResponseSchemaDTO | void;
    Body: BalanceRequestSchemaDTO;
  }>(
    '/balance',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        body: {
          type: 'object',
          properties: {
            code: Type.String(),
          },
        },
        response: {
          200: BalanceResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { code } = request.body;
      const res = await opts.giftCardService.balance(code);
      return reply.status(200).send(res);
    },
  );

  fastify.get(
    '/config',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        response: {
          200: Type.Object({
            clientId: Type.String(),
            clientName: Type.String(),
            env: Type.String(),
            amount: AmountSchema,
          }),
        },
      },
    },
    async (_request, reply) => {
      const res = await opts.giftCardService.widgetConfig();
      return reply.status(200).send(res);
    },
  );

  fastify.post<{ Body: RedeemRequestDTO; Reply: void }>(
    '/redeem',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        body: {
          type: 'object',
          properties: {
            code: Type.String(),
            redeemAmount: AmountSchema,
          },
          required: ['code', 'redeemAmount'],
        },
        response: {
          200: RedeemResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const res = await opts.giftCardService.redeem({
        data: request.body,
      });

      return reply.status(200).send(res);
    },
  );
};
