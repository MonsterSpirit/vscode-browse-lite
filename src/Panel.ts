import * as path from 'path'
import type { Disposable, TextDocument, WebviewPanel } from 'vscode'
import { Position, Selection, Uri, ViewColumn, commands, env, window, workspace } from 'vscode'
import { EventEmitter2 } from 'eventemitter2'

import type { BrowserClient } from './BrowserClient'
import type { BrowserPage } from './BrowserPage'
import type { ExtensionConfiguration } from './ExtensionConfiguration'
import { ContentProvider } from './ContentProvider'

export class Panel extends EventEmitter2 {
  private static readonly viewType = 'browse-lite'
  private _panel: WebviewPanel | null
  public disposables: Disposable[] = []
  public url = ''
  public title = ''
  private state = {}
  private contentProvider: ContentProvider
  public browserPage: BrowserPage | null
  private browser: BrowserClient
  public config: ExtensionConfiguration
  public parentPanel: Panel | undefined
  public debugPanel: Panel | undefined
  public disposed = false

  constructor(config: ExtensionConfiguration, browser: BrowserClient, parentPanel?: Panel) {
    super()
    this.config = config
    this._panel = null
    this.browserPage = null
    this.browser = browser
    this.parentPanel = parentPanel
    this.contentProvider = new ContentProvider(this.config)

    if (parentPanel)
      parentPanel.once('disposed', () => this.dispose())
  }

  get isDebugPage() {
    return !!this.parentPanel
  }
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
  public async launch(startUrl?: string) {
    try {
      // 创建一个新的浏览器页面
      this.browserPage = await this.browser.newPage();

      // 如果成功创建了浏览器页面
      if (this.browserPage) {
        // 在浏览器页面上设置消息处理器
        this.browserPage.else((data: any) => {
          // 如果面板存在，将数据发送到面板的 webview
          if (this._panel)
            this._panel.webview.postMessage(data);
        });
      }
    }
    catch (err) {
      // 捕获并显示错误信息
      window.showErrorMessage(err.message);
    }

    // 创建一个新的 webview 面板
    this._panel = window.createWebviewPanel(
      Panel.viewType, // 面板类型
      'Browse Lite', // 面板标题
      this.isDebugPage ? ViewColumn.Three : ViewColumn.Two, // 视图列
      {
        enableScripts: true, // 允许在 webview 中执行脚本
        retainContextWhenHidden: true, // 隐藏时保持上下文
        localResourceRoots: [
          // 指定本地资源根路径
          Uri.file(path.join(this.config.extensionPath, 'dist/client')),
        ],
      },
    );

    // 设置 webview 的 HTML 内容
    this._panel.webview.html = this.contentProvider.getContent(this._panel.webview);

    // 监听面板关闭事件，调用 dispose 方法
    this._panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // 监听面板视图状态变化事件，发出焦点或失去焦点事件
    this._panel.onDidChangeViewState(() => this.emit(this._panel.active ? 'focus' : 'blur'), null, this.disposables);

    // 监听 webview 收到消息的事件
    this._panel.webview.onDidReceiveMessage(
      (msg) => {
        // 处理消息类型为 'extension.updateTitle' 的情况
        if (msg.type === 'extension.updateTitle') {
          this.title = msg.params.title; // 更新标题
          if (this._panel) {
            // 根据调试状态更新面板标题
            this._panel.title = this.isDebugPage ? `DevTools - ${this.parentPanel.title}` : msg.params.title;
            try {
              // 设置面板图标
              this._panel.iconPath = Uri.parse(`https://favicon.yandex.net/favicon/${new URL(this.browserPage?.page.url() || '').hostname}`);
            }
            catch (err) { }
            return;
          }
        }

        // 处理请求打开新窗口的消息
        if (msg.type === 'extension.windowOpenRequested') {
          this.emit('windowOpenRequested', { url: msg.params.url });
          this.url = msg.params.url; // 更新当前 URL
        }

        // 处理打开文件请求的消息
        if (msg.type === 'extension.openFile')
          this.handleOpenFileRequest(msg.params);

        // 处理 JavaScript 对话框请求的消息
        if (msg.type === 'extension.windowDialogRequested') {
          const { message, type } = msg.params;
          if (type == 'alert') {
            // 显示信息提示
            window.showInformationMessage(message);
            if (this.browserPage) {
              // 处理警告对话框
              this.browserPage.send('Page.handleJavaScriptDialog', {
                accept: true,
              });
            }
          }
          else if (type === 'prompt') {
            // 显示输入框提示
            window
              .showInputBox({ placeHolder: message })
              .then((result) => {
                if (this.browserPage) {
                  // 处理输入框对话框
                  this.browserPage.send('Page.handleJavaScriptDialog', {
                    accept: true,
                    promptText: result,
                  });
                }
              });
          }
          else if (type === 'confirm') {
            // 显示确认选择框
            window.showQuickPick(['Ok', 'Cancel']).then((result) => {
              if (this.browserPage) {
                // 处理确认对话框
                this.browserPage.send('Page.handleJavaScriptDialog', {
                  accept: result === 'Ok',
                });
              }
            });
          }
        }

        // 处理应用状态改变的消息
        if (msg.type === 'extension.appStateChanged') {
          this.state = msg.params.state; // 更新状态
          this.emit('stateChanged'); // 发出状态改变事件
        }

        // 如果浏览器页面存在，发送消息到浏览器
        if (this.browserPage) {
          try {
            // 不处理 'extension.appStateChanged' 消息，直接发送其他消息
            if (msg.type !== 'extension.appStateChanged')
              this.browserPage.send(msg.type, msg.params, msg.callbackId);

            // 发出收到的消息类型事件
            this.emit(msg.type, msg.params);
          }
          catch (err) {
            // 捕获并显示错误
            window.showErrorMessage(err);
          }
        }
      },
      null,
      this.disposables,
    );

    // 如果提供了起始 URL，更新配置和当前 URL
    if (startUrl) {
      this.config.startUrl = startUrl;
      this.url = this.url || startUrl;
    }

    // 发送应用配置到 webview
    this._panel.webview.postMessage({
      method: 'extension.appConfiguration',
      result: {
        ...this.config, // 扩展配置
        isDebug: this.isDebugPage, // 调试状态
      },
    });

    // 发出焦点事件
    this.emit('focus');
  }
  // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

