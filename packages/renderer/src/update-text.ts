/**
 * What the window says about an update. The shell's main process sends a state and a reason; the
 * words are these, so nothing a relay or a peer chose is ever displayed. Pure: main also reads this
 * file, to check that the window shows what it was told.
 */
export const UPDATE_BANNER_ID = 'nutflix-update-status';

export const UPDATE_HELD_TEXT =
  'Unverified update held. Nutflix keeps running the version you have.';
export const UPDATE_APPLIED_TEXT =
  'Update verified and installed. It takes effect the next time you start Nutflix.';
export const UPDATE_FAILED_TEXT =
  'An update could not be installed. Nutflix keeps running the version you have.';

/** The banner's text for a state, or `null` when there is nothing to say. */
export function updateBannerText(state: unknown): string | null {
  switch (state) {
    case 'held':
      return UPDATE_HELD_TEXT;
    case 'applied':
      return UPDATE_APPLIED_TEXT;
    case 'failed':
      return UPDATE_FAILED_TEXT;
    default:
      return null;
  }
}
