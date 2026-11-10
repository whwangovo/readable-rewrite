/** A model that can rewrite. */
export type Rewriter = 'sonnet' | 'haiku'

/** What a message shows: the original or one model's rewrite. */
export type View = 'original' | Rewriter

/** One model's rewrite of a message. */
export type Rewrite = {
  status: 'pending' | 'done' | 'failed'
  /** The rewritten text, once done. */
  text?: string
  /** Why it failed, once failed. */
  error?: string
}

/** One message, keyed by a hash of its original text. */
export type Entry = {
  /** The original text. */
  source: string
  /** The version picked for this message; absent, the global mode decides. */
  view?: View
  sonnet?: Rewrite
  haiku?: Rewrite
}

export type Rewrites = {
  /** Messages by text hash. */
  entries: Record<string, Entry>
  /** Transcript row uuid → text hash. */
  byRow: Record<string, string>
  /** Hashes, oldest first, for trimming. */
  order: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'readable-rewrite': {
      /** original: rewrite on request; a model: rewrite every reply with it and show that. */
      mode: Shaped<View>
      rewrites: Shaped<Rewrites>
    }
  }
}
