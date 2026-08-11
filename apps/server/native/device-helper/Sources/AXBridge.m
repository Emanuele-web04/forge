#import "AXBridge.h"

#import <AppKit/AppKit.h>
#import <objc/message.h>
#import <objc/runtime.h>

/// An empty AXPTranslatorResponse, returned when a request cannot be satisfied.
/// The translator requires *some* response object; nil wedges the read.
id SynaraEmptyTranslatorResponse(void);

// Attribute reads go through objc_msgSend casts rather than declared headers:
// every one of these classes is private, and a wrong @interface would be a
// silent ABI mismatch instead of a nil.
static id SynaraMsgSend0(id target, NSString *selectorName) {
  SEL selector = NSSelectorFromString(selectorName);
  if (![target respondsToSelector:selector]) {
    return nil;
  }
  return ((id (*)(id, SEL))objc_msgSend)(target, selector);
}

static NSString *SynaraStringAttribute(id element, NSString *selectorName) {
  id value = SynaraMsgSend0(element, selectorName);
  return [value isKindOfClass:NSString.class] ? value : nil;
}

static BOOL SynaraBoolAttribute(id element, NSString *selectorName) {
  SEL selector = NSSelectorFromString(selectorName);
  if (![element respondsToSelector:selector]) {
    return NO;
  }
  return ((BOOL (*)(id, SEL))objc_msgSend)(element, selector);
}

// `accessibilityValue` is genuinely `id`; anything not JSON-representable is
// rendered with -description so the tree never fails to serialize.
static id SynaraJSONValue(id value) {
  if (value == nil) {
    return NSNull.null;
  }
  if ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class]) {
    return value;
  }
  return [value description] ?: NSNull.null;
}

@implementation SynaraAXBridge {
  dispatch_queue_t _callbackQueue;
  id _translator;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    // Concurrent, not serial: the translator issues nested accessibility
    // requests from inside a completion handler, and each one blocks waiting for
    // its own completion. On a serial queue that nesting deadlocks the moment a
    // tree needs more than one round-trip.
    _callbackQueue = dispatch_queue_create("dev.synara.device-helper.ax", DISPATCH_QUEUE_CONCURRENT);
    _requestTimeout = 5.0;
  }
  return self;
}

- (BOOL)prepare {
  Class translatorClass = NSClassFromString(@"AXPTranslator");
  if (translatorClass == nil) {
    return NO;
  }
  SEL sharedSelector = NSSelectorFromString(@"sharedInstance");
  if (![translatorClass respondsToSelector:sharedSelector]) {
    return NO;
  }
  _translator = ((id (*)(Class, SEL))objc_msgSend)(translatorClass, sharedSelector);
  if (_translator == nil) {
    return NO;
  }

  SEL enableSelector = NSSelectorFromString(@"setAccessibilityEnabled:");
  if ([_translator respondsToSelector:enableSelector]) {
    ((void (*)(id, SEL, BOOL))objc_msgSend)(_translator, enableSelector, YES);
  }

  SEL delegateSelector = NSSelectorFromString(@"setBridgeTokenDelegate:");
  if (![_translator respondsToSelector:delegateSelector]) {
    return NO;
  }
  ((void (*)(id, SEL, id))objc_msgSend)(_translator, delegateSelector, self);
  return YES;
}

#pragma mark - AXPTranslationTokenDelegateHelper

- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)rect
                                                    withToken:(NSString *)token {
  // Simulator frames are already in the display's coordinate space.
  return rect;
}

- (id)accessibilityTranslationRootParentWithToken:(NSString *)token {
  return nil;
}

- (id)accessibilityTranslationDelegateBridgeCallbackWithToken:(NSString *)token {
  id device = self.device;
  dispatch_queue_t queue = _callbackQueue;
  NSTimeInterval timeout = self.requestTimeout;

  id (^callback)(id) = ^id(id request) {
    if (device == nil) {
      return SynaraEmptyTranslatorResponse();
    }
    dispatch_group_t group = dispatch_group_create();
    dispatch_group_enter(group);
    __block id response = nil;
    void (^completion)(id) = ^(id inner) {
      response = inner;
      dispatch_group_leave(group);
    };

    SEL selector = NSSelectorFromString(@"sendAccessibilityRequestAsync:completionQueue:completionHandler:");
    ((void (*)(id, SEL, id, dispatch_queue_t, void (^)(id)))objc_msgSend)(
        device, selector, request, queue, completion);

    dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC));
    if (dispatch_group_wait(group, deadline) != 0) {
      // A wedged accessibility service must not hang the caller: an empty
      // response ends the read with a partial tree instead of blocking forever.
      return SynaraEmptyTranslatorResponse();
    }
    return response ?: SynaraEmptyTranslatorResponse();
  };
  return [callback copy];
}

#pragma mark - Tree

