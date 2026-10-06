import { loadConfig } from './config';
import { buildServer } from './server';

const config = loadConfig();
const server = await buildServer(config);
await server.app.listen({ host: config.host, port: config.port });
const tls = server.ctx.tls;
server.app.log.info(`FBRX control plane ${server.ctx.version} listening on ${tls ? 'https' : 'http'}://${config.host}:${config.port} (public URL ${config.publicUrl})`);
if (tls?.selfSigned) server.app.log.info(`FBRX Command's own certificate, SHA-256 fingerprint ${tls.fingerprint} (computers trust it by this fingerprint)`);
if (config.localPort) {
  await server.listenLocal(config.localPort);
  server.app.log.info(`Console on this computer: http://127.0.0.1:${config.localPort}`);
}
if (config.adminConsoleDir) server.app.log.info(`Admin console served from ${config.adminConsoleDir}`);

const shutdown = async (signal: string) => {
  server.app.log.info(`${signal} received, shutting down`);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
