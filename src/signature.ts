import SignaturePad from 'signature_pad';

export type Sig = { dataUrl: string; w: number; h: number };

// Resolves with a trimmed, transparent PNG, or null if cancelled (or nothing was drawn).
// onForget: when given, a "Forget saved signature" button calls it and closes the modal.
export function drawSignature(onForget?: () => void): Promise<Sig | null> {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="sheet">
      <div class="sheet-title">Draw your signature</div>
      <div class="pad"><canvas></canvas><div class="pad-line"></div><div class="pad-hint">Sign above</div></div>
      <div class="sheet-row">
        <button data-a="clear">Clear</button>${onForget ? '<button data-a="forget" class="link">Forget saved signature</button>' : ''}<span></span>
        <button data-a="cancel">Cancel</button>
        <button data-a="done" class="primary">Done</button>
      </div></div>`;
    document.body.append(modal);
    const canvas = modal.querySelector('canvas')!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    canvas.getContext('2d')!.scale(dpr, dpr);
    const pad = new SignaturePad(canvas, { penColor: '#000', backgroundColor: 'rgba(0,0,0,0)', minWidth: 1, maxWidth: 2.8 });

    const hint = modal.querySelector<HTMLElement>('.pad-hint')!;
    pad.addEventListener('beginStroke', () => (hint.hidden = true));
    const close = (value: Sig | null) => {
      pad.off();
      modal.remove();
      removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') close(null);
    };
    addEventListener('keydown', onKey, true);
    modal.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a === 'clear') pad.clear(), (hint.hidden = false);
      if (a === 'forget') onForget!();
      if (a === 'cancel' || a === 'forget' || (a === 'done' && pad.isEmpty())) close(null);
      else if (a === 'done') close(trim(canvas, Math.ceil(4 * dpr)));
    });
  });
}

function trim(c: HTMLCanvasElement, margin: number): Sig {
  const { width: w, height: h } = c;
  const data = c.getContext('2d')!.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  x0 = Math.max(0, x0 - margin); y0 = Math.max(0, y0 - margin);
  x1 = Math.min(w - 1, x1 + margin); y1 = Math.min(h - 1, y1 + margin);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL('image/png'), w: out.width, h: out.height };
}
