import type { UploadTarget } from '@sssb/kit/ports/storage'

/**
 * Send `file` to an upload target the server minted, in whichever form it has (`UploadTarget`). A POST is
 * `multipart/form-data`: every field first, then the file as the last `file` part. A PUT is the file itself as the
 * body, with exactly the headers the target names (the browser adds `Content-Length` from the body, which is the
 * size the target was minted for). Resolves to the store's response; the caller checks `ok`.
 */
export function sendToUploadTarget(target: UploadTarget, file: File): Promise<Response> {
    if (target.method === 'PUT') {
        return fetch(target.url, { method: 'PUT', headers: target.headers, body: file })
    }
    const form = new FormData()
    for (const [name, value] of Object.entries(target.fields)) form.append(name, value)
    form.append('file', file)
    return fetch(target.url, { method: 'POST', body: form })
}
