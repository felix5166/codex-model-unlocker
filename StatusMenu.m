#import <Cocoa/Cocoa.h>
#import <signal.h>
#import <unistd.h>

@interface StatusMenuController : NSObject <NSApplicationDelegate>
@property(nonatomic, assign) pid_t parentPID;
@property(nonatomic, copy) NSArray<NSDictionary *> *models;
@property(nonatomic, strong) NSStatusItem *statusItem;
@property(nonatomic, strong) NSTimer *parentMonitor;
@end

@implementation StatusMenuController

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    NSButton *button = self.statusItem.button;
    button.image = [NSImage imageWithSystemSymbolName:@"slider.horizontal.3"
                                  accessibilityDescription:@"ChatGPT自定义模型"];
    button.image.template = YES;
    button.toolTip = @"ChatGPT自定义模型";
    self.statusItem.menu = [self makeMenu];

    self.parentMonitor = [NSTimer scheduledTimerWithTimeInterval:1.0
                                                              target:self
                                                            selector:@selector(checkParent:)
                                                            userInfo:nil
                                                             repeats:YES];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    if (self.statusItem != nil) {
        [[NSStatusBar systemStatusBar] removeStatusItem:self.statusItem];
    }
    [self.parentMonitor invalidate];
}

- (NSMenu *)makeMenu {
    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"ChatGPT自定义模型"];

    NSMenuItem *title = [[NSMenuItem alloc] initWithTitle:@"ChatGPT自定义模型"
                                                    action:nil
                                             keyEquivalent:@""];
    title.enabled = NO;
    [menu addItem:title];

    for (NSDictionary *model in self.models) {
        NSString *displayName = model[@"displayName"] ?: model[@"id"] ?: @"";
        NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:displayName action:nil keyEquivalent:@""];
        item.toolTip = model[@"id"];
        item.enabled = NO;
        [menu addItem:item];
    }

    [menu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *stop = [[NSMenuItem alloc] initWithTitle:@"退出"
                                                    action:@selector(stopPlugin:)
                                             keyEquivalent:@""];
    stop.target = self;
    [menu addItem:stop];
    return menu;
}

- (void)stopPlugin:(id)sender {
    if (self.parentPID > 1) {
        kill(self.parentPID, SIGTERM);
    }
    [NSApp terminate:nil];
}

- (void)checkParent:(NSTimer *)timer {
    if (self.parentPID > 1 && kill(self.parentPID, 0) != 0) {
        [NSApp terminate:nil];
    }
}

@end

static NSString *ArgumentValue(NSString *name) {
    NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
    NSUInteger index = [arguments indexOfObject:name];
    if (index == NSNotFound || index + 1 >= arguments.count) return nil;
    return arguments[index + 1];
}

static NSArray<NSDictionary *> *LoadModels(NSString *value) {
    if (value.length == 0) return @[];
    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
    NSArray *items = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![items isKindOfClass:NSArray.class]) return @[];

    NSMutableArray<NSDictionary *> *models = [NSMutableArray array];
    for (id item in items) {
        if (![item isKindOfClass:NSDictionary.class]) continue;
        NSString *modelID = item[@"id"];
        if (![modelID isKindOfClass:NSString.class] || modelID.length == 0) continue;
        NSString *displayName = item[@"displayName"];
        if (![displayName isKindOfClass:NSString.class] || displayName.length == 0) displayName = modelID;
        [models addObject:@{@"id": modelID, @"displayName": displayName}];
    }
    return models;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        StatusMenuController *controller = [[StatusMenuController alloc] init];
        controller.parentPID = (pid_t)[ArgumentValue(@"--parent-pid") intValue];
        controller.models = LoadModels(ArgumentValue(@"--models"));

        NSApplication *application = NSApplication.sharedApplication;
        application.delegate = controller;
        [application run];
    }
    return 0;
}
