/**
 * Xiaohongshu comments — DOM-based comment extraction with scrolling & reply expansion.
 */
import { buildXhsProfileUrl, parseXhsProfileHref } from './note-helpers.js';

export function parseXhsLikeCountText(value) {
    const s = String(value || '').replace(/\s+/g, '').toLowerCase();
    if (!s) return 0;
    const m = s.match(/^([\d.]+)(w|万|k|千|亿)?/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    const u = m[2];
    if (u === 'w' || u === '万') return Math.round(n * 10000);
    if (u === 'k') return Math.round(n * 1000);
    if (u === '千') return Math.round(n * 1000);
    if (u === '亿') return Math.round(n * 100000000);
    return Math.round(n);
}

function parseCommentLimit(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : fallback;
}

function parseCommentTimeText(text) {
    if (!text) return '';
    const cleaned = text.replace(/\s+/g, ' ').trim();
    const now = new Date();
    const cy = now.getFullYear();
    const md = cleaned.match(/^(\d{1,2})[-\/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (md) {
        const month = parseInt(md[1]) - 1;
        const day = parseInt(md[2]);
        const d = new Date(cy, month, day);
        if (d > now) d.setFullYear(cy - 1);
        if (md[3] && md[4]) d.setHours(parseInt(md[3]), parseInt(md[4]));
        return d.toISOString();
    }
    const full = cleaned.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (full) {
        const d = new Date(parseInt(full[1]), parseInt(full[2]) - 1, parseInt(full[3]));
        if (full[4] && full[5]) d.setHours(parseInt(full[4]), parseInt(full[5]));
        return d.toISOString();
    }
    return cleaned;
}

const XHS_PROFILE_HREF_SELECTOR = '.avatar a[href*="/user/profile/"], .name[href*="/user/profile/"], a.name[href*="/user/profile/"], a[href*="/user/profile/"]';

function normalizeBuildOptions(input) {
    if (typeof input === 'boolean') {
        return { withReplies: input, page: 1, pageSize: 40, maxScrollRounds: 6, expandRounds: 3, existingIds: [], cursorCommentId: '' };
    }
    return {
        withReplies: Boolean(input?.withReplies),
        page: Math.max(1, Number(input?.page) || 1),
        pageSize: parseCommentLimit(input?.pageSize, 20),
        maxScrollRounds: Math.max(1, Math.min(Number(input?.maxScrollRounds) || 6, 40)),
        expandRounds: Math.max(1, Math.min(Number(input?.expandRounds) || 3, 10)),
        existingIds: Array.isArray(input?.existingIds) ? input.existingIds.filter(id => id) : [],
        cursorCommentId: typeof input?.cursorCommentId === 'string' ? input.cursorCommentId : '',
    };
}

export function buildCommentsExtractJs(options) {
    const { withReplies, page, pageSize, maxScrollRounds, expandRounds, existingIds, cursorCommentId } = normalizeBuildOptions(options);
    const parseLikeCountText = parseXhsLikeCountText.toString();
    const parseCommentTimeTextFn = parseCommentTimeText.toString();
    return `
      (async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms))
        const withReplies = ${withReplies}
        const targetPage = ${page}
        const pageSize = ${pageSize}
        const targetCount = pageSize
        const maxScrollRounds = ${maxScrollRounds}
        const expandRounds = ${expandRounds}
        const existingIds = ${JSON.stringify(existingIds)}
        const cursorCommentId = ${JSON.stringify(cursorCommentId)}
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
        const seenCommentIds = new Set(existingIds)
        const pageCollectionBudgetMs = targetPage > 1 ? 58000 : 45000
        const maxPlateauRounds = 3
        const underfilledPlateauRounds = Math.max(maxPlateauRounds, targetPage > 1 ? 20 : 6)
        const effectiveMaxScrollRounds = Math.max(maxScrollRounds, targetPage > 1 ? 24 : 8)
        const noteKey = clean(location.pathname || location.href)
        const pagerStateKey = '__xhsCommentPagerState'
        const priorPagerState = (window[pagerStateKey] && typeof window[pagerStateKey] === 'object') ? window[pagerStateKey] : {}
        const priorPagerNoteKey = clean(priorPagerState.noteKey || '')
        const pagerState = {
          noteKey,
          reachedEnd: priorPagerNoteKey === noteKey ? Boolean(priorPagerState.reachedEnd) : false,
          totalCommentHint: priorPagerNoteKey === noteKey ? Number(priorPagerState.totalCommentHint || 0) : 0,
          cursorCommentId: priorPagerNoteKey === noteKey ? clean(priorPagerState.cursorCommentId || '') : '',
        }
        const pageRows = []
        const trace = (...parts) => {
          try { console.log('[xhs.comments.trace]', ...parts) } catch {}
        }
        const debugState = {
          expandAttempts: 0,
          expandSuccesses: 0,
          scrollRounds: 0,
          reachedEnd: false,
          nodeErrors: 0,
          fatalError: '',
          plateauRounds: 0,
          exitReason: '',
          lastBeforeTop: 0,
          lastAfterTop: 0,
          lastBeforeHeight: 0,
          lastAfterHeight: 0,
          lastBeforeSignature: '',
          lastAfterSignature: '',
          lastLoadedRootCount: 0,
          endNodeText: '',
          lastVisibleRootIds: [],
        }
        const randomBetween = (min, max) => Math.floor(min + Math.random() * Math.max(0, max - min))
        const bodyText = document.body?.innerText || ''
        const loginWall = /登录后查看|请登录/.test(bodyText)
        const securityBlock = /安全限制|访问链接异常/.test(bodyText) || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href)
        const parseLikeCountText = ${parseLikeCountText}
        const parseCommentTimeText = ${parseCommentTimeTextFn}
        const parseLikes = (el) => parseLikeCountText(clean(el?.textContent || ''))
        const HREF_SELECTOR = ${JSON.stringify(XHS_PROFILE_HREF_SELECTOR)}
        const extractAuthorHref = (el) => { if (!el) return ''; const a = el.querySelector(HREF_SELECTOR); return a ? (a.getAttribute('href') || '') : '' }
        const commentIdOf = (el) => { const id = el?.getAttribute?.('id') || el?.closest?.('.comment-item')?.getAttribute?.('id') || ''; return clean(id).replace(/^comment-/, '') }
        const avatarOf = (el) => clean(el?.querySelector?.('.avatar-item')?.getAttribute?.('src') || '')
        const locationOf = (el) => clean(el?.querySelector?.('.location')?.textContent || '')
        const isAuthorOf = (el) => /作者/.test(clean(el?.querySelector?.('.tag')?.textContent || ''))
        const replyCountOf = (el) => { const v = clean(el?.querySelector?.('.reply .count')?.textContent || ''); return /^\\d+$/.test(v) ? Number(v) : 0 }
        const commentTextOf = (el) => clean(el?.querySelector?.('.note-text')?.textContent || el?.querySelector?.('.content')?.textContent || '')
        const timeOf = (el) => clean(el?.querySelector?.('.date span')?.textContent || el?.querySelector?.('.date')?.textContent || el?.querySelector?.('.time')?.textContent || '')
        const authorOf = (el) => clean(el?.querySelector?.('.author-wrapper .name, .user-name, .name')?.textContent || '')
        const isScrollable = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const style = window.getComputedStyle(el)
          const overflowY = style?.overflowY || ''
          return /(auto|scroll|overlay)/i.test(overflowY) && el.scrollHeight > el.clientHeight + 8
        }
        const findScrollableAncestor = (start) => {
          let node = start instanceof HTMLElement ? start : null
          while (node) {
            if (isScrollable(node)) return node
            node = node.parentElement
          }
          return null
        }
        const commentsRoot = () => {
          return document.querySelector('.comments-container')
            || document.querySelector('.comments-el')
            || document
        }
        const noteScroller = () => {
          const root = commentsRoot()
          const scopedList = root?.querySelector?.('.list-container') || null
          return findScrollableAncestor(root)
            || findScrollableAncestor(scopedList)
            || document.querySelector('.note-scroller')
            || document.querySelector('.container')
            || document.scrollingElement
            || document.documentElement
        }
        const isNearBottom = (scroller) => {
          const metrics = scrollMetrics(scroller)
          return (metrics.top + metrics.client) >= (metrics.height - 24)
        }
        const reachedEnd = () => {
          const root = commentsRoot()
          const endNode = root?.querySelector?.('.end-container') || document.querySelector('.end-container')
          const endText = clean(endNode?.textContent || '')
          debugState.endNodeText = endText
          if (!/THE\\s*END/i.test(endText)) return false
          return isNearBottom(noteScroller())
        }
        const currentLoadedCommentCount = () => pageRows.length
        const visibleReplyCountOf = (pn) => pn ? pn.querySelectorAll(':scope > .reply-container > .list-container > .comment-item-sub, :scope > .reply-container > .list-container > .comment-item.comment-item-sub').length : 0
        const replyTreeStateOf = (pn) => {
          if (!pn) return { directCount: 0, treeCount: 0, showMoreCount: 0, signature: '' }
          const replyRoot = pn.querySelector(':scope > .reply-container')
          const directCount = visibleReplyCountOf(pn)
          const treeIds = Array.from(replyRoot ? replyRoot.querySelectorAll('.comment-item-sub, .comment-item.comment-item-sub') : [])
            .map(el => commentIdOf(el))
            .filter(Boolean)
          const showMoreCount = replyRoot ? replyRoot.querySelectorAll('.show-more').length : 0
          return {
            directCount,
            treeCount: treeIds.length,
            showMoreCount,
            signature: [treeIds.join('|'), String(showMoreCount)].join('#'),
          }
        }
        const replyDomSignatureOf = (pn) => replyTreeStateOf(pn).signature
        const expectedReplyCountOf = (pi) => { const v = replyCountOf(pi); return Number.isFinite(v) ? v : 0 }
        const parentCommentNodes = (root) => {
          if (!root || root === document) return Array.from(document.querySelectorAll('.comments-container .parent-comment'))
          const direct = Array.from(root.querySelectorAll(':scope > .list-container > .parent-comment'))
          return direct.length > 0 ? direct : Array.from(root.querySelectorAll('.parent-comment'))
        }
        const parentSignatureOf = (root) => {
          const ids = parentCommentNodes(root).map(node => commentIdOf(node.querySelector('.comment-item'))).filter(Boolean)
          return ids.slice(-5).join('|')
        }
        const expandReplyButtonOf = (pn) => {
          if (!pn) return null
          const scopedShowMore = pn.querySelector(':scope > .reply-container .show-more, .reply-container .show-more')
          if (scopedShowMore instanceof HTMLElement) return scopedShowMore
          const cs = Array.from(pn.querySelectorAll('.show-more, button, [role="button"], span, div'))
          return cs.find(el => { if (!(el instanceof HTMLElement)) return false; const t = clean(el.textContent || ''); if (!t || t.length > 24) return false; return /(展开|更多回复|全部回复|查看.*回复|共\\d+条回复)/.test(t) }) || null
        }
        const clickExpandButton = async (button) => {
          if (!(button instanceof HTMLElement)) return false
          try { button.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch {}
          await wait(randomBetween(260, 420))
          for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) { try { button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })) } catch {} }
          try { button.click() } catch {}
          try { if (typeof button.onclick === 'function') button.onclick(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })) } catch {}
          await wait(randomBetween(220, 360))
          return true
        }
        const waitForReplyGrowth = async (pn, beforeVisible, expected, shouldStop = null) => {
          const maxChecks = expected > beforeVisible ? 12 : 8
          const beforeState = replyTreeStateOf(pn)
          let stable = 0, prev = beforeVisible
          for (let a = 0; a < maxChecks; a++) {
            if (typeof shouldStop === 'function' && shouldStop()) return false
            await wait(randomBetween(280, 460) + a * 80)
            if (typeof shouldStop === 'function' && shouldStop()) return false
            const curState = replyTreeStateOf(pn)
            const cur = curState.directCount
            if (curState.treeCount > beforeState.treeCount) return true
            if (curState.showMoreCount < beforeState.showMoreCount) return true
            if (curState.signature && curState.signature !== beforeState.signature) return true
            if (cur > beforeVisible) return true
            if (expected > 0 && cur >= expected) return true
            if (cur === prev) { stable += 1 } else { stable = 0 }
            prev = cur
            if (stable >= 2 && expected === 0) return false
          }
          return false
        }
        const hasPendingHiddenReplies = (root, rootIds = null) => {
          if (!withReplies || !root) return false
          return Array.from(root.querySelectorAll('.parent-comment')).some(pn => {
            const treeState = replyTreeStateOf(pn)
            return Boolean(expandReplyButtonOf(pn)) && treeState.showMoreCount > 0
          })
        }
        let collectionStartedAt = 0
        const shouldStopPage = () => {
          if (currentLoadedCommentCount() < pageSize) {
            const trees = collectCommentTree()
            mergeRowsIntoPage(trees)
          }
          if (currentLoadedCommentCount() >= pageSize) {
            trace('stop', 'filled_page_size', { page: targetPage, loaded: currentLoadedCommentCount(), pageSize })
            return true
          }
          if (Date.now() - collectionStartedAt >= pageCollectionBudgetMs) {
            trace('stop', 'budget_hit', { page: targetPage, loaded: currentLoadedCommentCount(), pageSize, elapsed: Date.now() - collectionStartedAt, budget: pageCollectionBudgetMs })
            return true
          }
          if (debugState.plateauRounds >= underfilledPlateauRounds) {
            trace('stop', 'plateau_hit', { page: targetPage, loaded: currentLoadedCommentCount(), pageSize, plateauRounds: debugState.plateauRounds, underfilledPlateauRounds })
            return true
          }
          return false
        }
        const expandReplyThreads = async (root, predicate = null) => {
          if (!withReplies || !root) return
          let idleRounds = 0
          while (true) {
            if (shouldStopPage()) break
            let progressed = false
            for (const pn of Array.from(root.querySelectorAll('.parent-comment'))) {
              if (shouldStopPage()) break
              const pi = pn.querySelector('.comment-item'); if (!pi) continue
              if (typeof predicate === 'function' && !predicate(pn, pi)) continue
              const er = expectedReplyCountOf(pi), vr = visibleReplyCountOf(pn)
              const btn = expandReplyButtonOf(pn)
              if (btn) {
                const elapsed = Date.now() - (window.__xhsLastExpand || 0)
                if (window.__xhsLastExpand && elapsed < 2400) await wait(2400 - elapsed)
                if (shouldStopPage()) break
                debugState.expandAttempts += 1
                const clicked = await clickExpandButton(btn)
                window.__xhsLastExpand = Date.now()
                if (!clicked) continue
                const grew = await waitForReplyGrowth(pn, vr, er, shouldStopPage)
                if (grew) debugState.expandSuccesses += 1
                progressed = progressed || grew
                if (shouldStopPage()) break
                await wait(grew ? randomBetween(760, 1120) : randomBetween(1100, 1600))
                if (shouldStopPage()) break
              }
            }
            if (progressed) {
              idleRounds = 0
            } else if (!hasPendingHiddenReplies(root)) {
              break
            } else {
              idleRounds += 1
              if (idleRounds >= 5) break
            }
            if (shouldStopPage()) break
            await wait(randomBetween(340, 620))
          }
        }
        const collectCommentTree = () => {
          const roots = []
          const findDirectChild = (node, sel) => { if (!node?.children) return null; for (const c of Array.from(node.children)) { if (c?.nodeType === 1 && c.matches && c.matches(sel)) return c } return null }
          const commentPicturesOf = (cn) => { const pe = cn.querySelector('.comment-picture, .comment-picture-container, .img-box'); if (!pe) return []; return Array.from(pe.querySelectorAll('img')).map(el => el.getAttribute('src') || '').filter(Boolean) }
          const extractCommentRow = (cn, { parentId = null, rootId = '', depth = 0, sortIndex = 0, replyToName = null } = {}) => {
            if (!cn) return null
            const commentId = commentIdOf(cn), content = commentTextOf(cn), dateText = timeOf(cn)
            return {
              comment_id: commentId, root_comment_id: rootId || commentId || '', parent_comment_id: parentId,
              reply_to_comment_id: parentId, reply_to_user_name: replyToName, user_id: '', user_name: authorOf(cn),
              user_avatar: avatarOf(cn), user_profile_url: extractAuthorHref(cn), content,
              like_count: parseLikes(cn.querySelector('.like .count, .count')), reply_count: replyCountOf(cn),
              time_text: dateText, time_iso: parseCommentTimeText(dateText), location: locationOf(cn),
              is_author: isAuthorOf(cn), pictures: commentPicturesOf(cn), depth, sort_index: sortIndex,
              page_no: targetPage, raw_json: { comment_dom_id: cn.getAttribute?.('id') || '' }, children: [],
            }
          }
          parentCommentNodes(commentsRoot()).forEach((pn, pi) => {
            try {
              const pi2 = findDirectChild(pn, '.comment-item') || pn.querySelector(':scope > .comment-item') || pn.querySelector('.comment-item:not(.comment-item-sub)')
              if (!pi2) return
              const parent = extractCommentRow(pi2, { parentId: null, rootId: commentIdOf(pi2), depth: 0, sortIndex: pi, replyToName: null })
              if (!parent) return
              const rc = findDirectChild(pn, '.reply-container') || pn.querySelector(':scope > .reply-container') || pn.querySelector('.reply-container')
              const children = rc ? Array.from(rc.querySelectorAll('.comment-item-sub, .comment-item.comment-item-sub')) : []
              children.forEach((cn, ci) => {
                try { const child = extractCommentRow(cn, { parentId: parent.comment_id || null, rootId: parent.comment_id || '', depth: 1, sortIndex: pi * 1000 + ci + 1, replyToName: parent.user_name || null }); if (child) parent.children.push(child) } catch { debugState.nodeErrors += 1 }
              })
              roots.push(parent)
            } catch { debugState.nodeErrors += 1 }
          })
          return roots
        }
        const flattenCommentTrees = (trees) => {
          const rows = []
          const walk = (node) => {
            if (!node) return
            const row = { ...node }
            delete row.children
            rows.push(row)
            for (const child of (node.children || [])) walk(child)
          }
          for (const tree of Array.isArray(trees) ? trees : []) walk(tree)
          return rows
        }
        const extractTotalCommentHint = () => {
          const totalText = clean(commentsRoot().querySelector('.total')?.textContent || '')
          const match = totalText.match(/共\\s*(\\d+)\\s*条评论/)
          return match ? Number(match[1]) : 0
        }
        const mergeRowsIntoPage = (trees) => {
          let newRows = 0
          for (const row of flattenCommentTrees(trees)) {
            if (pageRows.length >= pageSize) break
            const rowId = clean(row?.comment_id)
            if (!rowId || seenCommentIds.has(rowId)) continue
            seenCommentIds.add(rowId)
            pageRows.push(row)
            newRows += 1
          }
          const hint = extractTotalCommentHint()
          if (hint > 0) pagerState.totalCommentHint = Math.max(Number(pagerState.totalCommentHint || 0), hint)
          return newRows
        }
        const scrollMetrics = (scroller) => {
          if (scroller && typeof scroller.scrollTop === 'number') {
            return {
              top: Number(scroller.scrollTop || 0),
              height: Number(scroller.scrollHeight || 0),
              client: Number(scroller.clientHeight || 0),
            }
          }
          const doc = document.documentElement || document.body
          return {
            top: Number(window.scrollY || window.pageYOffset || 0),
            height: Number(doc?.scrollHeight || document.body?.scrollHeight || 0),
            client: Number(window.innerHeight || doc?.clientHeight || 0),
          }
        }
        const stepScroll = async (scroller) => {
          const before = scrollMetrics(scroller)
          const delta = Math.max(560, Math.floor((before.client || 720) * 1.05))
          if (scroller && typeof scroller.scrollBy === 'function') scroller.scrollBy(0, delta)
          else if (scroller && typeof scroller.scrollTo === 'function') scroller.scrollTo(0, before.top + delta)
          else window.scrollBy(0, delta)
          await wait(randomBetween(680, 980))
          const after = scrollMetrics(scroller)
          return { before, after }
        }
        const resetCommentsViewportForPageOne = async () => {
          if (targetPage !== 1) return
          window[pagerStateKey] = pagerState
          const scroller = noteScroller()
          if (scroller && typeof scroller.scrollTo === 'function') scroller.scrollTo(0, 0)
          else if (scroller && typeof scroller.scrollTop === 'number') scroller.scrollTop = 0
          try { window.scrollTo(0, 0) } catch {}
          await wait(randomBetween(520, 860))
        }
        try {
          collectionStartedAt = Date.now()
          trace('page_start', { page: targetPage, pageSize, maxScrollRounds: effectiveMaxScrollRounds, budget: pageCollectionBudgetMs, existing: existingIds.length })
          await resetCommentsViewportForPageOne()
          if (targetPage > 1) await wait(randomBetween(120, 240))
          for (let i = 0; i < 20; i++) { if (commentsRoot().querySelector('.parent-comment')) break; await wait(200) }
          for (let round = 0; round < effectiveMaxScrollRounds; round++) {
            if (shouldStopPage()) {
              debugState.exitReason = 'filled_page_size'
              break
            }
            debugState.scrollRounds = round + 1
            const root = commentsRoot(), scroller = noteScroller()
            await expandReplyThreads(root)
            if (shouldStopPage()) {
              debugState.exitReason = 'filled_page_size'
              break
            }
            const parentsBeforeScroll = collectCommentTree()
            const appendedBeforeScroll = mergeRowsIntoPage(parentsBeforeScroll)
            if (shouldStopPage()) {
              debugState.exitReason = 'filled_page_size'
              break
            }
            const beforeSignature = parentSignatureOf(root)
            debugState.lastBeforeSignature = beforeSignature
            debugState.reachedEnd = reachedEnd()
            const { before, after } = await stepScroll(scroller)
            debugState.lastBeforeTop = before.top
            debugState.lastAfterTop = after.top
            debugState.lastBeforeHeight = before.height
            debugState.lastAfterHeight = after.height
            await expandReplyThreads(commentsRoot())
            const parentsAfterScroll = collectCommentTree()
            const appendedAfterScroll = mergeRowsIntoPage(parentsAfterScroll)
            if (shouldStopPage()) {
              debugState.exitReason = 'filled_page_size'
              break
            }
            const afterSignature = parentSignatureOf(commentsRoot())
            debugState.lastAfterSignature = afterSignature
            debugState.reachedEnd = reachedEnd()
            const appendedThisRound = appendedBeforeScroll + appendedAfterScroll
            const moved = after.top > before.top || after.height > before.height || afterSignature !== beforeSignature
            trace('round_end', {
              page: targetPage,
              round: round + 1,
              loaded: currentLoadedCommentCount(),
              appendedBeforeScroll,
              appendedAfterScroll,
              appendedThisRound,
              moved,
              plateauRounds: debugState.plateauRounds,
              reachedEnd: debugState.reachedEnd,
            })
            if (appendedThisRound === 0 && !moved) debugState.plateauRounds += 1
            else debugState.plateauRounds = 0
            if (Date.now() - collectionStartedAt >= pageCollectionBudgetMs) {
              debugState.exitReason = 'budget_hit'
              break
            }
            if (debugState.plateauRounds >= underfilledPlateauRounds) {
              debugState.exitReason = 'plateau_hit'
              break
            }
          }
          const loadedCount = currentLoadedCommentCount()
          const parents = collectCommentTree()
          const totalParents = parents.length
          const totalRows = flattenCommentTrees(parents).length
          const visibleParentCount = commentsRoot().querySelectorAll('.parent-comment').length
          if (visibleParentCount > 0 && totalRows === 0) throw new Error('zero rows extracted despite visible nodes')
          mergeRowsIntoPage(parents)
          const selected = pageRows.map((row, idx) => ({ ...row, sort_index: idx })).filter(item => item && item.comment_id)
          const pendingHiddenReplies = hasPendingHiddenReplies(commentsRoot())
          debugState.lastLoadedRootCount = loadedCount
          debugState.lastVisibleRootIds = parentCommentNodes(commentsRoot())
            .map(node => commentIdOf(node.querySelector('.comment-item')))
            .filter(Boolean)
            .slice(-8)
          const newIds = selected.map(c => c.comment_id).filter(Boolean)
          const topLevelCount = selected.filter(item => !item.parent_comment_id).length
          const lastAnchorCommentId = selected.map(item => item.comment_id).filter(Boolean).slice(-1)[0] || ''
          const cursorAdvanced = Boolean(lastAnchorCommentId) && clean(lastAnchorCommentId) !== clean(cursorCommentId || '')
          const hasMore = newIds.length > 0 && !debugState.reachedEnd
          if (!debugState.exitReason) {
            debugState.exitReason = loadedCount >= pageSize ? 'filled_page_size_or_continue' : 'no_new_ids'
          }
          pagerState.reachedEnd = debugState.reachedEnd
          pagerState.cursorCommentId = lastAnchorCommentId
          window[pagerStateKey] = pagerState
          const results = selected.map((item, idx) => ({
            ...item, sort_index: idx, estimated_total_top_level: Math.max(loadedCount, Number(pagerState.totalCommentHint || 0), totalRows),
            top_level_count_current_page: topLevelCount, has_more: hasMore, page: targetPage, page_size: pageSize,
            debug_scroll_rounds: debugState.scrollRounds, debug_reached_end: debugState.reachedEnd,
            debug_expand_attempts: debugState.expandAttempts, debug_expand_successes: debugState.expandSuccesses,
            debug_pending_hidden_replies: pendingHiddenReplies, debug_parent_count: totalRows,
            debug_visible_parent_count: visibleParentCount, debug_node_errors: debugState.nodeErrors, debug_plateau_rounds: debugState.plateauRounds,
            debug_loaded_root_count: loadedCount,
            debug_last_before_top: debugState.lastBeforeTop,
            debug_last_after_top: debugState.lastAfterTop,
            debug_last_before_height: debugState.lastBeforeHeight,
            debug_last_after_height: debugState.lastAfterHeight,
            debug_last_before_signature: debugState.lastBeforeSignature,
            debug_last_after_signature: debugState.lastAfterSignature,
            debug_end_node_text: debugState.endNodeText,
            debug_last_visible_root_ids: debugState.lastVisibleRootIds,
          }))
          return {
            pageUrl: location.href, securityBlock, loginWall, page: targetPage, pageSize,
            topLevelCountCurrentPage: topLevelCount, estimatedTotalTopLevel: Math.max(loadedCount, Number(pagerState.totalCommentHint || 0), totalRows), hasMore, newIds, cursorCommentId: lastAnchorCommentId, results,
            debugNodeErrors: debugState.nodeErrors, debugFatalError: debugState.fatalError,
            debugVisibleParentCount: visibleParentCount, debugLoadedRootCount: loadedCount, debugExitReason: debugState.exitReason,
            debugLastBeforeTop: debugState.lastBeforeTop,
            debugLastAfterTop: debugState.lastAfterTop,
            debugLastBeforeHeight: debugState.lastBeforeHeight,
            debugLastAfterHeight: debugState.lastAfterHeight,
            debugLastBeforeSignature: debugState.lastBeforeSignature,
            debugLastAfterSignature: debugState.lastAfterSignature,
            debugEndNodeText: debugState.endNodeText,
            debugLastVisibleRootIds: debugState.lastVisibleRootIds,
          }
        } catch (error) {
          debugState.fatalError = String(error?.stack || error?.message || error || '')
          return {
            pageUrl: location.href, securityBlock, loginWall, page: targetPage, pageSize,
            topLevelCountCurrentPage: 0, estimatedTotalTopLevel: 0, hasMore: false, newIds: [], cursorCommentId: cursorCommentId || '', results: [],
            debugNodeErrors: debugState.nodeErrors, debugFatalError: debugState.fatalError,
            debugVisibleParentCount: commentsRoot().querySelectorAll('.parent-comment').length,
            debugExitReason: debugState.exitReason || 'error',
          }
        }
      })()
    `;
}

export { buildXhsProfileUrl, parseXhsProfileHref } from './note-helpers.js';
export { parseCommentTimeText, parseCommentLimit };
