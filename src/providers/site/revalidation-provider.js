import env from '../../configs/env.js'

// Frontend revalidation webhook: POST {SITE_REVALIDATE_URL} ({MARKETING_ORIGIN}/api/revalidate)
// with JSON { tags } and the header x-revalidate-secret: {SITE_REVALIDATE_SECRET}.
// Not configured (URL or secret missing): { skipped: true } without a request.
// Never throws; the result tells the job handler whether to retry.
function createSiteRevalidationProvider(config = env.siteRevalidate, fetchImpl = globalThis.fetch) {
   return {
      async revalidate({ tags }) {
         if (!config?.url || !config?.secret) return { skipped: true }
         try {
            const response = await fetchImpl(config.url, {
               method: 'POST',
               headers: {
                  'content-type': 'application/json',
                  'x-revalidate-secret': config.secret,
               },
               body: JSON.stringify({ tags }),
               // A redirect (for example the apex still sending visitors to the app) is a failure: following
               // it would turn the POST into a GET and pass the secret header to another host.
               redirect: 'manual',
               signal: AbortSignal.timeout(config.timeoutMs || 3000),
            })
            if (!response.ok) return { ok: false, status: response.status }
            return { ok: true, status: response.status }
         } catch (error) {
            return { ok: false, error: error.name }
         }
      },
   }
}

const siteRevalidationProvider = createSiteRevalidationProvider()

export { createSiteRevalidationProvider, siteRevalidationProvider }
