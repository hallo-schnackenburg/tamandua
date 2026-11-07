// What the Worker asks of GitHub: sign a person in, find out what they may do in the data repository,
// save objects to a branch, open a pull request. Everything runs with the person's own token (a GitHub
// App user access token), so commits and pull requests are theirs and GitHub's own rules (branch
// protection, who is a collaborator) apply.

export interface GithubEnv {
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /** owner/name of the data repository. */
  DATA_REPO?: string
  /** The branch pull requests go to. */
  BASE_BRANCH?: string
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export interface Tokens {
  access: string
  accessExpires: number
  refresh?: string
  refreshExpires?: number
}

export interface GitHubUser {
  login: string
  name: string
  avatar: string
}

const API = 'https://api.github.com'
const USER_AGENT = 'tamandua'
const TEN_YEARS = 10 * 365 * 24 * 3600 * 1000

async function tokenRequest(env: GithubEnv, params: Record<string, string>, fetchFn: typeof fetch): Promise<Tokens> {
  const response = await fetchFn('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok || typeof data.access_token !== 'string') {
    // GitHub answers 200 with an "error" field for a bad code or token.
    throw new GitHubError(String(data.error_description ?? data.error ?? `GitHub answered ${response.status}`), response.ok ? 401 : response.status)
  }
  const now = Date.now()
  return {
    access: data.access_token,
    accessExpires: now + (typeof data.expires_in === 'number' ? data.expires_in * 1000 : TEN_YEARS),
    refresh: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    refreshExpires: typeof data.refresh_token_expires_in === 'number' ? now + data.refresh_token_expires_in * 1000 : undefined,
  }
}

export const exchangeCode = (env: GithubEnv, code: string, verifier: string, redirectUri: string, fetchFn: typeof fetch) =>
  tokenRequest(env, { code, code_verifier: verifier, redirect_uri: redirectUri }, fetchFn)

/** A refresh token can be used once; the answer holds the next one. */
export const refreshTokens = (env: GithubEnv, refresh: string, fetchFn: typeof fetch) =>
  tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refresh }, fetchFn)

/** Takes the token back at GitHub when someone signs out (best effort). */
export async function revoke(env: GithubEnv, token: string, fetchFn: typeof fetch): Promise<void> {
  try {
    await fetchFn(`${API}/applications/${env.GITHUB_CLIENT_ID}/token`, {
      method: 'DELETE',
      headers: {
        authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({ access_token: token }),
    })
  } catch {
    // The cookie is gone either way.
  }
}

async function call<T>(fetchFn: typeof fetch, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetchFn(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string }
    throw new GitHubError(detail.message ?? `GitHub answered ${response.status}`, response.status)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

export async function currentUser(token: string, fetchFn: typeof fetch): Promise<GitHubUser> {
  const user = await call<{ login: string; name: string | null; avatar_url: string }>(fetchFn, token, 'GET', '/user')
  return { login: user.login, name: user.name || user.login, avatar: user.avatar_url }
}

/** What the person may do in the data repository: `admin` (maintain/admin), `write`, or `none`. */
export async function repoRole(token: string, repo: string, fetchFn: typeof fetch): Promise<'admin' | 'write' | 'none'> {
  const data = await call<{ permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } }>(fetchFn, token, 'GET', `/repos/${repo}`)
  if (data.permissions?.admin || data.permissions?.maintain) return 'admin'
  return data.permissions?.push ? 'write' : 'none'
}

export interface RepoFile {
  path: string
  content: string
}

export interface Pull {
  number: number
  url: string
  state: 'open' | 'closed'
  merged: boolean
  /** A draft cannot be merged and does not ask anybody to review it. */
  draft: boolean
}

interface OpenPull {
  number: number
  html_url: string
  node_id: string
  draft?: boolean
}

/** One person's work on the data repository: their own branch and its pull request. */
export class Repo {
  constructor(
    private token: string,
    private repo: string,
    private base: string,
    private fetchFn: typeof fetch,
  ) {}

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return call<T>(this.fetchFn, this.token, method, `/repos/${this.repo}${path}`, body)
  }

  /** The commit a branch points to, or null if there is no such branch. */
  private async head(branch: string): Promise<string | null> {
    try {
      return (await this.call<{ object: { sha: string } }>('GET', `/git/ref/heads/${branch}`)).object.sha
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null
      throw error
    }
  }

  /**
   * Puts the files into one commit on the branch (created from the base branch if it does not exist).
   * Returns the commit's hash. If someone else moved the branch meanwhile, it is tried once more.
   */
  async save(branch: string, files: RepoFile[], message: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      let head = await this.head(branch)
      if (!head) {
        const base = await this.head(this.base)
        if (!base) throw new GitHubError(`The branch ${this.base} does not exist.`, 404)
        await this.call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: base })
        head = base
      }
      const parent = await this.call<{ tree: { sha: string } }>('GET', `/git/commits/${head}`)
      const tree = await this.call<{ sha: string }>('POST', '/git/trees', {
        base_tree: parent.tree.sha,
        tree: files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
      })
      const commit = await this.call<{ sha: string }>('POST', '/git/commits', { message, tree: tree.sha, parents: [head] })
      try {
        await this.call('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha })
        return commit.sha
      } catch (error) {
        const raced = error instanceof GitHubError && (error.status === 422 || error.status === 409)
        if (!raced || attempt >= 1) throw error
      }
    }
  }

  private async openPull(branch: string): Promise<OpenPull | undefined> {
    const owner = this.repo.split('/')[0]
    const open = await this.call<OpenPull[]>('GET', `/pulls?state=open&base=${this.base}&head=${owner}:${branch}`)
    return open[0]
  }

  private static view(pull: OpenPull): Pull {
    return { number: pull.number, url: pull.html_url, state: 'open', merged: false, draft: pull.draft === true }
  }

  /**
   * The open pull request of the branch; if there is none, a new one as a draft. Returns nothing if
   * GitHub does not want one (e.g. the branch has no commit that is not in the base branch yet).
   */
  async draft(branch: string, title: string, body: string): Promise<Pull | undefined> {
    const existing = await this.openPull(branch)
    if (existing) return Repo.view(existing)
    try {
      const created = await this.call<OpenPull>('POST', '/pulls', { title, head: branch, base: this.base, body, draft: true })
      return Repo.view({ ...created, draft: true })
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) return undefined
      throw error
    }
  }

  /**
   * Asks for a review: the draft of the branch is marked ready. If the branch has no pull request yet,
   * a new one is opened (not as a draft). Throws a 409 if there is nothing to submit.
   */
  async submit(branch: string, title: string, body: string): Promise<Pull> {
    const existing = await this.openPull(branch)
    if (existing?.draft) {
      const answer = await call<{ errors?: { message: string }[] }>(this.fetchFn, this.token, 'POST', '/graphql', {
        query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number } } }',
        variables: { id: existing.node_id },
      })
      if (answer.errors?.length) throw new GitHubError(answer.errors[0].message, 502)
      return Repo.view({ ...existing, draft: false })
    }
    if (existing) return Repo.view(existing)
    try {
      const created = await this.call<OpenPull>('POST', '/pulls', { title, head: branch, base: this.base, body })
      return Repo.view({ ...created, draft: false })
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) throw new GitHubError('There is nothing new to submit.', 409)
      throw error
    }
  }

  async pull(number: number): Promise<Pull> {
    const data = await this.call<{ number: number; html_url: string; state: 'open' | 'closed'; merged: boolean; draft?: boolean }>('GET', `/pulls/${number}`)
    return { number: data.number, url: data.html_url, state: data.state, merged: data.merged, draft: data.draft === true }
  }
}
