import AppKit

struct ModelRow: Codable, Equatable {
    var id: String
    var context: Int

    init(id: String, context: Int = 272) {
        self.id = id
        self.context = context
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        context = try container.decodeIfPresent(Int.self, forKey: .context) ?? 272
    }
}

func contextConversionLabel(_ k: Int) -> String {
    if k < 1000 { return "\(k)k" }
    if k % 1000 == 0 { return "\(k / 1000)M" }
    var frac = String(k % 1000)
    while frac.count < 3 { frac = "0" + frac }
    while frac.last == "0" { frac.removeLast() }
    return "\(k / 1000).\(frac)M"
}

final class StatusMenuController: NSObject, NSApplicationDelegate, NSWindowDelegate,
    NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate {
    let parentPID: pid_t
    let iconPath: String
    var statusItem: NSStatusItem?
    var parentMonitor: Timer?
    var window: NSWindow?
    let table = NSTableView()
    let feedback = NSTextField(wrappingLabelWithString: "")
    let emptyLabel = NSTextField(labelWithString: "暂无自定义模型")
    let addButton = NSButton()
    let removeButton = NSButton()
    let saveButton = NSButton(title: "保存", target: nil, action: nil)
    let restartButton = NSButton(title: "保存并重启 ChatGPT", target: nil, action: nil)
    var models: [ModelRow] = []
    var savedModels: [ModelRow] = []
    var loaded = false
    var busy = false
    var sendRequest: ([String: Any]) -> Void = { message in
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(0x0a)
        FileHandle.standardOutput.write(data)
    }

    init(parentPID: pid_t, iconPath: String) {
        self.parentPID = parentPID
        self.iconPath = iconPath
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let icon = NSImage(contentsOfFile: iconPath)
        icon?.size = NSSize(width: 18, height: 18)
        statusItem?.button?.image = icon
        statusItem?.button?.imageScaling = .scaleProportionallyDown
        statusItem?.button?.toolTip = "ChatGPT自定义模型"
        statusItem?.button?.setAccessibilityLabel("ChatGPT自定义模型")
        let menu = NSMenu()
        let open = NSMenuItem(title: "打开面板", action: #selector(openPanel), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        let quit = NSMenuItem(title: "退出", action: #selector(quitPlugin), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        statusItem?.menu = menu
        parentMonitor = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            if self.parentPID > 1 && kill(self.parentPID, 0) != 0 && errno == ESRCH {
                NSApp.terminate(nil)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        parentMonitor?.invalidate()
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
    }

    @objc func openPanel() {
        if window == nil { buildPanel() }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        if !busy && models == savedModels {
            busy = true
            setFeedback("正在读取配置…")
            updateControls()
            sendRequest(["action": "load"])
        }
    }

    func buildPanel() {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 440),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable],
                             backing: .buffered, defer: false)
        panel.title = "ChatGPT自定义模型"
        panel.minSize = NSSize(width: 640, height: 380)
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.center()
        window = panel
        guard let content = panel.contentView else { return }

        let heading = NSTextField(labelWithString: "模型配置")
        heading.font = .systemFont(ofSize: 17, weight: .semibold)
        heading.setContentHuggingPriority(.defaultLow, for: .horizontal)
        configureIconButton(addButton, symbol: "plus", label: "添加模型", action: #selector(addModel))
        configureIconButton(removeButton, symbol: "minus", label: "删除选中模型", action: #selector(removeModel))
        let toolbar = NSStackView(views: [heading, addButton, removeButton])
        toolbar.spacing = 8
        toolbar.distribution = .fill

        let idColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("id"))
        idColumn.title = "模型 ID"
        idColumn.width = 520
        idColumn.minWidth = 200
        let contextColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("context"))
        contextColumn.title = "上下文窗口"
        contextColumn.width = 128
        contextColumn.minWidth = 120
        contextColumn.maxWidth = 160
        let convertedColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("converted"))
        convertedColumn.title = "会话大小"
        convertedColumn.width = 96
        convertedColumn.minWidth = 88
        convertedColumn.maxWidth = 120
        table.addTableColumn(idColumn)
        table.addTableColumn(contextColumn)
        table.addTableColumn(convertedColumn)
        table.delegate = self
        table.dataSource = self
        table.rowHeight = 36
        table.usesAlternatingRowBackgroundColors = true
        table.columnAutoresizingStyle = .firstColumnOnlyAutoresizingStyle
        table.allowsColumnReordering = false
        table.allowsEmptySelection = true
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        emptyLabel.textColor = .secondaryLabelColor

        saveButton.target = self
        saveButton.action = #selector(save)
        restartButton.target = self
        restartButton.action = #selector(saveAndRestart)
        for button in [saveButton, restartButton] { button.bezelStyle = .rounded }
        restartButton.keyEquivalent = "\r"
        let buttons = NSStackView(views: [saveButton, restartButton])
        buttons.spacing = 8
        feedback.font = .systemFont(ofSize: 12)
        feedback.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        for view in [toolbar, scroll, feedback, buttons, emptyLabel] {
            view.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(view)
        }
        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            toolbar.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            toolbar.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            toolbar.heightAnchor.constraint(equalToConstant: 30),
            scroll.topAnchor.constraint(equalTo: toolbar.bottomAnchor, constant: 14),
            scroll.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: feedback.topAnchor, constant: -12),
            emptyLabel.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
            feedback.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor),
            feedback.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor),
            feedback.heightAnchor.constraint(equalToConstant: 36),
            feedback.bottomAnchor.constraint(equalTo: buttons.topAnchor, constant: -8),
            buttons.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor),
            buttons.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
            buttons.heightAnchor.constraint(equalToConstant: 32),
        ])
        updateControls()
    }

    func configureIconButton(_ button: NSButton, symbol: String, label: String, action: Selector) {
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        button.toolTip = label
        button.setAccessibilityLabel(label)
        button.bezelStyle = .texturedRounded
        button.target = self
        button.action = action
        button.widthAnchor.constraint(equalToConstant: 30).isActive = true
        button.heightAnchor.constraint(equalToConstant: 28).isActive = true
    }

    func numberOfRows(in tableView: NSTableView) -> Int { models.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let tableColumn else { return nil }
        let cell = NSTableCellView()
        let kind = tableColumn.identifier.rawValue
        let isContext = kind == "context"
        let isConverted = kind == "converted"
        let value = isConverted ? contextConversionLabel(models[row].context)
            : isContext ? String(models[row].context) : models[row].id
        let field = isConverted ? NSTextField(labelWithString: value) : NSTextField(string: value)
        field.identifier = tableColumn.identifier
        field.tag = row
        if !isConverted {
            field.delegate = self
            field.isEditable = !busy && loaded
        }
        field.isBordered = false
        field.drawsBackground = false
        field.alignment = (isContext || isConverted) ? .right : .natural
        field.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        if isConverted { field.textColor = .secondaryLabelColor }
        field.setAccessibilityLabel("第 \(row + 1) 行\(tableColumn.title)")
        field.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(field)
        cell.textField = field
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8),
            field.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8),
            field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField, !busy else { return }
        let row = field.tag
        guard models.indices.contains(row) else { return }
        if field.identifier?.rawValue == "context" {
            if let value = Int(field.stringValue.trimmingCharacters(in: .whitespaces)), value >= 1 {
                models[row].context = value
                let convertedIndex = table.column(withIdentifier: NSUserInterfaceItemIdentifier("converted"))
                if convertedIndex >= 0,
                   let cell = table.view(atColumn: convertedIndex, row: row, makeIfNecessary: false) as? NSTableCellView {
                    cell.textField?.stringValue = contextConversionLabel(value)
                }
            }
        } else {
            models[row].id = field.stringValue
        }
        setFeedback(models == savedModels ? "" : "有未保存的更改")
        updateControls()
    }

    func tableViewSelectionDidChange(_ notification: Notification) { updateControls() }

    @objc func addModel() {
        guard loaded && !busy else { return }
        window?.makeFirstResponder(nil)
        models.append(ModelRow(id: "", context: 272))
        table.reloadData()
        let row = models.count - 1
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        table.scrollRowToVisible(row)
        if let cell = table.view(atColumn: 0, row: row, makeIfNecessary: true) as? NSTableCellView {
            window?.makeFirstResponder(cell.textField)
        }
        setFeedback("有未保存的更改")
        updateControls()
    }

    @objc func removeModel() {
        guard !busy && models.indices.contains(table.selectedRow) else { return }
        window?.makeFirstResponder(nil)
        models.remove(at: table.selectedRow)
        table.reloadData()
        setFeedback(models == savedModels ? "" : "有未保存的更改")
        updateControls()
    }

    @objc func save() { submit(restart: false) }
    @objc func saveAndRestart() { submit(restart: true) }

    func submit(restart: Bool) {
        guard loaded && !busy else { return }
        window?.makeFirstResponder(nil)
        busy = true
        setFeedback(restart ? "正在保存并重启 ChatGPT…" : "正在保存…")
        table.reloadData()
        updateControls()
        sendRequest(["action": "save", "restart": restart,
                     "models": models.map { ["id": $0.id, "context": $0.context] }])
    }

    func receive(_ response: [String: Any]) {
        busy = false
        let ok = response["ok"] as? Bool == true
        if ok || response["saved"] as? Bool == true {
            if let value = response["models"],
               let data = try? JSONSerialization.data(withJSONObject: value),
               let rows = try? JSONDecoder().decode([ModelRow].self, from: data) {
                models = rows
                savedModels = rows
                loaded = true
            }
        }
        if !ok {
            setFeedback(response["error"] as? String ?? "操作失败", error: true)
        } else if response["restarted"] as? Bool == true {
            setFeedback("已保存，ChatGPT 已重启")
        } else if response["saved"] as? Bool == true {
            setFeedback("已保存，点击“保存并重启 ChatGPT”后生效")
        } else {
            setFeedback("")
        }
        table.reloadData()
        updateControls()
    }

    func setFeedback(_ text: String, error: Bool = false) {
        feedback.stringValue = text
        feedback.textColor = error ? .systemRed : .secondaryLabelColor
    }

    func updateControls() {
        addButton.isEnabled = loaded && !busy
        removeButton.isEnabled = loaded && !busy && models.indices.contains(table.selectedRow)
        saveButton.isEnabled = loaded && !busy && models != savedModels
        restartButton.isEnabled = loaded && !busy
        emptyLabel.isHidden = !models.isEmpty || !loaded
        window?.isDocumentEdited = models != savedModels
    }

    func canDiscardChanges() -> Bool {
        guard !busy else { NSSound.beep(); return false }
        window?.makeFirstResponder(nil)
        guard models != savedModels else { return true }
        let alert = NSAlert()
        alert.messageText = "放弃未保存的更改？"
        alert.addButton(withTitle: "继续编辑")
        alert.addButton(withTitle: "放弃更改")
        guard alert.runModal() == .alertSecondButtonReturn else { return false }
        models = savedModels
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { canDiscardChanges() }

    @objc func quitPlugin() {
        guard canDiscardChanges() else { return }
        if parentPID > 1 { kill(parentPID, SIGTERM) }
        NSApp.terminate(nil)
    }
}

#if !STATUS_MENU_TEST
@main
struct StatusMenuApp {
    static func main() {
        func argument(_ name: String) -> String? {
            guard let index = CommandLine.arguments.firstIndex(of: name),
                  index + 1 < CommandLine.arguments.count else { return nil }
            return CommandLine.arguments[index + 1]
        }
        guard let parent = argument("--parent-pid").flatMap(Int32.init), parent > 1,
              let iconPath = argument("--icon-path") else { return }
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let controller = StatusMenuController(parentPID: parent, iconPath: iconPath)
        application.delegate = controller
        DispatchQueue.global(qos: .utility).async {
            while let line = readLine() {
                guard let data = line.data(using: .utf8),
                      let response = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { controller.receive(response) }
            }
            DispatchQueue.main.async { application.terminate(nil) }
        }
        withExtendedLifetime(controller) { application.run() }
    }
}
#endif
