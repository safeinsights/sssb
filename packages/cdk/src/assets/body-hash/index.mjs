// @ts-check
// SssbApp's Lambda@Edge function, on the origin request of the distribution's default behavior (the server's
// Function URL). The Function URL is reached only through CloudFront's origin access control, which signs each
// request with SigV4, and Lambda takes no unsigned payload there: a request with a body must carry its SHA-256 in
// `x-amz-content-sha256`. CloudFront does not compute it, so without this function every POST, PUT and PATCH would
// be refused with 403. Here the hash is computed from the body CloudFront hands over and will forward unchanged
// (the body is read-only to this function), and CloudFront then signs the request, the header included.
//
// No dependency, no environment (Lambda@Edge has none) and no network: Node's own `crypto`, on the event alone.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

/** The header Lambda checks the body against, in the lowercase form CloudFront's event keys headers by. */
const HASH_HEADER = 'x-amz-content-sha256'

/**
 * @typedef {{ inputTruncated?: boolean, encoding?: string, data?: string }} EdgeBody
 * @typedef {Record<string, { key?: string, value: string }[]>} EdgeHeaders
 * @typedef {{ method?: string, headers: EdgeHeaders, body?: EdgeBody }} EdgeRequest
 * @typedef {{ Records: { cf: { request: EdgeRequest } }[] }} EdgeEvent
 */

/**
 * The request with its body's hash set, whatever the viewer sent in that header; or a 413 when CloudFront could
 * hand over only part of the body (over 1 MB on an origin request), whose hash would not match what Lambda receives.
 * @param {EdgeEvent} event
 */
export const handler = async (event) => {
    const record = event.Records[0]
    if (record === undefined) throw new Error('body-hash: an origin-request event carries one record')
    const request = record.cf.request
    const body = request.body
    if (body?.inputTruncated === true) {
        return {
            status: '413',
            statusDescription: 'Payload Too Large',
            headers: { 'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }] },
            body: 'The request body is over the 1 MB this deployment accepts.',
        }
    }
    const data = body?.data ?? ''
    const bytes = Buffer.from(data, body?.encoding === 'text' ? 'utf8' : 'base64')
    request.headers[HASH_HEADER] = [{ key: HASH_HEADER, value: createHash('sha256').update(bytes).digest('hex') }]
    return request
}
