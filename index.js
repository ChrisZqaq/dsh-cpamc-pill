/**
 * Host half of the CPA capsule.
 *
 * Registers one same-origin route the browser half reads. The admin key never
 * crosses into the bundle: this process resolves it from disk and attaches it
 * to the outbound CPAMP request.
 */

import { createStatusReader } from './host/cpamc.js'
import { resolveAdminKey } from './host/credentials.js'

export const name = 'dsh-cpamc-pill'
export const inject = ['webServer']

/** Route the client half reads; served from the same origin as the UI. */
const ROUTE = '/dsh-cpamc-pill/status'

export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    const readStatus = createStatusReader({ resolveAdminKey })

    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.statusCode = 405
            response.end()
            return
          }
          try {
            const payload = await readStatus()
            const body = JSON.stringify(payload)
            response.statusCode = 200
            response.setHeader('content-type', 'application/json; charset=utf-8')
            response.setHeader('cache-control', 'no-store')
            response.end(request.method === 'HEAD' ? undefined : body)
          } catch (error) {
            response.statusCode = 500
            response.setHeader('content-type', 'application/json; charset=utf-8')
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        },
      }),
    )
  })
}
