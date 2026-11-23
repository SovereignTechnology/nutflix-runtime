/**
 * Settings › "Seeding and publishing": this app's own section, under `@sovit/ui`'s. Studio in
 * `@sovit/ui` is built around priced uploads and a browser file input, and neither belongs here:
 * this version publishes free videos only, and a page never names a file. So this is a small form
 * of its own, added to the Settings screen while it is shown, as `../settings/webrtc-note.ts` adds
 * its line. Every value is set with `textContent` or `.value`; nothing here parses HTML.
 *
 * The passphrase and bunker fields are `type=password` and are cleared as soon as they are used.
 */
import type {
  SeedingStatusWire,
  SignerStatusWire,
  StudioProbeWire,
  StudioSourceWire,
} from '@nutflix-runtime/worker';
import { MAX_DESCRIPTION, MAX_PASSPHRASE, MAX_TITLE } from '@nutflix-runtime/worker';

import type { SeedPublish } from './controller.js';

export const PANEL_ID = 'nutflix-seed-publish';
const MAX_BUNKER_FIELD = 2048;

/** The switch's plain text (ADR 0001 decision 4's disclosure, for seeding). */
export const SEEDING_DISCLOSURE =
  'Seeding shares your IP address with viewers. While this is on, Nutflix keeps the free videos ' +
  'you watch on this computer and serves them to anyone who asks, and the relays you use learn ' +
  'which videos you seed. It is off until you turn it on.';

export const PUBLISH_DISCLOSURE =
  'Publishing a video seeds it from this computer, which shares your IP address with its viewers.';

export interface SeedPublishPanel {
  stop(): void;
}

/** The screens' words for a refusal; a worker's message is its own text, one line, no secrets. */
function message(e: unknown): string {
  if (e instanceof Error) {
    const m = /^[a-z-]+: (.*)$/.exec(e.message);
    return (m?.[1] ?? e.message).slice(0, 240);
  }
  return 'that did not work';
}

function make<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: { readonly id?: string; readonly className?: string; readonly text?: string } = {},
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (props.id !== undefined) el.id = props.id;
  if (props.className !== undefined) el.className = props.className;
  if (props.text !== undefined) el.textContent = props.text;
  return el;
}

function button(doc: Document, id: string, text: string): HTMLButtonElement {
  const b = make(doc, 'button', { id, text, className: 'nf-settings__button' });
  b.type = 'button';
  return b;
}

function field(
  doc: Document,
  id: string,
  label: string,
  input: HTMLInputElement | HTMLTextAreaElement,
): HTMLElement {
  const row = make(doc, 'div', { className: 'nf-settings__field' });
  const l = make(doc, 'label', { text: label, className: 'nf-settings__label' });
  l.htmlFor = id;
  input.id = id;
  row.append(l, input);
  return row;
}

function signerLine(s: SignerStatusWire): string {
  const who = s.pubkey === null ? '' : ` (${s.pubkey.slice(0, 12)}…)`;
  if (s.kind === 'nip46') return `Signing with a bunker${who}.`;
  if (s.kind === 'local')
    return s.locked ? `Your key is locked${who}.` : `Your key is unlocked${who}.`;
  return 'No signer yet. Create a key sealed with a passphrase, or connect a bunker.';
}

