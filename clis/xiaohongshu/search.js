/**
 * Xiaohongshu search — DOM-based extraction from search results page.
 * The previous Pinia store + XHR interception approach broke because
 * the API now returns empty items. This version navigates directly to
 * the search results page and extracts data from rendered DOM elements.
 * Ref: https://github.com/jackwener/opencli/issues/10
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
/**
 * Wait for search results or login wall using MutationObserver (max 5s).
 * Returns 'content' if note items appeared, 'login_wall' if login gate
 * detected, or 'timeout' if neither appeared within the deadline.
 *
 * Note-item detection tries the legacy `section.note-item` class first
 * (still observed in many sessions, including rednote) and falls back to
 * a `<section>` element containing a `/search_result/` or `/explore/`
 * link. Issue #1506 reports the class being dropped on some xhs renders.
 */
const WAIT_FOR_CONTENT_JS = `
  new Promise((resolve) => {
    const findNoteCard = () => document.querySelector(
      'section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"])'
    );
    const detect = () => {
      if (findNoteCard()) return 'content';
      if (/登录后查看搜索结果/.test(document.body?.innerText || '')) return 'login_wall';
      return null;
    };
    const found = detect();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const result = detect();
      if (result) { observer.disconnect(); resolve(result); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 5000);
  })
`;
/**
 * Extract approximate publish date from a Xiaohongshu note URL.
 * XHS note IDs follow MongoDB ObjectID format where the first 8 hex
 * characters encode a Unix timestamp (the moment the ID was generated,
 * which closely matches publish time but is not an official API field).
 * e.g. "697f6c74..." → 0x697f6c74 = 1769958516 → 2026-02-01
 */
