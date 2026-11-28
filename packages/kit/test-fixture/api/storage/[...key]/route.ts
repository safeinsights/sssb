import { isSimulated, storage } from '../../stand-ins'

/**
 * FIXTURE ROUTE — SCANNED, NEVER SERVED. See ../../dockets/route.ts for what this tree is.
 *
 * THIS FILE backs the `storage/[...key]/route.ts` EXACT exemption: the simulated-mode local twin of an S3 signed
 * download URL, the read half of ../../storage-upload/route.ts. Real mode serves stored objects through signed URLs
 * that an authorized route minted, so the route is 404 there, and its exemption carries the `if (!isSimulated)`
 * `mustMatch` gate. It reads an object (a stand-in), so it passes by that gate, not because it reads nothing.
 */
export async function GET(): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const object = await storage.get('fixture/key')
    return object ? new Response(null, { status: 200 }) : new Response(null, { status: 404 })
}
