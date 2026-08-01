import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { appendFileSync } from 'node:fs';
import { buildNoteUrl, parseNoteId } from './note-helpers.js';
import { NOTE_EXTRACT_JS, collectAuthorHoverCardData } from './note.js';
import { buildSearchExtractJs, buildScrollUntilJs, noteIdToDate } from './search.js';

const HOT_NOTES_DEBUG = String(process.env.HOT_NOTES_DEBUG || '1') !== '0';
const HOT_NOTES_LOG_PATH = process.env.HOT_NOTES_LOG_PATH || '/tmp/opencli-hot-notes.log';
function hotNotesDebug(event, payload = {}) {
    if (!HOT_NOTES_DEBUG) return;
    const line = (() => {
        try {
            return `[hot-notes] ${new Date().toISOString()} ${event} ${JSON.stringify(payload)}`;
        } catch {
            return `[hot-notes] ${new Date().toISOString()} ${event} ${String(payload)}`;
        }
    })();
    try {
        console.error(line);
    } catch {
        console.error(`[hot-notes] ${event}`, payload);
    }
    try {
        appendFileSync(HOT_NOTES_LOG_PATH, `${line}\n`, 'utf8');
    } catch {
        // Ignore file logging failures; stderr logging remains available.
    }
}

function splitKeywords(raw) {
    return Array.from(new Set(
        String(raw || '')
            .split(/[\n,;，；、]/)
            .map((s) => s.trim())
            .filter(Boolean),
    ));
}

function parseMetric(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
    const raw = String(value ?? '').replace(/,/g, '').trim();
    if (!raw) return 0;
    const hasWan = /[wW万]/.test(raw);
    const cleaned = raw.replace(/[wW万+＋]/g, '');
    const parsed = Number.parseFloat(cleaned);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.trunc(parsed * (hasWan ? 10000 : 1)));
}

function randomBetween(min, max) {
    const start = Number.isFinite(min) ? min : 0;
    const end = Number.isFinite(max) ? max : start;
    if (end <= start) return start;
    return start + Math.random() * (end - start);
}

async function waitHuman(page, minSeconds, maxSeconds = null, reason = '') {
    const seconds = randomBetween(minSeconds, maxSeconds ?? minSeconds);
    hotNotesDebug('human.wait', {
        reason,
        seconds: Number(seconds.toFixed(3)),
    });
    await page.wait({ time: seconds });
}

async function humanScrollStep(page, {
    minRatio = 0.18,
    maxRatio = 0.34,
    minWait = 0.18,
    maxWait = 0.45,
    reason = '',
} = {}) {
    const state = await page.evaluate(({ minRatio: innerMin, maxRatio: innerMax }) => {
        const viewport = Math.max(400, Math.round(window.innerHeight || 800));
        const ratio = innerMin + Math.random() * Math.max(0, innerMax - innerMin);
        const delta = Math.max(90, Math.round(viewport * ratio));
        const beforeTop = Math.round(window.scrollY || window.pageYOffset || 0);
        const fullHeight = Math.max(
            document.documentElement?.scrollHeight || 0,
            document.body?.scrollHeight || 0,
        );
        window.scrollBy({ top: delta, behavior: 'instant' });
        const afterTop = Math.round(window.scrollY || window.pageYOffset || 0);
        return { beforeTop, afterTop, delta, viewport, fullHeight };
    }, { minRatio, maxRatio });
    hotNotesDebug('human.scroll', {
        reason,
        ...state,
    });
    await waitHuman(page, minWait, maxWait, `${reason || 'scroll'}:settle`);
    return state;
}

async function humanCenterCardPause(page, selector, reason = '') {
    await page.evaluate((targetSelector) => {
        const card = document.querySelector(targetSelector);
        if (!card) return false;
        if (typeof card.scrollIntoView === 'function') {
            card.scrollIntoView({ block: 'center', inline: 'center' });
        }
        return true;
    }, selector);
    await waitHuman(page, 0.22, 0.55, `${reason || 'card'}:preclick`);
}

async function captureSearchListTailState(page) {
    return await page.evaluate(() => {
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const cards = Array.from(document.querySelectorAll(
            'section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"])'
        ));
        const visibleCards = cards.filter((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        });
        const tail = visibleCards.slice(-5).map((el) => {
            const link = el.querySelector('a[href*="/search_result/"], a[href*="/explore/"], a[href*="/note/"]');
            const title = el.querySelector('.title, .note-title, a.title, .footer .title span');
            return {
                url: clean(link?.getAttribute('href') || ''),
                title: clean(title?.textContent || '').slice(0, 60),
            };
        });
        const scrollTop = Math.round(window.scrollY || window.pageYOffset || 0);
        const viewport = Math.max(0, Math.round(window.innerHeight || 0));
        const fullHeight = Math.max(
            document.documentElement?.scrollHeight || 0,
            document.body?.scrollHeight || 0,
        );
        return {
            scrollTop,
            viewport,
            fullHeight,
            atBottom: scrollTop + viewport >= fullHeight - 8,
            visibleCount: visibleCards.length,
            tailSignature: JSON.stringify(tail),
        };
    });
}

async function collectSearchRowsHuman(page, limit) {
    const extractRows = async () => {
        const value = await page.evaluate(buildSearchExtractJs('www.xiaohongshu.com'));
        return Array.isArray(value) ? value : [];
    };
    const merged = [];
    const seen = new Set();
    let idleSteps = 0;
    let previousCount = 0;
    let stuckScrollSteps = 0;
    let stagnantTailSteps = 0;
    let previousTailSignature = '';
    let previousScrollTop = -1;

    for (let step = 0; step < 18 && merged.length < limit; step += 1) {
        const payload = await extractRows();
        for (const item of payload) {
            if (!item?.url || seen.has(item.url)) continue;
            seen.add(item.url);
            merged.push(item);
            if (merged.length >= limit) break;
        }
        const tailState = await captureSearchListTailState(page);
        if (tailState.tailSignature && tailState.tailSignature === previousTailSignature) {
            stagnantTailSteps += 1;
        } else {
            stagnantTailSteps = 0;
            previousTailSignature = tailState.tailSignature || '';
        }
        hotNotesDebug('search.rows.collect_step', {
            step: step + 1,
            limit,
            seenCount: seen.size,
            mergedCount: merged.length,
            payloadCount: payload.length,
            idleSteps,
            stagnantTailSteps,
            stuckScrollSteps,
            scrollTop: tailState.scrollTop,
            viewport: tailState.viewport,
            fullHeight: tailState.fullHeight,
            atBottom: tailState.atBottom,
            tailSignature: tailState.tailSignature,
        });
        if (merged.length >= limit) break;
        if (merged.length === previousCount) idleSteps += 1;
        else idleSteps = 0;
        previousCount = merged.length;
        if (idleSteps >= 2) {
            hotNotesDebug('search.rows.stop', {
                reason: 'no-new-rows',
                step: step + 1,
                mergedCount: merged.length,
                seenCount: seen.size,
            });
            break;
        }
        if (tailState.atBottom && stagnantTailSteps >= 1) {
            hotNotesDebug('search.rows.stop', {
                reason: 'at-bottom-no-tail-change',
                step: step + 1,
                mergedCount: merged.length,
                seenCount: seen.size,
                scrollTop: tailState.scrollTop,
                fullHeight: tailState.fullHeight,
            });
            break;
        }
        if (stagnantTailSteps >= 2) {
            hotNotesDebug('search.rows.stop', {
                reason: 'tail-signature-stagnant',
                step: step + 1,
                mergedCount: merged.length,
                seenCount: seen.size,
                tailSignature: tailState.tailSignature,
            });
            break;
        }
        const scrollState = await humanScrollStep(page, {
            minRatio: 0.16,
            maxRatio: 0.31,
            minWait: 0.22,
            maxWait: 0.5,
            reason: `collect_rows#${step + 1}`,
        });
        if (scrollState.afterTop === scrollState.beforeTop || scrollState.afterTop === previousScrollTop) {
            stuckScrollSteps += 1;
        } else {
            stuckScrollSteps = 0;
        }
        previousScrollTop = scrollState.afterTop;
        if (stuckScrollSteps >= 2) {
            hotNotesDebug('search.rows.stop', {
                reason: 'scroll-position-stuck',
                step: step + 1,
                mergedCount: merged.length,
                seenCount: seen.size,
                beforeTop: scrollState.beforeTop,
                afterTop: scrollState.afterTop,
            });
            break;
        }
    }
    return merged.slice(0, limit);
}

