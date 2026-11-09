// Pages Function: everything under /api goes to the Worker.
//
// The app and the Worker must share one address, so that the session cookie is an ordinary
// same-origin cookie (locally, Vite's proxy does the same). A Pages project cannot proxy to another
// host from a _redirects file, but a Function can call a Worker through a service binding.
// The binding is declared in wrangler.<environment>.toml; the Worker needs no public address.
//
// The request is passed on unchanged, so the Worker sees the public https address (it sets
// `Secure` cookies from that), and its response, with Set-Cookie headers and redirects,
// goes back to the browser untouched.

interface Env {
  WORKER: { fetch(request: Request): Promise<Response> }
}

export const onRequest = ({ request, env }: { request: Request; env: Env }): Promise<Response> =>
  env.WORKER.fetch(request)
