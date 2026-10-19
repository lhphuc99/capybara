import { NPM_PUBLISHED, REPO, REPO_URL } from './config';
import { setUpLightbox } from './lightbox';
import {
  archFromHints,
  detectPlatform,
  downloadLabel,
  formatDate,
  formatSize,
  parseRelease,
  primaryDownload,
  type NavigatorLike,
  type Os,
  type ParsedRelease,
  type Platform,
  type Release,
} from './downloads';

const CACHE_KEY = 'capybara:release';
const CACHE_MS = 10 * 60_000;
const OS_NAMES: Record<Os, string> = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

type Hints = NavigatorLike['userAgentData'] & {
  getHighEntropyValues?(hints: string[]): Promise<{ architecture?: string }>;
};
const hints = (navigator as { userAgentData?: Hints }).userAgentData;
const platform: Platform = detectPlatform({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, userAgentData: hints });

/** The latest release, `null` when there is none yet, `undefined` when GitHub couldn't be asked (offline, rate limit). */
async function loadRelease(): Promise<ParsedRelease | null | undefined> {
  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null') as { at: number; release: ParsedRelease | null } | null;
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.release;
  } catch {
    // Storage blocked: ask GitHub every time.
  }
  let release: ParsedRelease | null;
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (response.status === 404) release = null;
    else if (response.ok) release = parseRelease((await response.json()) as Release);
    else return undefined;
  } catch {
    return undefined;
  }
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release }));
  } catch {
    // Not essential.
  }
  return release;
}

function link(href: string, ...children: Array<string | Node>): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.append(...children);
  return anchor;
}

function item(...children: Array<string | Node>): HTMLLIElement {
  const li = document.createElement('li');
  li.append(...children);
  return li;
}

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function showPlatform() {
  if (platform.os === 'mobile' || platform.os === 'unknown') return;
  const card = document.querySelector<HTMLElement>(`.platform[data-os="${platform.os}"]`);
  card?.setAttribute('data-current', '');
  const details = card?.querySelector('details');
  if (details) details.open = true;
  document.getElementById('intel-note')!.hidden = !(platform.os === 'mac' && platform.arch === 'x64');
  const hero = document.getElementById('hero-download') as HTMLAnchorElement;
  hero.textContent = `Download for ${OS_NAMES[platform.os]}`;
}

function showRelease(release: ParsedRelease | null) {
  const hero = document.getElementById('hero-download') as HTMLAnchorElement;
  const meta = document.getElementById('hero-meta')!;
  const summary = document.getElementById('release-summary')!;
  const releases = `${REPO_URL}/releases`;

  if (!release) {
    if (NPM_PUBLISHED) {
      const command = document.createElement('code');
      command.textContent = 'npx capybara-devtools';
      hero.textContent = 'Get started';
      hero.href = '#get-started';
      meta.textContent = 'The desktop app is on its way. Today, run npx capybara-devtools.';
      summary.replaceChildren('The first desktop release is on its way. Until then, run ', command, ' and use Capybara in your browser.');
    } else {
      const fromSource = `${REPO_URL}#quick-start-from-this-repo`;
      hero.textContent = 'Run from source';
      hero.href = fromSource;
      meta.textContent = 'The first release is on its way.';
      summary.replaceChildren('The first release is on its way. Until then, ', link(fromSource, 'run Capybara from source'), '.');
    }
    for (const list of document.querySelectorAll<HTMLElement>('[data-files]')) {
      list.replaceChildren(item(span('unavailable', 'Coming with the first release')));
    }
    return;
  }

  const date = release.date ? formatDate(release.date) : undefined;
  summary.replaceChildren(
    `Version ${release.version}${date ? `, released ${date}` : ''}. `,
    link(release.url, 'Release notes'),
  );
  for (const list of document.querySelectorAll<HTMLElement>('[data-files]')) {
    const files = release.downloads.filter((download) => download.os === list.dataset.files);
    list.replaceChildren(
      ...(files.length
        ? files.map((download) => item(link(download.url, span('label', downloadLabel(download)), span('size', formatSize(download.size)))))
        : [item(span('unavailable', 'Not in this release · '), link(releases, 'All releases'))]),
    );
  }

  const primary = primaryDownload(release.downloads, platform);
  if (primary) {
    hero.href = primary.url;
    meta.textContent = `Version ${release.version}${date ? ` · ${date}` : ''} · ${formatSize(primary.size)}`;
  } else {
    meta.textContent = `Version ${release.version}${date ? ` · ${date}` : ''}`;
  }
}

function setUpCopyButtons() {
  const status = document.getElementById('copy-status')!;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', async () => {
      const text = button.parentElement?.querySelector('pre')?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
        status.textContent = 'Copied to the clipboard';
      } catch {
        button.textContent = 'Press ⌘C';
        status.textContent = 'Copying is blocked; select the text and copy it yourself';
      }
      setTimeout(() => (button.textContent = 'Copy'), 1_500);
    });
  }
}

showPlatform();
setUpCopyButtons();
setUpLightbox();
const release = await loadRelease();
if (release !== undefined) showRelease(release);

// Chromium can tell an Apple silicon Mac from an Intel one, and arm64 Linux from x64.
if (platform.os === 'mac' || platform.os === 'linux') {
  hints
    ?.getHighEntropyValues?.(['architecture'])
    .then(({ architecture }) => {
      const arch = archFromHints(architecture);
      if (!arch || arch === platform.arch) return;
      platform.arch = arch;
      showPlatform();
      if (release) showRelease(release);
    })
    .catch(() => {});
}
