import AppKit

@main
struct StatusMenuTests {
    static func main() throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let controller = StatusMenuController(parentPID: getpid(), iconPath: CommandLine.arguments[1])
        controller.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        defer { controller.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification)) }
        assert(controller.statusItem?.menu?.items.map(\.title) == ["打开面板", "退出"])
        assert(controller.statusItem?.button?.image?.isValid == true)
        assert(controller.statusItem?.button?.image?.size == NSSize(width: 18, height: 18))
        var requests: [[String: Any]] = []
        controller.sendRequest = { requests.append($0) }
        controller.openPanel()
        assert(controller.table.tableColumns.map(\.identifier.rawValue) == ["id"])
        assert(controller.table.tableColumns.map(\.title) == ["模型 ID"])
        assert(requests.last?["action"] as? String == "load")
        assert(controller.busy && !controller.saveButton.isEnabled)
        let original = [["id": "gpt-6-astra"]]
        controller.receive(["ok": true, "models": original])
        assert(controller.models.first?.id == "gpt-6-astra")
        assert(!controller.saveButton.isEnabled && controller.restartButton.isEnabled)
        controller.addModel()
        assert(controller.models.count == 2 && controller.saveButton.isEnabled)
        let idField = NSTextField(string: "relay-test")
        idField.tag = 1
        controller.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: idField))
        controller.save()
        assert(requests.last?["restart"] as? Bool == false)
        let submitted = requests.last?["models"] as! [[String: String]]
        assert(submitted == [["id": "gpt-6-astra"], ["id": "relay-test"]])
        assert(controller.busy && !controller.restartButton.isEnabled)
        controller.receive(["ok": false, "error": "模型 ID 重复"])
        assert(controller.models.count == 2 && controller.saveButton.isEnabled)
        controller.saveAndRestart()
        assert(requests.last?["restart"] as? Bool == true)
        controller.receive(["ok": false, "saved": true, "models": submitted, "error": "配置已保存，但重启失败"])
        assert(controller.models == controller.savedModels)
        assert(controller.restartButton.isEnabled)
        controller.receive(["ok": true, "saved": true, "restarted": false, "models": submitted])
        assert(controller.feedback.stringValue == "已保存，点击“保存并重启 ChatGPT”后生效")
        controller.saveAndRestart()
        controller.receive(["ok": true, "saved": true, "restarted": true, "models": submitted])
        assert(controller.feedback.stringValue == "已保存，ChatGPT 已重启")
        let sameWindow = controller.window
        controller.openPanel()
        assert(controller.window === sameWindow)
        controller.receive(["ok": true, "models": submitted])
        for row in [1, 0] {
            controller.table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            controller.removeModel()
        }
        assert(controller.models.isEmpty && !controller.emptyLabel.isHidden)
        controller.saveAndRestart()
        assert((requests.last?["models"] as? [[String: String]])?.isEmpty == true)
        controller.receive(["ok": true, "saved": true, "restarted": true, "models": []])
        assert(controller.windowShouldClose(controller.window!))
        controller.receive(["ok": true, "models": submitted])
        if CommandLine.arguments.count > 2, let window = controller.window, let content = window.contentView {
            for width in [640, 900] {
                window.setContentSize(NSSize(width: width, height: 440))
                content.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                let image = content.bitmapImageRepForCachingDisplay(in: content.bounds)!
                content.cacheDisplay(in: content.bounds, to: image)
                try image.representation(using: .png, properties: [:])!.write(to:
                    URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent("panel-\(width).png"))
            }
        }
        controller.window?.close()
        print("Swift menu, editing, save, restart feedback and empty-list checks passed.")
    }
}
