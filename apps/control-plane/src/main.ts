import { loadConfig } from './config';
import { buildServer } from './server';

const config = loadConfig();
const server = await buildServer(config);
await server.app.listen({ host: config.host, port: config.port });
server.app.log.info(`FBRX control plane ${server.ctx.version} listening on ${config.host}:${config.port} (public URL ${config.publicUrl})`);
if (config.adminConsoleDir) server.app.log.info(`Admin console served from ${config.adminConsoleDir}`);

const shutdown = async (signal: string) => {
  server.app.log.info(`${signal} received, shutting down`);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
