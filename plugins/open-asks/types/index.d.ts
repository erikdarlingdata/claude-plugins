/** One question or decision the session is waiting on from the person. */
export type Ask = {
  /** Small and stable for the session's life: what the band shows and what ask_resolve and /asks done take. */
  id: number
  /** The full question, with enough context to answer it without scrolling back. */
  text: string
  /** The recommended answer and its one-line reason; '' when there is none. Older saved entries lack it. */
  recommendation: string
  /** Who needs the answer: '' for this session, else the name of the agent whose question was relayed. */
  from: string
  /** Clock time in ms. */
  addedAt: number
}

/** What the session keeps: the open asks and the next id. Saved to the plugin's store, one entry per session id. */
export type Book = { asks: Ask[]; nextId: number }

declare module 'claude-code' {
  interface PluginState {
    'open-asks': { book: Book; isHidden: boolean }
  }
}
