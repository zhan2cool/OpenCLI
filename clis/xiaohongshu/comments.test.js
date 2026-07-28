import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@jackwener/opencli/registry';
import { buildCommentsExtractJs, buildXhsProfileUrl, parseXhsCommentTimeText, parseXhsLikeCountText, parseXhsProfileHref } from './comments.js';
function createPageMock(evaluateResult) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(evaluateResult),
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

async function runCommentsExtract(html, options = false) {
    const dom = new JSDOM(html, {
        url: 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
        runScripts: 'dangerously',
    });
    const previousDocument = globalThis.document;
    const previousLocation = globalThis.location;
    const previousWindow = globalThis.window;
    const previousHTMLElement = globalThis.HTMLElement;
    const previousElement = globalThis.Element;
    const previousMouseEvent = globalThis.MouseEvent;
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    dom.window.scrollTo = () => {};
    globalThis.document = dom.window.document;
    globalThis.location = dom.window.location;
    globalThis.window = dom.window;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.MouseEvent = dom.window.MouseEvent;
    globalThis.setTimeout = ((callback, _ms, ...args) => {
        if (typeof callback === 'function')
            callback(...args);
        return 0;
    });
    globalThis.clearTimeout = (() => {});
    try {
        return await eval(buildCommentsExtractJs(options));
    } finally {
        globalThis.document = previousDocument;
        globalThis.location = previousLocation;
        globalThis.window = previousWindow;
        globalThis.HTMLElement = previousHTMLElement;
        globalThis.Element = previousElement;
        globalThis.MouseEvent = previousMouseEvent;
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
    }
}

describe('parseXhsLikeCountText', () => {
    it('parses exact integer and shortform like counts', () => {
        expect(parseXhsLikeCountText('0')).toBe(0);
        expect(parseXhsLikeCountText('42')).toBe(42);
        expect(parseXhsLikeCountText('1,234')).toBe(1234);
        expect(parseXhsLikeCountText('1，234+')).toBe(1234);
        expect(parseXhsLikeCountText('2.1w')).toBe(21000);
        expect(parseXhsLikeCountText('1.5万')).toBe(15000);
        expect(parseXhsLikeCountText('1.2k')).toBe(1200);
        expect(parseXhsLikeCountText('3千')).toBe(3000);
        expect(parseXhsLikeCountText(' 2.1 w + ')).toBe(21000);
    });

    it('returns 0 for unknown shapes without overparsing arbitrary text', () => {
        for (const raw of ['', null, undefined, '赞', 'likes 2.1w', '2w人', '1,23', '1.2.3k', '.', '1.5']) {
            expect(parseXhsLikeCountText(raw)).toBe(0);
        }
    });
});

describe('parseXhsCommentTimeText', () => {
    const now = new Date(2026, 6, 8, 15, 30, 0, 0);
    it('normalizes common relative and absolute comment time formats', () => {
        expect(parseXhsCommentTimeText('刚刚', now)).toBe(now.toISOString());
        expect(parseXhsCommentTimeText('15分钟前', now)).toBe(new Date(2026, 6, 8, 15, 15, 0, 0).toISOString());
        expect(parseXhsCommentTimeText('2小时前', now)).toBe(new Date(2026, 6, 8, 13, 30, 0, 0).toISOString());
        expect(parseXhsCommentTimeText('昨天 14:41', now)).toBe(new Date(2026, 6, 7, 14, 41, 0, 0).toISOString());
        expect(parseXhsCommentTimeText('前天 09:12', now)).toBe(new Date(2026, 6, 6, 9, 12, 0, 0).toISOString());
        expect(parseXhsCommentTimeText('2天前', now)).toBe(new Date(2026, 6, 6, 15, 30, 0, 0).toISOString());
        expect(parseXhsCommentTimeText('07-03 08:01', now)).toBe(new Date(2026, 6, 3, 8, 1, 0, 0).toISOString());
        expect(parseXhsCommentTimeText('2026-07-03 08:01', now)).toBe(new Date(2026, 6, 3, 8, 1, 0, 0).toISOString());
    });

    it('returns empty string for unsupported formats', () => {
        expect(parseXhsCommentTimeText('')).toBe('');
        expect(parseXhsCommentTimeText('未知时间', now)).toBe('');
    });
});

