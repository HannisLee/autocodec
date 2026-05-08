import { ScanQueueTab } from "./scan-queue";
import { RulesTab } from "./rules";
import { SettingsTab } from "./settings";

type TabName = "scan" | "rules" | "settings";

export class App {
  currentTab: TabName = "scan";

  constructor() {
    this.initTabs();
    this.renderTab();
  }

  private initTabs(): void {
    const buttons = document.querySelectorAll<HTMLButtonElement>(".tab-btn");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab as TabName;
        this.switchTab(tab);
      });
    });
  }

  switchTab(tab: TabName): void {
    this.currentTab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-tab") === tab);
    });
    this.renderTab();
  }

  private renderTab(): void {
    const content = document.getElementById("tab-content")!;
    switch (this.currentTab) {
      case "scan":
        content.innerHTML = ScanQueueTab.render();
        ScanQueueTab.init();
        break;
      case "rules":
        content.innerHTML = RulesTab.render();
        RulesTab.init();
        break;
      case "settings":
        content.innerHTML = SettingsTab.render();
        SettingsTab.init();
        break;
    }
  }
}
