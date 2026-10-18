/**
 * Server-half slot declaration. The server tree has no UI: it exists so every
 * plugin's two halves are real Cordis plugins of the same shape (contract.md
 * §2), and so the server half owns the only disk access (`ctx.fs`).
 * Full UI slot typing lives in the client half (`../client/slots.ts`);
 * this file types the server `ctx.slots` as absent-by-default.
 */
declare module 'cordis' {
  interface Context {
    /** Present only on the client tree. Never read it from a server half. */
    slots?: never
  }
}

export {}
