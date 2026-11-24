/**
 * The first frame every page writes (`../page/pipe.ts`). The page's pipe outlives a reload, so this
 * is how the gate learns that a new page is talking: it closes the sessions the old page opened and
 * drops answers still owed to it (`../bare/page-gate.ts`).
 */
export const PAGE_RESET = Object.freeze({ op: 'reset' as const });
