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

/** A pull request as the list of GitHub gives it (only what is read). */
export interface ListedPull {
  number: number
  html_url: string
  state: 'open' | 'closed'
  merged_at: string | null
  draft?: boolean
  title: string
  body: string | null
  created_at: string
  head: { ref: string; sha: string }
}

/** A pull request by its number, as far as the review needs it. */
export interface PullInfo {
  number: number
  node_id: string
  html_url: string
  state: 'open' | 'closed'
  merged: boolean
  draft?: boolean
  /** GitHub works this out when asked; null until it has. */
  mergeable: boolean | null
  title: string
  head: { ref: string; sha: string }
  base: { ref: string }
}

/** How the automatic checks of a commit (the validation of the data) stand: none, still running, failed, or all green. */
export type Checks = 'none' | 'pending' | 'failure' | 'success' | 'unknown'

/** A comment as GitHub gives it (an ordinary one on the pull request, or one on a line of a file in it). */
export interface RawComment {
  id: number
  body: string
  created_at: string
  updated_at: string
  user: { login: string; avatar_url: string } | null
  /** Only for a comment on a file. */
  path?: string
  /** Only for the comment of an issue or pull request, as asked for by its number. */
  issue_url?: string
}

/** 100 comments a page; a session is discussed by a few people, so this is far more than needed. */
const MAX_COMMENT_PAGES = 5

/** The compare API shows at most 300 files. */
const MAX_CHANGE_PAGES = 3

export interface ChangedFile {
  filename: string
  status: string
  sha: string
  previous_filename?: string
}

