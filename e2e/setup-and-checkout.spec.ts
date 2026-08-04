import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

function md5(parameters: Record<string, string>, key: string) {
  const canonical = Object.entries(parameters)
    .filter(([name, value]) => name !== "sign" && name !== "sign_type" && value !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return createHash("md5").update(`${canonical}${key}`).digest("hex");
}

test("first-run setup, key generation, QR upload and public checkout", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile-chromium", "The full write flow runs once on desktop; mobile has a focused navigation assertion below.");
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "先完成三项基础配置" })).toBeVisible();
  await page.getByLabel("公开访问地址").fill("http://127.0.0.1:3100");
  await page.getByLabel("管理员密码", { exact: true }).fill("Test-password-2026");
  await page.getByLabel("确认密码").fill("Test-password-2026");
  await page.getByRole("button", { name: /创建并进入后台/ }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible();

  await page.getByRole("link", { name: "密钥中心" }).click();
  await page.getByRole("button", { name: "生成应用密钥" }).click();
  const disclosure = page.getByRole("dialog");
  await expect(disclosure.getByText("支付宝应用密钥")).toBeVisible();
  const publicKey = await disclosure.locator("textarea").nth(1).inputValue();
  await disclosure.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "生成商户密钥对" }).click();
  await expect(page.getByRole("dialog").getByText(/私钥只在本次响应中展示/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();

  await page.getByRole("link", { name: "收款配置" }).click();
  await page.getByLabel("应用 ID").fill("2026000000000000");
  await page.getByLabel("支付宝公钥").fill(publicKey);
  await page.getByLabel("经营码图片").setInputFiles({
    name: "business-qr.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByText("已上传", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /保存全部配置/ }).click();
  await expect(page.getByText("配置已保存")).toBeVisible();

  await page.getByRole("link", { name: "密钥中心" }).click();
  await page.getByRole("button", { name: "查看凭据" }).click();
  const credentials = await page.getByRole("dialog").locator("textarea").inputValue();
  const pid = credentials.match(/PID=(\d+)/)?.[1] ?? "";
  const key = credentials.match(/KEY=([^\n]+)/)?.[1] ?? "";
  expect(pid).not.toBe("");
  expect(key).not.toBe("");

  const unsigned = {
    pid,
    type: "alipay",
    out_trade_no: `E2E-${Date.now()}`,
    notify_url: "https://8.8.8.8/notify",
    return_url: "https://8.8.8.8/return",
    name: "E2E order",
    money: "1.00",
    clientip: "203.0.113.10",
    sign_type: "MD5",
  };
  const response = await request.post("/mapi.php", { form: { ...unsigned, sign: md5(unsigned, key) } });
  const responseText = await response.text();
  expect(response.ok(), responseText).toBeTruthy();
  const order = JSON.parse(responseText) as { code: number; payurl: string };
  expect(order.code).toBe(1);
  await page.goto(order.payurl);
  await expect(page.getByRole("heading", { name: "¥1.01" })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByAltText("支付宝经营码")).toBeVisible();
});

test("mobile navigation is usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "Mobile-only assertion");
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
  await page.getByLabel("密码").fill("Test-password-2026");
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "订单" })).toBeVisible();
});
