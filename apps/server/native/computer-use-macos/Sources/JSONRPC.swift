// JSON-RPC 2.0 plumbing for synara-computer-helper.
//
// Newline-delimited JSON on stdio: one object per line, requests on stdin,
// responses and notifications on stdout. Diagnostics go to stderr and never mix
// into the protocol stream. This mirrors the device helper's transport exactly,
// which is the same wire `@synara/shared/jsonrpc-stdio` speaks on the Node side.

import Foundation
import CoreGraphics

/// JSON-RPC error codes: the standard range plus helper-specific ones.
enum RPCErrorCode: Int {
  case parseError = -32700
  case invalidRequest = -32600
  case methodNotFound = -32601
  case invalidParams = -32602
  case internalError = -32603
  /// A permission the action needed (Accessibility, Screen Recording) is not
  /// granted. Reported so the backend can surface an actionable card instead of
  /// treating an un-injected action as applied.
  case permissionDenied = -32000
  /// The requested target (window, node) does not exist right now.
  case targetMissing = -32001
  /// Input this process accepted but could not deliver to the target.
  case notDelivered = -32002
  case inactiveSpace = -32015
  case targetChanged = -32016
}

struct RPCError: Error {
  let code: RPCErrorCode
  let message: String

  init(_ code: RPCErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }
}

/// stdout carries only JSON-RPC; diagnostics go to stderr so a chatty log can
/// never corrupt the protocol stream.
private let stdoutHandle = FileHandle.standardOutput
private let stdoutLock = NSLock()

func logDiagnostic(_ message: String) {
  FileHandle.standardError.write(Data("[computer-helper] \(message)\n".utf8))
}

func writeMessage(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  else { return }
  stdoutLock.lock()
  defer { stdoutLock.unlock() }
  var line = data
  line.append(0x0a)
  try? stdoutHandle.write(contentsOf: line)
}

func writeResult(id: Any?, result: Any) {
  guard let id else { return }  // A notification expects no reply.
  writeMessage(["jsonrpc": "2.0", "id": id, "result": result])
}

func writeError(id: Any?, code: RPCErrorCode, message: String) {
  guard let id else {
    logDiagnostic("error with no request id: \(message)")
    return
  }
  writeMessage([
    "jsonrpc": "2.0", "id": id,
    "error": ["code": code.rawValue, "message": message],
  ])
}

func writeNotification(method: String, params: [String: Any]) {
  writeMessage(["jsonrpc": "2.0", "method": method, "params": params])
}

// MARK: - Parameter helpers

struct Params {
  let raw: [String: Any]

  func double(_ key: String) throws -> Double {
    guard let value = raw[key] as? NSNumber else {
      throw RPCError(.invalidParams, "missing or non-numeric parameter '\(key)'")
    }
    return value.doubleValue
  }

  func optionalDouble(_ key: String) -> Double? {
    (raw[key] as? NSNumber)?.doubleValue
  }

  func int(_ key: String) throws -> Int {
    guard let value = raw[key] as? NSNumber else {
      throw RPCError(.invalidParams, "missing or non-numeric parameter '\(key)'")
    }
    return value.intValue
  }

  func optionalInt(_ key: String, default fallback: Int) -> Int {
    (raw[key] as? NSNumber)?.intValue ?? fallback
  }

  /// A required string parameter that must carry content — a method name, a
  /// window id, a key name. Use `text` for agent-supplied text, where the empty
  /// string is a legitimate value.
  func string(_ key: String) throws -> String {
    guard let value = raw[key] as? String, !value.isEmpty else {
      throw RPCError(.invalidParams, "missing or empty parameter '\(key)'")
    }
    return value
  }

  /// A required string parameter that may legitimately be empty.
  ///
  /// Clearing a text field is `set-value` with `""`, and emptying the clipboard
  /// is `write-clipboard` with `""`; the contract allows both. Conflating
  /// "missing" with "empty" rejected them — and `write-clipboard` had already
  /// cleared the pasteboard by the time the throw happened, so the operation
  /// destroyed the clipboard and then reported failure.
  func text(_ key: String) throws -> String {
    guard let value = raw[key] as? String else {
      throw RPCError(.invalidParams, "missing parameter '\(key)'")
    }
    return value
  }

  func optionalString(_ key: String) -> String? {
    raw[key] as? String
  }

  func stringArray(_ key: String) -> [String] {
    (raw[key] as? [Any])?.compactMap { $0 as? String } ?? []
  }

  func rect(_ key: String) -> CGRect? {
    guard let record = raw[key] as? [String: Any],
      let x = (record["x"] as? NSNumber)?.doubleValue,
      let y = (record["y"] as? NSNumber)?.doubleValue,
      let width = (record["width"] as? NSNumber)?.doubleValue,
      let height = (record["height"] as? NSNumber)?.doubleValue
    else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
  }
}
