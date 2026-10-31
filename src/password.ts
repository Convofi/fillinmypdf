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
