import { Modal, Notice, Plugin, Setting, type App } from "obsidian";
import { ALLOWED_SIZES } from "./probe/fixtures";
import { LOCAL_NAME, ProbeRunner, uid, type ProbeOptions } from "./probe/runner";

export default class PlatformProbePlugin extends Plugin {
  private session = uid();
  private runner?: ProbeRunner;
  onload(): void {
    this.addCommand({ id: "open-platform-probe", name: "运行移动端可行性探针", callback: () => new ProbeModal(this.app, this).open() });
    this.addCommand({ id: "show-last-probe-report", name: "查看上次探针报告", callback: () => { void this.showLastReport(); } });
  }
  onunload(): void { this.runner?.cancel(); }
  async run(options: ProbeOptions, progress: (text: string) => void): Promise<void> {
    if (this.runner) throw new Error("已有探针在运行");
    this.runner = new ProbeRunner(this.app, this.session);
    try {
      const result = await this.runner.run(options, step => progress(`${step.status}: ${step.name}`));
      progress(`运行结束，仍有真机人工验收项。报告：${result.path}`);
      new ReportModal(this.app, JSON.stringify(result.report, null, 2), result.path).open();
    } finally { this.runner = undefined; }
  }
  cancel(): void { this.runner?.cancel(); }
  private async showLastReport(): Promise<void> {
    try {
      const root = `${this.app.vault.configDir}/${LOCAL_NAME}`;
      const { path } = JSON.parse(await this.app.vault.adapter.read(`${root}/last-run.json`)) as { path: string };
      if (!new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/reports/[a-f0-9]{32}\\.json$`).test(path)) throw new Error("Invalid local report pointer");
      new ReportModal(this.app, await this.app.vault.adapter.read(path), path).open();
    } catch (error) { new Notice(`无法读取报告：${error instanceof Error ? error.message : String(error)}`); }
  }
}

class ProbeModal extends Modal {
  constructor(app: App, private plugin: PlatformProbePlugin) { super(app); }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "ObsidianSync 移动端探针" });
    contentEl.createEl("p", { text: "请在独立空白测试库运行。探针生成假文本、附件和设备本地报告，测量读写与加密耗时。先测 1 MiB，再逐级增加；报告中的待测项需要人工验收。" });
    const options: ProbeOptions = { deviceLabel: "iPhone", model: "", osVersion: "", sizeMiB: 1 };
    for (const [key, label] of [["deviceLabel", "设备名称"], ["model", "机型"], ["osVersion", "系统版本"]] as const) {
      new Setting(contentEl).setName(label).addText(text => text.setValue(options[key]).onChange(value => { options[key] = value; }));
    }
    new Setting(contentEl).setName("本次合成附件大小").addDropdown(dropdown => {
      for (const size of ALLOWED_SIZES) dropdown.addOption(String(size), `${size} MiB`);
      dropdown.setValue("1").onChange(value => { options.sizeMiB = Number(value); });
    });
    let confirmed = false;
    new Setting(contentEl).setName("我已创建独立测试库").addToggle(toggle => toggle.onChange(value => { confirmed = value; }));
    const status = contentEl.createEl("p", { text: "等待运行" });
    new Setting(contentEl).addButton(button => button.setButtonText("开始").setCta().onClick(async () => {
      if (!confirmed) { new Notice("请先在独立测试库运行并勾选确认"); return; }
      button.setDisabled(true);
      try { await this.plugin.run(options, text => { status.setText(text); }); }
      catch (error) { status.setText(`运行失败：${error instanceof Error ? error.message : String(error)}`); }
      finally { button.setDisabled(false); }
    })).addButton(button => button.setButtonText("停止后续步骤").onClick(() => this.plugin.cancel()));
  }
  onClose(): void { this.contentEl.empty(); }
}
class ReportModal extends Modal {
  constructor(app: App, private report: string, private path: string) { super(app); }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: "探针报告" });
    this.contentEl.createEl("p", { text: this.path });
    this.contentEl.createEl("p", { text: "可复制下方 JSON；iPhone 真机结果需要包含机型、系统版本和人工内存/重启证据。" });
    const area = this.contentEl.createEl("textarea"); area.value = this.report; area.readOnly = true;
    area.rows = 20; area.style.width = "100%";
  }
  onClose(): void { this.contentEl.empty(); }
}
