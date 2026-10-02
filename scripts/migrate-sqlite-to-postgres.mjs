import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const sqlite = new DatabaseSync('data/workman-prototype.sqlite');
const client = new pg.Client({ host: '127.0.0.1', port: 5432, database: 'workman_app', user: 'workman_app', password: process.env.PGPASSWORD });
await client.connect();
await client.query('BEGIN');
try {
  for (const request of sqlite.prepare('SELECT * FROM requests ORDER BY id').all()) {
    await client.query('INSERT INTO requests (id, customer_name, confirmation_status, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [request.id, request.customer_name, request.confirmation_status, request.created_at]);
  }
  for (const detail of sqlite.prepare('SELECT * FROM request_details').all()) {
    await client.query('INSERT INTO request_details (request_id, app_number, registered_date, received_date, staff, customer_kana, phone, work_types_json, other_work, position, thread_font, embroidery_content, hemming_method, length_cm, hemming_thread, remaining_fabric, hemming_notes, amount, accounts_receivable, deposit, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT (request_id) DO NOTHING', [detail.request_id,detail.app_number,detail.registered_date||null,detail.received_date||null,detail.staff,detail.customer_kana,detail.phone,detail.work_types_json,detail.other_work,detail.position,detail.thread_font,detail.embroidery_content,detail.hemming_method,detail.length_cm,detail.hemming_thread,detail.remaining_fabric,detail.hemming_notes,detail.amount,detail.accounts_receivable,detail.deposit,detail.notes]);
  }
  for (const product of sqlite.prepare('SELECT * FROM request_products').all()) await client.query('INSERT INTO request_products (request_id,product_number,branch_number,combined_number,product_name,color,size,quantity,work_states_json,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)', [product.request_id,product.product_number,product.branch_number,product.combined_number,product.product_name,product.color,product.size,product.quantity,product.work_states_json,product.notes]);
  for (const photo of sqlite.prepare('SELECT * FROM request_photos').all()) await client.query('INSERT INTO request_photos (request_id,photo_type,file_path,original_name,created_at) VALUES ($1,$2,$3,$4,$5)', [photo.request_id,photo.photo_type,photo.file_path,photo.original_name,photo.created_at]);
  await client.query("SELECT setval(pg_get_serial_sequence('requests','id'), COALESCE((SELECT MAX(id) FROM requests), 1), true)");
  await client.query('COMMIT');
  console.log('SQLite data migrated to PostgreSQL.');
} catch (error) { await client.query('ROLLBACK'); throw error; } finally { sqlite.close(); await client.end(); }