export function noteIdToDate(url) {
    const match = url.match(/\/(?:search_result|explore|note)\/([0-9a-f]{24})(?=[?#/]|$)/i);
    if (!match)
        return '';
    const hex = match[1].substring(0, 8);
    const ts = parseInt(hex, 16);
    if (!ts || ts < 1_000_000_000 || ts > 4_000_000_000)
        return '';
    // Offset by UTC+8 (China Standard Time) so the date matches what XHS users see
    return new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
}
export function stripXhsAuthorDateSuffix(value) {
    const text = (value || '').replace(/\s+/g, ' ').trim();
    const stripped = text.replace(/\s*(?:\d{1,2}天前|\d+小时前|\d+分钟前|\d+秒前|刚刚|昨天|前天|\d+周前|\d+个月前|\d{1,2}-\d{1,2}|\d{4}-\d{1,2}-\d{1,2})$/u, '').trim();
    return stripped || text;
}
/**
 * `page.evaluate` may return either the raw IIFE value or a
 * `{ session, data }` envelope depending on the browser-bridge version.
 * Adapter code that called `Array.isArray(payload)` directly on the
 * envelope silently received [] for every search. This helper normalizes
 * both shapes so callers can keep their Array.isArray checks unchanged.
 */
export function unwrapEvaluateResult(payload) {
    if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
        return payload.data;
    }
    return payload;
}
function requireSearchRows(payload, phase) {
    const rows = unwrapEvaluateResult(payload);
    if (!Array.isArray(rows)) {
        throw new CommandExecutionError(`Unexpected Xiaohongshu search ${phase} payload shape; expected an array of rows.`);
    }
    return rows;
}
export function parseLimit(raw) {
    const parsed = Number(raw ?? 20);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new ArgumentError(`--limit must be an integer between 1 and 100, got ${JSON.stringify(raw)}`);
    }
    if (parsed < 1 || parsed > 100) {
        throw new ArgumentError(`--limit must be between 1 and 100, got ${parsed}`);
    }
    return parsed;
}
/**
 * Build a "scroll until enough or plateaued" IIFE used in place of a fixed
 * `autoScroll({ times: N })`. Xiaohongshu's search results page lazy-loads
 * ~5-7 notes per scroll, so the previous `times: 2` capped extraction at
 * ~13 items regardless of `--limit` (see #1471). This helper drives scrolls
 * dynamically:
 *
 *   - count visible `section.note-item` rows (excluding related-search
 *     `.query-note-item` rows)
 *   - if count >= targetCount → break (got enough)
 *   - if two consecutive scrolls add no new rows → break (DOM plateaued,
 *     no more lazy-load available)
 *   - hard cap at `maxScrolls` iterations (default 15) to bound runtime
 *
 * Exported so the rednote adapter (same DOM shape) can reuse it.
 */
export function buildScrollUntilJs(targetCount, maxScrolls = 15) {
    if (!Number.isSafeInteger(targetCount) || targetCount < 1) {
        throw new ArgumentError(`targetCount must be a positive integer, got ${JSON.stringify(targetCount)}`);
    }
    if (!Number.isSafeInteger(maxScrolls) || maxScrolls < 1) {
        throw new ArgumentError(`maxScrolls must be a positive integer, got ${JSON.stringify(maxScrolls)}`);
    }
    return `
      (async () => {
        const isVisibleNote = (el) => {
          if (el.classList.contains('query-note-item')) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        };
        // Note containers: legacy \`section.note-item\` first, fallback to
        // any \`<section>\` that wraps a search-result/explore note link
        // (#1506 reports the class being dropped on some xhs renders).
        const collectNoteCards = () => {
          const classMatches = document.querySelectorAll('section.note-item');
          if (classMatches.length > 0) return classMatches;
          const sections = new Set();
          for (const a of document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"]')) {
            const section = a.closest('section');
            if (section) sections.add(section);
          }
          return sections;
        };
        const countItems = () => {
          let count = 0;
          for (const el of collectNoteCards()) {
            if (isVisibleNote(el)) count++;
          }
          return count;
        };

        let lastCount = countItems();
        let plateauRounds = 0;
        for (let i = 0; i < ${maxScrolls}; i++) {
          if (countItems() >= ${targetCount}) break;
          const lastHeight = document.body.scrollHeight;
          window.scrollTo(0, lastHeight);
          await new Promise((resolve) => {
            let to;
            const ob = new MutationObserver(() => {
              if (document.body.scrollHeight > lastHeight) {
                clearTimeout(to);
                ob.disconnect();
                setTimeout(resolve, 1500);
              }
            });
            ob.observe(document.body, { childList: true, subtree: true });
            to = setTimeout(() => { ob.disconnect(); resolve(null); }, 2500);
          });
          const newCount = countItems();
          if (newCount === lastCount) {
            plateauRounds++;
            if (plateauRounds >= 2) break;
          } else {
            plateauRounds = 0;
            lastCount = newCount;
          }
        }
        return countItems();
      })()
    `;
}
/**
 * Build the search-result extraction IIFE. The web host is baked into the
 * `normalizeUrl` fallback so relative `/explore/...` hrefs resolve to a full
 * URL on the calling site. Exported so the rednote adapter can call it with
 * `www.rednote.com` without duplicating the selector logic.
 */
export function buildSearchExtractJs(webHost) {
    return `
      (() => {
        const normalizeUrl = (href) => {
          if (!href) return '';
          if (href.startsWith('http://') || href.startsWith('https://')) return href;
          if (href.startsWith('/')) return 'https://${webHost}' + href;
          return '';
        };

        const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const stripXhsAuthorDateSuffix = ${stripXhsAuthorDateSuffix.toString()};
        const isVisibleNote = (el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        };

        const results = [];
        const seen = new Set();

        // Note containers: legacy \`section.note-item\` first, fallback to any
        // \`<section>\` wrapping a search-result/explore link (#1506 reports the
        // class being dropped on some xhs renders).
        const collectNoteCards = () => {
          const classMatches = document.querySelectorAll('section.note-item');
          if (classMatches.length > 0) return classMatches;
          const sections = new Set();
          for (const a of document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"]')) {
            const section = a.closest('section');
            if (section) sections.add(section);
          }
          return sections;
        };

        for (const el of collectNoteCards()) {
          if (el.classList?.contains('query-note-item')) continue;
          if (!isVisibleNote(el)) continue;

          const titleEl = el.querySelector('.title, .note-title, a.title, .footer .title span');
          const nameEl = el.querySelector('a.author .name, .author-name, .nick-name, .name');
          const authorWrapEl = el.querySelector('a.author');
          let author = cleanText(nameEl?.textContent || '');
          if (!author && authorWrapEl) {
            const nameChild = authorWrapEl.querySelector('.name');
            author = nameChild ? cleanText(nameChild.textContent || '') : stripXhsAuthorDateSuffix(authorWrapEl.textContent || '');
          }
          const likesEl = el.querySelector('.count, .like-count, .like-wrapper .count');
          const timeEl = el.querySelector('.name-time-wrapper .time');
          const detailLinkEl =
            el.querySelector('a.cover.mask') ||
            el.querySelector('a[href*="/search_result/"]') ||
            el.querySelector('a[href*="/explore/"]') ||
            el.querySelector('a[href*="/note/"]');
          const authorLinkEl = el.querySelector('a.author, a[href*="/user/profile/"]');
          const avatarImg = authorLinkEl?.querySelector('img');
          const coverImg = detailLinkEl?.querySelector('img');
          const coverUrl = coverImg ? cleanText(coverImg.getAttribute('src') || '') : '';
          const videoEl = el.querySelector('.video-duration,.play-icon,.badge-video,[class*="video" i]');

          const url = normalizeUrl(detailLinkEl?.getAttribute('href') || '');
          if (!url) continue;

          const key = url;
          if (seen.has(key)) continue;
          seen.add(key);

          let title = cleanText(titleEl?.textContent || '');
          if (!title) {
            const captionSpan = detailLinkEl?.querySelector('span');
            title = cleanText(captionSpan?.textContent || '');
          }

          results.push({
            title,
            author,
            likes: cleanText(likesEl?.textContent || '0'),
            url,
            author_url: normalizeUrl(authorLinkEl?.getAttribute('href') || ''),
            author_avatar: avatarImg ? cleanText(avatarImg.getAttribute('src') || '') : '',
            cover: coverUrl,
            published_at: timeEl ? cleanText(timeEl.textContent) : '',
            type: videoEl ? 'video' : 'normal',
          });
        }

        return results;
      })()
    `;
}
export const command = cli({
    site: 'xiaohongshu',
    name: 'search',
    access: 'read',
    description: '搜索小红书笔记',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
        { name: 'query', required: true, positional: true, help: 'Search keyword' },
        { name: 'limit', type: 'int', default: 20, help: 'Number of results' },
    ],
    columns: ['rank', 'title', 'author', 'likes', 'published_at', 'url'],
    func: async (page, kwargs) => {
        const limit = parseLimit(kwargs.limit);
        const keyword = encodeURIComponent(kwargs.query);
        await page.goto(`https://www.xiaohongshu.com/search_result?keyword=${keyword}&source=web_search_result_notes`);
        // Wait for search results to render (or login wall to appear).
        // Uses MutationObserver to resolve as soon as content appears,
        // instead of a fixed delay + blind retry.
        const waitResult = unwrapEvaluateResult(await page.evaluate(WAIT_FOR_CONTENT_JS));
        if (waitResult === 'login_wall') {
            throw new AuthRequiredError('www.xiaohongshu.com', 'Xiaohongshu search results are blocked behind a login wall');
        }
        // Extract before scrolling. Xiaohongshu uses a virtualized masonry
        // layout, so scrolling to the bottom can evict the initially visible
        // note cards from the DOM and make extraction return [] even though the
        // browser rendered results correctly.
        const initialPayload = requireSearchRows(await page.evaluate(buildSearchExtractJs('www.xiaohongshu.com')), 'initial extraction');
        const payload = [...initialPayload];
        if (payload.length < limit) {
            // Scroll until enough rows are rendered or the lazy-load plateaus.
            // Replaces the previous fixed `autoScroll({ times: 2 })` which capped
            // extraction at ~13 notes regardless of `--limit` (#1471).
            await page.evaluate(buildScrollUntilJs(limit));
            const scrolledPayload = requireSearchRows(await page.evaluate(buildSearchExtractJs('www.xiaohongshu.com')), 'post-scroll extraction');
            const seen = new Set(payload.map((item) => item.url).filter(Boolean));
            for (const item of scrolledPayload) {
                if (item?.url && seen.has(item.url))
                    continue;
                if (item?.url)
                    seen.add(item.url);
                payload.push(item);
                if (payload.length >= limit)
                    break;
            }
        }
        const data = payload;
        return data
            .filter((item) => item.title)
            .slice(0, limit)
            .map((item, i) => ({
            rank: i + 1,
            ...item,
            published_at: noteIdToDate(item.url),
        }));
    },
});
const FILTER_SORT = { general: '综合', latest: '最新', most_liked: '最多点赞', most_commented: '最多评论' };
const FILTER_TIME = { all: '不限', last_one_day: '一天内', last_one_week: '一周内', last_half_year: '半年内' };

