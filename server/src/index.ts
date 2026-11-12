import { config } from './config';
import { buildApp } from './app';

const app = await buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Jira base URL: ${config.jiraBaseUrl} | allowed hosts: ${[...config.allowedHosts].join(', ')}`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
