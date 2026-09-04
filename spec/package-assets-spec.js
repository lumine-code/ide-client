const fs = require("fs");
const path = require("path");

describe("ide-client package assets", () => {
  const manifest = require("../package.json");

  it("ships one grouped Packages submenu for every workspace command", () => {
    expect(manifest.files).toContain("menus");
    const menu = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "menus", "main.json")));
    expect(Object.keys(menu)).toEqual(["menu"]);
    expect(menu.menu[0].label).toBe("Packages");
    const packageMenu = menu.menu[0].submenu[0];
    expect(packageMenu.label).toBe("IDE Client");
    const groups = [[]];
    for (const item of packageMenu.submenu) {
      if (item.type === "separator") groups.push([]);
      else groups.at(-1).push(item.command);
    }
    expect(groups).toEqual([
      [
        "ide-client:servers",
        "ide-client:manage-servers",
        "ide-client:restart",
        "ide-client:show-log",
        "ide-client:open-custom-servers-file",
      ],
      ["ide-client:toggle-problems", "ide-client:format"],
      [
        "ide-client:fold-server-ranges",
        "ide-client:expand-selection-range",
        "ide-client:select-linked-ranges",
        "ide-client:color-presentation",
      ],
    ]);
    expect(packageMenu.submenu.at(-1).label).toBe("Color Presentation…");
  });

  it("provides document links through the hyperclick service", () => {
    expect(manifest.providedServices["hyperclick.provider"].versions["1.0.0"]).toBe(
      "provideHyperclick",
    );
  });
});
