/** One problem found in an object, with the place where it was found. */
export interface Issue {
  /** JSON pointer into the object, e.g. "/files/0/path". "/" is the object itself. */
  path: string
  message: string
}
