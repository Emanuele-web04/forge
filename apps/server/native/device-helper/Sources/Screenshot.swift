// PNG encoding of the device framebuffer.

import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import IOSurface
import UniformTypeIdentifiers

/// Shared across screenshots: creating a CIContext is expensive and the helper
/// takes them repeatedly.
private let sharedImageContext = CIContext(options: [.useSoftwareRenderer: false])

/// Encodes the current contents of `surface` as PNG.
func encodePNG(surface: IOSurfaceRef) throws -> Data {
  let image = CIImage(ioSurface: surface)
  guard
    let data = sharedImageContext.pngRepresentation(
      of: image,
      format: .RGBA8,
      colorSpace: CGColorSpaceCreateDeviceRGB())
  else {
    throw RPCError(.internalError, "failed to encode framebuffer as PNG")
  }
  return data
}
