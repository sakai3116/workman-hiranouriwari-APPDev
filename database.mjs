import pg from 'pg';

const { Pool } = pg;

export const database = new Pool({
  host: process.env.WORKMAN_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.WORKMAN_DB_PORT ?? 5432),
  database: process.env.WORKMAN_DB_NAME ?? 'workman_app',
  user: process.env.WORKMAN_DB_USER ?? 'workman_app',
  password: process.env.WORKMAN_DB_PASSWORD ?? 'software'
});

export const verifyDatabase = async () => {
  const { rows } = await database.query('SELECT current_database() AS database, current_user AS username');
  return rows[0];
};