describe('xiaohongshu comments', () => {
    const command = getRegistry().get('xiaohongshu/comments');
    it('returns ranked comment rows for signed full URLs', async () => {
        const page = createPageMock({
            loginWall: false,
            results: [
                { comment_id: 'c1', root_comment_id: 'c1', parent_comment_id: '', user_name: 'Alice', user_profile_url: '/user/profile/u1', content: 'Great note!', like_count: 10, reply_count: 2, time_text: '2024-01-01', location: '广东', is_author: false, depth: 0, sort_index: 0, page: 1, page_size: 20, estimated_total_top_level: 2, top_level_count_current_page: 2, has_more: false },
                { comment_id: 'c2', root_comment_id: 'c2', parent_comment_id: '', user_name: 'Bob', user_profile_url: '/user/profile/u2', content: 'Very helpful', like_count: 0, reply_count: 0, time_text: '2024-01-02', location: '', is_author: false, depth: 0, sort_index: 1, page: 1, page_size: 20, estimated_total_top_level: 2, top_level_count_current_page: 2, has_more: false },
            ],
        });
        const signedUrl = 'https://www.xiaohongshu.com/search_result/69aadbcb000000002202f131?xsec_token=abc&xsec_source=pc_search';
        const result = (await command.func(page, { 'note-id': signedUrl, limit: 5 }));
        expect(page.goto.mock.calls[0][0]).toBe(signedUrl);
        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ rank: 1, comment_id: 'c1', author: 'Alice', text: 'Great note!', likes: 10, userId: 'u1' });
        expect(result[1]).toMatchObject({ rank: 2, comment_id: 'c2', author: 'Bob', text: 'Very helpful', likes: 0, userId: 'u2' });
    });
    it('accepts bare note IDs by falling back to a simple explore URL', async () => {
        const page = createPageMock({ loginWall: false, results: [] });
        await expect(command.func(page, { 'note-id': '69aadbcb000000002202f131', limit: 5 })).resolves.toEqual([]);
        expect(page.goto).toHaveBeenCalledWith('https://www.xiaohongshu.com/explore/69aadbcb000000002202f131');
    });
    it('preserves signed /explore/ URL as-is for navigation', async () => {
        const page = createPageMock({
            loginWall: false,
            results: [{ comment_id: 'c1', root_comment_id: 'c1', parent_comment_id: '', user_name: 'Alice', user_profile_url: '', content: 'Nice', like_count: 1, time_text: '2024-01-01', depth: 0, sort_index: 0, page: 1, page_size: 20, estimated_total_top_level: 1, top_level_count_current_page: 1, has_more: false }],
        });
        await command.func(page, {
            'note-id': 'https://www.xiaohongshu.com/explore/69aadbcb000000002202f131?xsec_token=abc&xsec_source=pc_search',
            limit: 5,
        });
        expect(page.goto.mock.calls[0][0]).toContain('/explore/69aadbcb000000002202f131?xsec_token=abc');
    });
    it('preserves full search_result URL with xsec_token for navigation', async () => {
        const page = createPageMock({
            loginWall: false,
            results: [{ comment_id: 'c1', root_comment_id: 'c1', parent_comment_id: '', user_name: 'Alice', user_profile_url: '', content: 'Nice', like_count: 1, time_text: '2024-01-01', depth: 0, sort_index: 0, page: 1, page_size: 20, estimated_total_top_level: 1, top_level_count_current_page: 1, has_more: false }],
        });
        const fullUrl = 'https://www.xiaohongshu.com/search_result/69aadbcb000000002202f131?xsec_token=abc&xsec_source=pc_search';
        await command.func(page, { 'note-id': fullUrl, limit: 5 });
        expect(page.goto.mock.calls[0][0]).toBe(fullUrl);
    });
    it('preserves signed /user/profile/<user>/<note> URLs for navigation', async () => {
        const page = createPageMock({
            loginWall: false,
            results: [{ comment_id: 'c1', root_comment_id: 'c1', parent_comment_id: '', user_name: 'Alice', user_profile_url: '', content: 'Nice', like_count: 1, time_text: '2024-01-01', depth: 0, sort_index: 0, page: 1, page_size: 20, estimated_total_top_level: 1, top_level_count_current_page: 1, has_more: false }],
        });
        const fullUrl = 'https://www.xiaohongshu.com/user/profile/user123/69aadbcb000000002202f131?xsec_token=abc&xsec_source=pc_user';
        await command.func(page, { 'note-id': fullUrl, limit: 5 });
        expect(page.goto.mock.calls[0][0]).toBe(fullUrl);
    });
    it('throws AuthRequiredError when login wall is detected', async () => {
        const page = createPageMock({ loginWall: true, results: [] });
        await expect(command.func(page, {
            'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
            limit: 5,
        })).rejects.toThrow('Note comments require login');
    });
    it('throws SECURITY_BLOCK with retry guidance when a full URL comments page is blocked', async () => {
        const page = createPageMock({
            pageUrl: 'https://www.xiaohongshu.com/website-login/error?error_code=300031',
            securityBlock: true,
            loginWall: false,
            results: [],
        });
        await expect(command.func(page, {
            'note-id': 'https://www.xiaohongshu.com/search_result/69aadbcb000000002202f131?xsec_token=abc&xsec_source=pc_search',
            limit: 5,
        })).rejects.toMatchObject({
            code: 'SECURITY_BLOCK',
            hint: expect.stringContaining('Try again later'),
        });
    });
    it('returns empty array when no comments are found', async () => {
        const page = createPageMock({ loginWall: false, results: [] });
        await expect(command.func(page, {
            'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
            limit: 5,
        })).resolves.toEqual([]);
    });
    it('uses condition-based comment scrolling instead of a fixed blind loop', async () => {
        const page = createPageMock({ loginWall: false, results: [] });
        await command.func(page, {
            'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
            limit: 5,
        });
        const script = page.evaluate.mock.calls[0][0];
        expect(script).toContain("const beforeCount = root.querySelectorAll('.parent-comment').length");
        expect(script).toContain("const afterCount = commentsRoot().querySelectorAll('.parent-comment').length");
        expect(script).toContain("const endNode = document.querySelector('.end-container')");
        expect(script).toContain("return /THE\\s*END/i.test(text)");
        expect(script).toContain("button.scrollIntoView({ block: 'center', inline: 'nearest' })");
        expect(script).toContain("const currentVisibleReplies = visibleReplyCountOf(parentNode)");
    });
    it('expands hidden reply threads from .show-more markers before collecting children', async () => {
        const data = await runCommentsExtract(`
          <main>
            <section class="parent-comment">
              <div class="comment-item" id="comment-parent-1">
                <div class="author-wrapper"><span class="name">Alice</span></div>
                <div class="content">Parent</div>
                <div class="reply icon-container"><span class="count">1</span></div>
              </div>
              <div class="reply-container">
                <div class="show-more" onclick="this.insertAdjacentHTML('beforebegin', '<div class=&quot;comment-item comment-item-sub&quot; id=&quot;comment-child-1&quot;><div class=&quot;author-wrapper&quot;><span class=&quot;name&quot;>Bob</span></div><div class=&quot;note-text&quot;>Child</div><div class=&quot;date&quot;><span>昨天 14:41</span><span class=&quot;location&quot;>河北</span></div></div>'); this.remove()">展开 1 条回复</div>
              </div>
            </section>
            <div class="end-container">- THE END -</div>
          </main>
        `, { withReplies: true, page: 1, pageSize: 20, maxScrollRounds: 2, expandRounds: 2 });
        expect(data.results).toHaveLength(1);
        expect(data.results[0]).toMatchObject({ comment_id: 'parent-1', user_name: 'Alice', content: 'Parent', depth: 0 });
        expect(data.results[0].debug_expand_attempts).toBeGreaterThan(0);
    });
    it('extracts shortform like counts from the shared xiaohongshu/rednote DOM script', async () => {
        const data = await runCommentsExtract(`
          <main>
            <section class="parent-comment">
              <div class="comment-item">
                <div class="author-wrapper"><span class="name">Alice</span></div>
                <div class="content">Great note</div>
                <span class="count">2.1w</span>
                <span class="date">today</span>
              </div>
            </section>
            <section class="parent-comment">
              <div class="comment-item">
                <span class="user-name">Bob</span>
                <div class="note-text">Malformed count</div>
                <span class="count">likes 2.1w</span>
              </div>
            </section>
          </main>
        `);

        expect(data.results[0]).toMatchObject({ user_name: 'Alice', content: 'Great note', like_count: 21000, time_text: 'today', depth: 0 });
        expect(data.results[1]).toMatchObject({ user_name: 'Bob', content: 'Malformed count', like_count: 0, time_text: '', depth: 0 });
    });
    it('extracts authorHrefRaw from /user/profile/ anchor wrapping the name', async () => {
        const data = await runCommentsExtract(`
          <main>
            <section class="parent-comment">
              <div class="comment-item">
                <div class="author-wrapper"><a class="name" href="/user/profile/5e8a1b2c3d4e5f6a7b8c9d0e?xsec_token=tok">Alice</a></div>
                <div class="content">Hi</div>
                <span class="count">1</span>
                <span class="date">today</span>
              </div>
            </section>
            <section class="parent-comment">
              <div class="comment-item">
                <a class="user-name" href="https://www.xiaohongshu.com/user/profile/abc123def456">Bob</a>
                <div class="note-text">Hey</div>
              </div>
            </section>
          </main>
        `);
        expect(data.results[0].user_name).toBe('Alice');
        expect(data.results[0].user_profile_url).toBe('/user/profile/5e8a1b2c3d4e5f6a7b8c9d0e?xsec_token=tok');
        expect(data.results[1].user_name).toBe('Bob');
        expect(data.results[1].user_profile_url).toBe('https://www.xiaohongshu.com/user/profile/abc123def456');
    });
    it('extracts visible parent and child comments from the real xiaohongshu note detail DOM shape', async () => {
        const data = await runCommentsExtract(`
          <div class="comments-el">
            <div class="comments-container">
              <div class="total">共 14 条评论</div>
              <div class="list-container">
                <div class="parent-comment">
                  <div id="comment-69d140b8000000000903521a" class="comment-item">
                    <div class="comment-inner-container">
                      <div class="avatar">
                        <a href="/user/profile/5fe04ce20000000001004161?xsec_token=tok"><img class="avatar-item" src="https://example.com/a1.jpg"></a>
                      </div>
                      <div class="right">
                        <div class="author-wrapper"><div class="author"><a class="name" href="/user/profile/5fe04ce20000000001004161?xsec_token=tok">东东</a></div></div>
                        <div class="content"><span class="note-text">学姐说得很好，我直接抄作业啦，</span></div>
                        <div class="info">
                          <div class="date"><span>04-05</span><span class="location">广东</span></div>
                          <div class="interactions">
                            <div class="like"><span class="count">赞</span></div>
                            <div class="reply icon-container"><span class="count">1</span></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="reply-container">
                    <div class="list-container">
                      <div id="comment-69d47cd6000000000f01a50e" class="comment-item comment-item-sub">
                        <div class="comment-inner-container">
                          <div class="avatar">
                            <a href="/user/profile/5bb0374274391300012dd8c7?xsec_token=tok"><img class="avatar-item" src="https://example.com/a2.jpg"></a>
                          </div>
                          <div class="right">
                            <div class="author-wrapper"><div class="author"><a class="name" href="/user/profile/5bb0374274391300012dd8c7?xsec_token=tok">侃侃学姐</a><span class="tag">作者</span></div></div>
                            <div class="content"><span class="note-text">记得实际行动哦</span></div>
                            <div class="info">
                              <div class="date"><span>04-07</span><span class="location">山东</span></div>
                              <div class="interactions">
                                <div class="like"><span class="count">赞</span></div>
                                <div class="reply icon-container"><span class="count">回复</span></div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="parent-comment">
                  <div id="comment-69d1dc850000000015009942" class="comment-item">
                    <div class="comment-inner-container">
                      <div class="avatar">
                        <a href="/user/profile/600533f8000000000101f6a4?xsec_token=tok"><img class="avatar-item" src="https://example.com/a3.jpg"></a>
                      </div>
                      <div class="right">
                        <div class="author-wrapper"><div class="author"><a class="name" href="/user/profile/600533f8000000000101f6a4?xsec_token=tok">俺家小孩👧🏠</a></div></div>
                        <div class="content"><span class="note-text">姐姐这是把知识讲解的明明白白的</span></div>
                        <div class="info">
                          <div class="date"><span>04-05</span><span class="location">河北</span></div>
                          <div class="interactions">
                            <div class="like"><span class="count">赞</span></div>
                            <div class="reply icon-container"><span class="count">2</span></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="reply-container">
                    <div class="list-container">
                      <div id="comment-69d47cc80000000015010caa" class="comment-item comment-item-sub">
                        <div class="comment-inner-container">
                          <div class="avatar">
                            <a href="/user/profile/5bb0374274391300012dd8c7?xsec_token=tok"><img class="avatar-item" src="https://example.com/a4.jpg"></a>
                          </div>
                          <div class="right">
                            <div class="author-wrapper"><div class="author"><a class="name" href="/user/profile/5bb0374274391300012dd8c7?xsec_token=tok">侃侃学姐</a><span class="tag">作者</span></div></div>
                            <div class="content"><span class="note-text">让姐妹们一起跟我变美嘻嘻</span></div>
                            <div class="info">
                              <div class="date"><span>04-07</span><span class="location">山东</span></div>
                              <div class="interactions">
                                <div class="like"><span class="count">赞</span></div>
                                <div class="reply icon-container"><span class="count">回复</span></div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="show-more">展开 1 条回复</div>
                  </div>
                </div>
              </div>
              <div class="end-container">- THE END -</div>
            </div>
          </div>
        `, { withReplies: true, page: 1, pageSize: 100, maxScrollRounds: 2, expandRounds: 2 });
        expect(data.debugFatalError).toBe('');
        expect(data.debugVisibleParentCount).toBe(2);
        expect(data.topLevelCountCurrentPage).toBe(2);
        expect(data.estimatedTotalTopLevel).toBe(2);
        expect(data.results).toHaveLength(4);
        expect(data.results[0]).toMatchObject({
            comment_id: '69d140b8000000000903521a',
            user_name: '东东',
            content: '学姐说得很好，我直接抄作业啦，',
            location: '广东',
            depth: 0,
        });
        expect(data.results[1]).toMatchObject({
            comment_id: '69d47cd6000000000f01a50e',
            parent_comment_id: '69d140b8000000000903521a',
            root_comment_id: '69d140b8000000000903521a',
            user_name: '侃侃学姐',
            content: '记得实际行动哦',
            is_author: true,
            depth: 1,
        });
        expect(data.results[2]).toMatchObject({
            comment_id: '69d1dc850000000015009942',
            user_name: '俺家小孩👧🏠',
            content: '姐姐这是把知识讲解的明明白白的',
            location: '河北',
            depth: 0,
        });
        expect(data.results[3]).toMatchObject({
            comment_id: '69d47cc80000000015010caa',
            parent_comment_id: '69d1dc850000000015009942',
            root_comment_id: '69d1dc850000000015009942',
            user_name: '侃侃学姐',
            content: '让姐妹们一起跟我变美嘻嘻',
            is_author: true,
            depth: 1,
        });
    });
    it('respects the limit for top-level comments', async () => {
        const manyComments = Array.from({ length: 10 }, (_, i) => ({
            comment_id: `c${i}`,
            root_comment_id: `c${i}`,
            parent_comment_id: '',
            user_name: `User${i}`,
            user_profile_url: '',
            content: `Comment ${i}`,
            like_count: i,
            time_text: '2024-01-01',
            depth: 0,
            sort_index: i,
            page: 1,
            page_size: 20,
            estimated_total_top_level: 10,
            top_level_count_current_page: 10,
            has_more: false,
        }));
        const page = createPageMock({ loginWall: false, results: manyComments });
        const result = (await command.func(page, {
            'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
            limit: 3,
        }));
        expect(result).toHaveLength(3);
        expect(result[0].rank).toBe(1);
        expect(result[2].rank).toBe(3);
    });
    it('enriches each row with userId and profileUrl derived from authorHrefRaw', async () => {
        const page = createPageMock({
            loginWall: false,
            results: [
                { comment_id: 'c1', root_comment_id: 'c1', parent_comment_id: '', user_name: 'Alice', user_profile_url: '/user/profile/abc123?xsec_token=tok', content: 'hi', like_count: 1, time_text: 't', depth: 0, sort_index: 0, page: 1, page_size: 20, estimated_total_top_level: 3, top_level_count_current_page: 3, has_more: false },
                { comment_id: 'c2', root_comment_id: 'c2', parent_comment_id: '', user_name: 'Bob', user_profile_url: 'https://www.xiaohongshu.com/user/profile/xyz789', content: 'hey', like_count: 0, time_text: '', depth: 0, sort_index: 1, page: 1, page_size: 20, estimated_total_top_level: 3, top_level_count_current_page: 3, has_more: false },
                { comment_id: 'c3', root_comment_id: 'c3', parent_comment_id: '', user_name: 'Anon', user_profile_url: '', content: 'no link', like_count: 0, time_text: '', depth: 0, sort_index: 2, page: 1, page_size: 20, estimated_total_top_level: 3, top_level_count_current_page: 3, has_more: false },
            ],
        });
        const result = (await command.func(page, {
            'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
            limit: 5,
        }));
        expect(result).toHaveLength(3);
        expect(result[0]).toMatchObject({ rank: 1, author: 'Alice', userId: 'abc123', profileUrl: 'https://www.xiaohongshu.com/user/profile/abc123' });
        expect(result[1]).toMatchObject({ rank: 2, author: 'Bob', userId: 'xyz789', profileUrl: 'https://www.xiaohongshu.com/user/profile/xyz789' });
        expect(result[2]).toMatchObject({ rank: 3, author: 'Anon', userId: '', profileUrl: '' });
        // the raw transport field must not leak into the final row shape
        for (const row of result) {
            expect(row).not.toHaveProperty('authorHrefRaw');
            expect(row).not.toHaveProperty('authorHref');
        }
    });
    it('buildXhsProfileUrl handles trusted relative/absolute inputs and rejects host/path drift', () => {
        expect(parseXhsProfileHref('/user/profile/abc123')).toBe('abc123');
        expect(parseXhsProfileHref('https://www.xiaohongshu.com/user/profile/xyz?xsec_token=tok')).toBe('xyz');
        expect(buildXhsProfileUrl('/user/profile/abc123')).toBe('https://www.xiaohongshu.com/user/profile/abc123');
        expect(buildXhsProfileUrl('https://www.xiaohongshu.com/user/profile/xyz?xsec_token=tok')).toBe('https://www.xiaohongshu.com/user/profile/xyz');
        expect(buildXhsProfileUrl('')).toBe('');
        expect(buildXhsProfileUrl(null)).toBe('');
        expect(buildXhsProfileUrl('/user/profile/zzz', 'www.rednote.com')).toBe('https://www.rednote.com/user/profile/zzz');
        expect(buildXhsProfileUrl('http://www.xiaohongshu.com/user/profile/abc123')).toBe('');
        expect(buildXhsProfileUrl('https://evil.test/user/profile/abc123')).toBe('');
        expect(buildXhsProfileUrl('https://www.xiaohongshu.com/user/profile/abc123/extra')).toBe('');
        expect(buildXhsProfileUrl('/user/profile/abc123/extra')).toBe('');
        expect(buildXhsProfileUrl('https://www.rednote.com/user/profile/zzz', 'www.rednote.com')).toBe('https://www.rednote.com/user/profile/zzz');
        expect(buildXhsProfileUrl('https://www.xiaohongshu.com/user/profile/zzz', 'www.rednote.com')).toBe('');
    });
    it('clamps invalid negative limits to a safe minimum', async () => {
        const page = createPageMock({
            loginWall: false,
            results: [
                { author: 'Alice', text: 'Great note!', likes: 10, time: '2024-01-01', is_reply: false, reply_to: '' },
                { author: 'Bob', text: 'Very helpful', likes: 0, time: '2024-01-02', is_reply: false, reply_to: '' },
            ],
        });
        const result = (await command.func(page, {
            'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
            limit: -3,
        }));
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ rank: 1, author: 'Alice' });
    });
    describe('--with-replies', () => {
        it('includes reply rows with is_reply=true and reply_to set', async () => {
            const page = createPageMock({
                loginWall: false,
                results: [
                    { author: 'Alice', text: 'Main comment', likes: 10, time: '03-25', is_reply: false, reply_to: '' },
                    { author: 'Bob', text: 'Reply to Alice', likes: 3, time: '03-25', is_reply: true, reply_to: 'Alice' },
                    { author: 'Carol', text: 'Another top', likes: 5, time: '03-26', is_reply: false, reply_to: '' },
                ],
            });
            const result = (await command.func(page, {
                'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok', limit: 50, 'with-replies': true,
            }));
            expect(result).toHaveLength(3);
            expect(result[0]).toMatchObject({ author: 'Alice', is_reply: false, reply_to: '' });
            expect(result[1]).toMatchObject({ author: 'Bob', is_reply: true, reply_to: 'Alice' });
            expect(result[2]).toMatchObject({ author: 'Carol', is_reply: false, reply_to: '' });
            const script = page.evaluate.mock.calls[0][0];
            expect(script).toContain('共\\d+条回复');
            expect(script).toContain('button.click()');
        });
        it('limits by top-level count, keeping attached replies', async () => {
            const page = createPageMock({
                loginWall: false,
                results: [
                    { author: 'A', text: 'Top 1', likes: 0, time: '', is_reply: false, reply_to: '' },
                    { author: 'A1', text: 'Reply 1', likes: 0, time: '', is_reply: true, reply_to: 'A' },
                    { author: 'A2', text: 'Reply 2', likes: 0, time: '', is_reply: true, reply_to: 'A' },
                    { author: 'B', text: 'Top 2', likes: 0, time: '', is_reply: false, reply_to: '' },
                    { author: 'C', text: 'Top 3', likes: 0, time: '', is_reply: false, reply_to: '' },
                ],
            });
            // Limit to 2 top-level comments — should include A + 2 replies + B = 4 rows
            const result = (await command.func(page, {
                'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok', limit: 2, 'with-replies': true,
            }));
            expect(result).toHaveLength(4);
            expect(result.map((r) => r.author)).toEqual(['A', 'A1', 'A2', 'B']);
        });
    });
});
