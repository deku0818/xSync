import { PluginSettingTab, type App, type SettingDefinitionItem } from "obsidian";
import type ObsidianSyncPlugin from "../sync-main";
import { connectionForm } from "./connection-form";

/** Index the approved custom form without reading credentials during search. */
export class SyncSettingTab extends PluginSettingTab {
  private cleanup?: () => void;

  constructor(app: App, private plugin: ObsidianSyncPlugin) { super(app, plugin); }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      name: "同步连接与本机规则",
      desc: "配置客户端名称、服务器地址与访问 key，设置或输入库加密密码；暂停或恢复同步，设置大小、目录、后缀和正则排除规则，查看客户端快照。",
      aliases: ["sync", "server", "endpoint", "key", "password", "pause", "resume", "exclude", "folder", "extension", "regex", "clients", "服务器", "密钥", "暂停", "恢复", "排除", "客户端"],
      render: setting => {
        this.hide();
        setting.settingEl.addClass("oss-settings-row");
        setting.settingEl.empty();
        const dispose = connectionForm(setting.settingEl.createDiv(), this.plugin);
        let closed = false;
        const cleanup = () => {
          if (closed) return;
          closed = true;
          dispose();
          if (this.cleanup === cleanup) this.cleanup = undefined;
        };
        this.cleanup = cleanup;
        return cleanup;
      },
    }];
  }

  hide(): void { this.cleanup?.(); }
}
