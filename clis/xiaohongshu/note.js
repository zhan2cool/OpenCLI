/**
 * Xiaohongshu note — read full note content from a public note page.
 *
 * Extracts title, author, description text, and engagement metrics
 * (likes, collects, comment count) via DOM extraction.
 *
 * Requires a full Xiaohongshu note URL with xsec_token.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CliError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseNoteId, buildNoteUrl } from './note-helpers.js';
/**
 * Host-agnostic IIFE that scrapes note title / author / counts / tags from a
 * rendered note detail page. Exported so the rednote adapter can reuse the
 * exact same selector set without copying it.
 */
export const NOTE_EXTRACT_JS = `
      (async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms))
        const bodyText = document.body?.innerText || ''
        const loginWall = /登录后查看|请登录/.test(bodyText)
        const notFound = /页面不见了|笔记不存在|无法浏览/.test(bodyText)
        const securityBlock = /安全限制|访问链接异常/.test(bodyText)
          || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href)

        const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()

        const title = clean(document.querySelector('#detail-title, .title'))
        const desc = clean(document.querySelector('#detail-desc, .desc, .note-text'))
        const author = clean(document.querySelector('.username, .author-wrapper .name'))
        // Scope to .interact-container — the post's main interaction bar.
        // Without scoping, .like-wrapper / .chat-wrapper also match each
        // comment's like/reply buttons in the comment section, and
        // querySelector returns the FIRST match (a comment's count, not the
        // post's). The post's true counts live inside .interact-container.
        const likes = clean(document.querySelector('.interact-container .like-wrapper .count'))
        const collects = clean(document.querySelector('.interact-container .collect-wrapper .count'))
        const comments = clean(document.querySelector('.interact-container .chat-wrapper .count'))

        // Try to extract tags/topics
        const tags = []
        document.querySelectorAll('#detail-desc a.tag, #detail-desc a[href*="search_result"]').forEach(el => {
          const t = (el.textContent || '').trim()
          if (t) tags.push(t)
        })

        // Extract all note images — try DOM selectors first, fall back to __INITIAL_STATE__
        const images = []
        document.querySelectorAll('.carousel img, .swiper-slide img, .note-image img, .images-container img, [class*="slide"] img').forEach(el => {
          const src = el.getAttribute('src') || el.getAttribute('data-src') || ''
          if (src && !images.includes(src)) images.push(src)
        })
        // Fallback: __INITIAL_STATE__ (covers lazy-loaded images and video covers)
        var _fallbackDebug = '';
        if (images.length === 0) {
          try {
            var _hasState = document.body.innerHTML.indexOf('__INITIAL_STATE__') >= 0;
            var _match = document.body.innerHTML.match(/window\\.__INITIAL_STATE__\\s*=\\s*(\\{.+?\\})<\\/script>/)
            _fallbackDebug = 'hasState=' + _hasState + ' regex=' + (_match ? 'ok' : 'nomatch');
            if (_match) {
              var _state = JSON.parse(JSON.stringify(eval('(' + _match[1] + ')')))
              var _nm = _state && _state.note && _state.note.noteDetailMap
              _fallbackDebug += ' noteMapKeys=' + (_nm ? Object.keys(_nm).join(',') : 'null');
              if (_nm) {
                var _keys = Object.keys(_nm)
                if (_keys.length) {
                  var _note = _nm[_keys[0]] && _nm[_keys[0]].note || {}
                  _fallbackDebug += ' imageListLen=' + ((_note.imageList || []).length);
                  ;(_note.imageList || []).forEach(function(i) {
                    var src = i.url || i.url_default || i.urlDefault || i.url_pre || i.urlPre || i.src || ''
                    if (src && images.indexOf(src) === -1) images.push(src)
                  })
                  if (images.length === 0 && _note.video && _note.video.cover) {
                    var vc = _note.video.cover
                    var src = vc.url || vc.url_default || vc.url_pre || ''
                    if (src) images.push(src)
                    _fallbackDebug += ' videoCover=' + (src ? 'ok' : 'empty');
                  }
                }
              }
            }
          } catch (e) { _fallbackDebug += ' error=' + e.message; }
        }

        // Scroll to trigger comment lazy loading
        const scroller = document.querySelector('.note-scroller') || document.querySelector('.container')
        if (scroller) {
          for (let i = 0; i < 5; i++) {
            const before = scroller.querySelectorAll('.parent-comment').length
            scroller.scrollTo(0, scroller.scrollHeight)
            await new Promise(r => setTimeout(r, 800 + Math.random() * 1200))
            const after = scroller.querySelectorAll('.parent-comment').length
            if (after <= before) break
          }
        }

        // Extract top-level comments from the DOM
        const commentsList = []
        document.querySelectorAll('.parent-comment').forEach(p => {
          const item = p.querySelector('.comment-item')
          if (!item) return
          const author = clean(item.querySelector('.author-wrapper .name, .user-name'))
          const text = clean(item.querySelector('.content, .note-text'))
          const likes = clean(item.querySelector('.count'))
          const time = clean(item.querySelector('.date, .time'))
          if (text) commentsList.push({ author, text, likes, time })
        })

        var _noteType = document.querySelector('#noteContainer,[class*=note-container]');
        var _type = _noteType ? (_noteType.getAttribute('data-type') || '') : '';
        if (!_type) _type = document.querySelector('video') ? 'video' : (images.length ? 'normal' : '');
        if (_fallbackDebug.indexOf('videoCover=ok') >= 0) _type = 'video';
        return { pageUrl: location.href, securityBlock, loginWall, notFound, title, desc, author, likes, collects, comments, tags, images, commentsList, type: _type, _fallbackDebug }
      })()
    `;
