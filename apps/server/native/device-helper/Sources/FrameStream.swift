// Framebuffer capture → H.264 → length-prefixed frames on a Unix socket.
//
// The simulator posts display updates via a damage-rectangle callback. Each
// update is read out of the device IOSurface, encoded by VideoToolbox (hardware
// where available), and written to the socket in the envelope defined by
// `@synara/contracts` (see HEADER.md).
//
// Backpressure is a hard requirement: the pane must never be the reason RPC
// traffic stalls. The encoder drops frames while busy, and the writer drops
// frames rather than blocking on a socket that is not draining.

import CoreVideo
import Foundation
import IOSurface
import VideoToolbox

/// Wire-format constants, mirrored from `packages/contracts/src/device.ts`.
/// These MUST stay in agreement with the TypeScript decoder.
enum FrameEnvelope {
  static let magic: UInt16 = 0x5346
  static let version: UInt8 = 1
  static let flagKeyframe: UInt8 = 0b0000_0001
  static let flagCodecConfig: UInt8 = 0b0000_0010
  static let headerFixedBytes = 17
  static let maxDeviceIdBytes = 255

  /// Serializes one payload with its header. Little-endian throughout.
  static func encode(
    deviceId: [UInt8],
    sequence: UInt32,
    timestampMs: Double,
    keyframe: Bool,
    codecConfig: Bool,
    payload: UnsafeRawBufferPointer
  ) -> Data {
    var flags: UInt8 = 0
    if keyframe { flags |= flagKeyframe }
    if codecConfig { flags |= flagCodecConfig }

    var data = Data(capacity: headerFixedBytes + deviceId.count + payload.count)
    withUnsafeBytes(of: magic.littleEndian) { data.append(contentsOf: $0) }
    data.append(version)
    data.append(flags)
    withUnsafeBytes(of: sequence.littleEndian) { data.append(contentsOf: $0) }
    withUnsafeBytes(of: timestampMs.bitPattern.littleEndian) { data.append(contentsOf: $0) }
    data.append(UInt8(deviceId.count))
    data.append(contentsOf: deviceId)
    data.append(contentsOf: payload)
    return data
  }
}

/// A framed writer over a connected Unix socket.
///
/// Each message is `u32 little-endian length` followed by that many bytes, so
/// the reader can frame without parsing the bitstream.
final class FrameSocketWriter {
  private let descriptor: Int32
  private let queue = DispatchQueue(label: "dev.synara.device-helper.socket")
  private let stateLock = NSLock()
  private var closed = false
  private var descriptorClosed = false
  private var droppedFrameCount = 0
  private var pendingBytes = 0

  /// Above this backlog the writer sheds frames instead of queueing more. Chosen
  /// to hold roughly a second of a healthy stream; beyond it the consumer is not
  /// keeping up and stale frames are worthless anyway.
  private let maxPendingBytes = 4 * 1024 * 1024

  init(path: String) throws {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else {
      throw SimulatorError.displayUnavailable(
        "cannot create socket: \(String(cString: strerror(errno)))")
    }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    guard pathBytes.count < capacity else {
      Darwin.close(fd)
      throw SimulatorError.displayUnavailable("socket path too long: \(path)")
    }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.baseAddress!.initializeMemory(as: UInt8.self, repeating: 0, count: capacity)
      raw.copyBytes(from: pathBytes)
    }

    let connected = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard connected == 0 else {
      let message = String(cString: strerror(errno))
      Darwin.close(fd)
      throw SimulatorError.displayUnavailable("cannot connect to \(path): \(message)")
    }

