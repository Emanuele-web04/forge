// Accessibility bridge between AXPTranslator and CoreSimulator.
//
// AXPTranslator drives accessibility reads through a *synchronous* delegate
// callback, while CoreSimulator's transport (`-[SimDevice
// sendAccessibilityRequestAsync:completionQueue:completionHandler:]`) is
// asynchronous. This class is installed as the translator's bridge-token
// delegate and turns each synchronous callback into an async XPC round-trip it
// waits on, which is the same shape idb's FBAXTranslationDispatcher uses.
//
// It lives in Objective-C because conformance is to a private informal protocol
// (`AXPTranslationTokenDelegateHelper`) whose callback returns a block; the
// runtime only checks `-respondsToSelector:`, so no header for the protocol is
// needed.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface SynaraAXBridge : NSObject

/// The `SimDevice` accessibility requests are sent to.
@property (nonatomic, strong, nullable) id device;

/// Seconds to wait for a single accessibility XPC round-trip before giving up
/// and returning an empty response. Never "forever": a wedged accessibility
/// service must not hang the helper's RPC loop.
@property (nonatomic, assign) NSTimeInterval requestTimeout;

/// Installs the shared AXPTranslator's bridge-token delegate and enables
/// accessibility. Returns NO when the private classes are unavailable.
- (BOOL)prepare;

/// Serializes the frontmost application's accessibility tree.
///
/// Must NOT be called on the main queue: the delegate performs blocking waits.
/// Returns nil and fills `error` when no translation object is produced (the
/// usual cause is a simulator that has not finished booting SpringBoard).
- (nullable NSDictionary *)frontmostTreeWithMaxDepth:(NSInteger)maxDepth
                                               error:(NSError **)error
    NS_SWIFT_NAME(frontmostTree(maxDepth:));

@end

NS_ASSUME_NONNULL_END
