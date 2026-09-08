import CoreGraphics

/// One output scale for every display, irrespective of its backing scale.
/// Frames are global top-left points; Core Graphics draws bottom-left pixels.
final class CaptureCanvas {
  let region: CGRect
  private let context: CGContext
  init?(region: CGRect, width: Int, height: Int) {
    guard region.width > 0, region.height > 0,
      let context = CGContext(data: nil, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    self.region = region
    self.context = context
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  }
  private func destination(_ frame: CGRect) -> CGRect {
    let sx = CGFloat(context.width) / region.width
    let sy = CGFloat(context.height) / region.height
    return CGRect(x: (frame.minX - region.minX) * sx, y: (region.maxY - frame.maxY) * sy,
      width: frame.width * sx, height: frame.height * sy)
  }
  func draw(_ image: CGImage, covering frame: CGRect) {
    context.draw(image, in: destination(frame))
  }
  func mask(_ frame: CGRect) {
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fill(destination(frame).integral)
  }
  func image() -> CGImage? { context.makeImage() }
}
