(() => {
  const form = document.querySelector('#entry-form');
  const controls = document.querySelector('#slip-photo-controls');
  const panel = document.createElement('div');
  panel.className = 'ocr-panel';
  panel.innerHTML = '<p id="ocr-status" role="status" aria-live="polite">OCRの設定を確認しています…</p><button class="button button--secondary" type="button" id="ocr-retry" hidden>伝票を再読み取り</button><label id="ocr-review" hidden><input type="checkbox" id="ocr-reviewed">写真と自動入力の内容を確認しました</label>';
  controls.append(panel);
  const status = panel.querySelector('#ocr-status');
  const retry = panel.querySelector('#ocr-retry');
  const review = panel.querySelector('#ocr-review');
  const reviewed = panel.querySelector('#ocr-reviewed');
  let enabled = false; let busy = false; let latest = null; let generation = 0;
  let configPromise;
  const touched = new WeakSet();
  form.addEventListener('input', event => { touched.add(event.target); });
  form.addEventListener('change', event => { if (event.isTrusted) touched.add(event.target); });
  const refresh = async () => {
    try {
      const response = await fetch('/api/features', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const config = await response.json();
      enabled = config.ocrEnabled === true;
      retry.hidden = !enabled || !latest;
      retry.disabled = busy || !config.ocrReady;
      if (!busy && review.hidden) status.textContent = !enabled ? 'OCR自動入力：OFF' : config.ocrReady ? 'OCR自動入力：ON（テスト）。伝票写真の追加時に読み取ります。現在は1商品分です。' : 'OCR自動入力：ONですが実行環境が未準備です。';
      return enabled && config.ocrReady;
    } catch { enabled = false; status.textContent = 'OCRの設定を取得できませんでした。手入力できます。'; return false; }
  };
  const bindings = () => {
    const card = document.querySelector('.product-card');
    const pairs = { customerName: 'customer-name', customerKana: 'customer-kana', phone: 'phone', receivedDate: 'received-date', amount: 'amount', depositAmount: 'deposit' };
    const items = Object.entries(pairs).map(([key, name]) => ({ key, name, input: form.querySelector(`[name="${name}"]`) }));
    for (const [key, name] of Object.entries({ productNumber: 'product-number', branchNumber: 'branch-number', productName: 'product-name', color: 'color', size: 'size', quantity: 'quantity' })) items.push({ key, name, input: card?.querySelector(`[name="${name}"]`) });
    return items.filter(({ input }) => input).map(item => ({ ...item, start: item.input.value, eligible: !touched.has(item.input) && (item.input.value === '' || (/^\/new\/?$/.test(location.pathname) && ['received-date', 'quantity'].includes(item.name))) }));
  };
  const run = async (file) => {
    if (busy) return;
    busy = true; retry.disabled = true;
    const ticket = ++generation;
    const snapshot = bindings();
    if (!await refresh()) { busy = false; retry.disabled = false; status.textContent = 'OCRはOFF、または実行環境が未準備です。手入力できます。'; return; }
    status.textContent = '伝票を読み取り中です…（初回はモデルの準備に時間がかかります）';
    try {
      const response = await fetch('/api/ocr/recognize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await fileToPayload(file)) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '読み取りに失敗しました。');
      // Recheck the switch before applying an in-flight response.
      const allowed = await refresh();
      if (!allowed || ticket !== generation || !slipPhotoCollection.getNewPhotos().some(photo => photo.file === file)) { status.textContent = '写真またはOCR設定が変わったため、結果は反映しませんでした。'; return; }
      let count = 0; let skipped = 0;
      for (const { key, name, input, start, eligible } of snapshot) {
        const value = result.fields[key];
        if (value === undefined || value === null || value === '') continue;
        if (!eligible || !input.isConnected || input.value !== start || touched.has(input)) { skipped++; continue; }
        input.value = name === 'deposit' ? (Number(value) > 0 ? 'あり' : 'なし') : String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.classList.add('ocr-filled');
        if (name === 'deposit') form.querySelectorAll('[data-choice="deposit"] button').forEach(button => button.classList.toggle('is-selected', button.dataset.value === input.value));
        count++;
      }
      // Confirmation stays a user decision; OCR never marks an entry as registered.
      if (count) { review.hidden = false; reviewed.checked = false; }
      status.textContent = count ? `${count}項目に入力候補を反映しました。写真と氏名・電話・商品・金額を必ず照合してください。${skipped ? `入力済みの${skipped}項目は保持しました。` : ''} 複数写真・複数商品は手入力で確認してください。` : '入力できる空欄がありませんでした。入力済みの内容を保持しています。';
    } catch (error) { status.textContent = `OCR：${error.message} 手入力で続けられます。`; }
    finally { busy = false; retry.disabled = false; }
  };
  document.addEventListener('slip-photos-added', async event => {
    latest = event.detail.files[0];
    ++generation;
    await configPromise;
    if (busy) { status.textContent = '別の伝票を読み取り中です。完了後に「伝票を再読み取り」を押してください。'; return; }
    await run(latest);
  });
  retry.addEventListener('click', () => {
    if (!slipPhotoCollection.getNewPhotos().some(photo => photo.file === latest)) { latest = slipPhotoCollection.getNewPhotos().at(-1)?.file; }
    if (latest) run(latest); else status.textContent = '読み取る伝票写真を追加してください。';
  });
  // Capture on document runs before both new-entry and edit-entry submit handlers.
  document.addEventListener('submit', event => {
    if (event.target !== form) return;
    if (busy || (!review.hidden && !reviewed.checked)) {
      event.preventDefault(); event.stopImmediatePropagation();
      status.textContent = busy ? 'OCRの完了を待ってから登録してください。' : '写真と自動入力の内容を確認し、確認チェックを入れてください。';
      panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, true);
  window.addEventListener('focus', () => refresh());
  configPromise = refresh();
})();
