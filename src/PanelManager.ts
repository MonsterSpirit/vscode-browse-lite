import type { ExtensionContext, Uri } from 'vscode'
import { commands, workspace } from 'vscode'
import * as EventEmitter from 'eventemitter2'

import { BrowserClient } from './BrowserClient'
import { getConfig, getConfigs } from './Config'
import { Panel } from './Panel'
import type { ExtensionConfiguration } from './ExtensionConfiguration'

export class PanelManager extends EventEmitter.EventEmitter2 {
  public panels: Set<Panel>
  public current: Panel | undefined
  public browser: BrowserClient
  public config: ExtensionConfiguration

  constructor(public readonly ctx: ExtensionContext) {
    super()
    this.panels = new Set()
    this.config = getConfigs(this.ctx)

    this.on('windowOpenRequested', (params) => {
      this.create(params.url)
    })
  }

  private async refreshSettings() {
    const prev = this.config

    this.config = {
      ...getConfigs(this.ctx),
      debugPort: prev.debugPort,
    }
  }

  // +++++++++++++++++++++++++++
  public async create(startUrl: string | Uri = this.config.startUrl) {
    // 刷新设置，以确保当前配置是最新的
    this.refreshSettings();

    // 如果浏览器客户端未初始化，则创建一个新的实例
    if (!this.browser)
      this.browser = new BrowserClient(this.config, this.ctx);

    // 创建一个新的面板实例，并传入配置和浏览器客户端
    const panel = new Panel(this.config, this.browser);

    // 监听面板被关闭（disposed）事件
    panel.once('disposed', () => {
      // 如果当前面板是被关闭的面板，将 current 设置为 undefined
      if (this.current === panel) {
        this.current = undefined;
        // 更新上下文，表示没有活跃面板
        commands.executeCommand('setContext', 'browse-lite-active', false);
      }

      // 从面板集合中移除已关闭的面板
      this.panels.delete(panel);

      // 如果没有剩余的面板，处理浏览器客户端
      if (this.panels.size === 0) {
        this.browser.dispose(); // 释放浏览器资源
        this.browser = null as unknown as BrowserClient; // 将浏览器设置为 null，避免类型错误
      }

      // 触发窗口关闭事件
      this.emit('windowDisposed', panel);
    });

    // 监听请求打开新窗口的事件
    panel.on('windowOpenRequested', (params) => {
      // 触发窗口打开请求事件
      this.emit('windowOpenRequested', params);
    });

    // 监听面板获得焦点的事件
    panel.on('focus', () => {
      this.current = panel; // 设置当前活跃面板
      // 更新上下文，表示当前面板是活跃的
      commands.executeCommand('setContext', 'browse-lite-active', true);
    });

    // 监听面板失去焦点的事件
    panel.on('blur', () => {
      // 如果当前面板是失去焦点的面板，将 current 设置为 undefined
      if (this.current === panel) {
        this.current = undefined;
        // 更新上下文，表示没有活跃面板
        commands.executeCommand('setContext', 'browse-lite-active', false);
      }
    });

    // 将面板添加到面板集合中
    this.panels.add(panel);

    // 启动面板并加载指定的起始 URL
    await panel.launch(startUrl.toString());

    // 触发窗口创建事件
    this.emit('windowCreated', panel);

    // 将面板的 dispose 方法注册到上下文的订阅中，以便在合适时调用
    this.ctx.subscriptions.push({
      dispose: () => panel.dispose(),
    });

    // 返回创建的面板实例
    return panel;
  }
  // +++++++++++++++++++++

  public async createFile(filepath: string) {
    if (!filepath)
      return

    const panel = await this.create(`file://${filepath}`)
    if (getConfig('browse-lite.localFileAutoReload')) {
      panel.disposables.push(
        workspace.createFileSystemWatcher(filepath, true, false, false).onDidChange(() => {
          // TODO: check filename
          panel.reload()
        }),
      )
    }
    return panel
  }

  public disposeByUrl(url: string) {
    this.panels.forEach((b: Panel) => {
      if (b.config.startUrl === url)
        b.dispose()
    })
  }
}
