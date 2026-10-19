/** The URL a srcset lists for one density, e.g. `2x`. */
export function srcsetUrl(srcset: string, density: string): string | undefined {
  for (const candidate of srcset.split(',')) {
    const [url, descriptor] = candidate.trim().split(/\s+/);
    if (url && descriptor === density) return url;
  }
  return undefined;
}

/** The sharpest file of a screenshot for the current color scheme, from its `<picture>`. */
function fullSizeUrl(picture: HTMLPictureElement, img: HTMLImageElement): string {
  for (const source of picture.querySelectorAll('source')) {
    if (source.media && matchMedia(source.media).matches) return srcsetUrl(source.srcset, '2x') ?? img.currentSrc;
  }
  return srcsetUrl(img.srcset, '2x') ?? img.currentSrc ?? img.src;
}

function zoomIcon(): HTMLSpanElement {
  const icon = document.createElement('span');
  icon.className = 'zoom-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  return icon;
}

/** Lets each screenshot open large: next to their text they are too small to read the UI in them. */
export function setUpLightbox(): void {
  const figures = document.querySelectorAll<HTMLElement>('figure.window');
  if (figures.length === 0 || typeof HTMLDialogElement !== 'function') return;

  const dialog = document.createElement('dialog');
  dialog.className = 'lightbox';
  dialog.setAttribute('aria-label', 'Screenshot');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightbox-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  const frame = document.createElement('figure');
  frame.className = 'lightbox-frame';
  dialog.append(close, frame);
  document.body.append(dialog);

  close.addEventListener('click', () => dialog.close());
  // Clicks on the dimmed area land on the dialog itself; the picture closes it too, like most lightboxes.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target instanceof HTMLImageElement) dialog.close();
  });
  dialog.addEventListener('close', () => document.documentElement.classList.remove('lightbox-open'));

  const open = (picture: HTMLPictureElement, img: HTMLImageElement) => {
    const copy = picture.cloneNode(true) as HTMLPictureElement;
    copy.querySelector('img')?.removeAttribute('loading');
    const caption = document.createElement('figcaption');
    const text = document.createElement('span');
    text.textContent = img.alt;
    const full = document.createElement('a');
    full.href = fullSizeUrl(picture, img);
    full.target = '_blank';
    full.rel = 'noopener';
    full.textContent = 'Open full size';
    const hint = document.createElement('span');
    hint.className = 'lightbox-hint';
    hint.textContent = 'Swipe sideways to see more';
    caption.append(text, full, hint);
    const view = document.createElement('div');
    view.className = 'lightbox-view';
    view.append(copy);
    frame.replaceChildren(view, caption);
    document.documentElement.classList.add('lightbox-open');
    dialog.showModal();
  };

  for (const figure of figures) {
    const picture = figure.querySelector('picture');
    const img = picture?.querySelector('img');
    if (!picture || !img) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'zoom';
    button.setAttribute('aria-label', `Enlarge screenshot: ${img.alt}`);
    picture.replaceWith(button);
    button.append(picture, zoomIcon());
    button.addEventListener('click', () => open(picture, img));
  }
}
