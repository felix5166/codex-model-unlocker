#import <Cocoa/Cocoa.h>
#import <signal.h>
#import <unistd.h>

@interface StatusMenuController : NSObject <NSApplicationDelegate>
@property(nonatomic, assign) pid_t parentPID;
@property(nonatomic, copy) NSString *iconPath;
@property(nonatomic, strong) NSStatusItem *statusItem;
@property(nonatomic, strong) NSTimer *parentMonitor;
@end

@implementation StatusMenuController

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    NSButton *button = self.statusItem.button;
    NSImage *icon = [[NSImage alloc] initWithContentsOfFile:self.iconPath];
    icon.size = NSMakeSize(18.0, 18.0);
    button.image = icon;
    button.imageScaling = NSImageScaleProportionallyDown;
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
    NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"退出"
                                                    action:@selector(stopPlugin:)
                                             keyEquivalent:@""];
    quit.target = self;
    [menu addItem:quit];
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

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        StatusMenuController *controller = [[StatusMenuController alloc] init];
        controller.parentPID = (pid_t)[ArgumentValue(@"--parent-pid") intValue];
        controller.iconPath = ArgumentValue(@"--icon-path");

        NSApplication *application = NSApplication.sharedApplication;
        application.delegate = controller;
        [application run];
    }
    return 0;
}
