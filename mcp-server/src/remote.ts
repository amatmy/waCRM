/** OAuth-protected, single-operator Streamable HTTP MCP resource server.
 * HTTPS terminates at a trusted reverse proxy; this process binds loopback only.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WacrmClient } from './client.js';
import { registerTools } from './tools/index.js';

export interface RemoteConfig {
  resource: string;
  issuer: string;
  publicKey: KeyObject;
  keyId: string;
  subject: string;
  tenant: string;
  accountId: string;
  operatorId: string;
  baseUrl: string;
  apiKey: string;
  allowWrites: boolean;
}
function httpsUrl(value: string, pathAllowed: boolean): string {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (!pathAllowed && u.pathname !== '/')
  )
    throw new Error('Invalid HTTPS configuration');
  // OAuth issuer and audience identifiers are exact strings, including a trailing slash.
  return value;
}
export function loadRemoteConfig(
  env: NodeJS.ProcessEnv = process.env
): RemoteConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const resource = httpsUrl(required('MCP_RESOURCE_URL'), true);
  if (new URL(resource).pathname !== '/mcp')
    throw new Error('Resource URL must end in /mcp');
  const issuer = httpsUrl(required('MCP_OAUTH_ISSUER'), true);
  const backend = new URL(required('WACRM_BASE_URL'));
  if (
    backend.username ||
    backend.password ||
    backend.search ||
    backend.hash ||
    backend.pathname !== '/' ||
    !(
      backend.protocol === 'https:' ||
      (backend.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(backend.hostname))
    )
  )
    throw new Error('Invalid CRM origin');
  const operatorId = required('WACRM_OPERATOR_ID');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      operatorId
    )
  )
    throw new Error('Invalid operator');
  const pem = required('MCP_OAUTH_PUBLIC_KEY').replaceAll(
    String.fromCharCode(92) + 'n',
    String.fromCharCode(10)
  );
  if (!pem.startsWith('-----BEGIN PUBLIC KEY-----'))
    throw new Error('Public key PEM required');
  const publicKey = createPublicKey(pem);
  if (
    publicKey.asymmetricKeyType !== 'rsa' ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw new Error('RSA public key of at least 2048 bits required');
  return {
    resource,
    issuer,
    publicKey,
    keyId: required('MCP_OAUTH_KEY_ID'),
    subject: required('MCP_OAUTH_SUBJECT'),
    tenant: required('MCP_OAUTH_TENANT'),
    accountId: required('WACRM_ACCOUNT_ID'),
    operatorId,
    baseUrl: backend.origin,
    apiKey: required('WACRM_API_KEY'),
    allowWrites: env.MCP_ENABLE_WRITES === 'true',
  };
}
/** Authenticate a token on every HTTP request; never accept identity from tool input. */
export function authenticate(
  token: string,
  cfg: RemoteConfig,
  now = Math.floor(Date.now() / 1000)
): { write: boolean } | null {
  try {
    if (token.length > 8192) return null;
    const parts = token.split('.');
    if (
      parts.length !== 3 ||
      parts.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p))
    )
      return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (
      header.typ !== 'at+jwt' ||
      header.alg !== 'RS256' ||
      header.kid !== cfg.keyId ||
      header.crit ||
      header.jku ||
      header.x5u
    )
      return null;
    if (
      !verifySignature(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        cfg.publicKey,
        Buffer.from(parts[2], 'base64url')
      )
    )
      return null;
    const audience = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (
      claims.iss !== cfg.issuer ||
      !Array.isArray(audience) ||
      !audience.includes(cfg.resource) ||
      claims.sub !== cfg.subject ||
      claims.tenant_id !== cfg.tenant ||
      !Number.isInteger(claims.exp) ||
      claims.exp <= now ||
      !Number.isInteger(claims.iat) ||
      claims.iat > now ||
      claims.exp - claims.iat > 900 ||
      claims.exp <= claims.iat ||
      (claims.nbf !== undefined &&
        (!Number.isInteger(claims.nbf) || claims.nbf > now))
    )
      return null;
    const scopes =
      typeof claims.scope === 'string' ? claims.scope.split(' ') : [];
    if (!scopes.includes('wacrm.read')) return null;
    return { write: cfg.allowWrites && scopes.includes('wacrm.write') };
  } catch {
    return null;
  }
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > 131072) throw new Error('Body too large');
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createRemoteServer(cfg: RemoteConfig) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const path = new URL(req.url ?? '/', cfg.resource).pathname;
    if (
      req.method === 'GET' &&
      path === '/.well-known/oauth-protected-resource/mcp'
    ) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          resource: cfg.resource,
          authorization_servers: [cfg.issuer],
          scopes_supported: ['wacrm.read', 'wacrm.write'],
          bearer_methods_supported: ['header'],
        })
      );
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== new URL(cfg.resource).origin) {
      res.writeHead(403).end();
      return;
    }
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(
      req.headers.authorization ?? ''
    );
    const auth = match && authenticate(match[1], cfg);
    if (!auth) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${new URL(cfg.resource).origin}/.well-known/oauth-protected-resource/mcp"`
      );
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    try {
      const parsed = await body(req);
      const server = new McpServer({ name: 'wacrm-remote', version: '0.1.0' });
      // Describe OAuth requirements for ChatGPT; server-side checks remain authoritative.
      const register = server.registerTool.bind(server);
      const definitions: Array<Record<string, unknown>> = [];
      Object.defineProperty(server, 'registerTool', {
        value: (...args: unknown[]) => {
          // The remote copilot has no broadcast tools, even read-only status.
          if (args[0] === 'get_broadcast') return undefined;
          const descriptor = args[1] as {
            title?: string;
            description?: string;
            inputSchema?: Parameters<typeof normalizeObjectSchema>[0];
            annotations?: { readOnlyHint?: boolean };
            _meta?: Record<string, unknown>;
          };
          descriptor._meta = {
            ...descriptor._meta,
            securitySchemes: [
              {
                type: 'oauth2',
                scopes: descriptor.annotations?.readOnlyHint
                  ? ['wacrm.read']
                  : ['wacrm.read', 'wacrm.write'],
              },
            ],
          };
          const schema = normalizeObjectSchema(descriptor.inputSchema);
          definitions.push({
            name: args[0],
            title: descriptor.title,
            description: descriptor.description,
            inputSchema: schema
              ? toJsonSchemaCompat(schema, {
                  strictUnions: true,
                  pipeStrategy: 'input',
                })
              : { type: 'object', properties: {} },
            annotations: descriptor.annotations,
            _meta: descriptor._meta,
            securitySchemes: descriptor._meta.securitySchemes,
          });
          return Reflect.apply(register, server, args);
        },
      });
      const client = new WacrmClient({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
      });
      const identity = (await client.me()) as {
        data?: { account?: { id?: string } };
      };
      if (identity.data?.account?.id !== cfg.accountId) {
        res.writeHead(403).end();
        return;
      }
      if (!authenticate(match[1], cfg)) {
        res.setHeader(
          'WWW-Authenticate',
          `Bearer resource_metadata="${new URL(cfg.resource).origin}/.well-known/oauth-protected-resource/mcp"`
        );
        res.writeHead(401).end();
        return;
      }
      registerTools(server, client, {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        copilotMode: true,
        operatorId: cfg.operatorId,
        enableWrites: auth.write,
        enableBroadcasts: false,
      });
      // SDK 1.31 emits only _meta; include OpenAI's top-level securitySchemes too.
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: definitions as unknown as Tool[],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
      await server.close();
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
      else res.destroy();
    }
  });
}
