import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { JSDOM } from 'jsdom';
import { stripXhsUserNameSuffix } from './user-search.js';
import './user-search.js';

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
        wait: vi.fn().mockResolvedValue(undefined),
        autoScroll: vi.fn().mockResolvedValue(undefined),
    };
}

describe('xiaohongshu user-search', () => {
    it('rejects invalid limit before browser navigation', async () => {
        const cmd = getRegistry().get('xiaohongshu/user-search');
        const page = createPageMock([]);

        await expect(cmd.func(page, { query: '成分控塔塔', limit: 0 })).rejects.toMatchObject({
            code: 'ARGUMENT',
            message: expect.stringContaining('--limit'),
        });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('throws a clear error when the user-search page is blocked by a login wall', async () => {
        const cmd = getRegistry().get('xiaohongshu/user-search');
        const page = createPageMock([
            { status: 'login_wall', tab: { found: true, active: false, clicked: true } },
        ]);

        await expect(cmd.func(page, { query: '成分控塔塔', limit: 5 })).rejects.toMatchObject({
            code: 'AUTH_REQUIRED',
            message: expect.stringContaining('blocked behind a login wall'),
        });
        expect(page.evaluate).toHaveBeenCalledTimes(1);
    });

    it('returns ranked user rows with profile_url preserved', async () => {
        const cmd = getRegistry().get('xiaohongshu/user-search');
        const page = createPageMock([
            { status: 'content', tab: { found: true, active: false, clicked: true } },
            [
                {
                    user_id: '64b115ef0000000011003d5b',
                    name: '成分控塔塔',
                    profile_url: 'https://www.xiaohongshu.com/user/profile/64b115ef0000000011003d5b',
                    url: 'https://www.xiaohongshu.com/user/profile/64b115ef0000000011003d5b',
                    avatar: 'https://example.test/avatar.webp',
                    fans: '1.1万',
                    xiaohongshu_id: '1147181179',
                    bio: '只说成分，不说废话',
                },
            ],
        ]);

        const result = await cmd.func(page, { query: '成分控塔塔', limit: 1 });

        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(result).toEqual([
            {
                rank: 1,
                user_id: '64b115ef0000000011003d5b',
                name: '成分控塔塔',
                profile_url: 'https://www.xiaohongshu.com/user/profile/64b115ef0000000011003d5b',
                url: 'https://www.xiaohongshu.com/user/profile/64b115ef0000000011003d5b',
                avatar: 'https://example.test/avatar.webp',
                fans: '1.1万',
                xiaohongshu_id: '1147181179',
                bio: '只说成分，不说废话',
            },
        ]);
    });

    it('extracts visible user-card rows from the search page DOM', async () => {
        const dom = new JSDOM(`
          <section class="user-card">
            <a href="/user/profile/64b115ef0000000011003d5b">
              <img src="https://example.test/avatar.webp" />
              <span>成分控塔塔</span>
            </a>
            <div><span>1.1万</span><span>粉丝</span></div>
            <div><span>小红书号: 1147181179</span></div>
            <p>只说成分，不说废话</p>
          </section>
        `, { url: 'https://www.xiaohongshu.com/search_result?keyword=test' });
        markVisible(dom.window.document.querySelector('section.user-card'));
        const cmd = getRegistry().get('xiaohongshu/user-search');
        const page = createPageMock([]);
        page.evaluate.mockImplementationOnce(async () => ({ status: 'content', tab: { found: true, active: false, clicked: true } }));
        page.evaluate.mockImplementationOnce(async (script) => Function('document', `return (${script})`)(dom.window.document));

        const result = await cmd.func(page, { query: '成分控塔塔', limit: 5 });

        expect(result[0]).toMatchObject({
            rank: 1,
            user_id: '64b115ef0000000011003d5b',
            name: '成分控塔塔',
            profile_url: 'https://www.xiaohongshu.com/user/profile/64b115ef0000000011003d5b',
            avatar: 'https://example.test/avatar.webp',
            fans: '1.1万',
            xiaohongshu_id: '1147181179',
            bio: '只说成分，不说废话',
        });
    });

    it('strips relative-date suffixes from user names', () => {
        expect(stripXhsUserNameSuffix('成分控塔塔06-09')).toBe('成分控塔塔');
        expect(stripXhsUserNameSuffix('成分控塔塔 3天前')).toBe('成分控塔塔');
        expect(stripXhsUserNameSuffix('成分控塔塔')).toBe('成分控塔塔');
    });
});
