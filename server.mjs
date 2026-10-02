import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const dataDirectory = join(projectRoot, 'data');
const databasePath = join(dataDirectory, 'workman-prototype.sqlite');
const sessions = new Map();

mkdirSync(dataDirectory, { recursive: true });
const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
database.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT;
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    customer_name TEXT,
    confirmation_status TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT;
`);

const existingAdmin = database.prepare('SELECT id FROM admin_users WHERE username = ?').get('admin');
if (!existingAdmin) {
  const passwordSalt = randomBytes(16).toString('hex');
  const passwordHash = scryptSync('software', passwordSalt, 64).toString('hex');
  database.prepare('INSERT INTO admin_users (username, password_salt, password_hash) VALUES (?, ?, ?)')
    .run('admin', passwordSalt, passwordHash);
}

const sendJson = (response, statusCode, body, headers = {}) => {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
};

const readJsonBody = async (request) => {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10_000) throw new Error('Request body is too large.');
  }
  return body ? JSON.parse(body) : {};
};

const getSession = (request) => {
  const cookies = Object.fromEntries((request.headers.cookie ?? '').split(';').map((item) => {
    const [name, ...value] = item.trim().split('=');
    return [name, value.join('=')];
  }));
  return sessions.get(cookies.workman_admin_session);
};

const requireAdmin = (request, response) => {
  const session = getSession(request);
  if (!session) {
    sendJson(response, 401, { error: 'ログインが必要です。' });
    return null;
  }
  return session;
};

const servePage = async (response, filename) => {
  try {
    const page = await readFile(join(projectRoot, 'public', filename));
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data: blob:;"
    });
    response.end(page);
  } catch (error) {
    console.error(error);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Internal Server Error');
  }
};

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${host}`);
  const pathname = requestUrl.pathname.replace(/\/$/, '') || '/';

  try {
    if (request.method === 'GET' && pathname === '/') return servePage(response, 'index.html');
    if (request.method === 'GET' && pathname === '/new') return servePage(response, 'new-entry.html');
    if (request.method === 'GET' && pathname === '/admin') return servePage(response, 'admin.html');

    if (request.method === 'POST' && pathname === '/api/admin/login') {
      const { username, password } = await readJsonBody(request);
      const user = database.prepare('SELECT username, password_salt, password_hash FROM admin_users WHERE username = ?').get(username);
      const passwordHash = user && scryptSync(String(password ?? ''), user.password_salt, 64).toString('hex');
      const isValid = user && timingSafeEqual(Buffer.from(passwordHash, 'hex'), Buffer.from(user.password_hash, 'hex'));
      if (!isValid) return sendJson(response, 401, { error: 'IDまたはパスワードが正しくありません。' });
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { username: user.username });
      return sendJson(response, 200, { username: user.username }, { 'Set-Cookie': `workman_admin_session=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }

    if (request.method === 'POST' && pathname === '/api/admin/logout') {
      const cookies = Object.fromEntries((request.headers.cookie ?? '').split(';').map((item) => {
        const [name, ...value] = item.trim().split('=');
        return [name, value.join('=')];
      }));
      sessions.delete(cookies.workman_admin_session);
      return sendJson(response, 200, { ok: true }, { 'Set-Cookie': 'workman_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    if (request.method === 'GET' && pathname === '/api/admin/status') {
      if (!requireAdmin(request, response)) return;
      const requestCount = database.prepare('SELECT COUNT(*) AS count FROM requests').get().count;
      return sendJson(response, 200, { databasePath, requestCount });
    }

    if (request.method === 'GET' && pathname === '/api/admin/requests') {
      if (!requireAdmin(request, response)) return;
      const rows = database.prepare('SELECT id, customer_name, confirmation_status, created_at FROM requests ORDER BY id DESC LIMIT 100').all();
      return sendJson(response, 200, { rows });
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: 'サーバー内部エラーが発生しました。' });
  }
});

server.listen(port, host, () => {
  console.log(`Web app is running at http://${host}:${port}`);
  console.log(`Admin page is available at http://${host}:${port}/admin`);
});
