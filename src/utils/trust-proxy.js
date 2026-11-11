import net from 'node:net'

// Express "trust proxy" values accepted from TRUST_PROXY:
//   unset or "false"         -> false (req.ip is the socket address, X-Forwarded-For is ignored)
//   "1", "2"                 -> number of proxy hops in front of the app
//   "loopback,172.16.0.0/12" -> addresses whose X-Forwarded-For is believed (names, IPs or CIDRs)
// "true" is rejected on purpose: it would trust any client-supplied X-Forwarded-For.
const namedRanges = new Set(['loopback', 'linklocal', 'uniquelocal'])
const maxHops = 10

function invalid(raw, reason) {
   return new Error(`Invalid TRUST_PROXY value "${raw}": ${reason}`)
}

function isAddressOrCidr(entry) {
   const [address, prefix, extra] = entry.split('/')
   const family = net.isIP(address)
   if (!family || extra !== undefined) return false
   if (prefix === undefined) return true
   if (!/^\d{1,3}$/.test(prefix)) return false
   return Number(prefix) <= (family === 4 ? 32 : 128)
}

function parseTrustProxy(raw) {
   if (raw === undefined || raw === null) return false
   const value = String(raw).trim()
   if (value === '' || value.toLowerCase() === 'false') return false
   if (value.toLowerCase() === 'true') {
      throw invalid(raw, 'trusting every hop lets clients spoof their IP; use a hop count or a list of proxy addresses')
   }
   if (/^\d+$/.test(value)) {
      const hops = Number(value)
      if (hops < 1 || hops > maxHops) throw invalid(raw, `hop count must be between 1 and ${maxHops}`)
      return hops
   }

   const entries = value.split(',').map((entry) => entry.trim())
   if (entries.some((entry) => entry === '')) throw invalid(raw, 'empty list entry')
   for (const entry of entries) {
      if (!namedRanges.has(entry) && !isAddressOrCidr(entry)) {
         throw invalid(raw, `"${entry}" is not loopback, linklocal, uniquelocal, an IP address or a CIDR range`)
      }
   }
   return entries
}

export { parseTrustProxy }