    // SIGPIPE would kill the process when the consumer disconnects; surface it
    // as a write error instead.
    var noSignal: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))

    descriptor = fd
  }

  var isClosed: Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return closed
  }

  func write(_ payload: Data) {
    // Reserve before enqueueing. Counting inside the serial queue sees zero at
    // the start of every job and therefore misses the jobs already waiting
    // behind a blocked socket write, which allows an unbounded Data backlog.
    stateLock.lock()
    if closed {
      stateLock.unlock()
      return
    }
    if pendingBytes + payload.count > maxPendingBytes {
      droppedFrameCount += 1
      stateLock.unlock()
      return
    }
    pendingBytes += payload.count
    stateLock.unlock()

    queue.async { [weak self] in
      guard let self else { return }
      defer {
        self.stateLock.lock()
        self.pendingBytes -= payload.count
        self.stateLock.unlock()
      }

      self.stateLock.lock()
      let canWrite = !self.closed
      self.stateLock.unlock()
      guard canWrite else { return }

      var length = UInt32(payload.count).littleEndian
      let header = withUnsafeBytes(of: &length) { Data($0) }
      if !self.writeAll(header) || !self.writeAll(payload) {
        self.stateLock.lock()
        self.closed = true
        let shouldClose = !self.descriptorClosed
        self.descriptorClosed = true
        self.stateLock.unlock()
        if shouldClose { Darwin.close(self.descriptor) }
      }
    }
  }

  private func writeAll(_ data: Data) -> Bool {
    data.withUnsafeBytes { buffer -> Bool in
      var offset = 0
      while offset < buffer.count {
        let written = Darwin.write(descriptor, buffer.baseAddress! + offset, buffer.count - offset)
        if written > 0 {
          offset += written
          continue
        }
        if written < 0 && (errno == EINTR || errno == EAGAIN) {
          continue
        }
        return false
      }
      return true
    }
  }

  func close() {
    stateLock.lock()
    closed = true
    stateLock.unlock()

    queue.sync {
      stateLock.lock()
      let shouldClose = !descriptorClosed
      descriptorClosed = true
      stateLock.unlock()
      if shouldClose { Darwin.close(descriptor) }
    }
  }

  var droppedFrames: Int {
    stateLock.lock()
    defer { stateLock.unlock() }
    return droppedFrameCount
  }
}

/// Captures the device framebuffer and emits encoded frames.
final class FrameStream {
  private let descriptor: NSObject
  private let deviceIdBytes: [UInt8]
  private let writer: FrameSocketWriter
  private let keyframeIntervalSeconds: Double
  private let encodeQueue = DispatchQueue(label: "dev.synara.device-helper.encode")

  private let damageCallbackUUID = NSUUID()
  private let surfaceCallbackUUID = NSUUID()
  private var damageRegistered = false
  private var surfaceRegistered = false

  private var session: VTCompressionSession?
  private let startedAt = CFAbsoluteTimeGetCurrent()
  private var sequence: UInt32 = 0
  private var lastKeyframeAt: Double = -.greatestFiniteMagnitude
  private var encodingInFlight = false
  private var streamGeneration: UInt64 = 0
  private var stopped = false
  private var emittedFrameCount = 0
  private var droppedBusyFrameCount = 0
  private let stateLock = NSLock()

  private(set) var pixelWidth = 0
  private(set) var pixelHeight = 0
  var emittedFrames: Int { withStateLock { emittedFrameCount } }
  var droppedBusyFrames: Int { withStateLock { droppedBusyFrameCount } }

  init(
    descriptor: NSObject,
    deviceId: String,
    writer: FrameSocketWriter,
    keyframeIntervalSeconds: Double
  ) throws {
    guard let idBytes = deviceId.data(using: .utf8),
      idBytes.count <= FrameEnvelope.maxDeviceIdBytes,
      !idBytes.isEmpty
    else {
      throw SimulatorError.displayUnavailable("device id is not a valid envelope identifier")
    }
    self.descriptor = descriptor
    self.deviceIdBytes = Array(idBytes)
    self.writer = writer
    self.keyframeIntervalSeconds = keyframeIntervalSeconds
  }

  func start() throws {
    guard let surface = descriptor.currentFramebufferSurface() else {
      throw SimulatorError.displayUnavailable("display has no framebuffer surface yet")
    }
    pixelWidth = IOSurfaceGetWidth(surface)
    pixelHeight = IOSurfaceGetHeight(surface)
    try encodeQueue.sync {
      try startSessionOnQueue(width: pixelWidth, height: pixelHeight)
    }

    // Prime with a first frame so a consumer sees the screen immediately rather
    // than waiting for the display to change.
    encode(surface: surface)

    let damageSelector = NSSelectorFromString("registerCallbackWithUUID:damageRectanglesCallback:")
    typealias DamageFn =
      @convention(c) (
        AnyObject, Selector, NSUUID, @convention(block) (AnyObject?) -> Void
      ) -> Void
    if let imp = descriptor.method(for: damageSelector) {
      let block: @convention(block) (AnyObject?) -> Void = { [weak self] _ in
        guard let self, let current = self.descriptor.currentFramebufferSurface() else { return }
        self.encode(surface: current)
      }
      unsafeBitCast(imp, to: DamageFn.self)(descriptor, damageSelector, damageCallbackUUID, block)
      damageRegistered = true
    }

    // The backing IOSurface can be swapped wholesale (rotation, resize); pick up
    // the new one when that happens.
    let surfaceSelector = NSSelectorFromString("registerCallbackWithUUID:ioSurfacesChangeCallback:")
    typealias SurfaceFn =
      @convention(c) (
        AnyObject, Selector, NSUUID, @convention(block) (AnyObject?, AnyObject?) -> Void
      ) -> Void
    if let imp = descriptor.method(for: surfaceSelector) {
      let block: @convention(block) (AnyObject?, AnyObject?) -> Void = { [weak self] _, updated in
        guard let self, let updated, CFGetTypeID(updated) == IOSurfaceGetTypeID() else { return }
        self.encode(surface: unsafeBitCast(updated, to: IOSurfaceRef.self))
      }
      unsafeBitCast(imp, to: SurfaceFn.self)(
        descriptor, surfaceSelector, surfaceCallbackUUID, block)
      surfaceRegistered = true
    }

    guard damageRegistered || surfaceRegistered else {
      stop()
      throw SimulatorError.displayUnavailable("display exposes no frame callbacks")
    }
  }

