import CommonCrypto
import ExpoModulesCore
import Foundation

public final class LeveragePasswordKdfModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LeveragePasswordKdf")

    AsyncFunction("pbkdf2Sha256") { (password: String, saltHex: String, iterations: Int, outputBytes: Int) throws -> String in
      guard !password.isEmpty && password.count <= 1024 else {
        throw NSError(domain: "LeveragePasswordKdf", code: 1, userInfo: [NSLocalizedDescriptionKey: "Password length is invalid."])
      }
      guard saltHex.range(of: "^[0-9a-fA-F]{32}$", options: .regularExpression) != nil else {
        throw NSError(domain: "LeveragePasswordKdf", code: 2, userInfo: [NSLocalizedDescriptionKey: "Password salt is invalid."])
      }
      guard (600_000...2_000_000).contains(iterations) else {
        throw NSError(domain: "LeveragePasswordKdf", code: 3, userInfo: [NSLocalizedDescriptionKey: "Password hash work factor is invalid."])
      }
      guard outputBytes == 32 else {
        throw NSError(domain: "LeveragePasswordKdf", code: 4, userInfo: [NSLocalizedDescriptionKey: "Password hash output size is invalid."])
      }

      var salt = stride(from: 0, to: saltHex.count, by: 2).map { index -> UInt8 in
        let start = saltHex.index(saltHex.startIndex, offsetBy: index)
        let end = saltHex.index(start, offsetBy: 2)
        return UInt8(saltHex[start..<end], radix: 16) ?? 0
      }
      let passwordBytes = Array(password.utf8)
      var derived = [UInt8](repeating: 0, count: outputBytes)
      let status = passwordBytes.withUnsafeBytes { passwordBuffer in
        salt.withUnsafeBytes { saltBuffer in
          derived.withUnsafeMutableBytes { derivedBuffer in
            CCKeyDerivationPBKDF(
              CCPBKDFAlgorithm(kCCPBKDF2),
              passwordBuffer.baseAddress?.assumingMemoryBound(to: Int8.self),
              passwordBytes.count,
              saltBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self),
              salt.count,
              CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
              UInt32(iterations),
              derivedBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self),
              outputBytes
            )
          }
        }
      }
      salt.withUnsafeMutableBufferPointer { buffer in
        for index in buffer.indices { buffer[index] = 0 }
      }
      guard status == kCCSuccess else {
        derived.withUnsafeMutableBufferPointer { buffer in
          for index in buffer.indices { buffer[index] = 0 }
        }
        throw NSError(domain: "LeveragePasswordKdf", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Native password derivation failed."])
      }
      let result = derived.map { String(format: "%02x", $0) }.joined()
      derived.withUnsafeMutableBufferPointer { buffer in
        for index in buffer.indices { buffer[index] = 0 }
      }
      return result
    }
  }
}
