// Password dialog for encrypted PDFs (same styling as the signature dialog). Resolves null on Cancel / Escape.
export function askPassword(retry: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="sheet">
      <div class="sheet-title"></div>
      <input type="password" autocomplete="off" />
      <div class="sheet-row"><span></span>
        <button data-a="cancel">Cancel</button>
        <button data-a="open" class="primary">Open</button>
      </div></div>`;
    modal.querySelector('.sheet-title')!.textContent = retry ? 'Wrong password. Try again.' : 'This PDF needs a password';
    document.body.append(modal);
    const input = modal.querySelector('input')!;
    input.focus();
    const close = (value: string | null) => {
      modal.remove();
      removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation(); // keep the editor's shortcuts (Delete, Backspace) away from the input
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter') close(input.value);
    };
    addEventListener('keydown', onKey, true);
    modal.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a === 'cancel') close(null);
      if (a === 'open') close(input.value);
    });
  });
}

// A one-button message in the same sheet styling (used when an export is refused).
export function notice(title: string, detail: string, reason = ''): Promise<void> {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="sheet" role="alertdialog" aria-modal="true">
      <div class="sheet-title"></div><p class="sheet-text"></p><p class="sheet-text muted"></p><p class="sheet-text muted"></p><p class="sheet-text muted small"></p>
      <div class="sheet-row"><span></span><button data-a="ok" class="primary">OK</button></div></div>`;
    const [t, d, m, p, r] = modal.querySelectorAll<HTMLElement>('.sheet-title, .sheet-text');
    t.textContent = title;
    d.textContent = detail;
    m.textContent = 'Nothing was downloaded.';
    p.textContent = "You can still print it to PDF from your browser's print dialog.";
    r.textContent = reason && `Reason: ${reason}`;
    document.body.append(modal);
    const ok = modal.querySelector<HTMLButtonElement>('[data-a=ok]')!;
    ok.focus();
    const close = () => {
      modal.remove();
      removeEventListener('keydown', onKey, true);
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape' || e.key === 'Enter') close();
    };
    addEventListener('keydown', onKey, true);
    ok.addEventListener('click', close);
  });
}

// Feedback: a message (and an optional email for a reply) goes to /api/feedback, which mails it to the maker.
// There is no way to attach the document.
export function feedback(): void {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="fb-title">
    <div class="sheet-title" id="fb-title">Feedback</div>
    <form>
      <label class="sheet-label" for="fb-message">What should we fix or add?</label>
      <textarea id="fb-message" name="message" required maxlength="4000" rows="5"></textarea>
      <label class="sheet-label" for="fb-email">Your email (optional, if you'd like a reply)</label>
      <input id="fb-email" name="email" type="email" autocomplete="email" maxlength="320" />
      <div class="honeypot" aria-hidden="true"><label for="fb-website">Website</label><input id="fb-website" name="website" type="text" tabindex="-1" autocomplete="off" /></div>
      <p class="sheet-text muted small">Your document stays on your computer. Only this message is sent.</p>
      <p class="sheet-text small" data-a="status" role="status"></p>
      <div class="sheet-row"><span></span><button type="button" data-a="cancel">Cancel</button><button type="submit" class="primary">Send</button></div>
    </form></div>`;
  document.body.append(modal);
  const form = modal.querySelector('form')!;
  const status = modal.querySelector<HTMLElement>('[data-a=status]')!;
  const send = modal.querySelector<HTMLButtonElement>('[type=submit]')!;
  modal.querySelector<HTMLTextAreaElement>('textarea')!.focus();
  const close = () => {
    modal.remove();
    removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation(); // keep the editor's shortcuts (Delete, Backspace) away from the fields
    if (e.key === 'Escape') close();
  };
  addEventListener('keydown', onKey, true);
  modal.querySelector('[data-a=cancel]')!.addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    send.disabled = true;
    send.textContent = 'Sending…';
    status.textContent = '';
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: data.get('message'), email: data.get('email') || undefined, website: data.get('website') || undefined }),
      });
      if (!res.ok) throw new Error(String(res.status));
      form.innerHTML = `<p class="sheet-text">Thanks, sent.</p><div class="sheet-row"><span></span><button type="button" data-a="ok" class="primary">OK</button></div>`;
      const ok = form.querySelector<HTMLButtonElement>('[data-a=ok]')!;
      ok.addEventListener('click', close);
      ok.focus();
    } catch {
      status.innerHTML = `Couldn't send. Email <a href="mailto:ali@convofi.com">ali@convofi.com</a> instead.`;
      send.disabled = false;
      send.textContent = 'Send';
    }
  });
}