function resolvePublishedAt(row = {}) {
    const rawPublishedAt = pickFirstString(row.published_at, row.publishedAt);
    if (rawPublishedAt) return rawPublishedAt;
    return noteIdToDate(pickFirstString(row.url, row.note_url));
}

const FILTER_SORT = { most_liked: '最多点赞', most_faved: '最多收藏' };
const FILTER_TIME = { all: '不限', last_one_day: '一天内', last_one_week: '一周内', last_half_year: '半年内' };
const FILTER_NOTE_TYPE = { image: '图文', video: '视频' };

function rowsToObject(rows) {
    const out = {};
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object') continue;
        const field = String(row.field || '').trim();
        if (!field) continue;
        out[field] = row.value;
    }
    return out;
}

async function waitForSearchContent(page) {
    const result = await page.evaluate(() => new Promise((resolve) => {
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
            const value = detect();
            if (value) {
                observer.disconnect();
                resolve(value);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
            observer.disconnect();
            resolve('timeout');
        }, 1000);
    }));
    if (result === 'login_wall') {
        throw new AuthRequiredError('www.xiaohongshu.com', 'Xiaohongshu search results are blocked behind a login wall');
    }
}

async function isFilterPanelOpen(page) {
    return !!(await page.evaluate(() => {
        const panel = document.querySelector('.filter-panel');
        if (!panel) return false;
        const style = getComputedStyle(panel);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = panel.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }));
}