export function installSeedPublishPanel(root: HTMLElement, control: SeedPublish): SeedPublishPanel {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (view === null) return { stop: () => undefined };

  const section = make(doc, 'section', { id: PANEL_ID, className: 'nf-settings__section' });
  section.dataset['section'] = PANEL_ID;
  const head = make(doc, 'header', { className: 'nf-settings__section-head' });
  // A level-2 heading in the outline; `<h2>`s are the design system's own sections.
  const heading = make(doc, 'div', {
    className: 'nf-settings__section-title',
    text: 'Seeding and publishing',
  });
  heading.setAttribute('role', 'heading');
  heading.setAttribute('aria-level', '2');
  head.append(heading);
  section.append(head);

  // ---- the switch ----------------------------------------------------------------------------
  const seedGroup = make(doc, 'div', { className: 'nf-settings__group' });
  seedGroup.append(make(doc, 'h3', { className: 'nf-settings__group-title', text: 'Seeding' }));
  const switchRow = make(doc, 'label', { className: 'nf-settings__row' });
  const seedSwitch = make(doc, 'input', { id: 'nutflix-seed-switch' });
  seedSwitch.type = 'checkbox';
  seedSwitch.setAttribute('role', 'switch');
  switchRow.append(seedSwitch, make(doc, 'span', { text: 'Seed what you watch' }));
  const seedStatus = make(doc, 'p', {
    id: 'nutflix-seed-status',
    className: 'nf-settings__desc',
  });
  seedStatus.setAttribute('role', 'status');
  const seedList = make(doc, 'ul', { id: 'nutflix-seed-list', className: 'nf-settings__desc' });
  seedGroup.append(
    switchRow,
    make(doc, 'p', {
      id: 'nutflix-seed-disclosure',
      className: 'nf-settings__desc',
      text: SEEDING_DISCLOSURE,
    }),
    seedStatus,
    seedList,
  );

  // ---- the signer ----------------------------------------------------------------------------
  const signerGroup = make(doc, 'div', { className: 'nf-settings__group' });
  signerGroup.append(make(doc, 'h3', { className: 'nf-settings__group-title', text: 'Signer' }));
  const signerStatus = make(doc, 'p', {
    id: 'nutflix-signer-status',
    className: 'nf-settings__desc',
  });
  signerStatus.setAttribute('role', 'status');
  const passphrase = make(doc, 'input');
  passphrase.type = 'password';
  passphrase.autocomplete = 'off';
  passphrase.maxLength = MAX_PASSPHRASE;
  const createKey = button(doc, 'nutflix-signer-create', 'Create a key');
  const unlock = button(doc, 'nutflix-signer-unlock', 'Unlock');
  const lock = button(doc, 'nutflix-signer-lock', 'Lock');
  const bunker = make(doc, 'input');
  bunker.type = 'password';
  bunker.autocomplete = 'off';
  bunker.maxLength = MAX_BUNKER_FIELD;
  bunker.placeholder = 'bunker://…';
  const connect = button(doc, 'nutflix-signer-connect', 'Connect bunker');
  signerGroup.append(
    signerStatus,
    field(doc, 'nutflix-passphrase', 'Passphrase (at least 8 characters)', passphrase),
    createKey,
    unlock,
    lock,
    field(doc, 'nutflix-bunker', 'Or a NIP-46 bunker', bunker),
    connect,
  );

  // ---- Studio --------------------------------------------------------------------------------
  const studio = make(doc, 'div', { className: 'nf-settings__group' });
  studio.append(make(doc, 'h3', { className: 'nf-settings__group-title', text: 'Publish' }));
  const ffmpegLine = make(doc, 'p', { id: 'nutflix-ffmpeg', className: 'nf-settings__desc' });
  const pick = button(doc, 'nutflix-pick', 'Choose a video…');
  const picked = make(doc, 'p', { id: 'nutflix-picked', className: 'nf-settings__desc' });
  const sizes = make(doc, 'fieldset', { id: 'nutflix-sizes', className: 'nf-settings__fieldset' });
  sizes.append(make(doc, 'legend', { text: 'Sizes to publish', className: 'nf-settings__legend' }));
  sizes.hidden = true;
  const title = make(doc, 'input');
  title.maxLength = MAX_TITLE;
  const description = make(doc, 'textarea');
  description.maxLength = MAX_DESCRIPTION;
  description.rows = 3;
  const tags = make(doc, 'input');
  tags.placeholder = 'space separated';
  const publish = button(doc, 'nutflix-publish', 'Publish');
  publish.disabled = true;
  const cancel = button(doc, 'nutflix-publish-cancel', 'Cancel');
  cancel.hidden = true;
  const publishStatus = make(doc, 'p', {
    id: 'nutflix-publish-status',
    className: 'nf-settings__desc',
  });
  publishStatus.setAttribute('role', 'status');
  studio.append(
    make(doc, 'p', { className: 'nf-settings__desc', text: PUBLISH_DISCLOSURE }),
    ffmpegLine,
    pick,
    picked,
    sizes,
    field(doc, 'nutflix-title', 'Title', title),
    field(doc, 'nutflix-description', 'Description', description),
    field(doc, 'nutflix-tags', 'Tags', tags),
    publish,
    cancel,
    publishStatus,
  );

  section.append(seedGroup, signerGroup, studio);

  // ---- state ---------------------------------------------------------------------------------
  let source: StudioSourceWire | null = null;
  let probe: StudioProbeWire | null = null;
  let publishing = false;

  /** Runs one user action: buttons report failure in `line`, in the worker's plain words. */
  const act = (line: HTMLElement, f: () => Promise<void>): void => {
    line.dataset['error'] = '';
    f().catch((e: unknown) => {
      line.textContent = message(e);
      line.dataset['error'] = 'true';
    });
  };

  const showSeeding = (s: SeedingStatusWire): void => {
    seedSwitch.checked = s.watched;
    const served = s.videos.filter((v) => v.served).length;
    seedStatus.textContent =
      served === 0
        ? 'Not seeding anything.'
        : `Seeding ${String(served)} ${served === 1 ? 'video' : 'videos'}.`;
    seedStatus.dataset['served'] = String(served);
    seedList.replaceChildren(
      ...s.videos.map((v) => {
        const li = make(doc, 'li', {
          text: `${v.video} (${v.origin}${v.served ? ', seeding' : ', not seeding'}) `,
        });
        const stop = button(doc, `nutflix-seed-stop-${v.root.slice(0, 16)}`, 'Stop and delete');
        stop.addEventListener('click', () => {
          act(seedStatus, async () => {
            await control.stopSeeding(v.video);
            showSeeding(await control.refreshSeeding());
          });
        });
        li.append(stop);
        return li;
      }),
    );
  };
  const showSigner = (s: SignerStatusWire): void => {
    signerStatus.textContent = signerLine(s);
    signerStatus.dataset['kind'] = s.kind;
    signerStatus.dataset['locked'] = String(s.locked);
    if (s.pubkey !== null) signerStatus.dataset['pubkey'] = s.pubkey;
    else delete signerStatus.dataset['pubkey'];
    createKey.hidden = s.keyFile;
    unlock.hidden = !s.keyFile || !s.locked;
    lock.hidden = s.locked;
  };
  const canPublish = (): void => {
    const chosen = sizes.querySelectorAll('input:checked').length > 0;
    publish.disabled = publishing || source === null || !chosen || title.value.trim() === '';
  };
  const showSizes = (p: StudioProbeWire): void => {
    for (const el of [...sizes.querySelectorAll('label')]) el.remove();
    const preferred = p.sizes.some((s) => s.height === 720) ? 720 : (p.sizes[0]?.height ?? 0);
    for (const s of p.sizes) {
      const l = make(doc, 'label', { className: 'nf-settings__row' });
      const c = make(doc, 'input');
      c.type = 'checkbox';
      c.value = String(s.height);
      c.checked = s.height === preferred;
      c.addEventListener('change', canPublish);
      l.append(
        c,
        make(doc, 'span', {
          text: `${String(s.height)}p${s.original ? ' (original)' : ''}, about ${String(s.kbps)} kbps`,
        }),
      );
      sizes.append(l);
    }
    sizes.hidden = false;
  };

  seedSwitch.addEventListener('change', () => {
    const want = seedSwitch.checked;
    // The state is the worker's: the box shows it again once the worker has answered.
    seedSwitch.checked = control.watching;
    act(seedStatus, async () => {
      showSeeding(await control.setSeeding(want));
    });
  });
  createKey.addEventListener('click', () => {
    const p = passphrase.value;
    passphrase.value = '';
    act(signerStatus, async () => {
      showSigner(await control.createKey(p));
    });
  });
  unlock.addEventListener('click', () => {
    const p = passphrase.value;
    passphrase.value = '';
    act(signerStatus, async () => {
      showSigner(await control.unlock(p));
    });
  });
  lock.addEventListener('click', () => {
    act(signerStatus, async () => {
      showSigner(await control.lock());
    });
  });
  connect.addEventListener('click', () => {
    const uri = bunker.value;
    bunker.value = '';
    act(signerStatus, async () => {
      showSigner(await control.connectBunker(uri));
    });
  });
  pick.addEventListener('click', () => {
    act(picked, async () => {
      const chosen = await control.pickVideo();
      if (chosen === null) return;
      source = chosen;
      probe = null;
      picked.textContent = `${chosen.name}: reading it…`;
      probe = await control.probe(chosen.source);
      picked.textContent = `${chosen.name}, ${String(Math.round(probe.durationSec))} s, ${String(probe.width)}x${String(probe.height)}`;
      picked.dataset['ready'] = 'true';
      showSizes(probe);
      canPublish();
    });
  });
  title.addEventListener('input', canPublish);
  cancel.addEventListener('click', () => {
    act(publishStatus, () => control.cancelPublish());
  });
  publish.addEventListener('click', () => {
    if (source === null || publishing) return;
    const chosen = [...sizes.querySelectorAll<HTMLInputElement>('input:checked')].map((c) =>
      Number(c.value),
    );
    publishing = true;
    publish.disabled = true;
    cancel.hidden = false;
    publishStatus.dataset['state'] = 'running';
    act(publishStatus, async () => {
      try {
        const done = await control.publish(
          {
            source: source?.source ?? '',
            title: title.value.trim(),
            description: description.value,
            tags: [...new Set(tags.value.split(/\s+/).filter((t) => t !== ''))],
            sizes: chosen,
          },
          (p) => {
            publishStatus.textContent =
              p.stage === 'encoding'
                ? `Encoding ${p.rendition ?? ''}: ${String(p.percent ?? 0)}%`
                : `${p.stage[0]?.toUpperCase() ?? ''}${p.stage.slice(1)}…`;
          },
        );
        publishStatus.textContent =
          done.relays === 0
            ? 'Signed and seeding, but no relay accepted the manifest, so nobody can find it. Check your relays.'
            : `Published. ${String(done.relays)} relays have it, and this computer is seeding it.`;
        publishStatus.dataset['state'] = done.relays === 0 ? 'no-relay' : 'done';
        publishStatus.dataset['video'] = done.video;
        showSeeding(await control.refreshSeeding());
      } catch (e) {
        publishStatus.dataset['state'] = 'failed';
        if (control.awaitingSignature)
          throw new Error(
            `no-signer: packaged, but not signed: ${message(e)}. Unlock your key or approve it in your bunker, then press Publish again.`,
            { cause: e },
          );
        throw e;
      } finally {
        publishing = false;
        cancel.hidden = true;
        canPublish();
      }
    });
  });

  const refresh = (): void => {
    void control.refreshSeeding().then(showSeeding, () => undefined);
    void control.signerStatus().then(showSigner, () => undefined);
    void control.ffmpeg().then(
      (f) => {
        ffmpegLine.textContent = f.found
          ? `Using your system's ffmpeg${f.version === undefined ? '' : ` (${f.version})`}.`
          : `Publishing needs ffmpeg. ${f.install}`;
        ffmpegLine.dataset['found'] = String(f.found);
        pick.disabled = !f.found;
      },
      () => undefined,
    );
  };

  /** Keeps the section at the end of the Settings screen's body, while that screen is shown. */
  const render = (): void => {
    const body = root.querySelector('.nf-settings__body');
    if (body === null) {
      if (section.isConnected) section.remove();
      return;
    }
    if (section.parentElement !== body || body.lastElementChild !== section) {
      const first = !section.isConnected;
      body.append(section);
      if (first) refresh();
    }
  };
  const observer = new view.MutationObserver(render);
  observer.observe(root, { childList: true, subtree: true });
  render();
  return {
    stop: () => {
      observer.disconnect();
      section.remove();
    },
  };
}
