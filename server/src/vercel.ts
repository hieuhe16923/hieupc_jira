import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './app';

/** Entry cho Vercel Serverless Function: dựng Fastify một lần / instance rồi chuyển request vào */
const ready = buildApp().then(async (app) => {
  await app.ready();
  return app;
});

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await ready;
  app.server.emit('request', req, res);
}