async function waitForFilterPanelVisible(page, timeoutMs = 1200) {
    return !!(await page.evaluate((timeout) => new Promise((resolve) => {
        const isOpen = () => {
            const panel = document.querySelector('.filter-panel');
            if (!panel) return false;
            const style = getComputedStyle(panel);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = panel.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        if (isOpen()) return resolve(true);
        const started = Date.now();
        const tick = () => {
            if (isOpen()) return resolve(true);
            if (Date.now() - started >= timeout) return resolve(false);
            setTimeout(tick, 60);
        };
        tick();
    }), timeoutMs));
}

async function waitForFilterPanelHidden(page, timeoutMs = 1200) {
    return !!(await page.evaluate((timeout) => new Promise((resolve) => {
        const isOpen = () => {
            const panel = document.querySelector('.filter-panel');
            if (!panel) return false;
            const style = getComputedStyle(panel);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = panel.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        if (!isOpen()) return resolve(true);
        const started = Date.now();
        const tick = () => {
            if (!isOpen()) return resolve(true);
            if (Date.now() - started >= timeout) return resolve(false);
            setTimeout(tick, 60);
        };
        tick();
    }), timeoutMs));
}

async function captureSearchRowsSignature(page) {
    return await page.evaluate(() => {
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const cards = Array.from(document.querySelectorAll(
            'section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"])'
        ));
        const rows = cards.slice(0, 12).map((el) => {
            const link = el.querySelector('a[href*="/search_result/"], a[href*="/explore/"], a[href*="/note/"]');
            const title = el.querySelector('.title, .note-title, a.title, .footer .title span');
            const like = el.querySelector('.like-wrapper .count');
            return {
                url: clean(link?.getAttribute('href') || ''),
                title: clean(title?.textContent || '').slice(0, 80),
                likes: clean(like?.textContent || ''),
            };
        });
        return JSON.stringify(rows);
    });
}

async function waitForSearchRowsRefresh(page, beforeSignature, reason, timeoutMs = 3500) {
    const changed = await page.evaluate(({ signature, timeout }) => new Promise((resolve) => {
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const getSignature = () => {
            const cards = Array.from(document.querySelectorAll(
                'section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"])'
            ));
            const rows = cards.slice(0, 12).map((el) => {
                const link = el.querySelector('a[href*="/search_result/"], a[href*="/explore/"], a[href*="/note/"]');
                const title = el.querySelector('.title, .note-title, a.title, .footer .title span');
                const like = el.querySelector('.like-wrapper .count');
                return {
                    url: clean(link?.getAttribute('href') || ''),
                    title: clean(title?.textContent || '').slice(0, 80),
                    likes: clean(like?.textContent || ''),
                };
            });
            return JSON.stringify(rows);
        };
        const start = Date.now();
        let stableSince = 0;
        let last = getSignature();
        const tick = () => {
            const current = getSignature();
            if (current !== signature) {
                if (current !== last) {
                    last = current;
                    stableSince = Date.now();
                } else if (stableSince && Date.now() - stableSince >= 350) {
                    resolve({ changed: true, signature: current });
                    return;
                } else if (!stableSince) {
                    stableSince = Date.now();
                }
            }
            if (Date.now() - start >= timeout) {
                resolve({ changed: current !== signature, signature: current });
                return;
            }
            setTimeout(tick, 80);
        };
        tick();
    }), { signature: beforeSignature, timeout: timeoutMs });
    hotNotesDebug('filter.rows_refresh', {
        reason,
        changed: Boolean(changed?.changed),
        timeoutMs,
    });
    return changed;
}

async function ensureFilterPanel(page) {
    if (await isFilterPanelOpen(page)) return;
    await page.evaluate(() => {
        const btn = document.querySelector('.filter');
        if (btn) btn.click();
    });
    if (await waitForFilterPanelVisible(page, 800)) return;
    await page.evaluate(() => {
        const btn = document.querySelector('.filter');
        if (!btn) return;
        for (const type of ['mouseenter', 'mouseover', 'mousemove']) {
            btn.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        }
    });
    await waitForFilterPanelVisible(page, 1200);
}

async function applyFilterByGroupTitle(page, groupTitle, label) {
    return await page.evaluate((title, wanted) => {
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        };
        const isSelected = (tag) => {
            if (!tag) return false;
            if (tag.classList.contains('active')) return true;
            if (tag.getAttribute('aria-selected') === 'true') return true;
            if (tag.getAttribute('data-active') === 'true') return true;
            if (tag.querySelector?.('input:checked')) return true;
            return false;
        };
        const titleAliases = title === '排序依据'
            ? ['排序依据', '排序方式', '排序']
            : [title];
        const groups = Array.from(document.querySelectorAll('.filter-panel .filters'));
        const group = groups.find((node) => {
            const heading = Array.from(node.children)
                .find((child) => child.tagName === 'SPAN');
            return titleAliases.includes(clean(heading?.textContent || ''));
        });
        if (!group) return { foundGroup: false, foundTag: false, active: false };
        const container = group.querySelector('.tag-container');
        if (container) container.scrollIntoView({ block: 'nearest' });
        const visibleTags = Array.from(group.querySelectorAll('.tags, [role="option"], button, .tag'))
            .filter((tag) => isVisible(tag));
        const target = visibleTags.find((tag) => clean(tag.textContent || '') === wanted);
        if (!target) return { foundGroup: true, foundTag: false, active: false };
        if (isSelected(target)) {
            return { foundGroup: true, foundTag: true, active: true, alreadyActive: true };
        }
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
            target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        if (typeof target.click === 'function') {
            target.click();
        }
        return new Promise((resolve) => {
            const started = Date.now();
            const check = () => {
                const active = visibleTags.find((tag) => isSelected(tag));
                if (active && clean(active.textContent || '') === wanted) {
                    resolve({ foundGroup: true, foundTag: true, active: true });
                    return;
                }
                if (Date.now() - started >= 1200) {
                    resolve({
                        foundGroup: true,
                        foundTag: true,
                        active: clean(active?.textContent || '') === wanted,
                    });
                    return;
                }
                setTimeout(check, 60);
            };
            check();
        });
    }, groupTitle, label);
}

async function closeFilterPanel(page) {
    const attempts = [
        () => page.evaluate(() => {
            const selectors = [
                '.filter-panel .operation-container .operation[data-hp-bound]',
                '.filter-panel .operation-container .operation',
                '.filter-panel .operation',
                '.filter-panel button',
                '.filter-panel [role="button"]',
            ];
            const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
            for (const selector of selectors) {
                for (const btn of Array.from(document.querySelectorAll(selector))) {
                    if (!(btn instanceof HTMLElement)) continue;
                    const text = clean(btn.innerText || btn.textContent || '');
                    if (!text || !/完成|确认|收起|关闭|确定/.test(text)) continue;
                    btn.click();
                    return { ok: true, mode: 'button', selector, text };
                }
            }
            return { ok: false, mode: 'button' };
        }),
        () => page.evaluate(() => {
            const trigger = document.querySelector('.filter');
            if (!(trigger instanceof HTMLElement)) return { ok: false, mode: 'toggle' };
            trigger.click();
            return { ok: true, mode: 'toggle', selector: '.filter' };
        }),
        () => page.evaluate(() => {
            const panel = document.querySelector('.filter-panel');
            if (!(panel instanceof HTMLElement)) return { ok: false, mode: 'outside-click' };
            const rect = panel.getBoundingClientRect();
            const x = Math.max(8, Math.round(rect.left) - 24);
            const y = Math.max(8, Math.round(rect.top) + 24);
            const el = document.elementFromPoint(x, y);
            if (!(el instanceof HTMLElement)) return { ok: false, mode: 'outside-click' };
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            return { ok: true, mode: 'outside-click', x, y, tag: el.tagName };
        }),
    ];

    for (let i = 0; i < attempts.length; i += 1) {
        const result = await attempts[i]();
        await waitHuman(page, 0.18, 0.4, `filter_close#${i + 1}`);
        const hidden = await waitForFilterPanelHidden(page, 1000);
        hotNotesDebug('filter.close', {
            attempt: i + 1,
            hidden,
            ...result,
        });
        if (hidden) return true;
    }
    const hidden = await waitForFilterPanelHidden(page, 400);
    hotNotesDebug('filter.close.final', { hidden });
    return hidden;
}

async function findSearchResultCardTarget(page, noteUrl, rowMeta = null) {
    const noteId = parseNoteId(String(noteUrl || ''));
    if (!noteId) return { ok: false, reason: 'note-id-missing' };
    const target = await page.evaluate(({ id, row }) => {
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        };
        const rowTitle = clean(row?.title || '');
        const rowAuthor = clean(row?.author || '');
        const scoreCard = (link, host, selector) => {
            const rect = host.getBoundingClientRect();
            const linkRect = link.getBoundingClientRect();
            const hostText = clean(host.textContent || '');
            const linkText = clean(link.textContent || '');
            let score = 0;
            if (hostText.includes(id) || linkText.includes(id)) score += 40;
            if (rowTitle && hostText.includes(rowTitle)) score += 30;
            if (rowAuthor && hostText.includes(rowAuthor)) score += 20;
            if (String(link.getAttribute('href') || '').includes(id)) score += 50;
            if (rect.width >= 220) score += 3;
            if (rect.height >= 220) score += 3;
            if (linkText.length > 0) score += 1;
            return {
                selector,
                score,
                text: linkText,
                left: Math.round(linkRect.left),
                top: Math.round(linkRect.top),
                width: Math.round(linkRect.width),
                height: Math.round(linkRect.height),
                hostSelector: host?.tagName ? host.tagName.toLowerCase() : '',
                hostText: hostText.slice(0, 240),
                hostLeft: Math.round(rect.left),
                hostTop: Math.round(rect.top),
                hostWidth: Math.round(rect.width),
                hostHeight: Math.round(rect.height),
            };
        };
        const selectors = [
            `a[href*="/search_result/${id}"]`,
            `a[href*="/explore/${id}"]`,
            `a[href*="/note/${id}"]`,
        ];
        const candidates = [];
        for (const selector of selectors) {
            for (const el of Array.from(document.querySelectorAll(selector))) {
                if (!isVisible(el)) continue;
                const host = el.closest('section.note-item, section, article, div') || el;
                candidates.push(scoreCard(el, host, selector));
            }
        }
        if (!candidates.length && (rowTitle || rowAuthor)) {
            const cards = Array.from(document.querySelectorAll('section.note-item, section')).filter((node) => isVisible(node));
            for (const card of cards) {
                const hostText = clean(card.textContent || '');
                if (rowTitle && !hostText.includes(rowTitle)) continue;
                if (rowAuthor && !hostText.includes(rowAuthor)) continue;
                const link = card.querySelector('a[href*="/search_result/"], a[href*="/explore/"], a[href*="/note/"]');
                if (!link || !isVisible(link)) continue;
                candidates.push(scoreCard(link, card, '[data-opencli-hot-match="text"]'));
            }
        }
        candidates.sort((a, b) => {
            return b.score - a.score || a.hostTop - b.hostTop;
        });
        const chosen = candidates[0] || null;
        if (!chosen) return { found: false, reason: 'search-card-not-found', candidates: [] };
        const marker = 'opencliHotNoteTarget';
        for (const prev of document.querySelectorAll(`[data-${marker}]`)) prev.removeAttribute(`data-${marker}`);
        const allLinks = Array.from(document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"], a[href*="/note/"]'));
        const el = allLinks.find((node) => {
            if (!isVisible(node)) return false;
            const href = String(node.getAttribute('href') || '');
            const host = node.closest('section.note-item, section, article, div') || node;
            const rect = host.getBoundingClientRect();
            const text = clean(host.textContent || '');
            if (href.includes(id) && Math.round(rect.left) === chosen.hostLeft && Math.round(rect.top) === chosen.hostTop) return true;
            if (rowTitle && rowAuthor && text.includes(rowTitle) && text.includes(rowAuthor) && Math.round(rect.left) === chosen.hostLeft && Math.round(rect.top) === chosen.hostTop) return true;
            return false;
        }) || allLinks.find((node) => String(node.getAttribute('href') || '').includes(id));
        if (!el) return { found: false, reason: 'search-card-not-found', candidates: [] };
        const card = el.closest('section.note-item, section, article, div') || el;
        if (typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center', inline: 'center' });
        } else if (typeof card.scrollIntoView === 'function') {
            card.scrollIntoView({ block: 'center', inline: 'center' });
        }
        card.setAttribute(`data-${marker}`, '1');
        const linkRect = el.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        return {
            found: true,
            selector: `[data-${marker}="1"]`,
            linkTag: el.tagName,
            linkHref: clean(el.getAttribute('href') || ''),
            linkLeft: Math.round(linkRect.left),
            linkTop: Math.round(linkRect.top),
            linkWidth: Math.round(linkRect.width),
            linkHeight: Math.round(linkRect.height),
            left: Math.round(cardRect.left),
            top: Math.round(cardRect.top),
            width: Math.round(cardRect.width),
            height: Math.round(cardRect.height),
            text: clean(card.textContent || '').slice(0, 200),
            score: chosen.score,
            candidates: candidates.slice(0, 5),
        };
    }, { id: noteId, row: rowMeta || {} });
    return target?.found ? { ok: true, ...target } : { ok: false, reason: target?.reason || 'search-card-not-found' };
}

async function locateSearchResultCardByScroll(page, noteUrl, rowMeta = null, maxSteps = 18) {
    const noteId = parseNoteId(String(noteUrl || ''));
    if (!noteId) return { ok: false, reason: 'note-id-missing' };
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await waitHuman(page, 0.28, 0.52, 'locate:start');
    for (let step = 0; step < maxSteps; step += 1) {
        const attempt = await findSearchResultCardTarget(page, noteUrl, rowMeta);
        if (attempt.ok) return attempt;
        const state = await humanScrollStep(page, {
            minRatio: 0.2,
            maxRatio: 0.38,
            minWait: 0.2,
            maxWait: 0.48,
            reason: `locate_card#${step + 1}`,
        });
    }
    return { ok: false, reason: 'search-card-not-found-after-scroll' };
}

async function clickSearchResultCard(page, noteUrl, rowMeta = null) {
    let target = await findSearchResultCardTarget(page, noteUrl, rowMeta);
    if (!target.ok) {
        target = await locateSearchResultCardByScroll(page, noteUrl, rowMeta);
    }
    if (!target?.ok) {
        return { ok: false, reason: target?.reason || 'search-card-not-found' };
    }
    if (target.selector) {
        await humanCenterCardPause(page, target.selector, 'click_target');
    } else {
        await waitHuman(page, 0.2, 0.45, 'click_target:preclick');
    }

    try {
        if (typeof page.nativeClick === 'function') {
            const clickLeft = Number.isFinite(target.linkLeft) ? target.linkLeft : target.left;
            const clickTop = Number.isFinite(target.linkTop) ? target.linkTop : target.top;
            const clickWidth = Number.isFinite(target.linkWidth) ? target.linkWidth : target.width;
            const clickHeight = Number.isFinite(target.linkHeight) ? target.linkHeight : target.height;
            await page.nativeClick(Math.round(clickLeft + clickWidth / 2), Math.round(clickTop + clickHeight / 2));
        } else {
            await page.evaluate((selector) => {
                const card = document.querySelector(selector);
                if (!card) return false;
                const link = card.querySelector('a[href*="/search_result/"], a[href*="/explore/"], a[href*="/note/"]') || card;
                if (typeof link.scrollIntoView === 'function') {
                    link.scrollIntoView({ block: 'center', inline: 'center' });
                }
                for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
                    link.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                }
                if (typeof link.click === 'function') link.click();
                return true;
            }, target.selector);
        }
        return { ok: true, ...target };
    } catch (error) {
        return { ok: false, reason: String(error?.message || error || 'click-failed') };
    }
}

