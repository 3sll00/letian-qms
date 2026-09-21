/**
 * preload 桥：在 contextIsolation 开启的前提下，向渲染进程暴露桌面端能力。
 *
 * 主窗口（web 工作台）只消费 getServerUrl / openSettings；
 * 设置窗口（settings/index.html）额外消费 getSettings / saveSettings / testConnection。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', {
  /** 服务器 API 基址（归一化后），未配置返回空串；同步接口，页面模块加载前调用 */
  getServerUrl: (): string => (ipcRenderer.sendSync('config:get-server-url') as string | null) ?? '',
  /** 打开「服务器设置」窗口 */
  openSettings: (): void => {
    ipcRenderer.send('app:open-settings');
  },
  /** 读取当前配置（设置窗口用） */
  getSettings: (): Promise<{ serverUrl: string; normalized: string }> =>
    ipcRenderer.invoke('config:get'),
  /** 保存服务器地址；主进程校验归一化后重新加载主窗口 */
  saveSettings: (serverUrl: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('config:set', serverUrl),
  /** 探测后端 /health 健康检查（主进程发起，绕开渲染进程 CORS 限制） */
  testConnection: (serverUrl: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('config:test', serverUrl),
  /** 客户端版本与运行环境信息 */
  getInfo: (): Promise<{
    version: string;
    electron: string;
    chrome: string;
    node: string;
    platform: string;
    configPath: string;
  }> => ipcRenderer.invoke('app:get-info'),
});
