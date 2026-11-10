import type { ObjectType } from '@tamandua/core'

/** Text of a new object. The id is a ULID; it is created once and never changes. */
export function newObjectText(id: string, type?: ObjectType, subtype?: string): string {
  return `id: ${id}
type:${type ? ` ${type}` : ''}
${subtype ? `subtype: ${subtype}\n` : ''}title:
`
}

/** Text of a new, empty object (the "+"): only the id; type and title are what the person or the chat fills in next. */
export function newEmptyText(id: string): string {
  return `id: ${id}
type:
title:
`
}
