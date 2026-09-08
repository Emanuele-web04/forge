import AppKit
import CoreGraphics

@main struct CaptureCanvasTests {
  static func solid(_ color: CGColor, width: Int, height: Int) -> CGImage {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(color)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()!
  }
  static func main() {
    let canvas = CaptureCanvas(region: CGRect(x: -100, y: -50, width: 300, height: 200), width: 150, height: 100)!
    // A 1x display at a negative origin and a 2x display offset down/right.
    canvas.draw(solid(CGColor(red: 1, green: 0, blue: 0, alpha: 1), width: 100, height: 100),
      covering: CGRect(x: -100, y: -50, width: 100, height: 100))
    canvas.draw(solid(CGColor(red: 0, green: 0, blue: 1, alpha: 1), width: 200, height: 200),
      covering: CGRect(x: 100, y: 50, width: 100, height: 100))
    canvas.mask(CGRect(x: -80, y: -30, width: 20, height: 20))
    let bitmap = NSBitmapImageRep(cgImage: canvas.image()!)
    func color(_ x: Int, _ y: Int) -> NSColor { bitmap.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)! }
    precondition(color(3, 3).redComponent > 0.9, "negative-origin display moved")
    precondition(color(125, 75).blueComponent > 0.9, "mixed-scale display moved")
    precondition(color(75, 25).redComponent < 0.1 && color(75, 25).blueComponent < 0.1, "display gap must be black")
    precondition(color(15, 15).redComponent < 0.1, "host mask must use the same coordinates")
    print("Capture composition: mixed scales, negative origins, gaps and host masking passed")
  }
}
