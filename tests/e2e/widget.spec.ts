import { test, expect } from "@playwright/test";
import { testAdmin } from "../fixture";
import { randomUUID } from "node:crypto";
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

test("switching tickets ignores a late history response and updates the selected status", async ({ page, request }) => {
  const projects = await (await request.get("/admin/api/projects", { headers: { Authorization: "Bearer " + testAdmin } })).json();
  const project = projects.find((p: any) => p.code === "letaicode");
  const boot = await (await request.post(`/admin/api/projects/${project.id}/preview`, { headers: { Authorization: "Bearer " + testAdmin } })).json();
  const post = async (path: string, data: unknown) => {
    const response = await request.post('/support/v1' + path, { headers: {
      Authorization: 'Bearer ' + boot.session.token,
      'X-Embed-Origin': boot.embedOrigin,
      'Idempotency-Key': randomUUID(),
    }, data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const a = await post('/conversations', {});
  await post('/tickets', { conversationId: a.id, category: 'technical', description: '工单 A 的问题' });
  const b = await post('/conversations', {});
  await post('/tickets', { conversationId: b.id, category: 'technical', description: '工单 B 的问题' });
  let release!: () => void;
  let historyRequested = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/support/v1/conversations/${a.id}/messages?before=*`, async route => {
    historyRequested = true;
    await gate;
    await route.fulfill({ json: { messages: [{ id: 1, content: '迟到的 A 历史消息', role: 'user', createdAt: 0 }], before: null } });
  });
  await page.route(`**/support/v1/conversations/${b.id}/messages`, async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.conversation.status = 'resolved';
    await route.fulfill({ json: data });
  });
  try {
    await page.goto('/admin');
    await page.getByLabel('管理令牌').fill(testAdmin);
    await page.getByRole('button', { name: '进入项目管理' }).click();
    await page.getByRole('button', { name: '测试项目 letaicode' }).click();
    await page.getByRole('button', { name: '预览客服' }).click();
    const widget = page.frameLocator('iframe[title="客服预览"]');
    await widget.getByRole('button', { name: '▤ 我的工单' }).click();
    await widget.getByRole('button', { name: /工单 A 的问题/ }).click();
    await expect(widget.locator('.messages')).toContainText('工单 A 的问题');
    await widget.getByRole('button', { name: '查看更早消息' }).click();
    await expect.poll(() => historyRequested).toBe(true);
    await widget.getByRole('button', { name: /工单 B 的问题/ }).click();
    await expect(widget.locator('.messages')).toContainText('工单 B 的问题');
    const response = page.waitForResponse(r => r.url().includes(a.id + '/messages?before='));
    release();
    await response;
    await expect(widget.locator('.messages')).not.toContainText('迟到的 A 历史消息');
    await expect(widget.locator('.ticket-item.active')).toContainText('已解决');
  } finally { release(); }
});
