import { ulid } from '@archive/core'

/** Text of a new draft. The id is created here, once, and never changes. */
export function newDraftText(): string {
  return `id: ${ulid()}
type: photo
title:
date: ""
`
}