export const command = cli({
    site: 'xiaohongshu',
    name: 'note',
    access: 'read',
    description: '获取小红书笔记正文和互动数据',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
        { name: 'note-id', required: true, positional: true, help: 'Full Xiaohongshu note URL with xsec_token' },
    ],
    columns: ['field', 'value'],
    func: async (page, kwargs) => {
        const raw = String(kwargs['note-id']);
        const noteId = parseNoteId(raw);
        const url = buildNoteUrl(raw, { commandName: 'xiaohongshu note' });
        // Use a dedicated tab so we don't interfere with the user's search tab
        const savedPage = page._page;
        const newTabId = await page.newTab(url);
        page._page = newTabId;
        try {
            await page.wait({ time: 2 + Math.random() * 3 });
            const data = await page.evaluate(NOTE_EXTRACT_JS);
            if (!data || typeof data !== 'object') {
                throw new EmptyResultError('xiaohongshu/note', 'Unexpected evaluate response');
            }
            if (data.securityBlock) {
                throw new CliError('SECURITY_BLOCK', 'Xiaohongshu security block: the note detail page was blocked by risk control.', /^https?:\/\//.test(raw)
                    ? 'The page may be temporarily restricted. Try again later or from a different session.'
                    : 'Try using a full URL from search results (with xsec_token) instead of a bare note ID.');
            }
            if (data.loginWall) {
                throw new AuthRequiredError('www.xiaohongshu.com', 'Note content requires login');
            }
            if (data.notFound) {
                throw new EmptyResultError('xiaohongshu/note', `Note ${noteId} not found or unavailable — it may have been deleted or restricted`);
            }
            const d = data;
            // XHS renders placeholder text like "赞"/"收藏"/"评论" when count is 0;
            // normalize to '0' unless the value looks numeric.
            const numOrZero = (v) => /^\d+/.test(v) ? v : '0';
            // Title + author are always present on a real note page.
            // If both are missing, the page likely failed to load properly.
            if (!d.title && !d.author) {
                throw new EmptyResultError('xiaohongshu/note', 'The note page loaded without visible content. The note may be deleted or restricted.');
            }
            const rows = [
                { field: 'title', value: d.title || '' },
                { field: 'author', value: d.author || '' },
                { field: 'content', value: d.desc || '' },
                { field: 'likes', value: numOrZero(d.likes || '') },
                { field: 'collects', value: numOrZero(d.collects || '') },
                { field: 'comments', value: numOrZero(d.comments || '') },
            ];
            if (d.type) {
                rows.push({ field: 'type', value: d.type });
            }
            if (d.tags?.length) {
                rows.push({ field: 'tags', value: d.tags.join(', ') });
            }
            if (d.images?.length) {
                rows.push({ field: 'images', value: JSON.stringify(d.images) });
            }
            if (d.commentsList?.length) {
                rows.push({ field: 'comments_list', value: JSON.stringify(d.commentsList) });
            }
            if (d._fallbackDebug) {
                rows.push({ field: '_debug_images', value: d._fallbackDebug });
            }
            return rows;
        } finally {
            await page.closeTab(newTabId).catch(() => {});
            page._page = savedPage;
        }
    },
});
