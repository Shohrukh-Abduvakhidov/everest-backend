class DisabledSmsProvider {
   isAvailable() {
      return false
   }

   async sendRecoveryCode() {
      return { delivered: false }
   }
}

export { DisabledSmsProvider }