  public navigateTo(url: string) {
    this._panel.webview.postMessage({
      method: 'extension.navigateTo',
      result: {
        url,
      },
    })
    this.url = url
  }

  public async createDebugPanel() {
    if (this.isDebugPage)
      return
    if (this.debugPanel)
      return this.debugPanel

    const panel = new Panel(this.config, this.browser, this)
    this.debugPanel = panel
    panel.on('focus', () => {
      commands.executeCommand('setContext', 'browse-lite-debug-active', true)
    })
    panel.on('blur', () => {
      commands.executeCommand('setContext', 'browse-lite-debug-active', false)
    })
    panel.once('disposed', () => {
      commands.executeCommand('setContext', 'browse-lite-debug-active', false)
      this.debugPanel = undefined
    })
    const domain = `${this.config.debugHost}:${this.config.debugPort}`
    await panel.launch(`http://${domain}/devtools/inspector.html?ws=${domain}/devtools/page/${this.browserPage.id}&experiments=true`)
    return panel
  }

  public reload() {
    this.browserPage?.send('Page.reload')
  }

  public goBackward() {
    this.browserPage?.send('Page.goBackward')
  }

  public goForward() {
    this.browserPage?.send('Page.goForward')
  }

  public getState() {
    return this.state
  }

  public openExternal(close = true) {
    if (this.url) {
      env.openExternal(Uri.parse(this.url))
      if (close)
        this.dispose()
    }
  }

  public setViewport(viewport: any) {
    this._panel!.webview.postMessage({
      method: 'extension.viewport',
      result: viewport,
    })
  }

  public show() {
    if (this._panel)
      this._panel.reveal()
  }

  public dispose() {
    this.disposed = true
    if (this._panel)
      this._panel.dispose()

    if (this.browserPage) {
      this.browserPage.dispose()
      this.browserPage = null
    }
    while (this.disposables.length) {
      const x = this.disposables.pop()
      if (x)
        x.dispose()
    }
    this.emit('disposed')
    this.removeAllListeners()
  }

  private handleOpenFileRequest(params: any) {
    const lineNumber = params.lineNumber
    const columnNumber = params.columnNumber | params.charNumber | 0

    const workspacePath = `${workspace.rootPath || ''}/`
    const relativePath = params.fileName.replace(workspacePath, '')

    workspace.findFiles(relativePath, '', 1).then((file) => {
      if (!file || !file.length)
        return

      const firstFile = file[0]

      // Open document
      workspace.openTextDocument(firstFile).then(
        (document: TextDocument) => {
          // Show the document
          window.showTextDocument(document, ViewColumn.One).then(
            (document) => {
              if (lineNumber) {
                // Adjust line position from 1 to zero-based.
                const pos = new Position(-1 + lineNumber, columnNumber)
                document.selection = new Selection(pos, pos)
              }
            },
            (reason) => {
              window.showErrorMessage(`Failed to show file. ${reason}`)
            },
          )
        },
        (err) => {
          window.showErrorMessage(`Failed to open file. ${err}`)
        },
      )
    })
  }
}
