# readable-rewrite

A Claude Code mod that adds three buttons under each assistant reply: **原文** (original), **Sonnet 5.5 改写**, **Haiku 5.5 改写**. Press a model's button and that model rewrites the reply to be easier to read; press 原文 to switch back.

- The rewrite changes only what you see. The conversation keeps the original, so the main model's context is untouched.
- Rewrites run through your own Claude Code session (its account and credentials), one small low-effort request per press; the label shows how long it took. Each model's result is cached, so switching back and forth costs nothing extra.
- Replies shorter than 60 characters and subagent output are left alone.

The rewrite rules (in Chinese, applied to Chinese and English replies alike) are in [`hooks/rubric.ts`](hooks/rubric.ts). They change only the wording and keep every piece of information, table and the overall length: the answer moves to the front of its paragraph, jargon and internal labels get a short plain explanation where they first appear, long sentences are split, dropped connectives come back. They also target constructions that psycholinguistics links to reading difficulty and that recent models overuse — inanimate subjects doing animate things, stacked nouns, ad-hoc verbs made from nouns, dropped connectives, long dependencies — following Clark, Martin & Mahowald (2026), *Why is AI-generated language so hard to understand?* (arXiv:2610.29162).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install readable-rewrite --marketplace whwangovo/readable-rewrite
```

From a shell:

```bash
claude plugin install readable-rewrite --marketplace whwangovo/readable-rewrite
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `whwangovo/readable-rewrite`, then **Add plugin**.

Answer `y` to add the marketplace and pick the user scope. New sessions load the mod from then on.

## Use

- Press **Sonnet 5.5 改写** or **Haiku 5.5 改写** under a reply to rewrite it; **原文** shows the original.
- `/readable sonnet` or `/readable haiku`: rewrite every new reply automatically with that model.
- `/readable off`: back to rewriting only when you press a button (the default).
- `/readable`: show the current mode.

Requires a Claude Code version with mod (hooks module) support and access to `claude-sonnet-5-5` and `claude-haiku-5-5` on your account.
