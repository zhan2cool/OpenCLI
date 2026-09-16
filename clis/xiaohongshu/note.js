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
        const authorLink = document.querySelector('.username, .author-wrapper .name')
        const author = clean(authorLink)
        const authorProfileUrl = authorLink?.getAttribute?.('href') || ''
        const authorAvatar = document.querySelector('.avatar img, .author-container img, .user-avatar img')?.getAttribute?.('src') || ''

        // Scope to .interact-container or .engage-bar-style — the post's main interaction bar.
        // Without scoping, .like-wrapper / .chat-wrapper also match each
        // comment's like/reply buttons in the comment section, and
        // querySelector returns the FIRST match (a comment's count, not the
        // post's). The post's true counts live inside the interaction area.
        const likes = clean(document.querySelector('.interact-container .like-wrapper .count, .engage-bar-style .left .like-wrapper .count'))
        const collects = clean(document.querySelector('.interact-container .collect-wrapper .count, .engage-bar-style .left .collect-wrapper .count'))
        const comments = clean(document.querySelector('.interact-container .chat-wrapper .count, .engage-bar-style .left .chat-wrapper .count'))

        // Try to extract tags/topics
        const tags = []
        document.querySelectorAll('#detail-desc a.tag, #detail-desc a[href*="search_result"]').forEach(el => {
          const t = (el.textContent || '').trim()
          if (t) tags.push(t)
        })

        const noteIdMatch = (location.pathname || '').match(new RegExp('(?:explore|note|search_result|discovery/item)/([a-f0-9]+)', 'i'));
        const noteId = noteIdMatch ? noteIdMatch[1] : '';

        const images = []
        const seenImageKeys = new Set()
        const imageDedupeKey = (raw) => {
          if (!raw || typeof raw !== 'string') return ''
          const src = raw.trim()
          if (!src) return ''
          try {
            const parsed = new URL(src, location.href)
            if (parsed.protocol === 'http:') parsed.protocol = 'https:'
            parsed.hash = ''
            parsed.search = ''
            parsed.hostname = parsed.hostname.toLowerCase()
            parsed.pathname = (parsed.pathname || '')
              .replace(new RegExp('!.*$'), '')
              .replace(new RegExp('/imageView\\d+/\\d+(?:/w/\\d+)?(?:/h/\\d+)?(?:/format/[^/?#]+)?', 'gi'), '')
              .replace(new RegExp('/{2,}', 'g'), '/')
            return parsed.toString()
          } catch (e) {
            return src
              .replace(new RegExp('[?#].*$'), '')
              .replace(new RegExp('!.*$'), '')
              .replace(new RegExp('/imageView\\d+/\\d+(?:/w/\\d+)?(?:/h/\\d+)?(?:/format/[^/?#]+)?', 'gi'), '')
          }
        }
        const pushImage = (raw) => {
          const src = typeof raw === 'string' ? raw.trim() : ''
          const key = imageDedupeKey(src)
          if (!src || !key || src.includes('avatar') || src.includes('fe-platform')) return false
          if (seenImageKeys.has(key)) return false
          seenImageKeys.add(key)
          images.push(src)
          return true
        }
        const getStructuredNotes = () => {
          const state = window.__INITIAL_STATE__
          const noteData = state?.note?.noteDetailMap || state?.note?.note || {}
          if (!noteData || typeof noteData !== 'object') return []
          const currentIds = [...new Set([noteId].filter(Boolean))]
          const notes = []
          for (const id of currentIds) {
            const entry = noteData[id]
            const note = entry?.note || entry
            if (note && typeof note === 'object') notes.push(note)
          }
          const keys = Object.keys(noteData)
          if (notes.length === 0 && keys.length === 1) {
            const entry = noteData[keys[0]]
            const note = entry?.note || entry
            if (note && typeof note === 'object') notes.push(note)
          }
          return notes
        }
        let structuredImageUsed = false
        let authorId = '', authorDesc = '', authorFans = 0, authorFollows = 0, authorInteractions = 0
        let _debugAuthor = ''
        try {
          const state = window.__INITIAL_STATE__
          const nm = state?.note?.noteDetailMap || {}
          const nmKeys = Object.keys(nm)
          _debugAuthor = 'nmKeys=' + nmKeys.join(',') + ' noteId=' + noteId
          for (const key of nmKeys) {
            const entry = nm[key]
            const noteData = entry?.note || entry
            if (!noteData || typeof noteData !== 'object') continue
            const u = noteData.user || {}
            _debugAuthor = 'userKeys=' + Object.keys(u).join(',') + ' ' + JSON.stringify(u).slice(0, 500)
            authorId = u.userId || authorId
            authorDesc = u.desc || authorDesc
            authorFans = parseInt(u.fans, 10) || authorFans
            authorFollows = parseInt(u.follows, 10) || authorFollows
            authorInteractions = parseInt(u.interactions, 10) || authorInteractions
          }
        } catch (e) {
          _debugAuthor = 'error:' + e.message
        }
        try {
          for (const note of getStructuredNotes()) {
            const list = Array.isArray(note?.imageList) ? note.imageList : []
            for (const item of list) {
              const candidate = item?.urlDefault || item?.urlPre || item?.url
                || item?.infoList?.find(i => i?.imageScene === 'WB_DFT')?.url
                || item?.infoList?.[0]?.url
                || ''
              structuredImageUsed = pushImage(candidate) || structuredImageUsed
            }
          }
        } catch (e) {}

        document.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate)').forEach(slide => {
          const img = slide.querySelector('img');
          const src = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
          pushImage(src);
        });
        document.querySelectorAll('.carousel img, .note-image img, .images-container img, .slide img, [class*="swiper"] img, .image-item img, .img-item img, .note-media img').forEach(el => {
          const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
          pushImage(src);
        });
        // Fallback: __INITIAL_STATE__ (covers lazy-loaded images and video covers)
        var _fallbackDebug = '';
        try {
          var _hasState = document.body.innerHTML.indexOf('__INITIAL_STATE__') >= 0;
          var _match = document.body.innerHTML.match(/window\\.__INITIAL_STATE__\\s*=\\s*(\\{[\\s\\S]*?\\});?\\s*<\\/script>/)
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
                  pushImage(src)
                })
                if (images.length === 0 && _note.video && _note.video.cover) {
                  var vc = _note.video.cover
                  var src = vc.url || vc.url_default || vc.url_pre || ''
                  pushImage(src)
                  _fallbackDebug += ' videoCover=' + (src ? 'ok' : 'empty');
                }
              }
            }
          }
        } catch (e) { _fallbackDebug += ' error=' + e.message; }

        // Extract top-level comments from the DOM (no scroll, comments already loaded by caller)
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
        return { pageUrl: location.href, securityBlock, loginWall, notFound, title, desc, author, authorProfileUrl, authorAvatar, authorId, authorDesc, authorFans, authorFollows, authorInteractions, likes, collects, comments, tags, images, commentsList, type: _type, _fallbackDebug, _debugAuthor }
      })()
    `;

export const STATIC_AUTHOR_PANEL_EXTRACT_JS = `
      (() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            rect.width > 0 &&
            rect.height > 0;
        };

        const parseNum = (s) => {
          if (!s) return 0;
          const raw = String(s).replace(/,/g, '').trim();
          const n = parseFloat(raw.replace(/[wW万]/g, ''));
          return /[wW万]/.test(raw) ? n * 10000 : n;
        };

        const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
        const keywords = /小红书号|IP属地|粉丝|关注|获赞与收藏|研究成分|配方|真神/;
        const classHints = /user-info|author-wrapper|author-container|user-page|user-interactions|user-desc|user-detail|profile/i;
        const selectors = [
          '.user-info',
          '.user-page .user-info',
          '.user-desc',
          '.user-interactions',
          '.author-container',
          '.author-wrapper',
          '[class*="user-info"]',
          '[class*="author"]',
          '[class*="profile"]',
        ];

        const baseCandidates = selectors.flatMap((sel) => Array.from(document.querySelectorAll(sel))).filter(visible);
        const allCandidates = [...new Set([
          ...baseCandidates,
          ...Array.from(document.querySelectorAll('body *')).filter(visible).filter((el) => {
            const text = textOf(el);
            return keywords.test(text) || classHints.test(String(el.className || ''));
          }),
        ])];
        if (allCandidates.length === 0) return { found: false, reason: 'static-panel-not-found' };

        const score = (el) => {
          const text = textOf(el);
          const rect = el.getBoundingClientRect();
          const cls = String(el.className || '');
          let n = 0;
          const keywordHits = [
            /小红书号/.test(text),
            /IP属地/.test(text),
            /粉丝/.test(text),
            /获赞与收藏/.test(text),
            /研究成分|配方|真神/.test(text),
            /关注/.test(text),
          ].filter(Boolean).length;
          n += keywordHits * 4;
          if (/user-info|user-page|user-interactions|user-desc/.test(cls)) n += 6;
          if (/author-wrapper|author-container|profile/.test(cls)) n += 3;
          if (rect.width >= 240 && rect.width <= 960) n += 2;
          if (rect.height >= 80 && rect.height <= 600) n += 2;
          if ((Number(getComputedStyle(el).zIndex) || 0) > 0) n += 1;
          if (text.length >= 40) n += 1;
          if (text.length >= 80) n += 1;
          return n;
        };

        const firstVisibleTextNode = (root, pattern) => {
          const nodes = [root, ...Array.from(root.querySelectorAll('*')).filter(visible)];
          const hits = nodes
            .map((el) => ({ el, text: textOf(el), cls: String(el.className || '') }))
            .filter(({ text }) => pattern.test(text))
            .sort((a, b) => {
              const aShort = a.text.length;
              const bShort = b.text.length;
              const aScore = (/user-interactions|author|stats|info/i.test(a.cls) ? 4 : 0) + (aShort <= 120 ? 3 : 0) + (aShort <= 80 ? 2 : 0);
              const bScore = (/user-interactions|author|stats|info/i.test(b.cls) ? 4 : 0) + (bShort <= 120 ? 3 : 0) + (bShort <= 80 ? 2 : 0);
              return bScore - aScore || aShort - bShort;
            });
          return hits[0]?.el || null;
        };

        const enrich = (panel) => {
          if (!panel) return panel;
          const wanted = [
            panel,
            panel.closest('.user-info'),
            panel.closest('.user-page'),
            panel.closest('.author-wrapper'),
            panel.closest('.author-container'),
            panel.closest('.interaction-container'),
          ].filter(Boolean);

          const descendants = [
            ...wanted,
            ...wanted.flatMap((node) => Array.from(node.querySelectorAll('.user-info, .user-desc, .user-interactions, .author-wrapper, .author-container, .interaction-container, [class*="user-info"], [class*="author"], [class*="profile"], [class*="interaction"]'))),
          ].filter(visible);

          const richer = descendants
            .map((el) => ({ el, s: score(el), t: textOf(el) }))
            .filter((x) => x.s > 0 && x.t)
            .sort((a, b) => b.s - a.s || b.el.getBoundingClientRect().width - a.el.getBoundingClientRect().width);

          return richer[0]?.el || panel;
        };

        let panel = allCandidates
          .map((el) => ({ el, s: score(el), t: textOf(el) }))
          .filter((x) => x.s > 0 && x.t)
          .sort((a, b) => b.s - a.s || b.el.getBoundingClientRect().width - a.el.getBoundingClientRect().width)[0]?.el;

        panel = enrich(panel);
        if (!panel) return { found: false, reason: 'static-panel-not-found' };

        const t = textOf(panel);
        const keywordText = textOf([panel, ...Array.from(panel.querySelectorAll('*')).filter(visible)].find((el) => keywords.test(textOf(el))) || panel);
        const interactionPattern = /获赞与收藏|获赞|粉丝|关注/;
        const interactionNode = firstVisibleTextNode(panel.closest('.interaction-container') || panel, interactionPattern)
          || firstVisibleTextNode(panel.closest('.user-page') || panel, interactionPattern)
          || firstVisibleTextNode(document.body, interactionPattern);
        const interactionText = textOf(interactionNode || panel);
        const info = (keywordText.match(/小红书号[：:\\s]*([A-Za-z0-9_-]+)/) || t.match(/小红书号[：:\\s]*([A-Za-z0-9_-]+)/));
        const ip = (keywordText.match(/IP属地[：:\\s]*([^\\s]+)/) || t.match(/IP属地[：:\\s]*([^\\s]+)/));
        const following = (interactionText.match(/([\\d,.]+[wW万]?)\\s*关注/) || keywordText.match(/([\\d,.]+[wW万]?)\\s*关注/) || t.match(/([\\d,.]+[wW万]?)\\s*关注/));
        const fans = (interactionText.match(/([\\d,.]+[wW万]?)\\s*粉丝/) || keywordText.match(/([\\d,.]+[wW万]?)\\s*粉丝/) || t.match(/([\\d,.]+[wW万]?)\\s*粉丝/));
        const interactions = (interactionText.match(/([\\d,.]+[wW万]?)\\s*获赞与收藏/) || keywordText.match(/([\\d,.]+[wW万]?)\\s*获赞与收藏/) || t.match(/([\\d,.]+[wW万]?)\\s*获赞与收藏/));
        const descEl = panel.querySelector('.user-desc, [class*="desc"], [class*="bio"], [class*="intro"], [class*="sign"]')
          || [...panel.querySelectorAll('*')].find((el) => /研究成分|配方|真神|简介|bio|desc|签名/.test(textOf(el)));
        const avatar = panel.querySelector('img')?.getAttribute('src') || panel.querySelector('img')?.getAttribute('data-src') || '';
        const rect = panel.getBoundingClientRect();
        return {
          found: true,
          mode: 'static-author-panel',
          className: (panel.className || '').slice(0, 180),
          text: t.slice(0, 300),
          interactionText: interactionText.slice(0, 240),
          name: (keywordText.match(/^(.+?)\\s+小红书号/) || t.match(/^(.+?)\\s+小红书号/))?.[1] || (keywordText.match(/^(.+?)\\s+IP属地/) || t.match(/^(.+?)\\s+IP属地/))?.[1] || '',
          xhsId: info?.[1] || '',
          ip: ip?.[1] || '',
          desc: descEl ? textOf(descEl) : '',
          following: parseNum(following?.[1] || ''),
          fans: parseNum(fans?.[1] || ''),
          interactions: parseNum(interactions?.[1] || ''),
          avatar,
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })()
    `;

export const HOVERCARD_EXTRACT_JS = `
      (() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            rect.width > 0 &&
            rect.height > 0;
        };

        const parseNum = (s) => {
          if (!s) return 0;
          const raw = String(s).replace(/,/g, '').trim();
          const n = parseFloat(raw.replace(/[wW万]/g, ''));
          return /[wW万]/.test(raw) ? n * 10000 : n;
        };

        const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
        const root = document.querySelector('.tooltip-content');
        if (!visible(root)) return { found: false, reason: 'tooltip-content-not-found' };

        const content = root.querySelector('.user-content') || root;
        const container = content.querySelector('.container') || content;
        const header = container.querySelector('.header-area') || container;
        const basicInfo = header.querySelector('.basic-info') || header;
        const descEl = container.querySelector('.desc');
        const avatarEl = container.querySelector('img.avatar-item, img');
        const profileLinkEl = container.querySelector('a.avatar-info, a[href*="/user/profile/"]');

        const fullText = textOf(container);
        const descText = textOf(descEl);
        const statsText = textOf(container);
        const nameText = textOf(basicInfo).split(' ')[0] || '';

        const metricPattern = (label) => new RegExp('([\\\\d,.]+[wW万]?)\\\\s*' + label);
        const metricPatterns = (label) => [
          metricPattern(label),
          new RegExp(label + '\\\\s*([\\\\d,.]+[wW万]?)'),
        ];
        const extractMetric = (label) => {
          const directMatches = metricPatterns(label)
            .map((pattern) => statsText.match(pattern))
            .filter(Boolean);
          if (directMatches.length) return directMatches[0]?.[1] || '';

          const snippets = [];
          const pushSnippet = (value) => {
            const text = textOf(value);
            if (text) snippets.push(text);
          };
          const pushNodeText = (node) => {
            const text = String(node?.textContent || '').replace(/\\s+/g, ' ').trim();
            if (text) snippets.push(text);
          };

          for (const el of Array.from(container.querySelectorAll('*'))) {
            const text = textOf(el);
            if (!text || !text.includes(label)) continue;
            pushSnippet(el);
            pushSnippet(el.previousElementSibling);
            pushSnippet(el.nextElementSibling);
            pushSnippet(el.parentElement);
            pushSnippet(el.parentElement?.previousElementSibling);
            pushSnippet(el.parentElement?.nextElementSibling);
            pushSnippet(el.parentElement?.parentElement);
            pushNodeText(el.previousSibling);
            pushNodeText(el.nextSibling);
          }

          for (const snippet of snippets) {
            for (const pattern of metricPatterns(label)) {
              const match = snippet.match(pattern);
              if (match?.[1]) return match[1];
            }
          }
          return '';
        };

        const followingRaw = extractMetric('关注');
        const fansRaw = extractMetric('粉丝');
        const interactionsRaw = extractMetric('获赞与收藏');
        const authorIdMatch = (profileLinkEl?.getAttribute?.('href') || '').match(/\\/user\\/profile\\/([^/?#]+)/);
        const xhsIdMatch = fullText.match(/小红书号[：:\\s]*([A-Za-z0-9_-]+)/);
        const ipMatch = fullText.match(/IP属地[：:\\s]*([^\\s]+)/);

        return {
          found: true,
          mode: 'tooltip-content',
          className: (root.className || '').slice(0, 180),
          text: fullText.slice(0, 400),
          name: nameText,
          authorId: authorIdMatch?.[1] || '',
          xhsId: xhsIdMatch?.[1] || '',
          ip: ipMatch?.[1] || '',
          desc: descText,
          hasFollowingMetric: Boolean(followingRaw),
          hasFansMetric: Boolean(fansRaw),
          hasInteractionsMetric: Boolean(interactionsRaw),
          following: parseNum(followingRaw),
          fans: parseNum(fansRaw),
          interactions: parseNum(interactionsRaw),
          avatar: avatarEl?.getAttribute?.('src') || avatarEl?.getAttribute?.('data-src') || '',
          profileUrl: profileLinkEl?.getAttribute?.('href') || '',
          left: Math.round(root.getBoundingClientRect().left),
          top: Math.round(root.getBoundingClientRect().top),
          width: Math.round(root.getBoundingClientRect().width),
          height: Math.round(root.getBoundingClientRect().height),
        };
      })()
    `;

const AUTHOR_HOVER_SELECTORS = [
    '.author-container a.avatar-info',
    '.author-container a.name',
    '.author-wrapper a.name',
    '.author-container .avatar-click-wrapper a',
    '.author-container .avatar-container a',
    '.author-container [href*="/user/profile/"]',
    '.username',
    '.author-container',
    '.author-wrapper',
];

async function waitForHoverCard(page, attempts = 12, delayMs = 180) {
    let hoverCardData = null;
    for (let i = 0; i < attempts; i += 1) {
        hoverCardData = await page.evaluate(HOVERCARD_EXTRACT_JS);
        if (hoverCardData?.found) return hoverCardData;
        await page.wait({ time: delayMs / 1000 });
    }
    return hoverCardData;
}

function isHoverCardDataReady(data) {
    if (!data?.found) return false;
    const hasCoreIdentity = Boolean(data.name || data.profileUrl || data.authorId);
    const hasFollowingMetric = Boolean(data.hasFollowingMetric);
    const hasOtherMetrics = Boolean(data.hasFansMetric) || Boolean(data.hasInteractionsMetric);
    return hasCoreIdentity && hasFollowingMetric && hasOtherMetrics;
}

function hoverCardSignature(data) {
    if (!data?.found) return 'missing';
    return JSON.stringify({
        mode: data.mode || '',
        name: data.name || '',
        xhsId: data.xhsId || '',
        desc: data.desc || '',
        following: data.following || 0,
        fans: data.fans || 0,
        interactions: data.interactions || 0,
        hasFollowingMetric: Boolean(data.hasFollowingMetric),
        hasFansMetric: Boolean(data.hasFansMetric),
        hasInteractionsMetric: Boolean(data.hasInteractionsMetric),
        profileUrl: data.profileUrl || '',
    });
}

async function waitForStableHoverCard(page, attempts = 16, delayMs = 220, stableMatches = 2) {
    let last = null;
    let lastSignature = '';
    let stableCount = 0;
    for (let i = 0; i < attempts; i += 1) {
        const current = await page.evaluate(HOVERCARD_EXTRACT_JS);
        if (current?.found) {
            const signature = hoverCardSignature(current);
            if (signature === lastSignature) {
                stableCount += 1;
            } else {
                stableCount = 1;
                lastSignature = signature;
                last = current;
            }
            if (isHoverCardDataReady(current) && stableCount >= stableMatches) {
                return current;
            }
            last = current;
        }
        await page.wait({ time: delayMs / 1000 });
    }
    return last;
}

async function resolveAuthorHoverTarget(page, hint = {}) {
    return page.evaluate(`
      (() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const selectors = ${JSON.stringify(AUTHOR_HOVER_SELECTORS)};
        const authorIdHint = ${JSON.stringify(hint.authorId || '')};
        const profileHint = ${JSON.stringify(hint.profileUrl || '')};
        const nameHint = ${JSON.stringify(hint.name || '')};
        const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        const candidates = [];
        for (const selector of selectors) {
          for (const el of Array.from(document.querySelectorAll(selector))) {
            if (!visible(el)) continue;
            const href = el.getAttribute?.('href') || '';
            const text = clean(el.innerText || el.textContent || '');
            const parentText = clean(el.parentElement?.innerText || el.parentElement?.textContent || '');
            const score =
              (authorIdHint && href.includes(authorIdHint) ? 8 : 0) +
              (profileHint && href.includes(profileHint) ? 6 : 0) +
              (nameHint && (text === nameHint || parentText.includes(nameHint)) ? 5 : 0) +
              (href.includes('/user/profile/') ? 3 : 0) +
              (text.length > 0 ? 2 : 0) +
              (selector.includes('a.name') ? 2 : 0) +
              (selector.includes('avatar-info') ? 1 : 0);
            candidates.push({ el, selector, href, text, score });
          }
        }
        candidates.sort((a, b) => b.score - a.score);
        const chosen = candidates[0]?.el || null;
        if (!chosen) return { found: false, reason: 'hover-target-not-found', candidates: [] };
        const marker = 'opencliHoverTarget';
        for (const prev of document.querySelectorAll('[data-' + marker + ']')) prev.removeAttribute('data-' + marker);
        chosen.setAttribute('data-' + marker, '1');
        const rect = chosen.getBoundingClientRect();
        return {
          found: true,
          selector: '[data-' + marker + '="1"]',
          tag: chosen.tagName,
          className: chosen.className || '',
          href: chosen.getAttribute?.('href') || '',
          text: clean(chosen.innerText || chosen.textContent || ''),
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          candidates: candidates.slice(0, 8).map((item) => ({
            selector: item.selector,
            href: item.href,
            text: item.text.slice(0, 80),
            score: item.score,
          })),
        };
      })()
    `);
}

async function triggerAuthorHover(page, hint = {}) {
    const attempts = [];
    const target = await resolveAuthorHoverTarget(page, hint);
    if (!target?.found) {
        return { ok: false, selector: '', attempts: target?.reason ? [target.reason] : [] };
    }
    attempts.push(`resolved=${target.selector} ${target.tag || ''} ${target.className || ''}`.trim());
    if (target.candidates?.length) {
    }
    try {
        await page.hover(target.selector);
        await page.wait({ time: 0.35 });
        return { ok: true, selector: target.selector, attempts };
    } catch (e) {
        attempts.push(`hover failed: ${(e?.message || e).toString().slice(0, 120)}`);
        return { ok: false, selector: target.selector, attempts };
    }
}

async function waitForPreferredHoverCard(page, cycle = 0) {
    const attempts = cycle === 0 ? 8 : 10;
    const delayMs = cycle === 0 ? 150 : 180;
    return waitForStableHoverCard(page, attempts, delayMs, 1);
}

export async function collectAuthorHoverCardData(page, hint = {}) {
    const debugParts = [];
    let hoverCardData = null;
    let hoverComplete = false;
    try {
        for (let cycle = 0; cycle < 3; cycle += 1) {
            const hoverResult = await triggerAuthorHover(page, hint);
            debugParts.push(`hover-target[${cycle + 1}]=${hoverResult.ok ? hoverResult.selector : 'none'}`);
            hoverCardData = await waitForPreferredHoverCard(page, cycle);
            hoverComplete = isHoverCardDataReady(hoverCardData);
            debugParts.push(`hover[${cycle + 1}]=${hoverCardData ? (hoverCardData.found ? hoverCardData.mode : 'not found') : 'null'}`);
            debugParts.push(`hover-ready[${cycle + 1}]=${hoverComplete ? 'yes' : 'no'}`);
            debugParts.push(`hover-follows[${cycle + 1}]=${hoverCardData?.following || 0}`);
            debugParts.push(`hover-fans[${cycle + 1}]=${hoverCardData?.fans || 0}`);
            debugParts.push(`hover-interactions[${cycle + 1}]=${hoverCardData?.interactions || 0}`);
            if (hoverComplete) break;
            await page.wait({ time: 0.25 });
        }
    } catch (e) {
        debugParts.push(`hover error=${(e?.message || e).toString().slice(0, 120)}`);
    }
    return {
        hoverCardData: hoverCardData?.found ? hoverCardData : null,
        hoverComplete,
        hoverDebug: debugParts.join(' | '),
    };
}

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

            const { hoverCardData, hoverDebug } = await collectAuthorHoverCardData(page, {
                authorId: d.authorId || '',
                profileUrl: d.authorProfileUrl || '',
                name: d.author || '',
            });
            const rows = [
                { field: 'title', value: d.title || '' },
                { field: 'author', value: d.author || '' },
                { field: 'author_profile_url', value: (hoverCardData && hoverCardData.profileUrl) || d.authorProfileUrl || '' },
                { field: 'author_avatar', value: (hoverCardData && hoverCardData.avatar) || d.authorAvatar || '' },
                { field: 'author_id', value: (hoverCardData && hoverCardData.authorId) || d.authorId || '' },
                { field: 'author_xhs_id', value: (hoverCardData && hoverCardData.xhsId) || d.authorXhsId || '' },
                { field: 'author_ip', value: (hoverCardData && hoverCardData.ip) || '' },
                { field: 'author_desc', value: (hoverCardData && hoverCardData.desc) || '' },
                { field: 'author_fans', value: String((hoverCardData && hoverCardData.fans) || 0) },
                { field: 'author_follows', value: String((hoverCardData && hoverCardData.following) || 0) },
                { field: 'author_interactions', value: String((hoverCardData && hoverCardData.interactions) || 0) },
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
            if (d._debugAuthor) {
                rows.push({ field: '_debug_author', value: d._debugAuthor });
            }
            if (hoverCardData?.found || hoverDebug.includes('error=')) {
                rows.push({ field: '_debug_hover', value: hoverDebug });
            }
            if (hoverCardData?.mode) {
                rows.push({ field: 'author_panel_mode', value: hoverCardData.mode });
            }
            return rows;
        } finally {
            await page.closeTab(newTabId).catch(() => {});
            page._page = savedPage;
        }
    },
});
