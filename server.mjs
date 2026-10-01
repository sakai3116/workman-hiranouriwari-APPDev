import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
const projectRoot = fileURLToPath(new URL('.', import.meta.url));

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${host}`);
  const pathname = requestUrl.pathname === '/new/' ? '/new' : requestUrl.pathname;
  const pages = {
    '/': 'index.html',
    '/new': 'new-entry.html',
  };

  if (request.method !== 'GET' || !pages[pathname]) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  try {
    const page = await readFile(join(projectRoot, 'public', pages[pathname]));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
  } catch (error) {
    console.error(error);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Internal Server Error');
  }
});

server.listen(port, host, () => {
  console.log(`Web app is running at http://${host}:${port}`);
});
