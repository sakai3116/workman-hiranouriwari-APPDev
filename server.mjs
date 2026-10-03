import { createServer } from 'node:http';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
  CREATE TABLE IF NOT EXISTS request_details (
    request_id INTEGER PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
    app_number TEXT NOT NULL UNIQUE,
    registered_date TEXT,
    received_date TEXT,
    staff TEXT,
    customer_kana TEXT,
    phone TEXT,
    work_types_json TEXT NOT NULL DEFAULT '[]',
    other_work TEXT,
    position TEXT,
    thread_font TEXT,
    embroidery_content TEXT,
    hemming_method TEXT,
    length_cm TEXT,
    hemming_thread TEXT,
    remaining_fabric TEXT,
    hemming_notes TEXT,
    amount TEXT,
    accounts_receivable TEXT,
    deposit TEXT,
    notes TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS request_products (
    id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    product_number TEXT,
    branch_number TEXT,
    combined_number TEXT,
    product_name TEXT,
    color TEXT,
    size TEXT,
    quantity TEXT,
    work_states_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS request_photos (
    id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    photo_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    original_name TEXT,
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
    if (body.length > 30 * 1024 * 1024) throw new Error('Request body is too large.');
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

const servePage = async (response, filename, editMode = false) => {
  try {
    let page = await readFile(join(projectRoot, 'public', filename), 'utf8');
    if (filename === 'edit.html') {
      page = page.replace('<input name="staff">', '<select name="staff"><option>指定なし</option><option>店長（イシダ）</option><option>クロダ</option><option>モリオカ</option><option>サカイ</option><option>マツモト（淳史）</option><option>フカヤマ</option><option>マツモト（香織）</option><option>ヤマオカ</option><option>ナカジマ</option><option>ホンダ</option><option>マツモト（慎也）</option><option>ヒロセ</option><option>ヤラ</option><option>ハセ</option><option>アベ</option><option>その他</option></select>');
    }
    if (editMode) {
      page = page.replace('</body>', `<script>
const editId=new URLSearchParams(location.search).get('id');
document.querySelector('.app-header h1')?.replaceChildren('受付情報を編集');
document.querySelector('#entry-form button[type="submit"]').textContent='更新を保存';
const setValue=(name,value)=>{const input=document.querySelector('[name="'+name+'"]');if(input)input.value=value??''};
fetch('/api/requests/'+editId).then(response=>response.json()).then(data=>{const r=data.request;setValue('request-id',r.app_number);setValue('registered-date',r.registered_date);setValue('received-date',r.received_date);setValue('staff',r.staff);setValue('customer-name',r.customer_name);setValue('customer-kana',r.customer_kana);setValue('phone',r.phone);setValue('other-work',r.other_work);setValue('position',r.position);setValue('thread-font',r.thread_font);setValue('embroidery-content',r.embroidery_content);setValue('hemming-method',r.hemming_method);setValue('length',r.length_cm);setValue('hemming-thread',r.hemming_thread);setValue('remaining-fabric',r.remaining_fabric);setValue('hemming-notes',r.hemming_notes);setValue('amount',r.amount);setValue('notes',r.notes);['accounts-receivable','deposit','confirmation'].forEach(name=>{const value=name==='confirmation'?r.confirmation_status:r[name.replace(/-([a-z])/g,(_,c)=>'_'+c)];const input=document.querySelector('[name="'+name+'"]');if(input){input.value=value??'';document.querySelectorAll('[data-choice="'+name+'"] .choice-button').forEach(button=>button.classList.toggle('is-selected',button.dataset.value===value))}});let types=[];try{types=JSON.parse(r.work_types_json)}catch{};document.querySelectorAll('#work-types input').forEach(input=>{input.checked=types.includes(input.value);input.dispatchEvent(new Event('change',{bubbles:true}))});(data.products||[]).forEach((p,index)=>{if(index>0)document.querySelector('#add-product').click();const card=document.querySelectorAll('.product-card')[index];if(card){card.querySelector('[name="combined-number"]').value=p.combined_number??'';card.querySelector('[name="product-name"]').value=p.product_name??'';card.querySelector('[name="product-notes"]').value=p.notes??''}})});
document.querySelector('#entry-form').addEventListener('submit',async event=>{event.preventDefault();event.stopImmediatePropagation();const value=name=>document.querySelector('[name="'+name+'"]').value;const payload={customerName:value('customer-name'),confirmationStatus:value('confirmation'),receivedDate:value('received-date'),staff:value('staff'),customerKana:value('customer-kana'),phone:value('phone'),workTypes:[...document.querySelectorAll('#work-types input:checked')].map(i=>i.value),amount:value('amount'),accountsReceivable:value('accounts-receivable'),deposit:value('deposit'),notes:value('notes'),products:[...document.querySelectorAll('.product-card')].map(card=>({combined:card.querySelector('[name="combined-number"]').value,name:card.querySelector('[name="product-name"]').value,notes:card.querySelector('[name="product-notes"]').value}))};const result=await fetch('/api/requests/'+editId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(result.ok){document.querySelector('#form-status').textContent='更新しました。検索画面へ戻ります。';setTimeout(()=>location.href='/search',500)}} ,true);
</script></body>`);
    }
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

const serveEditPage = async (response) => {
  try {
    const [page, editScript] = await Promise.all([
      readFile(join(projectRoot, 'public', 'new-entry.html'), 'utf8'),
      readFile(join(projectRoot, 'public', 'edit-entry.js'), 'utf8')
    ]);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data: blob:;"
    });
    response.end(page.replace('</body>', `<script>${editScript}</script></body>`));
  } catch (error) {
    console.error(error);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Internal Server Error');
  }
};

const serveUpload = async (response, pathname) => {
  const relativePath = pathname.replace(/^\//, '');
  const uploadsRoot = join(dataDirectory, 'uploads');
  const filePath = join(dataDirectory, relativePath);
  if (!filePath.startsWith(uploadsRoot)) {
    response.writeHead(404); response.end(); return;
  }
  try {
    const file = await readFile(filePath);
    const contentType = filePath.match(/\.(png)$/i) ? 'image/png' : filePath.match(/\.(gif)$/i) ? 'image/gif' : 'image/jpeg';
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600' });
    response.end(file);
  } catch {
    response.writeHead(404); response.end();
  }
};

const savePhotos = (requestId, photoType, photos = []) => {
  const uploadDirectory = join(dataDirectory, 'uploads', String(requestId));
  mkdirSync(uploadDirectory, { recursive: true });
  const insertPhoto = database.prepare('INSERT INTO request_photos (request_id, photo_type, file_path, original_name) VALUES (?, ?, ?, ?)');
  photos.forEach((photo, index) => {
    if (!photo?.base64 || !String(photo.mimeType ?? '').startsWith('image/')) return;
    const originalName = String(photo.name ?? `photo-${index + 1}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${photoType}-${index + 1}-${Date.now()}-${originalName}`;
    const relativePath = join('uploads', String(requestId), fileName);
    writeFileSync(join(dataDirectory, relativePath), Buffer.from(photo.base64, 'base64'));
    insertPhoto.run(requestId, photoType, relativePath, originalName);
  });
};

const removePhotos = (requestId, photoIds = []) => {
  const ids = [...new Set((photoIds ?? []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(', ');
  const photos = database.prepare(`SELECT id, file_path FROM request_photos WHERE request_id = ? AND id IN (${placeholders})`).all(requestId, ...ids);
  database.prepare(`DELETE FROM request_photos WHERE request_id = ? AND id IN (${placeholders})`).run(requestId, ...ids);
  photos.forEach(({ file_path: filePath }) => {
    const absolutePath = join(dataDirectory, filePath);
    if (absolutePath.startsWith(join(dataDirectory, 'uploads')) && existsSync(absolutePath)) unlinkSync(absolutePath);
  });
};

const createRequest = (payload) => {
  const customerName = String(payload.customerName ?? '').trim();
  const confirmationStatus = String(payload.confirmationStatus ?? '').trim();
  if (!customerName || !confirmationStatus) throw new Error('お客様名と確認状態は必須です。');
  database.exec('BEGIN');
  try {
    const requestId = Number(database.prepare('INSERT INTO requests (customer_name, confirmation_status) VALUES (?, ?)').run(customerName, confirmationStatus).lastInsertRowid);
    const appNumber = `WM-${String(requestId).padStart(6, '0')}`;
    database.prepare(`INSERT INTO request_details (request_id, app_number, registered_date, received_date, staff, customer_kana, phone, work_types_json, other_work, position, thread_font, embroidery_content, hemming_method, length_cm, hemming_thread, remaining_fabric, hemming_notes, amount, accounts_receivable, deposit, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(requestId, appNumber, payload.registeredDate ?? null, payload.receivedDate ?? null, payload.staff ?? null, payload.customerKana ?? null, payload.phone ?? null, JSON.stringify(payload.workTypes ?? []), payload.otherWork ?? null, payload.position ?? null, payload.threadFont ?? null, payload.embroideryContent ?? null, payload.hemmingMethod ?? null, payload.lengthCm ?? null, payload.hemmingThread ?? null, payload.remainingFabric ?? null, payload.hemmingNotes ?? null, payload.amount ?? null, payload.accountsReceivable ?? null, payload.deposit ?? null, payload.notes ?? null);
    const insertProduct = database.prepare('INSERT INTO request_products (request_id, product_number, branch_number, combined_number, product_name, color, size, quantity, work_states_json, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    (payload.products ?? []).forEach((product) => insertProduct.run(requestId, product.number ?? null, product.branch ?? null, product.combined ?? null, product.name ?? null, product.color ?? null, product.size ?? null, product.quantity ?? null, JSON.stringify(product.workStates ?? []), product.notes ?? null));
    savePhotos(requestId, 'slip', payload.slipPhotos);
    savePhotos(requestId, 'completed', payload.completedPhotos);
    database.exec('COMMIT');
    return { requestId, appNumber };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};

const updateRequest = (requestId, payload) => {
  const customerName = String(payload.customerName ?? '').trim(); const confirmationStatus = String(payload.confirmationStatus ?? '').trim();
  if (!customerName || !confirmationStatus) throw new Error('お客様名と確認状態は必須です。');
  database.exec('BEGIN');
  try {
    database.prepare('UPDATE requests SET customer_name = ?, confirmation_status = ? WHERE id = ?').run(customerName, confirmationStatus, requestId);
    database.prepare('UPDATE request_details SET registered_date=?, received_date=?, staff=?, customer_kana=?, phone=?, work_types_json=?, other_work=?, position=?, thread_font=?, embroidery_content=?, hemming_method=?, length_cm=?, hemming_thread=?, remaining_fabric=?, hemming_notes=?, amount=?, accounts_receivable=?, deposit=?, notes=? WHERE request_id=?').run(payload.registeredDate ?? null, payload.receivedDate ?? null, payload.staff ?? null, payload.customerKana ?? null, payload.phone ?? null, JSON.stringify(payload.workTypes ?? []), payload.otherWork ?? null, payload.position ?? null, payload.threadFont ?? null, payload.embroideryContent ?? null, payload.hemmingMethod ?? null, payload.lengthCm ?? null, payload.hemmingThread ?? null, payload.remainingFabric ?? null, payload.hemmingNotes ?? null, payload.amount ?? null, payload.accountsReceivable ?? null, payload.deposit ?? null, payload.notes ?? null, requestId);
    database.prepare('DELETE FROM request_products WHERE request_id = ?').run(requestId);
    const add = database.prepare('INSERT INTO request_products (request_id, product_number, branch_number, combined_number, product_name, color, size, quantity, work_states_json, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    (payload.products ?? []).forEach((product) => add.run(requestId, product.number ?? null, product.branch ?? null, product.combined ?? null, product.name ?? null, product.color ?? null, product.size ?? null, product.quantity ?? null, JSON.stringify(product.workStates ?? []), product.notes ?? null));
    removePhotos(requestId, payload.removedPhotoIds);
    savePhotos(requestId, 'slip', payload.slipPhotos);
    savePhotos(requestId, 'completed', payload.completedPhotos);
    database.exec('COMMIT'); return { requestId };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
};

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${host}`);
  const pathname = requestUrl.pathname.replace(/\/$/, '') || '/';

  try {
    if (request.method === 'GET' && pathname === '/') return servePage(response, 'index.html');
    if (request.method === 'GET' && pathname === '/new') return servePage(response, 'new-entry.html');
    if (request.method === 'GET' && pathname === '/search') return servePage(response, 'search-edit.html');
    if (request.method === 'GET' && pathname === '/edit') return serveEditPage(response);
    if (request.method === 'GET' && pathname === '/admin') return servePage(response, 'admin.html');
    if (request.method === 'GET' && pathname.startsWith('/uploads/')) return serveUpload(response, pathname);

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

    if (request.method === 'POST' && pathname === '/api/requests') {
      const payload = await readJsonBody(request);
      return sendJson(response, 201, createRequest(payload));
    }

    if (request.method === 'GET' && pathname === '/api/requests') {
      const query = `%${(requestUrl.searchParams.get('q') ?? '').trim()}%`;
      const rows = database.prepare(`SELECT r.id, d.app_number, r.customer_name, d.customer_kana, d.phone, d.staff, d.received_date, d.registered_date, d.work_types_json, d.amount, d.deposit, r.confirmation_status, r.created_at, (SELECT group_concat(trim(coalesce(combined_number, '') || ' ' || coalesce(product_name, '')), ' / ') FROM request_products product WHERE product.request_id = r.id) AS product_details, (SELECT group_concat(file_path, '|') FROM request_photos p WHERE p.request_id = r.id) AS photo_paths FROM requests r JOIN request_details d ON d.request_id = r.id WHERE r.customer_name LIKE ? OR d.customer_kana LIKE ? OR d.phone LIKE ? OR d.app_number LIKE ? ORDER BY r.id DESC LIMIT 100`).all(query, query, query, query);
      return sendJson(response, 200, { rows });
    }

    const requestMatch = pathname.match(/^\/api\/requests\/(\d+)$/);
    if (requestMatch && request.method === 'GET') {
      const requestId = Number(requestMatch[1]);
      const requestRow = database.prepare('SELECT r.id, r.customer_name, r.confirmation_status, d.* FROM requests r JOIN request_details d ON d.request_id = r.id WHERE r.id = ?').get(requestId);
      if (!requestRow) return sendJson(response, 404, { error: 'データが見つかりません。' });
      const products = database.prepare('SELECT product_number, branch_number, combined_number, product_name, color, size, quantity, work_states_json, notes FROM request_products WHERE request_id = ? ORDER BY id').all(requestId);
      const photos = database.prepare('SELECT id, photo_type, file_path, original_name FROM request_photos WHERE request_id = ? ORDER BY id').all(requestId);
      return sendJson(response, 200, { request: requestRow, products, photos });
    }
    if (requestMatch && request.method === 'PUT') return sendJson(response, 200, updateRequest(Number(requestMatch[1]), await readJsonBody(request)));

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
