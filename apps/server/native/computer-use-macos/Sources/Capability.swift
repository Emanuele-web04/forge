// Capability and permission probe.
//
// Two consumers: the one-shot `--probe` (read by the build and the settings
// checklist) and the live `capabilities` RPC the backend reads to seed
// `health.captureAvailable` and to decide availability. Both report the same
// facts — arch, macOS version, which TCC grants are present, and how this build
// is signed.
//
// The grants themselves belong to the *app*, not to this bundle: macOS
// attributes a TCC check to the responsible process, which for a helper spawned
// inside `Synara.app` is Synara. (Run this binary straight from Terminal and it
// reports Terminal's grants.) Asking from in here is still the right place —
// this is the process that will actually call the APIs — but the identity the
// user sees in Privacy & Security is the app's.

import ApplicationServices
import CoreGraphics
import Foundation
import Security

enum Capability {
  /** Ask macOS on an explicit user action; TCC remains the authority. */
  static func requestPermissions() -> [String: Any] {
    if !CGPreflightScreenCaptureAccess() {
      _ = CGRequestScreenCaptureAccess()
    }
    if !AXIsProcessTrusted() {
      let options = [
        kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
      ] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(options)
    }
    return report()
  }

  static func report() -> [String: Any] {
    let version = ProcessInfo.processInfo.operatingSystemVersion
    return [
      "arch": machineArch(),
      "macosVersion": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
      // CGPreflight does not prompt; it reports the current grant. A missing
      // grant is reported, never demanded, so the backend can surface a card.
      "screenRecording": CGPreflightScreenCaptureAccess(),
      "accessibility": AXIsProcessTrusted(),
      // Which private WindowServer entry points resolved on this OS: the
      // background focus prelude and window-local stamping depend on them.
      "skylight": SkyLight.report(),
      "signature": processSignature,
      "protocolVersion": 1,
    ]
  }

  /**
   * "adhoc" when this build carries only an ad-hoc signature, "signed" otherwise.
   *
   * TCC pins an ad-hoc grant to the binary's cdhash, so every local rebuild
   * silently invalidates it while System Settings goes on showing Synara switched
   * on — the state a user cannot diagnose from the outside. A Developer ID
   * signature keys on identifier and team and survives rebuilds. Anything that
   * cannot be read reports "signed": telling a release user to reset their TCC
   * database is worse than saying nothing.
   */
  private static let processSignature = signature()

  private static func signature() -> String {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return "signed" }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
      return "signed"
    }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, [], &information) == errSecSuccess,
      let flags = (information as? [String: Any])?[kSecCodeInfoFlags as String] as? UInt32
    else { return "signed" }
    return SecCodeSignatureFlags(rawValue: flags).contains(.adhoc) ? "adhoc" : "signed"
  }

  private static func machineArch() -> String {
    var info = utsname()
    uname(&info)
    let machine = withUnsafePointer(to: &info.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
    }
    return machine
  }
}