/** 100 files a page; a session holds a few dozen objects, so this is far more than needed. */
const MAX_FILE_PAGES = 10

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

  /** Whether the path exists in the tree of the commit. */
  private async exists(path: string, commit: string): Promise<boolean> {
    try {
      await this.call('GET', `/contents/${path}?ref=${commit}`)
      return true
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false
      throw error
    }
  }

  /**
   * Puts the files into one commit on the branch (created from the base branch if it does not exist) and
   * removes the paths in `removals` that exist there. Returns the commit's hash, or null if there was
   * nothing to change. If someone else moved the branch meanwhile, it is tried once more.
   */
  /** `message` may be made from the paths that were really removed (those that were not there are left out). */
  async save(branch: string, files: RepoFile[], removals: string[], message: string | ((removed: string[]) => string)): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      const head = await this.head(branch)
      let from = head
      if (!from) {
        from = await this.head(this.base)
        if (!from) throw new GitHubError(`The branch ${this.base} does not exist.`, 404)
      }
      const gone: string[] = []
      for (const path of removals) if (await this.exists(path, from)) gone.push(path)
      if (files.length === 0 && gone.length === 0) return null

      const parent = await this.call<{ tree: { sha: string } }>('GET', `/git/commits/${from}`)
      const tree = await this.call<{ sha: string }>('POST', '/git/trees', {
        base_tree: parent.tree.sha,
        tree: [
          ...files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
          ...gone.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
        ],
      })
      // Nothing differs from what is there: no commit (and no branch that would only point at the base).
      if (tree.sha === parent.tree.sha) return null
      if (!head) await this.call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: from })
      const commit = await this.call<{ sha: string }>('POST', '/git/commits', { message: typeof message === 'function' ? message(gone) : message, tree: tree.sha, parents: [from] })
      try {
        await this.call('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha })
        return commit.sha
      } catch (error) {
        const raced = error instanceof GitHubError && (error.status === 422 || error.status === 409)
        if (!raced || attempt >= 1) throw error
      }
    }
  }

  /** The open pull request of the branch, draft or not. */
  async current(branch: string): Promise<Pull | undefined> {
    const open = await this.openPull(branch)
    return open ? Repo.view(open) : undefined
  }

  /** Gives the open pull request of the branch a new title and text. Returns nothing if there is none. */
  async rename(branch: string, title: string, body: string): Promise<Pull | undefined> {
    const open = await this.openPull(branch)
    if (!open) return undefined
    await this.call('PATCH', `/pulls/${open.number}`, { title, body })
    return Repo.view(open)
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

  /** The newest pull requests (open, closed, merged) to the base branch; the caller picks the ones that are sessions. */
  async pulls(): Promise<ListedPull[]> {
    return this.call<ListedPull[]>('GET', `/pulls?state=all&base=${this.base}&sort=created&direction=desc&per_page=100`)
  }

  /** The pull request with this number (any; `sessionPull` is for those that are sessions). */
  async info(number: number): Promise<PullInfo> {
    return this.call<PullInfo>('GET', `/pulls/${number}`)
  }

  /** What the pull request changes: the pull request itself and the files it adds, changes or removes. */
  async pullFiles(number: number): Promise<{ head: string; pull: PullInfo; files: { filename: string; status: string }[] }> {
    const pull = await this.info(number)
    const files: { filename: string; status: string }[] = []
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const batch = await this.call<{ filename: string; status: string }[]>('GET', `/pulls/${number}/files?per_page=100&page=${page}`)
      files.push(...batch)
      if (batch.length < 100) break
    }
    return { head: pull.head.sha, pull, files }
  }

  /** The pull request of a session: only those can be handled here (their branch is erfassung/<login>/<slug>, they go to the base branch). */
  private async sessionPull(number: number): Promise<PullInfo> {
    const info = await this.info(number)
    if (!/^erfassung\/[A-Za-z0-9-]+\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(info.head.ref) || info.base.ref !== this.base) {
      throw new GitHubError('Das ist keine Erfassung.', 404)
    }
    return info
  }

  /** A pull request that waits for review: open and not a draft. Anything else is a 409 with the reason. */
  private async waiting(number: number): Promise<PullInfo> {
    const info = await this.sessionPull(number)
    if (info.state !== 'open') throw new GitHubError('Diese Erfassung ist nicht mehr offen.', 409)
    if (info.draft) throw new GitHubError('Diese Erfassung ist noch ein Entwurf und nicht eingereicht.', 409)
    return info
  }

  /**
   * Accepts a session: its pull request is merged into the base branch as one commit. `head` is the commit the
   * person looked at: if the session changed since, nothing is merged (409).
   */
  async merge(number: number, head?: string): Promise<Pull> {
    await this.waiting(number)
    try {
      await this.call('PUT', `/pulls/${number}/merge`, { merge_method: 'squash', ...(head ? { sha: head } : {}) })
    } catch (error) {
      // 405: not mergeable (checks, conflicts, rules); 409: the head moved.
      if (error instanceof GitHubError && (error.status === 405 || error.status === 409)) throw new GitHubError(error.message, 409)
      throw error
    }
    return this.pull(number)
  }

  /** Closes a session without merging it (it can be opened again on GitHub). */
  async reject(number: number): Promise<Pull> {
    await this.waiting(number)
    await this.call('PATCH', `/pulls/${number}`, { state: 'closed' })
    return this.pull(number)
  }

  /** The comments on a session: those on the pull request itself, and those on files in it (made on GitHub). */
  async comments(number: number): Promise<{ issue: RawComment[]; review: RawComment[] }> {
    const all = async (path: string): Promise<RawComment[]> => {
      const found: RawComment[] = []
      for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
        const batch = await this.call<RawComment[]>('GET', `${path}?per_page=100&page=${page}`)
        found.push(...batch)
        if (batch.length < 100) break
      }
      return found
    }
    await this.sessionPull(number)
    return { issue: await all(`/issues/${number}/comments`), review: await all(`/pulls/${number}/comments`) }
  }

  /** Writes a comment on the pull request of a session (as the person whose token this is). */
  async addComment(number: number, body: string): Promise<RawComment> {
    await this.sessionPull(number)
    return this.call<RawComment>('POST', `/issues/${number}/comments`, { body })
  }

  /** The comment (of the pull request of a session) with this id: it is only handled if it is one on a session. */
  async issueComment(id: number): Promise<RawComment> {
    const comment = await this.call<RawComment>('GET', `/issues/comments/${id}`)
    const number = Number(/\/issues\/(\d+)$/.exec(comment.issue_url ?? '')?.[1])
    if (!Number.isInteger(number)) throw new GitHubError('Das ist kein Kommentar zu einer Erfassung.', 404)
    await this.sessionPull(number)
    return comment
  }

  /** Changes the text of a comment. GitHub allows it for the person who wrote it, and for nobody else without the right to. */
  async editComment(id: number, body: string): Promise<RawComment> {
    await this.issueComment(id)
    return this.call<RawComment>('PATCH', `/issues/comments/${id}`, { body })
  }

  async deleteComment(id: number): Promise<void> {
    await this.issueComment(id)
    await this.call('DELETE', `/issues/comments/${id}`)
  }

  /** How the checks of a commit stand. Unknown if GitHub does not tell (the app may lack the permission to read checks). */
  async checks(commit: string): Promise<Checks> {
    try {
      const runs = await this.call<{ check_runs: { status: string; conclusion: string | null }[] }>('GET', `/commits/${commit}/check-runs?per_page=100`)
      const status = await this.call<{ state: string; total_count: number }>('GET', `/commits/${commit}/status`)
      const states: Checks[] = runs.check_runs.map((run) =>
        run.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(run.conclusion ?? '') ? 'success' : 'failure',
      )
      if (status.total_count > 0) states.push(status.state === 'success' ? 'success' : status.state === 'pending' ? 'pending' : 'failure')
      if (states.length === 0) return 'none'
      return states.includes('failure') ? 'failure' : states.includes('pending') ? 'pending' : 'success'
    } catch (error) {
      if (error instanceof GitHubError && error.status !== 401) return 'unknown'
      throw error
    }
  }

  /** The newest commit of the base branch and everything in it, with the hash of each file (the caller picks the object files). */
  async tree(): Promise<{ head: string; files: { path: string; sha: string }[] }> {
    const head = await this.head(this.base)
    if (!head) throw new GitHubError(`The branch ${this.base} does not exist.`, 404)
    const commit = await this.call<{ tree: { sha: string } }>('GET', `/git/commits/${head}`)
    const tree = await this.call<{ tree: { path: string; type: string; sha: string }[]; truncated?: boolean }>('GET', `/git/trees/${commit.tree.sha}?recursive=1`)
    if (tree.truncated) throw new GitHubError('The repository is too large to be listed at once.', 502)
    return { head, files: tree.tree.filter((entry) => entry.type === 'blob').map((entry) => ({ path: entry.path, sha: entry.sha })) }
  }

  /**
   * What changed on the base branch since a commit: its newest commit and the files that differ. Returns null if
   * that cannot be told (the commit is not known, the branch was rewritten, or there are too many changes): then
   * the caller has to read everything again.
   */
  async changes(since: string): Promise<{ head: string; files: ChangedFile[] } | null> {
    const head = await this.head(this.base)
    if (!head) throw new GitHubError(`The branch ${this.base} does not exist.`, 404)
    if (head === since) return { head, files: [] }
    const files: ChangedFile[] = []
    for (let page = 1; page <= MAX_CHANGE_PAGES; page++) {
      let data: { status: string; files?: ChangedFile[] }
      try {
        data = await this.call('GET', `/compare/${since}...${head}?per_page=100&page=${page}`)
      } catch (error) {
        if (error instanceof GitHubError && (error.status === 404 || error.status === 422)) return null
        throw error
      }
      // "behind" or "diverged": the branch no longer continues from that commit.
      if (data.status !== 'ahead' && data.status !== 'identical') return null
      const batch = data.files ?? []
      files.push(...batch)
      if (batch.length < 100) return { head, files }
    }
    return null // GitHub lists at most 300 files: more than that is read anew
  }

  async pull(number: number): Promise<Pull> {
    const data = await this.call<{ number: number; html_url: string; state: 'open' | 'closed'; merged: boolean; draft?: boolean }>('GET', `/pulls/${number}`)
    return { number: data.number, url: data.html_url, state: data.state, merged: data.merged, draft: data.draft === true }
  }
}
