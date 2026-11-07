import { describe, expect, it } from 'vitest'
import { objectUrl, presign, regionOf, type S3Config } from '../src/s3.js'

// The worked example from AWS's documentation ("Authenticating requests: using query parameters").
const aws: S3Config = {
  endpoint: 'https://s3.amazonaws.com',
  bucket: 'examplebucket',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
}

describe('presign', () => {
  it('reproduces the signature from the AWS documentation', async () => {
    const url = await presign(aws, { method: 'GET', key: 'test.txt', expires: 86400, now: new Date('2013-05-24T00:00:00Z') })
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
    expect(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?')).toBe(true)
  })

  it('signs extra headers and lists them', async () => {
    const hetzner: S3Config = { ...aws, endpoint: 'https://nbg1.your-objectstorage.com', region: undefined }
    const now = new Date('2026-11-07T20:00:00Z')
    const plain = await presign(hetzner, { method: 'PUT', key: 'files/ab/cd/x', expires: 600, now })
    const typed = await presign(hetzner, { method: 'PUT', key: 'files/ab/cd/x', expires: 600, now, headers: { 'Content-Type': 'image/tiff' } })
    expect(plain).toContain('X-Amz-SignedHeaders=host&')
    expect(typed).toContain('X-Amz-SignedHeaders=content-type%3Bhost&')
    expect(typed).not.toBe(plain)
    expect(plain).toContain('/nbg1/s3/aws4_request'.replace(/\//g, '%2F'))
  })

  it('encodes odd characters in keys and rejects bad lifetimes', async () => {
    expect(objectUrl(aws, 'a b/c(1).txt').pathname).toBe('/a%20b/c%281%29.txt')
    await expect(presign(aws, { method: 'GET', key: 'x', expires: 0 })).rejects.toThrow()
    await expect(presign(aws, { method: 'GET', key: 'x', expires: 700000 })).rejects.toThrow()
  })

  it('takes the region from the endpoint host', () => {
    expect(regionOf({ ...aws, endpoint: 'https://nbg1.your-objectstorage.com', region: undefined })).toBe('nbg1')
  })
})

describe('presign with a sub-resource', () => {
  it('puts the sub-resource into the signed query, sorted', async () => {
    const url = await presign(aws, { method: 'PUT', key: '', expires: 60, query: { cors: '' }, now: new Date('2026-11-07T20:00:00Z') })
    expect(url).toContain('X-Amz-SignedHeaders=host&cors=&X-Amz-Signature=')
  })
})
