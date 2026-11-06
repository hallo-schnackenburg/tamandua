/** Text of a new object. The id is a ULID; it is created once and never changes. */
export function newObjectText(id: string, type: 'photo' | 'document', subtype?: string): string {
  return `id: ${id}
type: ${type}
${subtype ? `subtype: ${subtype}\n` : ''}title:
`
}
