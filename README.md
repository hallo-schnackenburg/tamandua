# Tamandua

Tamandua (an anteater eating it all) is a prototype of a browser tool for
volunteers to capture archive objects (photos, letters, brochures, protocols)
without knowing YAML.

Drop scans, describe them in a chat, and an AI agent fills in the metadata. The
result is one validated YAML file per object, meant for a public data
repository, with the files in an S3-compatible store.

Files and objects are independent: files are hashed and uploaded as soon as
they are dropped, and an object (an image, or a document with pages) groups
them and describes them.

## Layout

- `core`: object schema, validation, comment-preserving YAML edits
- `app`: Svelte front end (files, chat, objects with an editor)
- `worker`: Cloudflare Worker that turns chat messages into edits using Claude
- `archive.yaml`: the object types, subtypes and entity types; edit it, then
  run `npm run generate`

## Develop

```
npm install
npm run dev            # app
npm run dev:worker     # worker, needs worker/.dev.vars (Anthropic key, S3 bucket)
npm test
```

Without `VITE_WORKER_URL` in `app/.env.local` the app uses a simple fake agent.

## Status

Early prototype. Upload, GitHub sync and Worker auth are not built yet. Notes
are in `doc/`.
