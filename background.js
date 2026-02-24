// Background Service Worker - Tsun Exporter

const MANGAUPDATES_API = 'https://api.mangaupdates.com/v1';

// Adaptive rate limiting state
let muCurrentDelay = 500;
let muLastRequestTime = 0;

let jikanCurrentDelay = 1200;
let jikanLastRequestTime = 0;

// ──────────────────────────────────────────────────────────
// Message Router
// ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true; // keep channel open for async
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'SCRAPE_PROFILE':
      return await scrapeWeebCentralProfile(message.url);
    case 'SCRAPE_CURRENT_TAB':
      return await scrapeCurrentTabSubscriptions(sender.tab);
    case 'VERIFY_MANGAUPDATES':
      return await verifyWithMangaUpdates(message.titles);
    case 'SEARCH_MANGAUPDATES':
      return await searchMangaUpdates(message.query);
    case 'EXPORT_DATA':
      return await exportData(message.data, message.format);
    case 'GET_CACHE':
      return await getCache();
    case 'CLEAR_CACHE':
      return await clearCache();
    case 'GET_STATS':
      return await getStats();
    case 'SAVE_CUSTOM_MATCH':
      return await saveCustomMatch(message.title, message.match);
    case 'FETCH_SERIES_DETAILS':
      return await fetchSeriesDetails(message.seriesId);
    case 'FAB_CLICKED':
      chrome.action.openPopup();
      return { success: true };
    default:
      throw new Error('Unknown message type: ' + message.type);
  }
}