async function hasNotePopup(page) {
    return !!(await page.evaluate(() => !!document.querySelector('#noteContainer')));
}

async function waitForNotePopup(page, attempts = 8, delaySeconds = 0.35) {
    for (let i = 0; i < attempts; i += 1) {
        const open = await hasNotePopup(page);
        if (open) return true;
        await page.wait({ time: delaySeconds });
    }
    return false;
}

async function closeNotePopup(page) {
    let open = await hasNotePopup(page);
    if (!open) return;

    const closeButtonClicked = await page.evaluate(() => {
        const selectors = [
            '.close',
            '.close-circle',
            '.close-btn',
            '.close-wrapper',
            '[class*="close"]',
            '[aria-label*="关闭"]',
            '[aria-label*="close"]',
        ];
        for (const selector of selectors) {
            const btn = document.querySelector(selector);
            if (!(btn instanceof HTMLElement)) continue;
            btn.click();
            return true;
        }
        return false;
    });
    if (closeButtonClicked) {
        await page.wait({ time: 0.4 });
        open = await hasNotePopup(page);
        if (!open) return;
    }

    const maskClicked = await page.evaluate(() => {
        const mask = document.querySelector('.note-detail-mask');
        if (!(mask instanceof HTMLElement)) return false;
        mask.click();
        return true;
    });
    if (maskClicked) {
        await page.wait({ time: 0.5 });
        open = await hasNotePopup(page);
        if (!open) return;
    }

    const maskRect = await page.evaluate(() => {
        const mask = document.querySelector('.note-detail-mask');
        const popup = document.querySelector('#noteContainer');
        if (!(mask instanceof HTMLElement) || !(popup instanceof HTMLElement)) return null;
        const popupRect = popup.getBoundingClientRect();
        return {
            x: Math.max(10, Math.round(popupRect.left) - 20),
            y: Math.max(10, Math.round(popupRect.top) + 40),
        };
    });
    if (maskRect && typeof page.nativeClick === 'function') {
        await page.nativeClick(maskRect.x, maskRect.y);
        await page.wait({ time: 0.5 });
    }
}

async function collectSearchRows(page, { keyword, limit, noteType, time, sort }) {
    const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForSearchContent(page);

    const needPanel = true;
    if (needPanel) {
        await ensureFilterPanel(page);

        async function applyOneFilter(groupTitle, label, name) {
            for (let i = 0; i < 2; i += 1) {
                await ensureFilterPanel(page);
                const beforeSignature = await captureSearchRowsSignature(page);
                const result = await applyFilterByGroupTitle(page, groupTitle, label);
                hotNotesDebug('filter.apply', {
                    groupTitle,
                    label,
                    name,
                    attempt: i + 1,
                    active: Boolean(result?.active),
                    alreadyActive: Boolean(result?.alreadyActive),
                    foundGroup: Boolean(result?.foundGroup),
                    foundTag: Boolean(result?.foundTag),
                });
                if (result?.alreadyActive) return;
                await page.wait({ time: 0.8 });
                await waitForSearchRowsRefresh(page, beforeSignature, `${name}:${label}`, 3500);
                await page.wait({ time: 0.5 });
                if (result?.active) return;
                if (i === 0 && await isFilterPanelOpen(page)) {
                    await closeFilterPanel(page);
                }
            }
            throw new CommandExecutionError(`${name}「${label}」筛选失败`);
        }

        const sortLabel = FILTER_SORT[sort];
        if (sortLabel) {
            await applyOneFilter('排序依据', sortLabel, '排序');
        }

        if (noteType === 'image' || noteType === 'video') {
            const ntLabel = FILTER_NOTE_TYPE[noteType];
            if (ntLabel) await applyOneFilter('笔记类型', ntLabel, '笔记类型');
        }

        if (time !== 'all') {
            const timeLabel = FILTER_TIME[time];
            if (timeLabel) await applyOneFilter('发布时间', timeLabel, '时间');
        }

        await closeFilterPanel(page);
    }

    const initialExtract = await page.evaluate(buildSearchExtractJs('www.xiaohongshu.com'));
    const initialPayload = Array.isArray(initialExtract) ? initialExtract : [];
    const rows = initialPayload.slice(0, limit);
    rows.sort((a, b) => {
        const aMetric = sort === 'most_faved' ? parseMetric(a?.collects) : parseMetric(a?.likes);
        const bMetric = sort === 'most_faved' ? parseMetric(b?.collects) : parseMetric(b?.likes);
        if (bMetric !== aMetric) return bMetric - aMetric;
        const aTime = parsePublishedAt(resolvePublishedAt(a)) || 0;
        const bTime = parsePublishedAt(resolvePublishedAt(b)) || 0;
        return bTime - aTime;
    });
    hotNotesDebug('search.rows.loaded', {
        keyword,
        limit,
        sort,
        noteType,
        time,
        source: 'visible-only',
        count: rows.length,
        rows: rows.map((row, index) => ({
            index,
            ...briefRow(row),
        })),
    });
    return rows;
}