- (nullable NSDictionary *)frontmostTreeWithMaxDepth:(NSInteger)maxDepth error:(NSError **)error {
  if (_translator == nil) {
    if (error) {
      *error = [NSError errorWithDomain:@"dev.synara.device-helper.ax"
                                   code:1
                               userInfo:@{NSLocalizedDescriptionKey: @"accessibility translator unavailable"}];
    }
    return nil;
  }

  NSString *token = NSUUID.UUID.UUIDString;
  SEL frontmostSelector = NSSelectorFromString(@"frontmostApplicationWithDisplayId:bridgeDelegateToken:");
  // Resolved on a dedicated thread rather than the caller's queue: the
  // translator blocks on nested XPC round-trips, and running that on a
  // dispatch-queue worker thread deadlocks against libdispatch's thread pool.
  __block id translation = nil;
  id translator = _translator;
  dispatch_semaphore_t resolved = dispatch_semaphore_create(0);
  NSThread *worker = [[NSThread alloc] initWithBlock:^{
    translation = ((id (*)(id, SEL, unsigned int, NSString *))objc_msgSend)(
        translator, frontmostSelector, 0, token);
    dispatch_semaphore_signal(resolved);
  }];
  worker.stackSize = 1024 * 1024;
  [worker start];
  // Bounded: a translator that never answers must not wedge the RPC loop.
  dispatch_semaphore_wait(resolved, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(30 * NSEC_PER_SEC)));
  if (translation == nil) {
    if (error) {
      *error = [NSError errorWithDomain:@"dev.synara.device-helper.ax"
                                   code:2
                               userInfo:@{NSLocalizedDescriptionKey: @"no frontmost application (SpringBoard may still be starting)"}];
    }
    return nil;
  }

  SEL tokenSelector = NSSelectorFromString(@"setBridgeDelegateToken:");
  if ([translation respondsToSelector:tokenSelector]) {
    ((void (*)(id, SEL, NSString *))objc_msgSend)(translation, tokenSelector, token);
  }

  SEL elementSelector = NSSelectorFromString(@"macPlatformElementFromTranslation:");
  id element = ((id (*)(id, SEL, id))objc_msgSend)(_translator, elementSelector, translation);
  if (element == nil) {
    if (error) {
      *error = [NSError errorWithDomain:@"dev.synara.device-helper.ax"
                                   code:3
                               userInfo:@{NSLocalizedDescriptionKey: @"translation produced no platform element"}];
    }
    return nil;
  }

  return [self serializeElement:element depth:0 maxDepth:maxDepth];
}

- (NSDictionary *)serializeElement:(id)element depth:(NSInteger)depth maxDepth:(NSInteger)maxDepth {
  NSMutableDictionary *node = [NSMutableDictionary new];

  NSString *role = SynaraStringAttribute(element, @"accessibilityRole");
  // Roles come back AX-prefixed ("AXButton"); the contract wants the bare role.
  if ([role hasPrefix:@"AX"] && role.length > 2) {
    node[@"role"] = [role substringFromIndex:2];
  } else if (role != nil) {
    node[@"role"] = role;
  }

  NSString *label = SynaraStringAttribute(element, @"accessibilityLabel");
  if (label.length > 0) {
    node[@"label"] = label;
  }
  id value = SynaraJSONValue(SynaraMsgSend0(element, @"accessibilityValue"));
  if (value != NSNull.null) {
    node[@"value"] = value;
  }
  NSString *identifier = SynaraStringAttribute(element, @"accessibilityIdentifier");
  if (identifier.length > 0) {
    node[@"identifier"] = identifier;
  }
  NSString *title = SynaraStringAttribute(element, @"accessibilityTitle");
  if (title.length > 0) {
    node[@"title"] = title;
  }

  SEL frameSelector = NSSelectorFromString(@"accessibilityFrame");
  if ([element respondsToSelector:frameSelector]) {
    NSRect frame = ((NSRect (*)(id, SEL))objc_msgSend)(element, frameSelector);
    node[@"frame"] = @{
      @"x": @(frame.origin.x),
      @"y": @(frame.origin.y),
      @"width": @(frame.size.width),
      @"height": @(frame.size.height),
    };
  }

  // UIKit merges a settings row and the control it contains into ONE element
  // whose frame spans the whole row, so the frame centre of a switch row is
  // dead space that swallows taps. The activation point is the control's own
  // hit point, and is the only coordinate that actually toggles it.
  SEL activationSelector = NSSelectorFromString(@"accessibilityActivationPoint");
  if ([element respondsToSelector:activationSelector]) {
    NSPoint point = ((NSPoint (*)(id, SEL))objc_msgSend)(element, activationSelector);
    if (!CGPointEqualToPoint(NSPointToCGPoint(point), CGPointZero)) {
      node[@"activationPoint"] = @{@"x": @(point.x), @"y": @(point.y)};
    }
  }

  // AXCheckBox covers both checkboxes and switches on iOS; the subrole is what
  // distinguishes them, and an agent needs it to know "0"/"1" means off/on.
  NSString *subrole = SynaraStringAttribute(element, @"accessibilitySubrole");
  if ([subrole hasPrefix:@"AX"] && subrole.length > 2) {
    node[@"subrole"] = [subrole substringFromIndex:2];
  } else if (subrole.length > 0) {
    node[@"subrole"] = subrole;
  }

  node[@"enabled"] = @(SynaraBoolAttribute(element, @"isAccessibilityEnabled"));

  if (depth >= maxDepth) {
    // Depth-capped rather than dropped, so a pathological tree still returns.
    node[@"truncated"] = @YES;
    return node;
  }

  id rawChildren = SynaraMsgSend0(element, @"accessibilityChildren");
  if ([rawChildren isKindOfClass:NSArray.class] && [rawChildren count] > 0) {
    NSMutableArray *children = [NSMutableArray new];
    for (id child in (NSArray *)rawChildren) {
      NSDictionary *serialized = [self serializeElement:child depth:depth + 1 maxDepth:maxDepth];
      if (serialized != nil) {
        [children addObject:serialized];
      }
    }
    if (children.count > 0) {
      node[@"children"] = children;
    }
  }

  return node;
}

@end

id SynaraEmptyTranslatorResponse(void) {
  Class responseClass = NSClassFromString(@"AXPTranslatorResponse");
  SEL emptySelector = NSSelectorFromString(@"empty");
  if (responseClass == nil || ![responseClass respondsToSelector:emptySelector]) {
    return nil;
  }
  return ((id (*)(Class, SEL))objc_msgSend)(responseClass, emptySelector);
}
