// Serves the explorer at http://127.0.0.1:4373/ (localhost only). The explorer is static: it reads
// ui/data/*.json, which npm run build-explorer writes from the run folders.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {ROOT} from '../src/config.js';

const UI = path.join(ROOT, 'ui');
const PORT = Number(process.env.PORT || 4373);
const TYPES = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml'};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(UI, relative));
  if (!file.startsWith(UI + path.sep) || request.method !== 'GET') {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Roads Not Taken explorer: http://127.0.0.1:${PORT}/`));
