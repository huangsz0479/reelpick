import { app, Menu, type MenuItemConstructorOptions } from 'electron'

/** 中文的应用菜单。「设置…」和它的快捷键 Cmd/Ctrl+, 只能从这里提供 */
export function installMenu(openSettings: () => void): void {
  const isMac = process.platform === 'darwin'
  const separator: MenuItemConstructorOptions = { type: 'separator' }
  const settings: MenuItemConstructorOptions = { label: '设置…', accelerator: 'CmdOrCtrl+,', click: openSettings }
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about', label: `关于${app.name}` },
      separator,
      settings,
      separator,
      { role: 'services', label: '服务' },
      separator,
      { role: 'hide', label: `隐藏${app.name}` },
      { role: 'hideOthers', label: '隐藏其他' },
      { role: 'unhide', label: '全部显示' },
      separator,
      { role: 'quit', label: `退出${app.name}` }
    ]
  }
  const fileMenu: MenuItemConstructorOptions = {
    label: '文件',
    submenu: isMac ? [{ role: 'close', label: '关闭窗口' }] : [settings, separator, { role: 'quit', label: '退出' }]
  }
  // 重新载入会丢掉解析结果和下载列表，只在开发时提供
  const devItems: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [{ role: 'reload', label: '重新载入' }, { role: 'toggleDevTools', label: '开发者工具' }, separator]

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [appMenu] : []),
      fileMenu,
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          separator,
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '拷贝' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' }
        ]
      },
      { label: '显示', submenu: [...devItems, { role: 'togglefullscreen', label: '切换全屏' }] },
      {
        label: '窗口',
        submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, ...(isMac ? [separator, { role: 'front', label: '前置全部窗口' } as const] : [])]
      }
    ])
  )
}
