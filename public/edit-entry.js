(() => {
  const editId = new URLSearchParams(location.search).get('id');
  const form = document.querySelector('#entry-form');
  const status = document.querySelector('#form-status');
  const value = (name) => document.querySelector(`[name="${name}"]`)?.value ?? '';
  const setValue = (name, newValue) => {
    const input = document.querySelector(`[name="${name}"]`);
    if (input) input.value = newValue ?? '';
  };
  const parseJson = (text) => {
    try { return JSON.parse(text ?? '[]'); } catch { return []; }
  };
  const toPhotoPayload = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mimeType: file.type, base64: String(reader.result).split(',')[1] });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  document.querySelector('.app-header h1')?.replaceChildren('受付情報を編集');
  document.querySelector('#entry-form button[type="submit"]').textContent = '更新を保存';
  document.querySelector('#cancel').textContent = '更新を中止';

  const setChoice = (name, selectedValue) => {
    setValue(name, selectedValue);
    document.querySelectorAll(`[data-choice="${name}"] .choice-button`).forEach((button) => {
      button.classList.toggle('is-selected', button.dataset.value === selectedValue);
    });
  };

  const setStaff = (staff) => {
    const select = document.querySelector('#staff');
    if (staff && ![...select.options].some((option) => option.value === staff)) select.append(new Option(staff, staff));
    select.value = staff ?? '指定なし';
    select.dispatchEvent(new Event('change'));
  };

  const populateProduct = (card, product) => {
    const field = (name, newValue) => { const input = card.querySelector(`[name="${name}"]`); if (input) input.value = newValue ?? ''; };
    field('product-number', product.product_number);
    field('branch-number', product.branch_number);
    field('combined-number', product.combined_number);
    field('product-name', product.product_name);
    field('color', product.color);
    field('size', product.size);
    field('quantity', product.quantity || '1');
    field('product-notes', product.notes);
    const states = parseJson(product.work_states_json);
    card.querySelectorAll('.check-list input').forEach((input) => { input.checked = states.includes(input.value); });
  };

  fetch(`/api/requests/${encodeURIComponent(editId)}`)
    .then((response) => response.ok ? response.json() : Promise.reject(new Error('登録データを取得できませんでした。')))
    .then((data) => {
      const request = data.request;
      setValue('request-id', request.app_number);
      setValue('registered-date', request.registered_date);
      setValue('received-date', request.received_date);
      setStaff(request.staff);
      setValue('customer-name', request.customer_name);
      setValue('customer-kana', request.customer_kana);
      setValue('phone', request.phone);
      setValue('other-work', request.other_work);
      setValue('position', request.position);
      setValue('thread-font', request.thread_font);
      setValue('embroidery-content', request.embroidery_content);
      setValue('hemming-method', request.hemming_method);
      setValue('length', request.length_cm);
      setValue('hemming-thread', request.hemming_thread);
      setValue('remaining-fabric', request.remaining_fabric);
      setValue('hemming-notes', request.hemming_notes);
      setValue('amount', request.amount);
      setValue('notes', request.notes);
      setChoice('accounts-receivable', request.accounts_receivable ?? '');
      setChoice('deposit', request.deposit ?? '');
      setChoice('confirmation', request.confirmation_status ?? '');

      const workTypes = parseJson(request.work_types_json);
      document.querySelectorAll('#work-types input').forEach((input) => {
        input.checked = workTypes.includes(input.value);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      (data.products ?? []).forEach((product, index) => {
        if (index > 0) document.querySelector('#add-product').click();
        populateProduct(document.querySelectorAll('.product-card')[index], product);
      });

      slipPhotoCollection.setExistingPhotos((data.photos ?? []).filter((photo) => photo.photo_type === 'slip'));
      completedPhotoCollection.setExistingPhotos((data.photos ?? []).filter((photo) => photo.photo_type === 'completed'));
      status.textContent = '既存写真は右上の×で削除できます。写真を追加して更新することもできます。';
    })
    .catch((error) => { status.textContent = error.message; });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!value('confirmation')) {
      status.textContent = '確認状態を選択してください。';
      document.querySelector('[data-choice="confirmation"]').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    status.textContent = '更新中です…';
    const products = [...document.querySelectorAll('.product-card')].map((card) => ({
      number: card.querySelector('[name="product-number"]').value,
      branch: card.querySelector('[name="branch-number"]').value,
      combined: card.querySelector('[name="combined-number"]').value,
      name: card.querySelector('[name="product-name"]').value,
      color: card.querySelector('[name="color"]').value,
      size: card.querySelector('[name="size"]').value,
      quantity: card.querySelector('[name="quantity"]').value,
      workStates: [...card.querySelectorAll('.check-list input:checked')].map((input) => input.value),
      notes: card.querySelector('[name="product-notes"]').value
    }));
    const payload = {
      registeredDate: value('registered-date'), receivedDate: value('received-date'), staff: value('staff'), customerName: value('customer-name'), customerKana: value('customer-kana'), phone: value('phone'),
      workTypes: [...document.querySelectorAll('#work-types input:checked')].map((input) => input.value), otherWork: value('other-work'), position: value('position'), threadFont: value('thread-font'), embroideryContent: value('embroidery-content'), hemmingMethod: value('hemming-method'), lengthCm: value('length'), hemmingThread: value('hemming-thread'), remainingFabric: value('remaining-fabric'), hemmingNotes: value('hemming-notes'), amount: value('amount'), accountsReceivable: value('accounts-receivable'), deposit: value('deposit'), confirmationStatus: value('confirmation'), notes: value('notes'), products,
      slipPhotos: await Promise.all(slipPhotoCollection.getNewPhotos().map(({ file }) => toPhotoPayload(file))),
      completedPhotos: await Promise.all(completedPhotoCollection.getNewPhotos().map(({ file }) => toPhotoPayload(file))),
      removedPhotoIds: [...slipPhotoCollection.getRemovedPhotoIds(), ...completedPhotoCollection.getRemovedPhotoIds()]
    };
    try {
      const response = await fetch(`/api/requests/${encodeURIComponent(editId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error((await response.json()).error ?? '更新に失敗しました。');
      status.textContent = '更新しました。検索画面へ戻ります。';
      window.setTimeout(() => { location.href = '/search'; }, 500);
    } catch (error) { status.textContent = `更新できませんでした: ${error.message}`; }
  }, true);
})();
