import { createRemoteServer, loadRemoteConfig } from './remote.js';
try {
  const port = Number(process.env.MCP_PORT ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid port');
  createRemoteServer(loadRemoteConfig()).listen(port, '127.0.0.1', () =>
    console.error('Remote MCP listening on loopback')
  );
} catch (error) {
  console.error(`Remote MCP configuration error: ${(error as Error).message}`);
  process.exitCode = 1;
}
