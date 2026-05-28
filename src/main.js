import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT ?? '3000');
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? '/app/data/freewheel.db';
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const HEALTH_PATH = process.env.HEALTH_PATH ?? '/health';

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

function quoteFts(value) {
  return String(value).trim().split(/\s+/).filter(Boolean).map((part) => `"${part.replace(/"/g, '""')}"`).join(' AND ');
}

if (!fs.existsSync(DB_PATH)) {
  throw new Error(`Missing database at ${DB_PATH}. Mount the volume and copy freewheel.db into place.`);
}

const db = new DatabaseSync(DB_PATH, { readonly: true });

const getExactPage = db.prepare(`
  SELECT rowid, page_id, title, depth, url, file, version, created_at, bytes_html, content
  FROM pages
  WHERE page_id = ? OR lower(file) = ? OR lower(url) = ? OR lower(title) = ?
  LIMIT 1
`);

const searchById = db.prepare(`
  SELECT p.rowid, p.page_id, p.title, p.depth, p.url, p.file, p.version, p.created_at, p.bytes_html,
         snippet(pages_fts, 4, '…', '…', '…', 18) AS snippet,
         bm25(pages_fts) AS score
  FROM pages_fts
  JOIN pages p ON p.rowid = pages_fts.rowid
  WHERE pages_fts MATCH ?
  ORDER BY score ASC, p.depth ASC, p.title ASC
  LIMIT ?
`);

function toPageRow(row) {
  return {
    pageId: row.page_id,
    title: row.title,
    depth: row.depth,
    url: row.url,
    file: row.file,
    version: row.version,
    createdAt: row.created_at,
    bytesHtml: row.bytes_html
  };
}

function getPage(lookup) {
  const row = getExactPage.get(
    String(lookup.pageId ?? ''),
    normalize(lookup.file),
    normalize(lookup.url),
    normalize(lookup.title)
  );
  if (!row) return null;
  return { ...toPageRow(row), content: row.content };
}

function search(query, limit = 10) {
  const normalized = normalize(query);
  if (!normalized) return [];

  const exact = getPage({ pageId: query, file: query, url: query, title: query });
  const results = exact ? [exact] : [];
  const rows = searchById.all(quoteFts(query), Math.max(1, Math.min(Number(limit) || 10, 50)));

  for (const row of rows) {
    if (results.some((entry) => entry.pageId === row.page_id)) continue;
    results.push({
      ...toPageRow(row),
      score: row.score,
      snippet: row.snippet
    });
  }

  return results;
}

function jsonRpc(methodHandlers) {
  return async (req, res) => {
    let payload;
    try {
      payload = await new Promise((resolve, reject) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          if (!raw) return resolve(null);
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
        req.on('error', reject);
      });
    } catch (error) {
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
        id: null
      });
    }

    if (!payload || typeof payload !== 'object') {
      return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
    }

    const handler = methodHandlers[payload.method];
    if (!handler) {
      return sendJson(res, 404, {
        jsonrpc: '2.0',
        error: { code: -32601, message: `Method not found: ${payload.method}` },
        id: payload.id ?? null
      });
    }

    try {
      const result = await handler(payload.params ?? {});
      return sendJson(res, 200, { jsonrpc: '2.0', result, id: payload.id ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        error: { code: -32000, message },
        id: payload.id ?? null
      });
    }
  };
}

const handleRpc = jsonRpc({
  async initialize() {
    return {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'freewheel-db-mcp', version: '1.0.0' },
      capabilities: { tools: {} }
    };
  },
  async 'notifications/initialized'() {
    return null;
  },
  async 'tools/list'() {
    return {
      tools: [
        {
          name: 'search',
          description: 'Search pages in freewheel.db.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 }
            },
            required: ['query'],
            additionalProperties: false
          }
        },
        {
          name: 'get_page',
          description: 'Fetch a page by pageId, file, url, or title.',
          inputSchema: {
            type: 'object',
            properties: {
              pageId: { type: 'string' },
              file: { type: 'string' },
              url: { type: 'string' },
              title: { type: 'string' }
            },
            additionalProperties: false
          }
        }
      ]
    };
  },
  async 'tools/call'({ name, arguments: args = {} }) {
    if (name === 'search') {
      const results = search(args.query ?? '', args.limit ?? 10);
      return { content: [{ type: 'text', text: JSON.stringify({ query: args.query ?? '', count: results.length, results }, null, 2) }] };
    }

    if (name === 'get_page') {
      const page = getPage(args);
      if (!page) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'Page not found', lookup: args }, null, 2) }]
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(page, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  }
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  if (url.pathname === HEALTH_PATH) {
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/') {
    return sendText(res, 200, 'freewheel-db-mcp');
  }

  if (url.pathname === MCP_PATH) {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    return handleRpc(req, res);
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`freewheel-db-mcp listening on ${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Health: http://${HOST}:${PORT}${HEALTH_PATH}`);
  console.log(`MCP: http://${HOST}:${PORT}${MCP_PATH}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
