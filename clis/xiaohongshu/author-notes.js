import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import {
  readUserSnapshotHydrated,
  readUserSnapshot,
  assertReadableUserSnapshot,
  isLoginWallSnapshot,
} from './user.js';
import { extractXhsUserNotes } from './user-helpers.js';
import { buildUserSearchExtractJs, stripXhsUserNameSuffix } from './user-search.js';

const WEB_HOST = 'www.xiaohongshu.com';
const MAX_FIFO = 200;
const MAX_SCROLL = 8;

function throwLoginWall() {
  throw new AuthRequiredError('xiaohongshu.com', 'Xiaohongshu requires login; re-login and retry.');
}

async function searchAndMatchUser(page, keyword, xhsId) {
  const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.wait(2000);
  const body = await page.evaluate(() => (document.body?.innerText || '').trim().slice(0, 100));
  if (/登录/.test(body)) throwLoginWall();
  if (!await page.evaluate(() => document.querySelector('#user.channel.active'))) {
    await page.evaluate(() => { const t = document.querySelector('#user.channel'); if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }
  await page.evaluate(() => new Promise(r => { let t = 0; const c = () => { if (document.querySelectorAll('.user-item-box').length > 0) return r(); if (++t > 40) return r(); setTimeout(c, 500); }; c(); }));
  const users = await page.evaluate(buildUserSearchExtractJs(WEB_HOST));
  if (!Array.isArray(users) || users.length === 0) return null;

  const qf = keyword.replace(/\s+/g, '').toLowerCase();
  const xhsIdFold = xhsId ? xhsId.replace(/\s+/g, '').toLowerCase() : '';

  for (const u of users) {
    if (!u.user_id) continue;
    const nameFold = stripXhsUserNameSuffix(u.name || '').replace(/\s+/g, '').toLowerCase();
    const nameMatch = nameFold === qf;
    const idMatch = xhsIdFold && u.xiaohongshu_id && u.xiaohongshu_id.replace(/\s+/g, '').toLowerCase() === xhsIdFold;
    if (xhsId) {
      if (nameMatch && idMatch) return u;
    } else {
      if (nameMatch) return u;
    }
  }
  return null;
}

function normalizeInteractions(raw) {
  if (!raw || typeof raw !== 'object') return {};
  if (Array.isArray(raw)) {
    const r = {};
    for (const i of raw) { if (i && typeof i === 'object') { const k = i.name || i.type || i.label || ''; const v = i.count ?? i.value ?? i.number ?? ''; if (k) r[k] = String(v); } }
    return r;
  }
  return raw;
}

function pick(v, ...ks) { if (!v || typeof v !== 'object') return '0'; for (const k of ks) { const x = v[k]; if (x !== undefined && x !== null && x !== '') return String(x); } return '0'; }

async function extractAuthor(snapshot, authorId, sr, page) {
  const pd = (snapshot?.pageData && typeof snapshot.pageData === 'object' && snapshot.pageData) || {};
  const ud = pd.user || pd.basicInfo || pd.basic_info || pd.profile || {};
  const raw = pd.interactions || ud.interactions;
  const ints = normalizeInteractions(raw);
  let followed = sr.followed || '';
  if (!followed && page) { try { followed = await page.evaluate(() => { const b = document.querySelector('.xhs-user-follow-area .follow-button'); return b ? (b.textContent || '').trim() : ''; }) || ''; } catch {} }
  return {
    author_id: authorId,
    name: sr.name || ud.nickname || ud.nickName || ud.name || '',
    avatar: sr.avatar || ud.images || ud.imageb || ud.avatar || '',
    fans: sr.fans || pick(ints, '粉丝', 'fans', 'fans_count', 'fansCount') || '0',
    follows: pick(ints, '关注', 'follows', 'follow_count', 'followCount') || '0',
    likes_collects: pick(ints, '获赞与收藏', '获赞和收藏', 'interaction', 'faved_count', 'favedCount', 'likes_collects') || '0',
    notes_count: sr.notes_count || '0',
    bio: ud.desc || ud.description || ud.personal_desc || ud.bio || '',
    followed,
    profile_url: sr.profile_url || `https://${WEB_HOST}/user/profile/${authorId}`,
  };
}

async function initState(page) {
  await page.evaluate(() => { window.__xhsAns = { uniqIds: [] }; });
}

async function getUniqIds(page) {
  return page.evaluate(() => { const s = window.__xhsAns; return s ? s.uniqIds : null; });
}

async function pushIds(page, ids) {
  if (ids.length === 0) return;
  await page.evaluate((newIds, maxFifo) => {
    const s = window.__xhsAns;
    if (!s) return;
    for (const id of newIds) {
      if (!s.uniqIds.includes(id)) {
        s.uniqIds.push(id);
        if (s.uniqIds.length > maxFifo) s.uniqIds = s.uniqIds.slice(-maxFifo);
      }
    }
  }, ids, MAX_FIFO);
}

const EXTRACT_NOTE_JS = `() => {
  const c = document.querySelector('#noteContainer');
  if (!c) return null;

  const getText = (sel) => {
    const el = c.querySelector(sel);
    return el ? (el.textContent || '').trim() : '';
  };

  const title = getText('#detail-title');
  const dateStr = getText('.date');
  const likeStr = c.querySelector('.engage-bar .like-wrapper .count')?.textContent?.trim() || '0';
  const collectStr = c.querySelector('.engage-bar .collect-wrapper .count')?.textContent?.trim() || '0';
  const chatStr = c.querySelector('.engage-bar .chat-wrapper .count')?.textContent?.trim() || '0';
  const authorName = getText('.author .username');
  const avatarImg = c.querySelector('.author .avatar-item');
  const authorAvatar = avatarImg ? (avatarImg.getAttribute('src') || '') : '';
  const noteType = c.getAttribute('data-type') || '';

  const poster = c.querySelector('.xgplayer-poster');
  let coverUrl = '';
  if (poster) {
    const bg = poster.style.backgroundImage || '';
    coverUrl = bg.replace(/^url\\(["']?|["']?\\)$/g, '');
  }

  const videoEl = c.querySelector('video');
  let videoUrl = '';
  if (videoEl) {
    const src = videoEl.getAttribute('src') || '';
    if (src && !src.startsWith('blob:')) videoUrl = src;
    if (!videoUrl) {
      const sourceEl = videoEl.querySelector('source');
      if (sourceEl) videoUrl = sourceEl.getAttribute('src') || '';
    }
    if (!videoUrl) {
      try { videoUrl = videoEl.currentSrc || ''; } catch {}
    }
  }
  if (!videoUrl && c.querySelector('.media-container.video-player-media')) {
    const xg = c.querySelector('.xgplayer');
    if (xg) {
      const cfg = xg.getAttribute('data-url') || xg.getAttribute('data-src') || '';
      if (cfg && !cfg.startsWith('blob:')) videoUrl = cfg;
    }
  }

  const imageUrls = [];
  const seen = new Set();
  const realSlides = c.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate)');
  if (realSlides.length > 0) {
    realSlides.forEach(slide => {
      const img = slide.querySelector('img');
      if (img) {
        const src = img.getAttribute('src') || '';
        if (src && !seen.has(src)) { seen.add(src); imageUrls.push(src); }
      }
    });
  } else {
    const imgs = c.querySelectorAll('.media-container img:not(.avatar-item):not(.xgplayer-icon *)');
    imgs.forEach(img => {
      const src = img.getAttribute('src') || '';
      if (src && !seen.has(src)) { seen.add(src); imageUrls.push(src); }
    });
  }
  if (!coverUrl && imageUrls.length > 0) coverUrl = imageUrls[0];

  const descText = getText('#detail-desc');
  const tags = (descText.match(/#[^#\\s]+/g) || []).map(t => t.slice(1));
  const cleanDesc = descText.replace(/#[^#\\s]+/g, '').replace(/\\s+/g, ' ').trim();

  const now = new Date();
  const cy = now.getFullYear();
  let ts = 0;
  const d4 = dateStr.match(/(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})/);
  if (d4) {
    ts = new Date(+d4[1], +d4[2] - 1, +d4[3]).getTime();
  } else {
    const d2y = dateStr.match(/(\\d{2})[-/](\\d{1,2})[-/](\\d{1,2})/);
    if (d2y) {
      ts = new Date(2000 + +d2y[1], +d2y[2] - 1, +d2y[3]).getTime();
    } else {
      const md = dateStr.match(/(\\d{1,2})[-/](\\d{1,2})/);
      if (md) {
        let d = new Date(cy, +md[1] - 1, +md[2]);
        if (d > now) d = new Date(cy - 1, +md[1] - 1, +md[2]);
        ts = d.getTime();
      } else if (/今天/.test(dateStr)) {
        ts = new Date(cy, now.getMonth(), now.getDate()).getTime();
      } else if (/昨天/.test(dateStr)) {
        const y = new Date(now); y.setDate(y.getDate() - 1);
        ts = new Date(y.getFullYear(), y.getMonth(), y.getDate()).getTime();
      } else if (/前天/.test(dateStr)) {
        const y = new Date(now); y.setDate(y.getDate() - 2);
        ts = new Date(y.getFullYear(), y.getMonth(), y.getDate()).getTime();
      } else {
        const dayMatch = dateStr.match(/(\\d+)\\s*天前/);
        if (dayMatch) {
          const y = new Date(now); y.setDate(y.getDate() - +dayMatch[1]);
          ts = new Date(y.getFullYear(), y.getMonth(), y.getDate()).getTime();
        } else if (/刚刚/.test(dateStr)) {
          ts = now.getTime();
        } else {
          const hourMatch = dateStr.match(/(\\d+)\\s*(?:小时|时)\\s*前/);
          if (hourMatch) ts = now.getTime() - +hourMatch[1] * 3600000;
          else {
            const minMatch = dateStr.match(/(\\d+)\\s*分钟前/);
            if (minMatch) ts = now.getTime() - +minMatch[1] * 60000;
          }
        }
      }
    }
  }

  return { title, desc: cleanDesc, date: dateStr, ts, likeStr, collectStr, chatStr, authorName, authorAvatar, noteType, coverUrl, videoUrl, imageUrls, tags };
}`;

async function clickNoteAndExtract(page, noteId) {
  const clickResult = await page.evaluate(async (nid) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const tryFind = () => {
      const sel = 'section.note-item a[href*="/' + nid + '"]';
      const link = document.querySelector(sel);
      if (!link) return null;
      const href = link.getAttribute('href') || '';
      const fullUrl = href.startsWith('http') ? href : 'https://www.xiaohongshu.com' + href;
      const card = link.closest('section.note-item') || link.parentElement;
      if (!card) return null;
      card.scrollIntoView({ block: 'center' });
      const rect = card.getBoundingClientRect();
      return { ok: true, url: fullUrl, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    };
    let r = tryFind();
    if (!r) {
      window.scrollBy(0, 200);
      await sleep(300);
      r = tryFind();
    }
    if (!r) {
      window.scrollBy(0, -400);
      await sleep(300);
      r = tryFind();
    }
    return r || { ok: false };
  }, noteId);
  if (!clickResult || !clickResult.ok) return null;
  const noteUrl = clickResult.url || `https://www.xiaohongshu.com/explore/${noteId}`;
  await page.wait(200 + Math.random() * 300);
  await page.nativeClick(clickResult.x, clickResult.y);
  await page.wait(1000);

  let hasPopup = await page.evaluate(() => !!document.querySelector('#noteContainer'));
  if (!hasPopup) {
    const rect = clickResult;
    for (const offset of [{ x: 0, y: -40 }, { x: 40, y: 20 }, { x: -30, y: 30 }]) {
      await page.nativeClick(rect.x + offset.x, rect.y + offset.y);
      await page.wait(1000);
      hasPopup = await page.evaluate(() => !!document.querySelector('#noteContainer'));
      if (hasPopup) break;
    }
  }

  if (!hasPopup) {
    await page.evaluate(() => {
      const el = document.querySelector('.tab-content-item, .feeds-container, .main-content');
      if (el) el.scrollBy(0, 250);
    });
    await page.wait(500);
    await page.nativeClick(clickResult.x, clickResult.y - 30);
    await page.wait(1200);
    hasPopup = await page.evaluate(() => !!document.querySelector('#noteContainer'));
  }

  if (!hasPopup) {
    const titleRect = await page.evaluate((nid) => {
      const link = document.querySelector('section.note-item a[href*="/' + nid + '"]');
      const card = link?.closest('section.note-item');
      if (!card) return null;
      const titleEl = card.querySelector('a.title, .note-title a, a[class*="title"]');
      if (!titleEl) return null;
      titleEl.scrollIntoView({ block: 'center' });
      const r = titleEl.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, noteId);
    if (titleRect) {
      await page.nativeClick(titleRect.x, titleRect.y);
      await page.wait(1500);
      hasPopup = await page.evaluate(() => !!document.querySelector('#noteContainer'));
    }
  }

  if (!hasPopup) {
    await page.wait(2000);
  }
  const detail = await page.evaluate(EXTRACT_NOTE_JS);
  if (!detail) return null;

  await page.wait(200);
  let stillOpen = await page.evaluate(() => !!document.querySelector('#noteContainer'));
  if (stillOpen) {
    const maskRect = await page.evaluate(() => {
      const mask = document.querySelector('.note-detail-mask');
      if (!mask) return null;
      const m = mask.getBoundingClientRect();
      const c = document.querySelector('#noteContainer');
      const n = c ? c.getBoundingClientRect() : null;
      return { mw: m.width, mh: m.height, nx: n ? n.left : 0, ny: n ? n.top : 0, nw: n ? n.width : 0 };
    });
    if (maskRect) {
      const clickX = 20;
      const clickY = Math.min(maskRect.ny + 50, maskRect.mh - 10);
      await page.nativeClick(clickX, clickY);
      await page.wait(400);
    }
    stillOpen = await page.evaluate(() => !!document.querySelector('#noteContainer'));
    if (stillOpen) {
      await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
      await page.wait(500);
      stillOpen = await page.evaluate(() => !!document.querySelector('#noteContainer'));
    }
    if (stillOpen) {
      await page.evaluate(() => {
        const mask = document.querySelector('.note-detail-mask');
        if (mask) mask.click();
      });
      await page.wait(500);
    }
  }

  return {
    id: noteId,
    title: detail.title || '',
    type: detail.noteType || '',
    likes: detail.likeStr || '0',
    collects: detail.collectStr || '0',
    comments: detail.chatStr || '0',
    cover: detail.coverUrl || '',
    desc: detail.desc || '',
    date: detail.date || '',
    author_name: detail.authorName || '',
    author_avatar: detail.authorAvatar || '',
    tags: detail.tags || [],
    timestamp: detail.ts || 0,
    video_url: detail.videoUrl || '',
    cover_urls: detail.imageUrls || [],
    url: noteUrl,
  };
}

export const command = cli({
  site: 'xiaohongshu',
  name: 'author-notes',
  access: 'read',
  description: '搜索博主并逐个点击笔记弹窗采集详情',
  domain: WEB_HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'query', type: 'string', default: '', positional: true, help: '博主名称（第1页必填）' },
    { name: 'page', type: 'int', default: 1, help: '页码' },
    { name: 'limit', type: 'int', default: 30, help: '每页笔记数' },
    { name: 'author-id', type: 'string', default: '', help: '博主ID（第2+页必填，校验用）' },
    { name: 'xhs-id', type: 'string', default: '', help: '小红书号，提供时与昵称双重校验' },
    { name: 'detail', type: 'boolean', default: true, help: '是否点开获取笔记详情' },
  ],
  columns: ['id', 'title', 'type', 'likes', 'collects', 'comments', 'cover', 'url'],
  func: async (page, kwargs) => {
    const pageNum = Math.max(1, Number(kwargs.page ?? 1));
    const limit = Math.max(1, Number(kwargs.limit ?? 30));
    const isFirst = pageNum === 1;
    const withDetail = kwargs.detail !== false;

    async function collectNote(n) {
      if (withDetail) return await clickNoteAndExtract(page, n.id);
      return {
        id: n.id || '',
        title: n.title || '',
        type: n.type || '',
        likes: n.likes || '0',
        collects: '0',
        comments: '0',
        cover: n.cover || '',
        desc: '',
        date: '',
        author_name: '',
        author_avatar: '',
        tags: [],
        timestamp: 0,
        video_url: '',
        cover_urls: [],
        url: n.url || '',
      };
    }

    if (isFirst) {
      const kw = String(kwargs.query || '').trim();
      if (!kw) throw new ArgumentError('query is required for page 1');
      const xhsId = String(kwargs['xhs-id'] || '').trim();

      const matched = await searchAndMatchUser(page, kw, xhsId);
      if (!matched) throw new EmptyResultError('xiaohongshu author-notes', '博主不存在');

      const authorId = String(matched.user_id || '').trim();
      await page.goto(`https://${WEB_HOST}/user/profile/${authorId}`);
      let snapshot = await readUserSnapshotHydrated(page);
      if (isLoginWallSnapshot(snapshot)) throwLoginWall();
      assertReadableUserSnapshot(snapshot);

      const author = await extractAuthor(snapshot, authorId, matched, page);
      await initState(page);

      let collected = [];
      let scrollCount = 0;
      let noNewCount = 0;

      while (collected.length < limit && scrollCount <= MAX_SCROLL) {
        snapshot = await readUserSnapshot(page);
        const all = extractXhsUserNotes(snapshot ?? {}, authorId, WEB_HOST);
        const uniqIds = await getUniqIds(page) || [];
        const seenSet = new Set(uniqIds);

        let newInBatch = 0;
        for (const n of all) {
          if (collected.length >= limit) break;
          if (seenSet.has(n.id)) continue;

          const note = await collectNote(n);
          if (note) {
            collected.push(note);
            seenSet.add(n.id);
            newInBatch++;
          }
        }
        await pushIds(page, collected.map(n => n.id));

        if (newInBatch === 0) {
          noNewCount++;
          if (noNewCount >= 2) break;
        } else {
          noNewCount = 0;
        }

        if (collected.length >= limit) break;
        if (scrollCount >= MAX_SCROLL) break;

        await page.autoScroll({ times: 1, delayMs: 1500 });
        await page.wait(1);
        scrollCount++;
      }

      if (collected.length === 0) {
        throw new EmptyResultError('xiaohongshu author-notes', '该用户没有公开笔记。');
      }

      return {
        author,
        notes: collected,
        page: 1,
        has_more: collected.length >= limit,
        author_id: authorId,
      };
    }

    const authorId = String(kwargs['author-id'] || '').trim();
    if (!authorId) throw new ArgumentError('author-id is required for page 2+');
    const curUrl = await page.evaluate(() => window.location.href);
    if (!curUrl.includes(`/user/profile/${authorId}`)) {
      throw new CommandExecutionError('博主页面已变化，请重新从第1页开始搜索');
    }

    let collected = [];
    let scrollCount = 0;
    let noNewCount = 0;

    while (collected.length < limit && scrollCount < MAX_SCROLL) {
      const snapshot = await readUserSnapshot(page);
      if (isLoginWallSnapshot(snapshot)) throwLoginWall();
      const all = extractXhsUserNotes(snapshot ?? {}, authorId, WEB_HOST);
      const uniqIds = await getUniqIds(page) || [];
      const seenSet = new Set(uniqIds);

      let newInBatch = 0;
      for (const n of all) {
        if (collected.length >= limit) break;
        if (seenSet.has(n.id)) continue;

        const note = await collectNote(n);
        if (note) {
          collected.push(note);
          seenSet.add(n.id);
          newInBatch++;
        }
      }
      await pushIds(page, collected.map(n => n.id));

      if (newInBatch === 0) {
        noNewCount++;
        if (noNewCount >= 2) break;
      } else {
        noNewCount = 0;
      }

      if (collected.length >= limit) break;
      if (scrollCount >= MAX_SCROLL) break;

      await page.autoScroll({ times: 1, delayMs: 1500 });
      await page.wait(1);
      scrollCount++;
    }

    return {
      notes: collected,
      page: pageNum,
      has_more: collected.length >= limit,
      author_id: authorId,
    };
  },
});
