// Generated from archive.yaml by `npm run generate` in core. Do not edit.

export const OBJECT_TYPES = {
  image: ['photo', 'drawing', 'print', 'plan'],
  document: ['letter', 'note', 'protocol', 'brochure'],
} as const

export type ObjectType = keyof typeof OBJECT_TYPES

export const ENTITY_TYPES = ['person', 'place', 'building', 'business', 'event', 'thing'] as const
