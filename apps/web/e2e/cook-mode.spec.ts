import { expect, test } from "@playwright/test";

import { VIDEO_ID } from "./fixture";

/**
 * Cook mode, clicked.
 *
 * The reason this suite exists is written into CLAUDE.md: a boundary once left
 * client children rendered, correct-looking and inert, with every other check
 * green. These specs are the ones that would have failed.
 */

test.describe("cook mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/r/${VIDEO_ID}/cook`);
  });

  test("shows the first step and moves through them", async ({ page }) => {
    await expect(page.getByText("Step 1 of 3")).toBeVisible();
    await expect(page.getByText("Warm the oil in a heavy pan.")).toBeVisible();

    // Back is unavailable on the first step rather than a silent no-op.
    await expect(page.getByRole("button", { name: "Previous step" })).toBeDisabled();

    await page.getByRole("button", { name: "Next step" }).click();
    await expect(page.getByText("Step 2 of 3")).toBeVisible();
    await expect(page.getByText("Add the onions and cook until golden.")).toBeVisible();

    await page.getByRole("button", { name: "Previous step" }).click();
    await expect(page.getByText("Step 1 of 3")).toBeVisible();
  });

  test("the last step offers Done rather than a dead end", async ({ page }) => {
    // The bug this replaced: the final step left a disabled "Done" button, at
    // the one moment worth recording.
    await page.getByRole("button", { name: "Next step" }).click();
    await page.getByRole("button", { name: "Next step" }).click();
    await expect(page.getByText("Step 3 of 3")).toBeVisible();

    const done = page.getByRole("button", { name: "Done" });
    await expect(done).toBeVisible();
    await expect(done).toBeEnabled();

    await done.click();
    await expect(page).toHaveURL(new RegExp(`/r/${VIDEO_ID}$`));
  });

  test("arrow keys move between steps", async ({ page, isMobile }) => {
    // Desktop only, and not as a workaround: a Pixel 7 has no arrow keys. The
    // mobile run failed this on the first pass, which is the spec's scope being
    // wrong rather than the app. Keyboard navigation is a real affordance on a
    // laptop propped open in a kitchen, so it is still worth covering there.
    test.skip(isMobile, "no hardware keyboard on a touch device");

    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Step 2 of 3")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByText("Step 1 of 3")).toBeVisible();
  });
});

test.describe("cook mode timers", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/r/${VIDEO_ID}/cook`);
  });

  test("a duration is a control, not a label", async ({ page }) => {
    // The whole point of the feature: BUILD_PLAN §6.1 asked for inline timers
    // and the duration was printed as static text for three phases.
    const timer = page.getByRole("button", { name: /2s/ });
    await expect(timer).toBeVisible();

    await timer.click();
    await expect(page.getByRole("button", { name: /remaining, cancel timer/ })).toBeVisible();
  });

  test("rings when it finishes", async ({ page }) => {
    await page.getByRole("button", { name: /2s/ }).click();

    // The fixture's first step is 2 seconds precisely so this is a spec rather
    // than a minute of waiting.
    const alert = page.getByRole("alertdialog");
    await expect(alert).toBeVisible({ timeout: 10_000 });
    await expect(alert).toContainText("2 seconds up");
    await expect(alert).toContainText("Step 1");

    await page.getByRole("button", { name: "Stop" }).click();
    await expect(alert).toBeHidden();
    // Dismissing resets it, so the same step can be timed again.
    await expect(page.getByRole("button", { name: /2s/ })).toBeVisible();
  });

  test("keeps running when you move to another step", async ({ page }) => {
    // The property that makes timers useful at all: you start a simmer and get
    // on with the next thing. A timer scoped to the visible step would be
    // cancelled by the very action it exists to survive.
    await page.getByRole("button", { name: /3s/ }).isVisible().catch(() => null);

    await page.getByRole("button", { name: /2s/ }).click();
    await page.getByRole("button", { name: "Next step" }).click();

    await expect(page.getByText("Step 2 of 3")).toBeVisible();
    // Now visible in the other-timers strip rather than as the step's own chip.
    await expect(page.getByRole("button", { name: /Cancel the timer on step 1/ })).toBeVisible();
  });

  test("two timers run at once", async ({ page }) => {
    // Rice simmers while the onions fry.
    await page.getByRole("button", { name: /2s/ }).click();
    await page.getByRole("button", { name: "Next step" }).click();
    await page.getByRole("button", { name: /3s/ }).click();

    await expect(page.getByRole("button", { name: /Cancel the timer on step 1/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /remaining, cancel timer/ })).toBeVisible();
  });

  test("a cancelled timer goes away", async ({ page }) => {
    await page.getByRole("button", { name: /2s/ }).click();
    await page.getByRole("button", { name: /remaining, cancel timer/ }).click();
    await expect(page.getByRole("button", { name: /2s/ })).toBeVisible();
  });
});
