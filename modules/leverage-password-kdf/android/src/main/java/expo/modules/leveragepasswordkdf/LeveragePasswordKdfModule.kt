package expo.modules.leveragepasswordkdf

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

class LeveragePasswordKdfModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LeveragePasswordKdf")

    AsyncFunction("pbkdf2Sha256") { password: String, saltHex: String, iterations: Int, outputBytes: Int ->
      require(password.isNotEmpty() && password.length <= 1024) { "Password length is invalid." }
      require(saltHex.matches(Regex("^[0-9a-fA-F]{32}$"))) { "Password salt is invalid." }
      require(iterations in 600_000..2_000_000) { "Password hash work factor is invalid." }
      require(outputBytes == 32) { "Password hash output size is invalid." }

      val salt = ByteArray(16) { index -> saltHex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
      val passwordChars = password.toCharArray()
      val spec = PBEKeySpec(passwordChars, salt, iterations, outputBytes * 8)
      try {
        val derived = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        try {
          derived.joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
        } finally {
          derived.fill(0)
        }
      } finally {
        spec.clearPassword()
        passwordChars.fill('\u0000')
        salt.fill(0)
      }
    }
  }
}
