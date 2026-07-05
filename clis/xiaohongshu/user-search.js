import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { parseLimit, unwrapEvaluateResult } from './search.js';

const WAIT_FOR_USER_CONTENT_JS = `
  (async () => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const userTabMatchers = new Set(['用户', '博主']);
    const isUserTabNode = (node) => userTabMatchers.has(clean(node?.textContent || ''));
    const isActiveTab = (node) => {
      const target = node?.closest?.('button,a,[role="tab"],div,span') || node;
      if (!target) return false;
      if (target.getAttribute?.('aria-selected') === 'true') return true;
      const className = clean(target.className || '');
      return /(^|\\s)(active|selected|current|on)(\\s|$)/i.test(className);
    };
    const findUserTab = () => {
      const byId = document.querySelector('#user.channel');
      if (byId) return byId;
      const nodes = Array.from(document.querySelectorAll('button,a,div,span,[role="tab"]'));
      return nodes.find((node) => isUserTabNode(node)) || null;
    };
    const clickUserTab = () => {
      const tab = findUserTab();
      if (!tab) return { found: false, active: false, clicked: false };
      if (isActiveTab(tab)) return { found: true, active: true, clicked: false };
      const target = tab.closest('button,a,[role="tab"]') || tab;
      target.scrollIntoView?.({ block: 'center', inline: 'center' });
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { found: true, active: false, clicked: true };
    };
    const isUserTabActive = () => {
      const tab = document.querySelector('#user.channel');
      if (!tab) return false;
      const className = clean(tab.className || '');
      return /(^|\\s)(active|selected|current|on)(\\s|$)/i.test(className);
    };
    const hasUserCards = () => isUserTabActive() && Boolean(document.querySelector('.user-item-box a[href*="/user/profile/"]'));
    let tabState = clickUserTab();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const bodyText = clean(document.body?.innerText || '');
      if (/登录后查看搜索结果|请登录/.test(bodyText)) return { status: 'login_wall', tab: tabState };
      if (hasUserCards()) return { status: 'content', tab: tabState };
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!tabState.found || (!tabState.active && !tabState.clicked)) tabState = clickUserTab();
    }
    return { status: 'timeout', tab: tabState };
  })()
`;

export function stripXhsUserNameSuffix(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const stripped = text.replace(/\s*(?:\d{1,2}天前|\d+小时前|\d+分钟前|\d+秒前|刚刚|昨天|前天|\d+周前|\d+个月前|\d{1,2}-\d{1,2}|\d{4}-\d{1,2}-\d{1,2})$/u, '').trim();
    return stripped || text;
}

function requireUserSearchRows(payload, phase) {
    const rows = unwrapEvaluateResult(payload);
    if (!Array.isArray(rows)) {
        throw new CommandExecutionError(`Unexpected Xiaohongshu user-search ${phase} payload shape; expected an array of rows.`);
    }
    return rows;
}

export function buildUserSearchExtractJs(webHost) {
    return `
      (() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const seen = new Set();
        const results = [];
        const items = document.querySelectorAll('.user-list-item');
        for (const item of items) {
          const link = item.querySelector('a[href*="/user/profile/"]');
          if (!link) continue;
          const href = link.getAttribute('href') || '';
          const userId = (href.match(/\\/user\\/profile\\/([a-f0-9]{24})/i) || [])[1] || '';
          if (!userId || seen.has(userId)) continue;
          seen.add(userId);
          const box = item.querySelector('.user-item-box');
          if (!box) continue;
          const nameEl = box.querySelector('.user-name');
          const name = nameEl ? clean(nameEl.textContent || '') : '';
          if (!name || name === '我') continue;
          const imgEl = box.querySelector('.avatar-container img');
          const avatar = imgEl ? clean(imgEl.getAttribute('src') || '') : '';
          const descTexts = Array.from(box.querySelectorAll('.user-desc, .user-desc-box'))
            .map(el => clean(el.textContent || ''))
            .filter(Boolean);
          let fans = '', xiaohongshuId = '', bio = '', notes_count = '', tag = '', followed = '';
          for (const text of descTexts) {
            const fm = text.match(/粉丝[・·]?([\\d.,，万wW]+)/);
            if (fm) fans = fm[1];
            const nm = text.match(/笔记[・·]?([\\d.,，万wW]+)/);
            if (nm) notes_count = nm[1];
            const xm = text.match(/小红书号[:：]?\\s*([A-Za-z0-9_-]+)/);
            if (xm) xiaohongshuId = xm[1];
            if (!text.includes('粉丝') && !text.includes('笔记') && !text.includes('小红书号')) {
              tag = text;
            }
          }
          const tagEl = box.querySelector('.user-tag');
          if (tagEl) bio = clean(tagEl.textContent || '');
          const followBtn = box.querySelector('.follow-button');
          if (followBtn) followed = clean(followBtn.textContent || '');
          const fullUrl = href.startsWith('http') ? href : 'https://${webHost}' + href;
          results.push({
            user_id: userId, name, profile_url: fullUrl, url: fullUrl,
            avatar, fans, xiaohongshu_id: xiaohongshuId, bio,
            notes_count, tag, followed,
          });
        }
        return results;
      })()
    `;
}

export const command = cli({
    site: 'xiaohongshu',
    name: 'user-search',
    access: 'read',
    description: '搜索小红书用户/博主',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
        { name: 'query', required: true, positional: true, help: 'User keyword' },
        { name: 'limit', type: 'int', default: 10, help: 'Number of results' },
    ],
    columns: ['rank', 'name', 'user_id', 'fans', 'notes_count', 'xiaohongshu_id', 'tag', 'followed', 'url'],
    func: async (page, kwargs) => {
        const limit = parseLimit(kwargs.limit ?? 10);
        const keyword = encodeURIComponent(String(kwargs.query || ''));
        if (!keyword) {
            throw new ArgumentError('query is required');
        }
        await page.goto(`https://www.xiaohongshu.com/search_result?keyword=${keyword}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.evaluate(() => new Promise(r => setTimeout(r, 2000)));
        if (!await page.evaluate(() => document.querySelector('#user.channel.active'))) {
            await page.evaluate(() => {
                const tab = document.querySelector('#user.channel');
                if (tab) tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
        }
        const bodyText = await page.evaluate(() => document.body?.innerText?.trim()?.slice(0, 100) || '');
        if (/登录/.test(bodyText)) {
            throw new AuthRequiredError('www.xiaohongshu.com', 'Xiaohongshu user search is blocked behind a login wall');
        }
        await page.evaluate(() => new Promise(r => {
            let tries = 0;
            const check = () => {
                if (document.querySelectorAll('.user-item-box').length > 0) return r();
                if (++tries > 40) return r();
                setTimeout(check, 500);
            };
            check();
        }));
        const rawPayload = await page.evaluate(buildUserSearchExtractJs('www.xiaohongshu.com'));
        const rows = requireUserSearchRows(rawPayload, 'extraction');
        return rows.slice(0, limit).map((item, index) => ({
            rank: index + 1,
            ...item,
        }));
    },
});