// ──────────────────────────────────────────────────────────
// WeebCentral Scraper
// ──────────────────────────────────────────────────────────
async function scrapeWeebCentralProfile(profileUrl) {
  try {
    // Determine subscription URL from profile URL
    // Profile: /users/ID/profiles → Subscriptions: /users/ID/library or similar
    const urlObj = new URL(profileUrl);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    const userId = pathParts[1]; // /users/USER_ID/...

    const subscriptionUrls = [
      `https://weebcentral.com/users/${userId}/library`,
      `https://weebcentral.com/users/${userId}/subscriptions`,
      `https://weebcentral.com/lists/favorites?user_id=${userId}`,
    ];

    let allManga = [];
    let successUrl = null;

    for (const url of subscriptionUrls) {
      try {
        const result = await fetchAndParsePage(url);
        if (result && result.length > 0) {
          allManga = result;
          successUrl = url;
          break;
        }
      } catch (e) {
        console.warn('Failed to fetch:', url, e);
      }
    }

    // If those don't work, try paginated fetching from the profile
    if (allManga.length === 0) {
      allManga = await fetchPaginatedSubscriptions(userId);
    }

    await updateStats('scrapes', allManga.length);
    return {
      success: true,
      manga: allManga,
      count: allManga.length,
      sourceUrl: successUrl || profileUrl
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function fetchAndParsePage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();

  return parseSubscriptionHTML(html, url);
}

function parseSubscriptionHTML(html, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const manga = [];

  // WeebCentral subscription/library page selectors
  // Try multiple possible structures
  const selectors = [
    'article[data-series-id]',
    '.manga-item',
    '.series-item',
    'li.subscription',
    '[class*="subscription"]',
    '[class*="library"] a[href*="/series/"]',
    'a[href*="/series/"]',
  ];

  let items = [];
  for (const sel of selectors) {
    items = doc.querySelectorAll(sel);
    if (items.length > 0) break;
  }

  // If items found as series links
  if (items.length > 0) {
    items.forEach(item => {
      const link = item.tagName === 'A' ? item : item.querySelector('a[href*="/series/"]');
      if (!link) return;

      const href = link.getAttribute('href');
      if (!href || !href.includes('/series/')) return;

      // Extract ID and slug from URL like /series/01J76XY.../Manga-Title
      const seriesMatch = href.match(/\/series\/([^/]+)(?:\/([^?#]+))?/);
      if (!seriesMatch) return;

      const seriesId = seriesMatch[1];
      const slug = seriesMatch[2] || '';

      // Get title - try multiple sources
      const titleEl = item.querySelector('h3, h2, h1, .title, [class*="title"], strong');
      const title = titleEl?.textContent?.trim() ||
                    link.getAttribute('title') ||
                    link.textContent?.trim() ||
                    slug.replace(/-/g, ' ');

      if (!title || title.length < 2) return;

      // Get thumbnail
      const img = item.querySelector('img');
      const thumbnail = img?.getAttribute('src') || img?.getAttribute('data-src') || '';

      // Get status/tags
      const statusEl = item.querySelector('[class*="status"], .badge, [class*="tag"]');
      const status = statusEl?.textContent?.trim() || '';

      // Get chapter info
      const chapterEl = item.querySelector('[class*="chapter"], [class*="latest"]');
      const latestChapter = chapterEl?.textContent?.trim() || '';

      manga.push({
        id: seriesId,
        title: title,
        url: href.startsWith('http') ? href : `https://weebcentral.com${href}`,
        thumbnail: thumbnail,
        status: status,
        latestChapter: latestChapter,
        slug: slug,
      });
    });
  }

  return manga;
}

async function fetchPaginatedSubscriptions(userId) {
  const allManga = [];
  let page = 1;
  const maxPages = 50;

  while (page <= maxPages) {
    try {
      const url = `https://weebcentral.com/users/${userId}/library?page=${page}`;
      const res = await fetch(url);
      if (!res.ok) break;

      const html = await res.text();
      const parsed = parseSubscriptionHTML(html, url);

      if (parsed.length === 0) break;

      allManga.push(...parsed);

      // Check if there's a next page
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const nextBtn = doc.querySelector('a[rel="next"], .pagination .next:not(.disabled), [class*="next-page"]');
      if (!nextBtn) break;

      page++;
      await sleep(300); // Rate limiting
    } catch (e) {
      break;
    }
  }

  return allManga;
}

// ──────────────────────────────────────────────────────────
// MangaUpdates Integration
// ──────────────────────────────────────────────────────────
async function verifyWithMangaUpdates(titles) {
  const results = [];
  const cache = await getCache();

  for (let i = 0; i < titles.length; i++) {
    const item = titles[i];
    let result;

    // Check custom matches first
    if (cache.customMatches && cache.customMatches[item.title]) {
      result = { ...item, muMatch: cache.customMatches[item.title], confidence: 1.0, source: 'custom' };
    }
    // Check cache
    else if (cache.muCache && cache.muCache[item.title]) {
      result = { ...item, ...cache.muCache[item.title], source: 'cache' };
    }
    // Fetch from API
    else {
      const match = await searchMangaUpdates(item.title);
      result = { ...item, ...match, source: 'api' };
      if (!cache.muCache) cache.muCache = {};
      cache.muCache[item.title] = match;
    }

    results.push(result);

    // Save cache every 5 items
    if (i % 5 === 0) await chrome.storage.local.set({ muCache: cache.muCache });

    // Per-item progress broadcast
    chrome.runtime.sendMessage({
      type: 'VERIFY_PROGRESS',
      current: i + 1,
      total: titles.length,
      title: item.title,
      matched: !!(result.muMatch && result.confidence >= 0.7)
    }).catch(() => {});

    if (i < titles.length - 1 && result.source === 'api') {
      await sleep(muCurrentDelay);
    }
  }

  // Final cache save
  await chrome.storage.local.set({ muCache: cache.muCache });

  await updateStats('verifications', results.length);
  return { success: true, results };
}



async function searchMangaUpdates(query, retryCount = 0) {
  try {
    // Rate limiting
    const now = Date.now();
    const elapsed = now - muLastRequestTime;
    if (elapsed < muCurrentDelay) await sleep(muCurrentDelay - elapsed);
    muLastRequestTime = Date.now();

    const res = await fetch(`${MANGAUPDATES_API}/series/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search: query, per_page: 5 })
    });

    // Rate limited — back off and retry once
    if (res.status === 429) {
      muCurrentDelay = Math.min(muCurrentDelay + 500, 3000);
      if (retryCount < 2) {
        await sleep(1500);
        return searchMangaUpdates(query, retryCount + 1);
      }
      return { muMatch: null, confidence: 0, muResults: [] };
    }

    // 403 or other error — skip, don't retry (Chrome extension Origin header issue)
    if (!res.ok) {
      console.warn(`[Tsun] MU ${res.status} for "${query}"`);
      return { muMatch: null, confidence: 0, muResults: [] };
    }

    // Speed up on success
    if (muCurrentDelay > 500) muCurrentDelay = Math.max(500, muCurrentDelay - 100);

    const data = await res.json();
    const results = data.results || [];

    if (results.length === 0) {
      return { muMatch: null, confidence: 0, muResults: [] };
    }

    // Calculate confidence for each result using improved algorithm
    const scoredResults = results.map(r => {
      const muTitle = r.record?.title || '';
      const hitTitle = r.hit_title || muTitle; // hit_title is the API's best title match
      const muType = r.record?.type || '';

      // Score using the better of record title vs hit title
      let confidence = Math.max(
        calcConfidence(query, muTitle),
        calcConfidence(query, hitTitle)
      );

      // Type penalty: penalize Doujinshi/Anthology/Novel unless query mentions it
      const qLower = query.toLowerCase();
      if (muType === 'Doujinshi' && !qLower.includes('doujin')) confidence -= 0.5;
      if (muType === 'Anthology' && !qLower.includes('anthology')) confidence -= 0.5;
      if (muType === 'Novel' && !qLower.includes('novel')) confidence -= 0.5;

      return {
        id: r.record?.series_id,
        title: muTitle,
        url: r.record?.url,
        type: muType,
        year: r.record?.year,
        image: r.record?.image?.url?.original || r.record?.image?.url?.thumb,
        confidence: Math.max(0, confidence) // clamp to 0
      };
    });

    scoredResults.sort((a, b) => b.confidence - a.confidence);
    const best = scoredResults[0];

    return {
      muMatch: best.confidence >= 0.4 ? best : null,
      confidence: best.confidence,
      muResults: scoredResults
    };
  } catch (err) {
    console.error('MangaUpdates search error:', err);
    return { muMatch: null, confidence: 0, muResults: [], error: err.message };
  }
}

function calcConfidence(query, target) {
  if (!query || !target) return 0;
  const q = normalize(query);
  const t = normalize(target);

  // Exact match
  if (q === t) return 1.0;

  // Exact match ignoring all non-alphanumeric chars
  const qStripped = q.replace(/[^a-z0-9]/g, '');
  const tStripped = t.replace(/[^a-z0-9]/g, '');
  if (qStripped === tStripped) return 1.0;

  // Containment
  if (t.includes(q) || q.includes(t)) return 0.9;

  // Token-based Jaccard for multi-word titles
  const jaccardScore = jaccardSimilarity(q.split(' '), t.split(' '));

  // Levenshtein for short titles or typo tolerance
  let levScore = 0;
  if (Math.abs(q.length - t.length) < 5) {
    levScore = levenshteinSimilarity(q, t);
  }

  // For very short titles, prefer Levenshtein
  if (q.length < 5 || t.length < 5) return levScore;

  return Math.max(jaccardScore, levScore);
}

function normalize(str) {
  return str.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function levenshteinSimilarity(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  const distance = matrix[b.length][a.length];
  const maxLength = Math.max(a.length, b.length);
  return maxLength === 0 ? 1 : 1 - (distance / maxLength);
}

// ──────────────────────────────────────────────────────────
// Export
// ──────────────────────────────────────────────────────────
async function exportData(data, format) {
  let content, filename;

  switch (format) {
    case 'mangaupdates':
      content = generateMUExport(data);
      filename = `tsun-export-mu-${timestamp()}.txt`;
      break;
    case 'mal':
      content = await generateMALExportAsync(data);
      filename = `tsun-export-mal-${timestamp()}.xml`;
      break;
    default:
      throw new Error('Unknown export format: ' + format);
  }

  // Service workers can't use Blob/URL.createObjectURL — use data URI
  const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true
  });

  await updateStats('exports', 1);
  return { success: true, filename, count: data.length };
}

function generateMUExport(data) {
  const lines = [];
  data.forEach(item => {
    if (item.muMatch?.id) {
      const base36Id = Number(item.muMatch.id).toString(36);
      const slug = (item.muMatch.title || item.title)
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
      lines.push(`https://www.mangaupdates.com/series/${base36Id}/${slug}`);
    }
  });
  return lines.join('\n');
}

async function generateMALExportAsync(data) {
  const entries = [];
  
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    let malId = 0;
    
    try {
      // Rate limiting for Jikan API
      const now = Date.now();
      const elapsed = now - jikanLastRequestTime;
      if (elapsed < jikanCurrentDelay) await sleep(jikanCurrentDelay - elapsed);
      jikanLastRequestTime = Date.now();

      // Search Jikan API
      const query = encodeURIComponent(item.title);
      const res = await fetch(`https://api.jikan.moe/v4/manga?q=${query}&limit=1`);
      
      if (res.ok) {
        const json = await res.json();
        if (json.data && json.data.length > 0) {
          malId = json.data[0].mal_id;
        }
      } else if (res.status === 429) {
        jikanCurrentDelay += 500; // Back off
      }
    } catch (e) {
      console.warn('Jikan API error for:', item.title, e);
    }
    
    chrome.runtime.sendMessage({
      type: 'MAL_EXPORT_PROGRESS',
      current: i + 1,
      total: data.length,
      title: item.title,
      matched: malId > 0
    }).catch(() => {});
    
    // Status mapping (default to Reading, map Completed)
    let myStatus = 'Reading';
    if (item.status && item.status.toLowerCase().includes('completed')) {
      myStatus = 'Completed';
    }
    
    // Chapter extraction
    let chapterNum = '0.000';
    if (item.latestChapter) {
      const match = item.latestChapter.match(/\d+(\.\d+)?/);
      if (match) chapterNum = parseFloat(match[0]).toFixed(3);
    }

    entries.push(`
  <manga>
    <manga_mangadb_id>${malId || ''}</manga_mangadb_id>
    <manga_title><![CDATA[${item.title}]]></manga_title>
    <my_read_volumes>0</my_read_volumes>
    <my_read_chapters>${chapterNum}</my_read_chapters>
    <my_status>${myStatus}</my_status>
    <my_score>0</my_score>
    <update_on_import>1</update_on_import>
  </manga>`);
  }

  return `<myanimelist>
  <myinfo>
    <user_export_type>2</user_export_type>
  </myinfo>${entries.join('')}
</myanimelist>`;
}

function generateCSVExport(data) {
  const headers = ['Title', 'WeebCentral URL', 'MU Title', 'MU ID', 'MU URL', 'Confidence', 'Status'];
  const rows = data.map(item => [
    csvEscape(item.title),
    csvEscape(item.url || ''),
    csvEscape(item.muMatch?.title || ''),
    item.muMatch?.id || '',
    csvEscape(item.muMatch?.url || ''),
    item.confidence != null ? (item.confidence * 100).toFixed(0) + '%' : '',
    csvEscape(item.status || '')
  ]);
  return [headers, ...rows].map(r => r.join(',')).join('\n');
}

function generateMarkdownExport(data) {
  const lines = [
    '# My Manga List (WeebCentral Export)',
    '',
    `> Exported on ${new Date().toLocaleDateString()} | ${data.length} titles`,
    '',
    '| # | Title | Status | MangaUpdates |',
    '|---|-------|--------|--------------|',
  ];
  data.forEach((item, i) => {
    const muLink = item.muMatch?.url ? `[Link](${item.muMatch.url})` : '-';
    lines.push(`| ${i + 1} | [${item.title}](${item.url || '#'}) | ${item.status || 'Unknown'} | ${muLink} |`);
  });
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────
// Series Details
// ──────────────────────────────────────────────────────────
async function fetchSeriesDetails(seriesId) {
  try {
    const url = `https://weebcentral.com/series/${seriesId}`;
    const res = await fetch(url);
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    return {
      success: true,
      description: doc.querySelector('[class*="description"], .synopsis, p.desc')?.textContent?.trim() || '',
      genres: [...doc.querySelectorAll('[class*="genre"] a, [class*="tag"] a')].map(el => el.textContent.trim()),
      author: doc.querySelector('[class*="author"] a, [data-author]')?.textContent?.trim() || '',
      artist: doc.querySelector('[class*="artist"] a, [data-artist]')?.textContent?.trim() || '',
      chapterCount: doc.querySelector('[class*="chapter-count"]')?.textContent?.trim() || '',
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ──────────────────────────────────────────────────────────
// Cache & Storage
// ──────────────────────────────────────────────────────────
async function getCache() {
  const data = await chrome.storage.local.get(['muCache', 'customMatches', 'stats', 'lastScrape']);
  return {
    muCache: data.muCache || {},
    customMatches: data.customMatches || {},
    stats: data.stats || { scrapes: 0, verifications: 0, exports: 0, totalManga: 0 },
    lastScrape: data.lastScrape || null,
  };
}

async function clearCache() {
  await chrome.storage.local.remove(['muCache', 'customMatches', 'lastScrape']);
  return { success: true };
}

async function saveCustomMatch(title, match) {
  const cache = await getCache();
  cache.customMatches[title] = match;
  await chrome.storage.local.set({ customMatches: cache.customMatches });
  return { success: true };
}

async function getStats() {
  const cache = await getCache();
  return cache.stats;
}

async function updateStats(key, count) {
  const cache = await getCache();
  cache.stats[key] = (cache.stats[key] || 0) + count;
  await chrome.storage.local.set({ stats: cache.stats });
}

// ──────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function csvEscape(str) {
  if (!str) return '';
  const s = str.toString();
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