  func stop() {
    let shouldStop = withStateLock {
      if stopped { return false }
      stopped = true
      streamGeneration &+= 1
      encodingInFlight = false
      return true
    }
    guard shouldStop else { return }

    if damageRegistered {
      let selector = NSSelectorFromString("unregisterDamageRectanglesCallbackWithUUID:")
      typealias Fn = @convention(c) (AnyObject, Selector, NSUUID) -> Void
      if let imp = descriptor.method(for: selector) {
        unsafeBitCast(imp, to: Fn.self)(descriptor, selector, damageCallbackUUID)
      }
      damageRegistered = false
    }
    if surfaceRegistered {
      let selector = NSSelectorFromString("unregisterIOSurfacesChangeCallbackWithUUID:")
      typealias Fn = @convention(c) (AnyObject, Selector, NSUUID) -> Void
      if let imp = descriptor.method(for: selector) {
        unsafeBitCast(imp, to: Fn.self)(descriptor, selector, surfaceCallbackUUID)
      }
      surfaceRegistered = false
    }
    encodeQueue.sync {
      if let session {
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
        self.session = nil
      }
    }
    writer.close()
  }

  var droppedSocketFrames: Int { writer.droppedFrames }

  private func startSessionOnQueue(width: Int, height: Int) throws {
    var created: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(width),
      height: Int32(height),
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: nil,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: nil,
      refcon: nil,
      compressionSessionOut: &created)
    guard status == noErr, let session = created else {
      throw SimulatorError.displayUnavailable("VTCompressionSessionCreate failed (\(status))")
    }

    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_ProfileLevel,
      value: kVTProfileLevel_H264_Baseline_AutoLevel)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 120 as CFNumber)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
      value: keyframeIntervalSeconds as CFNumber)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: 60 as CFNumber)
    VTCompressionSessionPrepareToEncodeFrames(session)

    self.session = session
  }

  /// Encodes one surface. Returns immediately when an encode is already in
  /// flight: dropping is the correct response to a display that outruns the
  /// encoder, since only the newest frame matters.
  private func encode(surface: IOSurfaceRef) {
    let generation = withStateLock { () -> UInt64? in
      if stopped { return nil }
      if encodingInFlight {
        droppedBusyFrameCount += 1
        return nil
      }
      encodingInFlight = true
      return streamGeneration
    }
    guard let generation else { return }

    // The surface must be retained across the async hop: the simulator may
    // recycle it as soon as this callback returns.
    let retained = Unmanaged.passRetained(surface as AnyObject)
    encodeQueue.async { [weak self] in
      defer {
        retained.release()
        self?.finishEncoding(generation: generation)
      }
      self?.encodeOnQueue(surface: surface, generation: generation)
    }
  }

  private func encodeOnQueue(surface: IOSurfaceRef, generation: UInt64) {
    guard accepts(generation: generation), let session, !writer.isClosed else { return }

    var unmanagedBuffer: Unmanaged<CVPixelBuffer>?
    let status = CVPixelBufferCreateWithIOSurface(
      kCFAllocatorDefault, surface, nil, &unmanagedBuffer)
    guard status == kCVReturnSuccess, let unmanagedBuffer else { return }
    let pixelBuffer = unmanagedBuffer.takeRetainedValue()

    let elapsed = CFAbsoluteTimeGetCurrent() - startedAt
    let presentationTime = CMTime(seconds: elapsed, preferredTimescale: 1000)

    var properties: [CFString: Any]? = nil
    if elapsed - lastKeyframeAt >= keyframeIntervalSeconds {
      // Periodic keyframes bound how long a late joiner waits for a decodable
      // picture and give the consumer a resync point after dropped frames.
      properties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!]
      lastKeyframeAt = elapsed
    }

    VTCompressionSessionEncodeFrame(
      session,
      imageBuffer: pixelBuffer,
      presentationTimeStamp: presentationTime,
      duration: .invalid,
      frameProperties: properties as CFDictionary?,
      infoFlagsOut: nil
    ) { [weak self] encodeStatus, _, sampleBuffer in
      guard let self, encodeStatus == noErr, let sampleBuffer,
        self.accepts(generation: generation)
      else { return }
      self.emit(sampleBuffer: sampleBuffer, generation: generation)
    }
  }

  private func emit(sampleBuffer: CMSampleBuffer, generation: UInt64) {
    guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

    let attachments = CMSampleBufferGetSampleAttachmentsArray(
      sampleBuffer, createIfNecessary: false)
    var isKeyframe = true
    if let attachments, CFArrayGetCount(attachments) > 0 {
      let entry = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFDictionary.self)
      let dictionary = entry as NSDictionary
      if let notSync = dictionary[kCMSampleAttachmentKey_NotSync] as? Bool {
        isKeyframe = !notSync
      }
    }

    // A keyframe is only decodable alongside its parameter sets, so SPS/PPS are
    // sent as their own codec-config message immediately before it.
    if isKeyframe, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
      emitParameterSets(format: format, generation: generation)
    }

    var lengthAtOffset = 0
    var totalLength = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard
      CMBlockBufferGetDataPointer(
        dataBuffer, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset,
        totalLengthOut: &totalLength, dataPointerOut: &pointer) == noErr,
      let pointer, totalLength > 0
    else { return }

    // VideoToolbox emits AVCC (4-byte length prefixes); the browser decoder
    // wants Annex B, so start codes are substituted in place of the lengths.
    var annexB = Data(capacity: totalLength)
    let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]
    var offset = 0
    pointer.withMemoryRebound(to: UInt8.self, capacity: totalLength) { bytes in
      while offset + 4 <= totalLength {
        let naluLength =
          (Int(bytes[offset]) << 24) | (Int(bytes[offset + 1]) << 16)
          | (Int(bytes[offset + 2]) << 8) | Int(bytes[offset + 3])
        offset += 4
        guard naluLength > 0, offset + naluLength <= totalLength else { break }
        annexB.append(contentsOf: startCode)
        annexB.append(UnsafeBufferPointer(start: bytes + offset, count: naluLength))
        offset += naluLength
      }
    }
    guard !annexB.isEmpty else { return }

    guard
      send(
        payload: annexB, keyframe: isKeyframe, codecConfig: false, generation: generation
      )
    else { return }
    withStateLock {
      if acceptsGenerationLocked(generation) { emittedFrameCount += 1 }
    }
  }

  private func emitParameterSets(format: CMFormatDescription, generation: UInt64) {
    var parameterSetCount = 0
    guard
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
        parameterSetCountOut: &parameterSetCount, nalUnitHeaderLengthOut: nil) == noErr
    else { return }

    var payload = Data()
    let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]
    for index in 0..<parameterSetCount {
      var setPointer: UnsafePointer<UInt8>?
      var setSize = 0
      guard
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          format, parameterSetIndex: index, parameterSetPointerOut: &setPointer,
          parameterSetSizeOut: &setSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
          == noErr, let setPointer, setSize > 0
      else { continue }
      payload.append(contentsOf: startCode)
      payload.append(UnsafeBufferPointer(start: setPointer, count: setSize))
    }
    guard !payload.isEmpty else { return }
    _ = send(payload: payload, keyframe: false, codecConfig: true, generation: generation)
  }

  private func send(
    payload: Data, keyframe: Bool, codecConfig: Bool, generation: UInt64
  ) -> Bool {
    // Sequence wraps rather than saturating, matching the decoder's contract.
    let nextSequence = withStateLock { () -> UInt32? in
      guard acceptsGenerationLocked(generation) else { return nil }
      sequence = sequence &+ 1
      return sequence
    }
    guard let nextSequence else { return false }
    let timestampMs = (CFAbsoluteTimeGetCurrent() - startedAt) * 1000
    let message = payload.withUnsafeBytes { buffer in
      FrameEnvelope.encode(
        deviceId: deviceIdBytes, sequence: nextSequence, timestampMs: timestampMs,
        keyframe: keyframe, codecConfig: codecConfig, payload: buffer)
    }
    writer.write(message)
    return true
  }

  private func finishEncoding(generation: UInt64) {
    withStateLock {
      if acceptsGenerationLocked(generation) { encodingInFlight = false }
    }
  }

  private func accepts(generation: UInt64) -> Bool {
    withStateLock { acceptsGenerationLocked(generation) }
  }

  private func acceptsGenerationLocked(_ generation: UInt64) -> Bool {
    !stopped && generation == streamGeneration
  }

  private func withStateLock<T>(_ operation: () -> T) -> T {
    stateLock.lock()
    defer { stateLock.unlock() }
    return operation()
  }
}
