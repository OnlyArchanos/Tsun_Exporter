// Content Script — Tsun Exporter
// Runs on weebcentral.com pages
// Handles: Subscriptions tab → View More pagination → DOM extraction

(function () {
  "use strict";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── Inject floating action button on profile/library pages ──
  const isRelevantPage =
    /\/(users\/[^/]+\/(library|subscriptions|profiles)|lists\/)/i.test(
      location.pathname,
    );

  if (isRelevantPage) {
    injectActionButton();
  }

  // ── Listen for messages from popup/background ──
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === "GET_PAGE_MANGA") {
      extractAllMangaWithPagination()
        .then((manga) => respond({ manga }))
        .catch((err) => {
          console.error("[Tsun] Extraction error:", err);
          respond({ manga: extractMangaSnapshot() });
        });
      return true;
    }
    if (msg.type === "GET_USER_INFO") {
      respond({ userInfo: extractUserInfo() });
    }
    if (msg.type === "PING") {
      respond({ alive: true, url: location.href });
    }
  });

  // ──────────────────────────────────────────────────────────
  // Full extraction: Subscriptions tab → View More → Extract
  // ──────────────────────────────────────────────────────────
  async function extractAllMangaWithPagination() {
    console.log("[Tsun] Starting full extraction with pagination…");

    // Step 1: Click "Subscriptions (N)" tab and wait for content to load
    await activateSubscriptionsTab();

    // Step 2: Click "View More" repeatedly until all items are loaded
    await clickAllViewMore();

    // Step 3: Extract everything from the fully-loaded DOM
    const manga = extractMangaSnapshot();
    console.log(`[Tsun] Extracted ${manga.length} manga total`);
    return manga;
  }

  // ──────────────────────────────────────────────────────────
  // Step 1: Click the Subscriptions tab
  // The WeebCentral profile page uses Alpine.js + HTMX.
  // The tab is a <button> with text like "Subscriptions (108)"
  // and hx-get that loads content into #profile-content.
  // ──────────────────────────────────────────────────────────
  async function activateSubscriptionsTab() {
    // Check if subscription content is ALREADY visible
    // (user may have clicked it themselves before opening extension)
    const profileContent = document.getElementById("profile-content");

    // Look for a visible "Subscriptions" button that is NOT the active one
    const allButtons = Array.from(document.querySelectorAll("button"));
    const subsButton = allButtons.find((btn) => {
      const text = (btn.textContent || "").trim();
      return (
        text.startsWith("Subscriptions") &&
        text.includes("(") &&
        !btn.classList.contains("menu-active") &&
        btn.offsetParent !== null && // visible
        !btn.hidden
      );
    });

    if (subsButton) {
      console.log("[Tsun] Found Subscriptions tab — clicking…");
      subsButton.click();

      // Wait for HTMX to load subscription content into #profile-content
      // We watch for series links to appear, or a "View More" button
      await waitForSubscriptionContent(15000);
    } else {
      // Check if the active tab is already Subscriptions
      const activeBtn = allButtons.find(
        (btn) =>
          btn.classList.contains("menu-active") &&
          (btn.textContent || "").trim().startsWith("Subscriptions"),
      );
      if (activeBtn) {
        console.log("[Tsun] Subscriptions tab already active");
      } else {
        console.log("[Tsun] No Subscriptions tab found — using current page");
      }
    }
  }

  async function waitForSubscriptionContent(timeout) {
    const start = Date.now();
    const target = document.getElementById("profile-content");

    while (Date.now() - start < timeout) {
      // Check if series links or View More button appeared in #profile-content
      if (target) {
        const hasSeriesLinks = target.querySelectorAll(
          'a[href*="/series/"]',
        ).length;
        const hasViewMore = Array.from(target.querySelectorAll("button")).some(
          (btn) => (btn.textContent || "").trim() === "View More",
        );
        if (hasSeriesLinks > 0 || hasViewMore) {
          console.log(
            `[Tsun] Subscription content loaded (${hasSeriesLinks} items found)`,
          );
          await sleep(300); // brief settle
          return;
        }
      }

      // Also check the page at large for series items
      const pageSeriesLinks = document.querySelectorAll(
        'a[href*="/series/"]',
      ).length;
      if (pageSeriesLinks > 5) {
        console.log(
          `[Tsun] Found ${pageSeriesLinks} series items on page already`,
        );
        await sleep(300);
        return;
      }

      await sleep(250);
    }

    console.warn("[Tsun] Timed out waiting for subscription content");
  }

  // ──────────────────────────────────────────────────────────
  // Step 2: Click "View More" repeatedly
  // ──────────────────────────────────────────────────────────
  async function clickAllViewMore() {
    const MAX_CLICKS = 100;
    let clicks = 0;
    let previousCount = countSeriesItems();

    while (clicks < MAX_CLICKS) {
      const viewMoreBtn = findViewMoreButton();
      if (!viewMoreBtn) {
        console.log(
          `[Tsun] No more "View More" — done after ${clicks} clicks (${countSeriesItems()} items)`,
        );
        break;
      }

      viewMoreBtn.click();
      clicks++;

      if (clicks % 5 === 0) {
        console.log(
          `[Tsun] Clicked View More ${clicks} times (${countSeriesItems()} items)…`,
        );
      }

      // Wait for new items to appear
      const loaded = await waitForNewItems(previousCount, 8000);
      if (loaded) {
        previousCount = countSeriesItems();
      } else {
        // No new items appeared — check if button is still there
        if (findViewMoreButton()) {
          console.log("[Tsun] View More persists but no new items — stopping");
        }
        break;
      }
    }

    await sleep(300);
    console.log(
      `[Tsun] Pagination complete: ${clicks} clicks, ${countSeriesItems()} items`,
    );
  }

  function findViewMoreButton() {
    // Search within #profile-content first, then fall back to whole page
    const containers = [
      document.getElementById("profile-content"),
      document.body,
    ].filter(Boolean);

    for (const container of containers) {
      const buttons = Array.from(container.querySelectorAll("button"));
      const btn = buttons.find(
        (b) =>
          (b.textContent || "").trim() === "View More" &&
          !b.disabled &&
          b.offsetParent !== null,
      );
      if (btn) return btn;
    }
    return null;
  }

  function countSeriesItems() {
    return document.querySelectorAll('a[href*="/series/"]').length;
  }

  async function waitForNewItems(previousCount, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (countSeriesItems() > previousCount) return true;
      await sleep(200);
    }
    return false;
  }

  // ──────────────────────────────────────────────────────────
  // Step 3: Extract manga from the DOM
  // ──────────────────────────────────────────────────────────
  function extractMangaSnapshot() {
    const manga = [];
    const seen = new Set();

    // Skip patterns - these are nav links, not actual series
    const SKIP_PATHS = ['/series/random', '/series/search', '/series/latest'];

    // Strategy 1: Extract from cover image containers (most reliable structure)
    document
      .querySelectorAll('a[href*="/series/"]')
      .forEach((link) => {
        const href = link.getAttribute("href");
        if (!href) return;

        // Skip nav links like /series/random
        if (SKIP_PATHS.some(p => href.includes(p))) return;

        const match = href.match(/\/series\/([^/]+)(?:\/([^?#]+))?/);
        if (!match) return;

        const id = match[1];
        if (seen.has(id)) return;

        // Skip IDs that are obviously not real series IDs (e.g. "random")
        if (id === 'random' || id === 'search' || id === 'latest') return;

        seen.add(id);

        const slug = match[2] || "";

        // Try to get the title from multiple sources
        const img = link.querySelector("img");
        const altTitle = img?.getAttribute("alt")?.replace(/'s avatar$/, "");

        // Look in parent for heading text
        const parent = link.closest("article, div, li, section");
        const headingEl = parent?.querySelector(
          "h1, h2, h3, h4, strong, .title, [class*='title']",
        );
        const headingTitle = headingEl?.textContent?.trim();

        // Use link title attribute
        const linkTitle = link.getAttribute("title");

        // Use link text (if it's not just whitespace)
        const linkText = link.textContent?.trim();
        const hasContent = linkText && linkText.length > 2 && linkText.length < 200;

        const title =
          altTitle ||
          headingTitle ||
          linkTitle ||
          (hasContent ? linkText : null) ||
          slug.replace(/-/g, " ");

        if (!title || title.length < 2) return;

        // Get thumbnail
        const thumbnail =
          img?.getAttribute("src") || img?.getAttribute("data-src") || "";

        manga.push({
          id,
          title,
          url: href.startsWith("http")
            ? href
            : `https://weebcentral.com${href}`,
          thumbnail,
          slug,
          status: "",
          latestChapter: "",
        });
      });

    return manga;
  }

  // ──────────────────────────────────────────────────────────
  // User info extraction
  // ──────────────────────────────────────────────────────────
  function extractUserInfo() {
    const avatar = document.querySelector('.avatar img')?.getAttribute('src') || '';
    const username = document.querySelector('strong.text-4xl, .profile-name, h1')?.textContent?.trim() || '';
    return { avatar, username, url: location.href };
  }

  // ──────────────────────────────────────────────────────────
  // Floating Action Button
  // ──────────────────────────────────────────────────────────
  function injectActionButton() {
    if (document.getElementById("tsun-fab")) return;

    const fab = document.createElement("div");
    fab.id = "tsun-fab";
    fab.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" width="20" height="20">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      </svg>
    `;
    Object.assign(fab.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      width: "48px",
      height: "48px",
      borderRadius: "14px",
      background: "linear-gradient(135deg, #e94560, #c23152)",
      boxShadow: "0 4px 20px rgba(233, 69, 96, 0.35)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      zIndex: "99999",
      transition: "transform 0.2s, box-shadow 0.2s",
    });
    fab.addEventListener("mouseenter", () => {
      fab.style.transform = "scale(1.08)";
      fab.style.boxShadow = "0 6px 28px rgba(233, 69, 96, 0.5)";
    });
    fab.addEventListener("mouseleave", () => {
      fab.style.transform = "scale(1)";
      fab.style.boxShadow = "0 4px 20px rgba(233, 69, 96, 0.35)";
    });
    fab.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "FAB_CLICKED" });
    });
    document.body.appendChild(fab);
  }
})();
