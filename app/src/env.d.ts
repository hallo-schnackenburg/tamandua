/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the Worker runs. Without it the stand-in agent is used. */
  readonly VITE_WORKER_URL?: string
}
