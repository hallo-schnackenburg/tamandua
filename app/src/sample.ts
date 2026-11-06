// Start text of the editor until drafts are stored. The files entry points to a
// made-up hash; it only shows how a finished object looks.

const hash = 'a'.repeat(64)

export const sample = `id: 01JC8Z3Q7M5K2V9X4T6R1B0N8D
type: photo
title: Schützenumzug am Marktplatz
date: "1963-07"
location: Schnackenburg, Marktplatz
people:
  - Heinrich Meyer
files:
  - role: main
    path: files/aa/aa/${hash}/original.tif
    sha256: ${hash}
    mime: image/tiff
    bytes: 18204331
`
