import { expect, test } from "@playwright/test";

import { VIDEO_ID } from "./fixture";

test.describe("recipe page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/r/${VIDEO_ID}`);
  });

  test("renders the recipe with its attribution", async ({ page }) => {
    // Attribution is non-negotiable (CLAUDE.md): creator name, channel link and
    // an embedded player. Asserted here so a layout change cannot quietly drop
    // the thing the project's legal posture rests on.
    await expect(page.getByRole("heading", { name: "End-to-end Test Curry" })).toBeVisible();
    const channel = page.getByRole("link", { name: "Playwright Kitchen" });
    await expect(channel).toBeVisible();
    await expect(channel).toHaveAttribute("href", /youtube\.com\/channel\//);
    await expect(page.locator("iframe")).toHaveAttribute("src", new RegExp(VIDEO_ID));
  });

  test("scaling runs the real engine", async ({ page }) => {
    const servings = page.getByRole("status");
    await expect(servings).toHaveText("4");
    await expect(page.getByText("2 tbsp")).toBeVisible();

    await page.getByRole("button", { name: "More servings" }).click();
    await page.getByRole("button", { name: "More servings" }).click();

    await expect(servings).toHaveText("6");
    // 2 tbsp of oil at 1.5x is linear: 3 tbsp.
    await expect(page.getByText("3 tbsp")).toBeVisible();
    // A vague quantity must never acquire a number, at any factor. This is the
    // single worst thing the engine could do and it is asserted in the browser
    // as well as in the property tests.
    await expect(page.getByText("to taste")).toBeVisible();
  });

  test("the metric toggle converts what it can and leaves the rest", async ({ page }) => {
    await expect(page.getByText("2 tbsp")).toBeVisible();

    await page.getByRole("button", { name: "Metric" }).click();

    await expect(page.getByText("30 ml")).toBeVisible();
    // "2 onions" is a count and "to taste" is vague: neither has a metric form,
    // and inventing one would be the same failure as inventing a quantity.
    await expect(page.getByText("to taste")).toBeVisible();

    await page.getByRole("button", { name: "As written" }).click();
    await expect(page.getByText("2 tbsp")).toBeVisible();
  });

  test("emits Recipe JSON-LD matching what is rendered", async ({ page }) => {
    // §6.1 calls this the main organic acquisition channel. Structured data
    // that contradicts the visible page is worse than none — it is what gets
    // penalised — so this asserts they agree.
    const raw = await page.locator('script[type="application/ld+json"]').textContent();
    expect(raw).not.toBeNull();
    const jsonLd = JSON.parse(raw!) as Record<string, unknown>;

    expect(jsonLd["@type"]).toBe("Recipe");
    expect(jsonLd.name).toBe("End-to-end Test Curry");
    expect((jsonLd.recipeIngredient as string[]).length).toBe(3);
    expect((jsonLd.recipeInstructions as unknown[]).length).toBe(3);
  });

  test("a video nobody has extracted is a 404", async ({ page }) => {
    const response = await page.goto("/r/zzzzzzzzzzz");
    expect(response?.status()).toBe(404);
  });
});

test.describe("personal edits, signed out", () => {
  // The e2e stack runs with no DATABASE_URL and no auth configured, which is
  // exactly the deployment BUILD_PLAN §6.1 requires to keep working: the whole
  // public surface, with no signup wall. These assert the personal-edit surface
  // added on top of it stays shut to anonymous readers rather than 500ing.

  test("the edit page does not render for a signed-out reader", async ({ page }) => {
    const response = await page.goto(`/r/${VIDEO_ID}/mine`);
    // 404 when accounts are not configured at all, 307 to /signin when they are.
    // Never 200, and never a stack trace.
    expect([307, 404]).toContain(response?.status() ?? 0);
  });

  test("the API refuses an unauthenticated write", async ({ request }) => {
    const response = await request.put(`/api/recipes/${VIDEO_ID}/mine`, {
      data: { videoId: VIDEO_ID, title: "not mine to change" },
    });
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
    // A typed envelope, never a raw exception (CLAUDE.md).
    expect(await response.json()).toHaveProperty("error");
  });

  test("the API refuses an unauthenticated delete", async ({ request }) => {
    const response = await request.delete(`/api/recipes/${VIDEO_ID}/mine`);
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
  });
});
