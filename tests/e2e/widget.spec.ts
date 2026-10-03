import { test, expect } from "@playwright/test";
import { testAdmin } from "../fixture";
test("project admin previews AI questions and submits an asynchronous ticket", async ({
  page,
}) => {
  await page.goto("/admin");
  await page.getByLabel("管理令牌").fill(testAdmin);
  await page.getByRole("button", { name: "进入项目管理" }).click();
  await page.getByRole("button", { name: "测试项目 letaicode" }).click();
  const questions = ["API Key 在哪里创建？", "如何充值？", "支持哪些模型？", "在哪里查看用量？", "如何提交工单？"];
  await page.getByLabel(/预设问题（每行一个/).fill(questions.join("\n"));
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("配置已保存。新项目请先连接机器人，再启用并预览。")).toBeVisible();
  await page.getByRole("button", { name: "预览客服" }).click();
  const widget = page.frameLocator('iframe[title="客服预览"]');
  const presets = widget.locator(".presets button");
  await expect(presets).toHaveCount(3);
  const shown = await presets.allTextContents();
  expect(new Set(shown).size).toBe(3);
  expect(shown.every((text) => questions.includes(text.trim()))).toBe(true);
  await presets.first().click();
  await expect(widget.locator(".assistant .bubble")).toContainText(
    "知识库(letaicode)",
    { timeout: 15000 },
  );
  await page.screenshot({
    path: "test-results/ai-support-desktop.png",
    fullPage: false,
  });
  await widget.getByRole("button", { name: "未解决？提交工单" }).click();
  await widget.getByLabel("问题描述").fill("调用接口仍然失败，请帮忙查看。");
  await widget.getByRole("button", { name: "立即提交" }).click();
  await expect(widget.getByLabel("补充工单")).toBeVisible();
  await expect(widget.locator(".ticket-list")).toContainText(
    "调用接口仍然失败",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/ai-support-mobile.png",
    fullPage: false,
  });
  expect(
    await widget
      .locator("body")
      .evaluate((el) => el.scrollWidth <= window.innerWidth),
  ).toBe(true);
});
