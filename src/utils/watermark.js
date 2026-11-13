// Short label drawn over the player so a recorded screen can be traced to an account.
// Only a first name and a masked phone are shown: "Ali +992 *** 45".

const countryCodes = ['992', '998', '996', '994', '995', '993', '7', '1']

function maskPhone(phone) {
   if (typeof phone !== 'string' || !/^\+\d{8,15}$/.test(phone)) return null
   const digits = phone.slice(1)
   const country = countryCodes.find((code) => digits.startsWith(code)) || digits.slice(0, 3)
   return `+${country} *** ${digits.slice(-2)}`
}

function watermarkLabel(identity, userId) {
   const name = typeof identity?.first_name === 'string'
      ? identity.first_name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 40)
      : ''
   const phone = maskPhone(identity?.phone_e164)
   const label = [name, phone].filter(Boolean).join(' ')
   return label || `ID ${userId}`
}

export { maskPhone, watermarkLabel }
