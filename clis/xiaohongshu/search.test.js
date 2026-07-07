import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { JSDOM } from 'jsdom';
import { __test__, buildScrollUntilJs, noteIdToDate, unwrapEvaluateResult } from './search.js';

function markVisible(el) {
    el.getBoundingClientRect = () => ({ width: 100, height: 100 });
}
function createPageMock(evaluateResults) {
    const evaluate = vi.fn();
    for (const result of evaluateResults) {
        evaluate.mockResolvedValueOnce(result);
    }
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate,
        snapshot: vi.fn().mockResolvedValue(undefined),
        click: vi.fn().mockResolvedValue(undefined),
        typeText: vi.fn().mockResolvedValue(undefined),
        pressKey: vi.fn().mockResolvedValue(undefined),
        scrollTo: vi.fn().mockResolvedValue(undefined),
        getFormState: vi.fn().mockResolvedValue({ forms: [], orphanFields: [] }),
        wait: vi.fn().mockResolvedValue(undefined),
        tabs: vi.fn().mockResolvedValue([]),
        selectTab: vi.fn().mockResolvedValue(undefined),
        networkRequests: vi.fn().mockResolvedValue([]),
        consoleMessages: vi.fn().mockResolvedValue([]),
        scroll: vi.fn().mockResolvedValue(undefined),
        autoScroll: vi.fn().mockResolvedValue(undefined),
        installInterceptor: vi.fn().mockResolvedValue(undefined),
        getInterceptedRequests: vi.fn().mockResolvedValue([]),
        getCookies: vi.fn().mockResolvedValue([]),
        screenshot: vi.fn().mockResolvedValue(''),
        waitForCapture: vi.fn().mockResolvedValue(undefined),
    };
}
describe('xiaohongshu search', () => {
    it('rejects invalid limit before browser navigation', async () => {
        const cmd = getRegistry().get('xiaohongshu/search');
        const page = createPageMock([]);

        await expect(cmd.func(page, { query: '特斯拉', limit: 0 })).rejects.toMatchObject({
            code: 'ARGUMENT',
            message: expect.stringContaining('--limit'),
        });
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('throws a clear error when the search page is blocked by a login wall', async () => {
        const cmd = getRegistry().get('xiaohongshu/search');
        expect(cmd?.func).toBeTypeOf('function');
        const page = createPageMock([
            // First evaluate: MutationObserver wait (login wall detected)
            'login_wall',
        ]);
        await expect(cmd.func(page, { query: '特斯拉', limit: 5 })).rejects.toThrow('Xiaohongshu search results are blocked behind a login wall');
        // No scroll-until / autoScroll call when a login wall is detected early.
        expect(page.evaluate).toHaveBeenCalledTimes(1);
        expect(page.autoScroll).not.toHaveBeenCalled();
    });
    it('unwraps a browser-bridge envelope before handling login-wall wait result', async () => {
        const cmd = getRegistry().get('xiaohongshu/search');
        const page = createPageMock([
            { session: 'site:xiaohongshu', data: 'login_wall' },
        ]);

        await expect(cmd.func(page, { query: '特斯拉', limit: 5 })).rejects.toMatchObject({
            code: 'AUTH_REQUIRED',
            message: expect.stringContaining('blocked behind a login wall'),
        });
        expect(page.evaluate).toHaveBeenCalledTimes(1);
    });
    it('returns ranked results with search_result url and author_url preserved', async () => {
        const cmd = getRegistry().get('xiaohongshu/search');
        expect(cmd?.func).toBeTypeOf('function');
        const detailUrl = 'https://www.xiaohongshu.com/search_result/68e90be80000000004022e66?xsec_token=test-token&xsec_source=';
        const authorUrl = 'https://www.xiaohongshu.com/user/profile/635a9c720000000018028b40?xsec_token=user-token&xsec_source=pc_search';
        const rows = [
            {
                title: '某鱼买FSD被坑了4万',
                author: '随风',
                likes: '261',
                url: detailUrl,
                author_url: authorUrl,
            },
        ];
        const page = createPageMock([
            // First evaluate: MutationObserver wait (content appeared)
            'content',
            // Second evaluate: initial DOM extraction (already enough results) through Browser Bridge envelope.
            { session: 'site:xiaohongshu', data: rows },
        ]);
        const result = await cmd.func(page, { query: '特斯拉', limit: 1 });
        // Should only do one goto (the search page itself), no per-note detail navigation
        expect(page.goto.mock.calls).toHaveLength(1);
        expect(result).toEqual([
            {
                rank: 1,
                title: '某鱼买FSD被坑了4万',
                author: '随风',
                likes: '261',
                published_at: '2025-10-10',
                url: detailUrl,
                author_url: authorUrl,
            },
        ]);
    });
    it('fails typed instead of silently returning [] for malformed extraction payloads', async () => {
        const cmd = getRegistry().get('xiaohongshu/search');
        const page = createPageMock([
            'content',
            { session: 'site:xiaohongshu', data: { rows: [] } },
        ]);

        await expect(cmd.func(page, { query: '测试', limit: 1 })).rejects.toMatchObject({
            code: 'COMMAND_EXEC',
            message: expect.stringContaining('payload shape'),
        });
    });
    it('filters out results with no title and respects the limit', async () => {
        const cmd = getRegistry().get('xiaohongshu/search');
        expect(cmd?.func).toBeTypeOf('function');
        const page = createPageMock([
            // First evaluate: MutationObserver wait (content appeared)
            'content',
            // Second evaluate: initial DOM extraction (already enough valid rows)
            [
                {
                    title: 'Result A',
                    author: 'UserA',
                    likes: '10',
                    url: 'https://www.xiaohongshu.com/search_result/aaa',
                    author_url: '',
                },
                {
                    title: '',
                    author: 'UserB',
                    likes: '5',
                    url: 'https://www.xiaohongshu.com/search_result/bbb',
                    author_url: '',
                },
                {
                    title: 'Result C',
                    author: 'UserC',
                    likes: '3',
                    url: 'https://www.xiaohongshu.com/search_result/ccc',
                    author_url: '',
                },
            ],
        ]);
        const result = (await cmd.func(page, { query: '测试', limit: 1 }));
        // limit=1 should return only the first valid-titled result
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ rank: 1, title: 'Result A' });
    });
    it('waits for content via MutationObserver before extracting', async () => {
        const cmd = getRegistry().get('xiaohongshu/search');
        expect(cmd?.func).toBeTypeOf('function');
        const page = createPageMock([
            // First evaluate: MutationObserver wait (content appeared)
            'content',
            // Second evaluate: initial extraction (no rows rendered)
            [],
            // Third evaluate: scroll-until row count
            0,
            // Fourth evaluate: post-scroll extraction (still no rows)
            [],
        ]);
        const result = (await cmd.func(page, { query: '测试等待', limit: 5 }));
        expect(result).toHaveLength(0);
        // Only one navigation, no retry
        expect(page.goto).toHaveBeenCalledTimes(1);
        // Four evaluate calls: wait, initial extraction, scroll-until, post-scroll extraction.
        expect(page.evaluate).toHaveBeenCalledTimes(4);
    });
    it('scrolls only when the initial extraction has fewer rows than requested', async () => {
        const cmd = getRegistry().get('xiaohongshu/search');
        expect(cmd?.func).toBeTypeOf('function');
        const page = createPageMock([
            'content',
            [
                { title: 'Result A', author: 'UserA', likes: '10', url: 'https://www.xiaohongshu.com/search_result/aaa', author_url: '' },
            ],
            3,
            [
                { title: 'Result A', author: 'UserA', likes: '10', url: 'https://www.xiaohongshu.com/search_result/aaa', author_url: '' },
                { title: 'Result B', author: 'UserB', likes: '5', url: 'https://www.xiaohongshu.com/search_result/bbb', author_url: '' },
            ],
        ]);

        const result = (await cmd.func(page, { query: '测试等待', limit: 2 }));

        expect(result).toHaveLength(2);
        expect(result.map((item) => item.title)).toEqual(['Result A', 'Result B']);
        expect(page.evaluate).toHaveBeenCalledTimes(4);
    });
    it('separates fallback author text from appended relative date', async () => {
        const cmd = getRegistry().get('xiaohongshu/search');
        expect(cmd?.func).toBeTypeOf('function');
        const dom = new JSDOM(`
          <section class="note-item">
            <a class="cover mask" href="/search_result/68e90be80000000004022e66?xsec_token=test-token"></a>
            <div class="title">数字作者测试</div>
            <a class="author" href="/user/profile/author123">
              <span>数字3天前端</span><span>3天前</span>
            </a>
            <span class="count">8</span>
          </section>
        `, { url: 'https://www.xiaohongshu.com/search_result?keyword=test' });
        markVisible(dom.window.document.querySelector('section.note-item'));
        const page = createPageMock([]);
        page.evaluate.mockImplementationOnce(async () => 'content');
        page.evaluate.mockImplementationOnce(async (script) => Function('document', 'getComputedStyle', `return (${script})`)(dom.window.document, dom.window.getComputedStyle.bind(dom.window)));

        const result = await cmd.func(page, { query: '测试', limit: 1 });

        expect(result[0]).toMatchObject({
            title: '数字作者测试',
            author: '数字3天前端',
            likes: '8',
            author_url: 'https://www.xiaohongshu.com/user/profile/author123',
        });
    });
});
describe('xiaohongshu search-notes filters', () => {
    it('applies filters by group title instead of hard-coded group index', async () => {
        const cmd = getRegistry().get('xiaohongshu/search-notes');
        expect(cmd?.func).toBeTypeOf('function');
        const page = createPageMock([]);
        page.nativeClick = vi.fn().mockResolvedValue(undefined);
        page.evaluate.mockImplementation(async (script, ...args) => {
            const text = String(script);
            if (text.includes('if (document.querySelector(\'.filter\')) return r()')) {
                return undefined;
            }
            if (text.includes('window.location.href')) {
                return 'https://www.xiaohongshu.com/search_result?keyword=%E6%8A%A4%E8%82%A4&source=web_search_result_notes';
            }
            if (text.includes('const panel = document.querySelector(\'.filter-panel\')')) {
                return true;
            }
            if (text.includes('const btn = document.querySelector(\'.filter\')')) {
                return undefined;
            }
            if (text.includes('foundGroup: false, foundTag: false, active: false')) {
                const [groupTitle, label] = args;
                return {
                    foundGroup: ['排序依据', '笔记类型', '发布时间'].includes(groupTitle),
                    foundTag: true,
                    active: (groupTitle === '排序依据' && label === '最多点赞')
                        || (groupTitle === '笔记类型' && label === '图文')
                        || (groupTitle === '发布时间' && label === '一天内'),
                };
            }
            if (text.includes('const btn = document.querySelector(\'.filter-panel .operation-container .operation[data-hp-bound]\')')) {
                return undefined;
            }
            if (text.includes('window.__xhsSearch = { keyword, uniqIds: initIds, page: 1 }')) {
                return undefined;
            }
            if (text.includes('const end = document.querySelector(\'.end-container.status-container\')')) {
                return true;
            }
            if (text.includes('new Promise((resolve) =>')) {
                return 'content';
            }
            return [];
        });

        const result = await cmd.func(page, {
            query: '护肤',
            page: 1,
            limit: 5,
            sort: 'most_liked',
            'note-type': 'image',
            time: 'last_one_day',
        });

        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ items: [], page: 1, has_more: false });
        const filterCalls = page.evaluate.mock.calls.filter(([script]) =>
            String(script).includes('foundGroup: false, foundTag: false, active: false'));
        expect(filterCalls.map(([, groupTitle, label]) => [groupTitle, label])).toEqual([
            ['排序依据', '最多点赞'],
            ['笔记类型', '图文'],
            ['发布时间', '一天内'],
        ]);
    });
});
describe('buildScrollUntilJs', () => {
    it('inlines the target count and default maxScrolls into the generated IIFE', () => {
        const js = buildScrollUntilJs(40);
        // Target count must drive the early-exit check (#1471: --limit > 13 was capped).
        expect(js).toContain('countItems() >= 40');
        // Default safety cap of 15 to bound runtime on infinite-scroll pages.
        expect(js).toContain('i < 15');
        // Plateau detection so the loop exits early when XHS stops lazy-loading
        // instead of spinning all 15 iterations against an exhausted feed.
        expect(js).toContain('plateauRounds');
        // Related-search rows must not count toward the target.
        expect(js).toContain("classList.contains('query-note-item')");
    });
    it('respects a custom maxScrolls override', () => {
        const js = buildScrollUntilJs(100, 5);
        expect(js).toContain('countItems() >= 100');
        expect(js).toContain('i < 5');
    });
    it('counts only visible real note rows', async () => {
        const dom = new JSDOM(`
          <section class="note-item" id="visible"></section>
          <section class="note-item query-note-item" id="query"></section>
          <section class="note-item" id="hidden" style="display:none"></section>
        `, { url: 'https://www.xiaohongshu.com/search_result?keyword=test' });
        markVisible(dom.window.document.querySelector('#visible'));
        markVisible(dom.window.document.querySelector('#query'));
        markVisible(dom.window.document.querySelector('#hidden'));

        const result = await Function('document', 'window', 'MutationObserver', 'getComputedStyle', `return (${buildScrollUntilJs(1)})`)(dom.window.document, dom.window, dom.window.MutationObserver, dom.window.getComputedStyle.bind(dom.window));

        expect(result).toBe(1);
    });
    it('rejects unsafe helper arguments instead of interpolating them into code', () => {
        expect(() => buildScrollUntilJs(0)).toThrow(/targetCount/);
        expect(() => buildScrollUntilJs(10, 0)).toThrow(/maxScrolls/);
    });
});
describe('stripXhsAuthorDateSuffix', () => {
    it('only strips trailing date suffixes and preserves date-like author text', () => {
        expect(__test__.stripXhsAuthorDateSuffix('作者名 3天前')).toBe('作者名');
        expect(__test__.stripXhsAuthorDateSuffix('作者名2026-04-01')).toBe('作者名');
        expect(__test__.stripXhsAuthorDateSuffix('3天前端工程师')).toBe('3天前端工程师');
        expect(__test__.stripXhsAuthorDateSuffix('刚刚好')).toBe('刚刚好');
        expect(__test__.stripXhsAuthorDateSuffix('刚刚')).toBe('刚刚');
    });
});
describe('noteIdToDate (ObjectID timestamp parsing)', () => {
    it('parses a known note ID to the correct China-timezone date', () => {
        // 0x697f6c74 = 1769958516 → 2026-02-01 in UTC+8
        expect(noteIdToDate('https://www.xiaohongshu.com/search_result/697f6c74000000002103de17')).toBe('2026-02-01');
        // 0x68e90be8 → 2025-10-10 in UTC+8
        expect(noteIdToDate('https://www.xiaohongshu.com/explore/68e90be80000000004022e66')).toBe('2025-10-10');
    });
    it('returns China date when UTC+8 crosses into the next day', () => {
        // 0x69b739f0 = 2026-03-15 23:00 UTC = 2026-03-16 07:00 CST
        // Without UTC+8 offset this would incorrectly return 2026-03-15
        expect(noteIdToDate('https://www.xiaohongshu.com/search_result/69b739f00000000000000000')).toBe('2026-03-16');
    });
    it('handles /note/ path variant', () => {
        expect(noteIdToDate('https://www.xiaohongshu.com/note/697f6c74000000002103de17')).toBe('2026-02-01');
    });
    it('handles URL with query parameters', () => {
        expect(noteIdToDate('https://www.xiaohongshu.com/search_result/697f6c74000000002103de17?xsec_token=abc')).toBe('2026-02-01');
    });
    it('returns empty string for non-matching URLs', () => {
        expect(noteIdToDate('https://www.xiaohongshu.com/user/profile/635a9c720000000018028b40')).toBe('');
        expect(noteIdToDate('https://www.xiaohongshu.com/')).toBe('');
    });
    it('returns empty string for IDs shorter than 24 hex chars', () => {
        expect(noteIdToDate('https://www.xiaohongshu.com/search_result/abcdef')).toBe('');
    });
    it('returns empty string when timestamp is out of range', () => {
        // All zeros → ts = 0
        expect(noteIdToDate('https://www.xiaohongshu.com/search_result/000000000000000000000000')).toBe('');
    });
});
describe('unwrapEvaluateResult (browser-bridge envelope normalization)', () => {
    it('returns the raw array unchanged when payload is already an array', () => {
        const arr = [{ title: 'a' }, { title: 'b' }];
        expect(unwrapEvaluateResult(arr)).toBe(arr);
    });
    it('unwraps { session, data: [...] } envelope to the inner array', () => {
        const arr = [{ title: 'a' }];
        const env = { session: 'site:xiaohongshu:abc', data: arr };
        expect(unwrapEvaluateResult(env)).toBe(arr);
    });
    it('unwraps primitive data from Browser Bridge envelopes', () => {
        expect(unwrapEvaluateResult({ session: 'site:xiaohongshu:abc', data: 'login_wall' })).toBe('login_wall');
    });
    it('passes non-envelope objects through unchanged', () => {
        const obj = { results: [], loginWall: true };
        expect(unwrapEvaluateResult(obj)).toBe(obj);
    });
    it('handles null and undefined safely', () => {
        expect(unwrapEvaluateResult(null)).toBe(null);
        expect(unwrapEvaluateResult(undefined)).toBe(undefined);
    });
    it('unwraps non-array envelope data so callers can validate the payload shape', () => {
        const env = { session: 'x', data: { not: 'an array' } };
        expect(unwrapEvaluateResult(env)).toEqual({ not: 'an array' });
    });
});
