import { loadConfig } from './config';
import { buildServer } from './server';
import { writeSetupCode } from './setup-code';

const config = loadConfig();
const server = await buildServer(config);
await server.app.listen({ host: config.host, port: config.port });
const { tls, version, hv } = server.ctx;
server.app.log.info(`FBRX Virtual ${version} (${hv.kind}) listening on ${tls ? 'https' : 'http'}://${config.host}:${config.port}`);
if (tls?.selfSigned) server.app.log.info(`Certificate fingerprint (SHA-256): ${tls.fingerprint}`);
// The FBRX Server console screen shows the setup code until someone sets the server up.
writeSetupCode(config.dataDir, server.ctx.auth.userCount() === 0 ? config.setupToken : null);

const shutdown = async (signal: string) => {
  server.app.log.info(`${signal} received, shutting down`);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
