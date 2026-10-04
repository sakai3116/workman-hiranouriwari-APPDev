import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export class OcrError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function decodePhoto(photo) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo?.mimeType)) throw new OcrError(400, 'OCRはJPEG・PNG・WebPの写真に対応しています。');
  if (typeof photo.base64 === 'string' && photo.base64.length > 16 * 1024 * 1024) throw new OcrError(413, 'OCR用の写真は12MB以下にしてください。');
  if (typeof photo.base64 !== 'string' || photo.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(photo.base64)) throw new OcrError(400, '写真データが不正です。');
  const bytes = Buffer.from(photo.base64, 'base64');
  if (bytes.toString('base64') !== photo.base64) throw new OcrError(400, '写真データが不正です。');
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new OcrError(413, 'OCR用の写真は12MB以下にしてください。');
  return bytes;
}
export class OcrService {
  constructor(root, { python, worker, timeout = 120000 } = {}) {
    this.root = root;
    this.python = python ?? join(root, '.venv-ocr', 'Scripts', 'python.exe');
    this.worker = worker ?? join(root, 'tools', 'ocr-lab', 'recognize_receipt.py');
    this.timeout = timeout;
    this.active = null;
  }
  get ready() { return existsSync(this.python) && existsSync(this.worker) && existsSync(join(this.root, 'tools', 'ocr-lab', 'models', 'qwen-vl-4b', 'config.json')); }
  stop(job) {
    if (!job.child?.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => job.child.kill());
    } else job.child.kill();
  }
  cancel() { if (this.active) { this.active.cancelled = true; this.stop(this.active); } }
  async recognize(photo) {
    if (this.active) throw new OcrError(409, '別の写真を読み取り中です。完了後にもう一度お試しください。');
    if (!this.ready) throw new OcrError(503, 'OCRの実行環境が未準備です。管理者に確認してください。');
    const bytes = decodePhoto(photo);
    const job = { cancelled: false };
    this.active = job;
    let directory;
    try {
      const inputRoot = join(this.root, 'tools', 'ocr-lab', 'inputs', 'runtime');
      await mkdir(inputRoot, { recursive: true });
      directory = await mkdtemp(join(inputRoot, 'receipt-'));
      const imagePath = join(directory, 'photo');
      await writeFile(imagePath, bytes);
      if (job.cancelled) throw new OcrError(409, 'OCRがOFFになったため読み取りを中止しました。');
      return await new Promise((resolve, reject) => {
        const child = spawn(this.python, [this.worker, imagePath], { cwd: this.root, windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        job.child = child;
        child.stdout.setEncoding('utf8');
        let output = ''; let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; this.stop(job); }, this.timeout);
        child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 128 * 1024) this.stop(job); });
        child.stderr.on('data', () => {}); // Do not log recognized customer information or model diagnostics.
        child.on('error', () => { clearTimeout(timer); reject(new OcrError(503, 'OCRを起動できませんでした。実行環境を確認してください。')); });
        child.on('close', code => {
          clearTimeout(timer);
          if (job.cancelled) return reject(new OcrError(409, 'OCRがOFFになったため読み取りを中止しました。'));
          if (timedOut) return reject(new OcrError(504, 'OCRが時間内に完了しませんでした。写真を小さくして再試行してください。'));
          try {
            const result = JSON.parse(output.trim().split(/\r?\n/).at(-1));
            if (code !== 0 || !result.ok) throw new OcrError(result.status ?? 503, result.error ?? 'OCRで読み取れませんでした。');
            if (!result.fields || typeof result.fields !== 'object' || Array.isArray(result.fields)) throw new Error('Invalid result');
            resolve(result);
          } catch (error) { reject(error instanceof OcrError ? error : new OcrError(503, 'OCRで読み取れませんでした。手入力するか再試行してください。')); }
        });
      });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (this.active === job) this.active = null;
    }
  }
}