export const searchMoreCommand = cli({
    site: 'xiaohongshu',
    name: 'search-more',
    access: 'read',
    description: '搜索或续采小红书笔记（支持筛选）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'query', type: 'string', default: '', positional: true, help: '搜索关键词（第1页必填）' },
        { name: 'page', type: 'int', default: 1, help: '页码' },
        { name: 'limit', type: 'int', default: 30, help: '目标笔记数量' },
        { name: 'note-type', type: 'string', default: 'all', help: '笔记类型: all/image/video' },
        { name: 'time', type: 'string', default: 'all', help: '发布时间: all/last_one_day/last_one_week/last_half_year' },
        { name: 'sort', type: 'string', default: 'general', help: '排序: general/latest/most_liked/most_commented' },
    ],
    columns: ['title', 'author', 'likes', 'type', 'url', 'cover'],
    func: async (page, kwargs) => {
        const pageNum = Math.max(1, Number(kwargs.page ?? 1));
        const limit = parseLimit(kwargs.limit);
        const isFirst = pageNum === 1;

        if (isFirst) {
            const kw = String(kwargs.query || '').trim();
            if (!kw) throw new ArgumentError('query is required for page 1');

            const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}&source=web_search_result_notes`;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            const waitResult = unwrapEvaluateResult(await page.evaluate(WAIT_FOR_CONTENT_JS));
            if (waitResult === 'login_wall') {
                throw new AuthRequiredError('www.xiaohongshu.com', '搜索需要登录');
            }

            const noteType = String(kwargs['note-type'] || 'all');
            if (noteType === 'image' || noteType === 'video') {
                const sel = '#' + noteType + '.channel';
                await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); }, sel);
                await page.wait(1500);
            }

            const sort = String(kwargs.sort || 'general');
            const time = String(kwargs.time || 'all');
            if (sort !== 'general' || time !== 'all') {
                const filterBtn = await page.$('.filter');
                if (filterBtn) {
                    await filterBtn.hover();
                    await page.wait(500);
                    if (sort !== 'general') {
                        const label = FILTER_SORT[sort];
                        if (label) {
                            await page.evaluate((gi, lbl) => {
                                const groups = document.querySelectorAll('.filter-panel .filters');
                                const group = groups[gi];
                                if (!group) return;
                                for (const t of group.querySelectorAll('.tags')) {
                                    if ((t.textContent || '').trim() === lbl) { t.click(); return; }
                                }
                            }, 0, label);
                            await page.wait(1000);
                        }
                    }
                    if (time !== 'all') {
                        const label = FILTER_TIME[time];
                        if (label) {
                            await page.evaluate((gi, lbl) => {
                                const groups = document.querySelectorAll('.filter-panel .filters');
                                const group = groups[gi];
                                if (!group) return;
                                for (const t of group.querySelectorAll('.tags')) {
                                    if ((t.textContent || '').trim() === lbl) { t.click(); return; }
                                }
                            }, 2, label);
                            await page.wait(1000);
                        }
                    }
                }
                await page.wait(1500);
            }

            const initialPayload = requireSearchRows(
                await page.evaluate(buildSearchExtractJs('www.xiaohongshu.com')), 'initial extraction'
            );
            const payload = [...initialPayload];
            if (payload.length < limit) {
                await page.evaluate(buildScrollUntilJs(limit));
                const scrolled = requireSearchRows(
                    await page.evaluate(buildSearchExtractJs('www.xiaohongshu.com')), 'scroll extraction'
                );
                const seen = new Set(payload.map(i => i.url).filter(Boolean));
                for (const item of scrolled) {
                    if (item?.url && seen.has(item.url)) continue;
                    if (item?.url) seen.add(item.url);
                    payload.push(item);
                    if (payload.length >= limit) break;
                }
            }
            const hasMore = await page.evaluate(() => {
                const end = document.querySelector('.end-container.status-container');
                if (end && (end.textContent || '').includes('THE END')) return false;
                return document.querySelectorAll('section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"])').length > 0;
            });

            const ids = payload.map(i => i.url).filter(Boolean);
            await page.evaluate((keyword, initIds) => {
                window.__xhsSearch = { keyword, uniqIds: initIds, page: 1 };
            }, kw, ids);
            if (ids.length > 200) {
                await page.evaluate(() => {
                    const s = window.__xhsSearch;
                    if (s) s.uniqIds = s.uniqIds.slice(-200);
                });
            }

            const items = payload.filter(i => i.title).slice(0, limit);
            return { items, page: 1, has_more: hasMore };
        }

        const state = await page.evaluate(() => {
            const s = window.__xhsSearch;
            return s ? { keyword: s.keyword, uniqIds: s.uniqIds } : null;
        });
        if (!state) {
            throw new CommandExecutionError('搜索会话已过期，请重新从第1页开始搜索');
        }
        const curUrl = await page.evaluate(() => window.location.href);
        if (!curUrl.includes('search_result')) {
            throw new CommandExecutionError('搜索页面已变化，请重新搜索');
        }

        await page.evaluate(buildScrollUntilJs(limit));
        const payload = requireSearchRows(
            await page.evaluate(buildSearchExtractJs('www.xiaohongshu.com')), 'scroll extraction'
        );

        const seenSet = new Set(state.uniqIds);
        const newItems = [];
        for (const item of payload) {
            const key = item.url;
            if (!key || seenSet.has(key)) continue;
            seenSet.add(key);
            newItems.push(item);
            if (newItems.length >= limit) break;
        }

        const newIds = newItems.map(i => i.url).filter(Boolean);
        if (newIds.length > 0) {
            await page.evaluate((addIds) => {
                const s = window.__xhsSearch;
                if (!s) return;
                for (const id of addIds) {
                    if (!s.uniqIds.includes(id)) {
                        s.uniqIds.push(id);
                        if (s.uniqIds.length > 200) s.uniqIds = s.uniqIds.slice(-200);
                    }
                }
            }, newIds);
        }

        const items = newItems.filter(i => i.title).slice(0, limit);
        const hasMore = await page.evaluate(() => {
            const end = document.querySelector('.end-container.status-container');
            if (end && (end.textContent || '').includes('THE END')) return false;
            return document.querySelectorAll('section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"])').length > 0;
        });
        return { items, page: pageNum, has_more: hasMore };
    },
});

export const __test__ = {
    stripXhsAuthorDateSuffix,
};