function parsePublishedAt(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysAgo = (days) => {
        const date = new Date(startOfToday);
        date.setDate(date.getDate() - days);
        return date.getTime();
    };
    if (text === '刚刚') return now.getTime();
    let match = text.match(/^(\d+)\s*秒前$/);
    if (match) return now.getTime() - Number(match[1]) * 1000;
    match = text.match(/^(\d+)\s*分钟前$/);
    if (match) return now.getTime() - Number(match[1]) * 60 * 1000;
    match = text.match(/^(\d+)\s*小时前$/);
    if (match) return now.getTime() - Number(match[1]) * 60 * 60 * 1000;
    match = text.match(/^(\d+)\s*天前(?:\s+\d{1,2}:\d{2})?$/);
    if (match) return daysAgo(Number(match[1]));
    match = text.match(/^(\d+)\s*周前$/);
    if (match) return daysAgo(Number(match[1]) * 7);
    match = text.match(/^(\d+)\s*个月前$/);
    if (match) return daysAgo(Number(match[1]) * 30);
    if (/^昨天(?:\s+\d{1,2}:\d{2})?$/.test(text)) return daysAgo(1);
    if (/^前天(?:\s+\d{1,2}:\d{2})?$/.test(text)) return daysAgo(2);
    match = text.match(/^(\d{1,2})-(\d{1,2})(?:\s+\d{1,2}:\d{2})?$/);
    if (match) {
        const month = Number(match[1]) - 1;
        const day = Number(match[2]);
        const candidate = new Date(now.getFullYear(), month, day);
        if (candidate.getTime() > now.getTime()) {
            candidate.setFullYear(candidate.getFullYear() - 1);
        }
        return candidate.getTime();
    }
    const direct = Date.parse(text);
    if (Number.isFinite(direct)) return direct;
    const normalized = text
        .replace(/年/g, '-')
        .replace(/月/g, '-')
        .replace(/日/g, '')
        .replace(/\//g, '-')
        .replace(/\s+/g, ' ')
        .trim();
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function isWithinDays(publishedAt, daysMax) {
    if (!daysMax || daysMax <= 0) return true;
    const ts = parsePublishedAt(publishedAt);
    if (!ts) return false;
    const diff = Date.now() - ts;
    return diff >= 0 && diff <= daysMax * 24 * 60 * 60 * 1000;
}

function normalizeType(value) {
    const text = String(value || '').toLowerCase();
    if (text.includes('video')) return 'video';
    if (text.includes('image') || text.includes('normal') || text.includes('note')) return 'image';
    return text || '';
}

function pickFirstString(...values) {
    for (const value of values) {
        const text = String(value ?? '').trim();
        if (text) return text;
    }
    return '';
}

function briefRow(row = {}) {
    return {
        title: pickFirstString(row.title).slice(0, 120),
        author: pickFirstString(row.author).slice(0, 80),
        url: pickFirstString(row.url),
        authorUrl: pickFirstString(row.author_url),
        typeRaw: pickFirstString(row.type),
        typeNormalized: normalizeType(row.type),
        likesRaw: pickFirstString(row.likes, '0'),
        likesParsed: parseMetric(row.likes),
        collectsRaw: pickFirstString(row.collects, '0'),
        collectsParsed: parseMetric(row.collects),
        commentsRaw: pickFirstString(row.comments, '0'),
        commentsParsed: parseMetric(row.comments),
        publishedRaw: pickFirstString(row.published_at),
        publishedResolved: resolvePublishedAt(row),
        cover: pickFirstString(row.cover),
    };
}

async function snapshotNotePopupState(page) {
    try {
        return await page.evaluate(() => {
            const brief = (el) => {
                if (!(el instanceof Element)) return null;
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return {
                    tag: el.tagName,
                    cls: typeof el.className === 'string' ? el.className : '',
                    id: el.id || '',
                    text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    display: style.display,
                    visibility: style.visibility,
                    opacity: style.opacity,
                };
            };
            return {
                url: window.location.href || '',
                title: document.title || '',
                popup: brief(document.querySelector('#noteContainer')),
                mask: brief(document.querySelector('.note-detail-mask')),
                tooltip: brief(document.querySelector('.tooltip-content, .user-content, .user-info, .user-card-container')),
                author: brief(document.querySelector('.author-container, .author-wrapper, .author .name, .author-avatar, .username')),
                visibleAuthors: Array.from(document.querySelectorAll(
                    '.author-container, .author-wrapper, .author, .username, .avatar-item, .author-avatar'
                ))
                    .slice(0, 8)
                    .map(brief)
                    .filter(Boolean),
            };
        });
    } catch (error) {
        return { error: String(error?.message || error || 'snapshot-failed') };
    }
}

function parseProfileKey(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const match = text.match(/\/user\/profile\/([^/?#]+)/i);
    if (match) return match[1];
    return '';
}

function pickMetric(...values) {
    for (const value of values) {
        const parsed = parseMetric(value);
        if (parsed > 0) return parsed;
    }
    return 0;
}

function normalizeAuthorRecord(author = {}, searchRow = {}) {
    const profileUrl = pickFirstString(
        author.author_profile_url,
        author.profileUrl,
        author.authorProfileUrl,
        searchRow.author_url,
    );
    const authorId = pickFirstString(
        author.author_id,
        author.authorId,
        parseProfileKey(profileUrl),
        searchRow.author_id,
        parseProfileKey(searchRow.author_url),
    );
    return {
        author_id: authorId,
        author_name: pickFirstString(author.author_name, author.name, author.author, searchRow.author),
        author_avatar: pickFirstString(author.author_avatar, author.avatar, author.authorAvatar, searchRow.author_avatar),
        author_xhs_id: pickFirstString(author.author_xhs_id, author.xhsId, author.authorXhsId),
        author_desc: pickFirstString(author.author_desc, author.desc, author.authorDesc),
        author_fans: pickMetric(author.author_fans, author.fans, author.authorFans),
        author_follows: pickMetric(author.author_follows, author.follows, author.following, author.authorFollows),
        author_interactions: pickMetric(
            author.author_interactions,
            author.interactions,
            author.authorInteractions,
            author.likes_collects,
        ),
        author_profile_url: profileUrl,
    };
}

function mergeAuthorRecord(baseAuthor = {}, overrideAuthor = {}) {
    const base = normalizeAuthorRecord(baseAuthor);
    const override = normalizeAuthorRecord(overrideAuthor);
    const merged = {
        author_id: pickFirstString(override.author_id, base.author_id),
        author_name: pickFirstString(override.author_name, base.author_name),
        author_avatar: pickFirstString(override.author_avatar, base.author_avatar),
        author_xhs_id: pickFirstString(override.author_xhs_id, base.author_xhs_id),
        author_desc: pickFirstString(override.author_desc, base.author_desc),
        author_fans: pickMetric(override.author_fans, base.author_fans),
        author_follows: pickMetric(override.author_follows, base.author_follows),
        author_interactions: pickMetric(override.author_interactions, base.author_interactions),
        author_profile_url: pickFirstString(override.author_profile_url, base.author_profile_url),
    };
    if (!merged.author_id) {
        merged.author_id = pickFirstString(
            parseProfileKey(merged.author_profile_url),
            base.author_id,
            override.author_id,
        );
    }
    return merged;
}

function cacheAuthor(authorCache, noteData, searchRow = {}) {
    const author = normalizeAuthorRecord(noteData, searchRow);

    const keys = [
        author.author_id,
        author.author_xhs_id,
        parseProfileKey(author.author_profile_url),
        parseProfileKey(searchRow.author_url),
    ].filter(Boolean);

    for (const key of keys) {
        authorCache.set(key, author);
    }
    return author;
}

function decodeCursor(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    try {
        const data = JSON.parse(text);
        return data && typeof data === 'object' ? data : null;
    } catch {
        return null;
    }
}

function encodeCursor(state) {
    return JSON.stringify(state);
}

function normalizeCursorState(state) {
    if (!state || typeof state !== 'object') {
        return {
            keyword_index: 0,
            search_page: 1,
            row_index: 0,
            seen_note_ids: [],
            author_cache: {},
        };
    }
    return {
        keyword_index: Math.max(0, Number(state.keyword_index ?? 0)),
        search_page: Math.max(1, Number(state.search_page ?? 1)),
        row_index: Math.max(0, Number(state.row_index ?? 0)),
        seen_note_ids: Array.isArray(state.seen_note_ids) ? state.seen_note_ids.map((v) => String(v || '').trim()).filter(Boolean) : [],
        author_cache: state.author_cache && typeof state.author_cache === 'object' ? state.author_cache : {},
    };
}

function toJsonArray(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    try {
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function buildCandidate(note, searchRow, keyword, keywordIndex, searchRank, authorOverride = null) {
    const noteId = parseNoteId(pickFirstString(note.note_id, searchRow.url, note.note_url));
    const publishedAt = resolvePublishedAt(searchRow);
    const author = mergeAuthorRecord(
        normalizeAuthorRecord(note, searchRow),
        normalizeAuthorRecord(authorOverride || {}, searchRow),
    );
    const likes = parseMetric(note.likes || searchRow.likes);
    const collects = parseMetric(note.collects || searchRow.collects);
    const comments = parseMetric(note.comments || searchRow.comments);
    const shares = parseMetric(note.shares || searchRow.shares);
    const imageUrls = Array.isArray(note.images) ? note.images : toJsonArray(note.images);
    const coverUrl = pickFirstString(note.cover_url, searchRow.cover, imageUrls[0]);
    const authorId = pickFirstString(
        author.author_id,
        note.authorId,
        note.author_id,
        parseProfileKey(author.author_profile_url),
        parseProfileKey(searchRow.author_url),
    );
    const authorProfileUrl = pickFirstString(
        author.author_profile_url,
        note.authorProfileUrl,
        note.author_profile_url,
        searchRow.author_url,
    );
    const rawSearch = {
        ...(searchRow && typeof searchRow === 'object' ? searchRow : {}),
        author_id: pickFirstString(searchRow.author_id, authorId),
        author_url: pickFirstString(searchRow.author_url, authorProfileUrl),
    };
    const rawNote = {
        ...(note && typeof note === 'object' ? note : {}),
        author_id: pickFirstString(note.author_id, note.authorId, authorId),
        author_profile_url: pickFirstString(note.author_profile_url, note.authorProfileUrl, authorProfileUrl),
        author_fans: pickMetric(note.author_fans, note.authorFans, author.author_fans),
        author_follows: pickMetric(note.author_follows, note.authorFollows, author.author_follows),
        author_interactions: pickMetric(note.author_interactions, note.authorInteractions, author.author_interactions),
    };
    return {
        keyword,
        keyword_index: keywordIndex,
        search_rank: searchRank,
        note_id: noteId,
        note_url: pickFirstString(note.note_url, searchRow.url),
        url: pickFirstString(note.note_url, searchRow.url),
        title: pickFirstString(note.title, searchRow.title),
        content: pickFirstString(note.content, searchRow.content),
        type: normalizeType(pickFirstString(note.type, searchRow.type)),
        likes,
        collects,
        comments,
        shares,
        author_name: author.author_name,
        author_avatar: author.author_avatar,
        author_id: authorId,
        author_xhs_id: author.author_xhs_id,
        author_desc: author.author_desc,
        author_fans: author.author_fans,
        author_follows: author.author_follows,
        author_interactions: author.author_interactions,
        author_profile_url: authorProfileUrl,
        published_at: publishedAt,
        timestamp: publishedAt ? Date.parse(publishedAt) || 0 : 0,
        tags: toJsonArray(note.tags),
        image_urls: imageUrls,
        video_url: pickFirstString(note.video_url),
        cover_url: coverUrl,
        raw_search: rawSearch,
        raw_note: rawNote,
    };
}

async function extractNoteDetail(page, noteUrl, cachedAuthor = null, rowMeta = null) {
    const beforePopup = await hasNotePopup(page);
    if (beforePopup) {
        await closeNotePopup(page);
        await page.wait({ time: 0.2 });
    }
    const clickResult = await clickSearchResultCard(page, noteUrl, rowMeta);
    if (!clickResult.ok) {
        throw new CommandExecutionError(clickResult.reason || 'note-popup-click-failed');
    }

    let popupOpen = await waitForNotePopup(page, 6, 0.35);
    if (!popupOpen && typeof page.nativeClick === 'function') {
        const clickLeft = Number.isFinite(clickResult.linkLeft) ? clickResult.linkLeft : clickResult.left;
        const clickTop = Number.isFinite(clickResult.linkTop) ? clickResult.linkTop : clickResult.top;
        const retries = [
            { x: Math.round(clickLeft + 10), y: Math.round(clickTop + 10) },
            { x: Math.round(clickLeft + 30), y: Math.round(clickTop + 24) },
            { x: Math.round(clickLeft + 16), y: Math.round(clickTop + 42) },
        ];
        for (const point of retries) {
            await page.nativeClick(point.x, point.y);
            await page.wait({ time: 0.9 });
            popupOpen = await hasNotePopup(page);
            if (popupOpen) break;
        }
    }

    if (!popupOpen) {
        throw new CommandExecutionError('note-popup-not-opened');
    }

    try {
        await page.wait({ time: 2 + Math.random() * 3 });
        const detail = await page.evaluate(NOTE_EXTRACT_JS);
        if (!detail || typeof detail !== 'object') {
            throw new CommandExecutionError('Unexpected note detail payload');
        }
        if (detail.securityBlock) {
            throw new AuthRequiredError('www.xiaohongshu.com', 'Note detail page was blocked by risk control');
        }
        if (detail.loginWall) {
            throw new AuthRequiredError('www.xiaohongshu.com', 'Note content requires login');
        }
        if (detail.notFound) {
            throw new CommandExecutionError('Note not found or unavailable');
        }
        if (!cachedAuthor) {
            const { hoverCardData, hoverComplete } = await collectAuthorHoverCardData(page, {
                authorId: detail.authorId || '',
                profileUrl: detail.authorProfileUrl || '',
                name: detail.author || '',
            });
            if (!hoverComplete && !cachedAuthor) {
                throw new CommandExecutionError('hover-data-incomplete');
            }
            cachedAuthor = hoverCardData?.found
                ? normalizeAuthorRecord(hoverCardData, { author_url: detail.authorProfileUrl || '' })
                : null;
        } else {
            cachedAuthor = normalizeAuthorRecord(cachedAuthor, { author_url: detail.authorProfileUrl || '' });
        }
        const mergedAuthor = mergeAuthorRecord(
            normalizeAuthorRecord(detail, { author_url: detail.authorProfileUrl || '' }),
            cachedAuthor || {},
        );
        return { detail, cachedAuthor };
    } finally {
        await closeNotePopup(page).catch(() => {});
    }
}

function hitSummary(item) {
    return `${item.keyword || ''}#${item.search_rank || 0} ${item.title || ''}`.trim();
}

export const command = cli({
    site: 'xiaohongshu',
    name: 'hot-notes',
    access: 'read',
    description: '逐个关键词挖掘爆款小红书笔记，只返回命中条件的结果',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
        { name: 'keywords', required: true, positional: true, help: '多个关键词，支持用逗号、分号或换行分隔' },
        { name: 'cursor', type: 'string', default: '', help: '分页游标，留空表示从头开始' },
        { name: 'timeout', type: 'int', default: 210, help: '命令整体超时秒数（默认 210，内部 +30s padding）' },
        { name: 'scan-limit', type: 'int', default: 50, help: '每个关键词最多扫描多少条搜索结果' },
        { name: 'hit-limit', type: 'int', default: 20, help: '最终最多返回多少条命中结果' },
        { name: 'likes-min', type: 'int', default: 500, help: '点赞下限' },
        { name: 'collects-min', type: 'int', default: 0, help: '收藏下限' },
        { name: 'fans-min', type: 'int', default: 0, help: '作者粉丝下限' },
        { name: 'fans-max', type: 'int', default: 10000, help: '作者粉丝上限（0 表示不限制）' },
        { name: 'sort', type: 'string', default: 'most_liked', help: '排序: most_liked/most_faved' },
        { name: 'note-type', type: 'string', default: 'all', help: '笔记类型: all/image/video' },
        { name: 'time', type: 'string', default: 'last_one_week', help: '发布时间: all/last_one_day/last_one_week/last_half_year' },
        { name: 'pause-seconds', type: 'float', default: 2, help: '每个关键词执行完后的停顿秒数' },
    ],
    columns: ['keyword', 'title', 'author_name', 'likes', 'collects', 'author_fans', 'published_at', 'url'],
    func: async (page, kwargs) => {
        const keywordList = splitKeywords(kwargs.keywords);
        if (keywordList.length === 0) {
            throw new CommandExecutionError('至少需要一个关键词');
        }

        const scanLimit = Math.max(1, Number(kwargs['scan-limit'] ?? 50));
        const hitLimit = Math.max(1, Number(kwargs['hit-limit'] ?? 20));
        const likesMin = Math.max(0, Number(kwargs['likes-min'] ?? 500));
        const collectsMin = Math.max(0, Number(kwargs['collects-min'] ?? 0));
        const fansMin = Math.max(0, Number(kwargs['fans-min'] ?? 0));
        const fansMaxRaw = Math.max(0, Number(kwargs['fans-max'] ?? 10000));
        const fansMax = fansMaxRaw > 0 ? fansMaxRaw : 0;
        const sort = String(kwargs.sort ?? 'most_liked');
        const noteType = String(kwargs['note-type'] ?? 'all');
        const time = String(kwargs.time ?? 'last_one_week');
        const pauseSeconds = Math.max(0, Number(kwargs['pause-seconds'] ?? 2));
        if (sort !== 'most_liked' && sort !== 'most_faved') {
            throw new CommandExecutionError('爆款挖掘只支持 most_liked / most_faved 两种排序');
        }
        if (sort === 'most_liked' && collectsMin > 0) {
            throw new CommandExecutionError('点赞排序只允许设置点赞阈值，收藏阈值必须为 0');
        }
        if (sort === 'most_faved' && likesMin > 0) {
            throw new CommandExecutionError('收藏排序只允许设置收藏阈值，点赞阈值必须为 0');
        }
        const activeThreshold = sort === 'most_faved' ? collectsMin : likesMin;
        const timeDays = { all: 0, last_one_day: 1, last_one_week: 7, last_half_year: 180 }[time] || 0;
        const cursorState = normalizeCursorState(decodeCursor(kwargs.cursor));
        const startKeywordIndex = Math.min(cursorState.keyword_index || 0, keywordList.length);
        const startSearchPage = Math.max(1, cursorState.search_page || 1);
        let startRowIndex = cursorState.row_index || 0;

        const results = [];
        const seenNoteIds = new Set(cursorState.seen_note_ids);
        const authorCache = new Map(
            Object.entries(cursorState.author_cache || {})
                .filter(([, value]) => value && typeof value === 'object')
        );
        const keywordStats = [];
        let nextCursor = null;

        hotNotesDebug('run.start', {
            keywords: keywordList,
            cursor: cursorState,
            scanLimit,
            hitLimit,
            likesMin,
            collectsMin,
            fansMin,
            fansMax,
            sort,
            noteType,
            time,
            pauseSeconds,
        });

        outer: for (let keywordIndex = startKeywordIndex; keywordIndex < keywordList.length; keywordIndex += 1) {
            const keyword = keywordList[keywordIndex];
            hotNotesDebug('keyword.start', {
                keywordIndex,
                keyword,
                page: keywordIndex === startKeywordIndex ? startSearchPage : 1,
                rowStart: keywordIndex === startKeywordIndex ? startRowIndex : 0,
                hitCount: results.length,
                cacheSize: authorCache.size,
                seenCount: seenNoteIds.size,
            });
            const rows = await collectSearchRows(page, {
                keyword,
                limit: scanLimit,
                noteType,
                time,
                sort,
            });
            hotNotesDebug('keyword.rows', {
                keywordIndex,
                keyword,
                rows: rows.length,
                searchPage: keywordIndex === startKeywordIndex ? startSearchPage : 1,
            });
            let keywordHits = 0;
            let scanned = 0;
            let belowThresholdStreak = 0;
            let keywordStatSaved = false;
            let thresholdSkipped = 0;
            let timeSkipped = 0;
            let detailAttempts = 0;
            let clickAttempts = 0;
            let detailSuccess = 0;

            const rowStart = keywordIndex === startKeywordIndex ? startRowIndex : 0;
            startRowIndex = 0;
            const currentSearchPage = keywordIndex === startKeywordIndex ? startSearchPage : 1;

            for (let i = rowStart; i < rows.length && scanned < scanLimit && results.length < hitLimit; i += 1) {
                const row = rows[i];
                if (!row || typeof row !== 'object') continue;
                scanned += 1;

                const rowType = normalizeType(row.type);
                const typePass = noteType === 'all' || noteType === rowType || (noteType === 'image' && rowType === 'normal');
                const rowLikes = parseMetric(row.likes);
                const rowCollects = parseMetric(row.collects);
                const rowPublishedAt = resolvePublishedAt(row);
                const thresholdBasis = sort === 'most_faved' ? rowCollects : rowLikes;
                const thresholdPass = thresholdBasis >= activeThreshold;
                const timePass = isWithinDays(rowPublishedAt, timeDays);
                hotNotesDebug('row.inspect', {
                    keywordIndex,
                    keyword,
                    rowIndex: i,
                    noteId: parseNoteId(String(row.url || '')),
                    noteUrl: row.url || '',
                    row: briefRow(row),
                    decision: {
                        noteTypeWanted: noteType,
                        rowType,
                        typePass,
                        sort,
                        activeThreshold,
                        thresholdBasis,
                        thresholdPass,
                        timeRange: time,
                        timeDays,
                        timePass,
                        rowPublishedAt,
                        parsedPublishedAt: parsePublishedAt(rowPublishedAt),
                    },
                });
                if (!typePass) {
                    hotNotesDebug('row.skip.type', {
                        keywordIndex,
                        keyword,
                        rowIndex: i,
                        noteId: parseNoteId(String(row.url || '')),
                        noteUrl: row.url || '',
                        row: briefRow(row),
                        noteTypeWanted: noteType,
                        rowType,
                    });
                    continue;
                }
                if (sort === 'most_liked' && rowLikes < activeThreshold) {
                    belowThresholdStreak += 1;
                    thresholdSkipped += 1;
                    hotNotesDebug('row.skip.threshold', {
                        keywordIndex,
                        keyword,
                        rowIndex: i,
                        noteId: parseNoteId(String(row.url || '')),
                        noteUrl: row.url || '',
                        row: briefRow(row),
                        rowLikes,
                        rowCollects,
                        activeThreshold,
                        streak: belowThresholdStreak,
                        sort,
                    });
                    continue;
                }
                if (sort === 'most_faved' && rowCollects < activeThreshold) {
                    belowThresholdStreak += 1;
                    thresholdSkipped += 1;
                    hotNotesDebug('row.skip.threshold', {
                        keywordIndex,
                        keyword,
                        rowIndex: i,
                        noteId: parseNoteId(String(row.url || '')),
                        noteUrl: row.url || '',
                        row: briefRow(row),
                        rowLikes,
                        rowCollects,
                        activeThreshold,
                        streak: belowThresholdStreak,
                        sort,
                    });
                    continue;
                }
                belowThresholdStreak = 0;
                if (!isWithinDays(rowPublishedAt, timeDays)) {
                    timeSkipped += 1;
                    hotNotesDebug('row.skip.time', {
                        keywordIndex,
                        keyword,
                        rowIndex: i,
                        noteId: parseNoteId(String(row.url || '')),
                        noteUrl: row.url || '',
                        row: briefRow(row),
                        rowPublishedAt,
                        parsedPublishedAt: parsePublishedAt(rowPublishedAt),
                        timeDays,
                        timeRange: time,
                    });
                    continue;
                }

                try {
                    detailAttempts += 1;
                    const authorKey = parseProfileKey(row.author_url);
                    const cachedAuthor = authorKey ? authorCache.get(authorKey) : null;
                    clickAttempts += 1;
                    const { detail, cachedAuthor: hoverAuthor } = await extractNoteDetail(page, row.url, cachedAuthor || null, row);
                    detailSuccess += 1;
                    const noteData = buildCandidate(detail, row, keyword, keywordIndex + 1, i + 1, hoverAuthor || cachedAuthor || null);
                    const authorRecord = hoverAuthor || cachedAuthor || null;
                    if (authorRecord || noteData.author_fans > 0 || noteData.author_id || noteData.author_profile_url) {
                        cacheAuthor(authorCache, noteData, row);
                    }
                    const hotFansOk = noteData.author_fans >= fansMin && (fansMax === 0 || noteData.author_fans <= fansMax);
                    if (!hotFansOk) {
                        hotNotesDebug('row.skip.post_detail', {
                            keywordIndex,
                            keyword,
                            rowIndex: i,
                            noteId: noteData.note_id,
                            row: briefRow(row),
                            hotFansOk,
                            authorFans: noteData.author_fans,
                            likes: noteData.likes,
                            collects: noteData.collects,
                            notePublishedAt: noteData.published_at || '',
                        });
                        continue;
                    }
                    if (seenNoteIds.has(noteData.note_id)) {
                        hotNotesDebug('row.skip.duplicate', {
                            keywordIndex,
                            keyword,
                            rowIndex: i,
                            noteId: noteData.note_id,
                        });
                        continue;
                    }
                    seenNoteIds.add(noteData.note_id);
                    results.push(noteData);
                    keywordHits += 1;
                    if (results.length >= hitLimit) {
                        keywordStats.push({
                            keyword,
                            scanned,
                            hits: keywordHits,
                        });
                        keywordStatSaved = true;
                        nextCursor = encodeCursor({
                            keyword_index: keywordIndex,
                            search_page: currentSearchPage,
                            row_index: i + 1,
                            seen_note_ids: Array.from(seenNoteIds),
                            author_cache: Object.fromEntries(authorCache),
                        });
                        hotNotesDebug('cursor.next', {
                            keywordIndex,
                            keyword,
                            searchPage: currentSearchPage,
                            rowIndex: i + 1,
                            nextCursor,
                            cacheSize: authorCache.size,
                            seenCount: seenNoteIds.size,
                        });
                        break outer;
                    }
                } catch (error) {
                    const message = String(error?.message || error || '');
                    hotNotesDebug('row.error', {
                        keywordIndex,
                        keyword,
                        rowIndex: i,
                        noteUrl: row.url || '',
                        message,
                    });
                    if (/login/i.test(message)) {
                        throw new AuthRequiredError('www.xiaohongshu.com', '爆款挖掘需要登录');
                    }
                    continue;
                }
            }

            if (!keywordStatSaved) {
                keywordStats.push({
                    keyword,
                    scanned,
                    hits: keywordHits,
                });
            }

            hotNotesDebug('keyword.done', {
                keywordIndex,
                keyword,
                scanned,
                thresholdSkipped,
                timeSkipped,
                detailAttempts,
                clickAttempts,
                detailSuccess,
                hits: keywordHits,
                nextCursor: Boolean(nextCursor),
                cacheSize: authorCache.size,
                seenCount: seenNoteIds.size,
            });

            if (!nextCursor && rows.length >= scanLimit) {
                nextCursor = encodeCursor({
                    keyword_index: keywordIndex,
                    search_page: currentSearchPage + 1,
                    row_index: 0,
                    seen_note_ids: Array.from(seenNoteIds),
                    author_cache: Object.fromEntries(authorCache),
                });
                hotNotesDebug('cursor.next', {
                    keywordIndex,
                    keyword,
                    searchPage: currentSearchPage + 1,
                    rowIndex: 0,
                    nextCursor,
                    reason: 'row_limit_reached',
                });
                break;
            }

            if (!nextCursor && keywordIndex < keywordList.length - 1 && pauseSeconds > 0) {
                hotNotesDebug('keyword.pause', {
                    keywordIndex,
                    keyword,
                    pauseSeconds,
                });
                await page.wait({ time: pauseSeconds });
            }
        }

        hotNotesDebug('run.done', {
            hitCount: results.length,
            nextCursor: Boolean(nextCursor),
            cacheSize: authorCache.size,
            seenCount: seenNoteIds.size,
            keywordStats,
        });

        return {
            items: results,
            total: results.length,
            total_hits: results.length,
            has_more: Boolean(nextCursor),
            next_cursor: nextCursor,
            keywords: keywordStats,
            config: {
                scan_limit: scanLimit,
                hit_limit: hitLimit,
                likes_min: likesMin,
                collects_min: collectsMin,
                fans_min: fansMin,
                fans_max: fansMax,
                sort,
                note_type: noteType,
                time,
                pause_seconds: pauseSeconds,
            },
            columns: ['keyword', 'title', 'author_name', 'likes', 'collects', 'author_fans', 'published_at', 'url'],
            hits: results.map(hitSummary),
        };
    },
});
