/**
 * Xiaohongshu note-comments — fetch note summary and paged comments in one page open.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CliError, EmptyResultError } from '@jackwener/opencli/errors';
import { NOTE_EXTRACT_JS } from './note.js';
import { buildCommentsExtractJs, parseXhsLikeCountText, parseXhsProfileHref } from './comments.js';
import { parseNoteId, buildNoteUrl } from './note-helpers.js';

function normalizeCount(value) {
    return String(parseXhsLikeCountText(value));
}

function formatStageError(stage, error) {
    const err = error instanceof Error ? error : new Error(String(error ?? 'unknown error'));
    const detail = err.stack || err.message || String(error);
    return `${stage} failed: ${detail}`;
}

export const command = cli({
    site: 'xiaohongshu',
    name: 'note-comments',
    access: 'read',
    description: '一次打开页面获取小红书笔记摘要和分页评论',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
        { name: 'note-id', required: true, positional: true, help: 'Full Xiaohongshu note URL or bare note ID' },
        { name: 'page-size', type: 'int', default: 100, help: 'Top-level comments per page' },
        { name: 'page', type: 'int', default: 1, help: 'Top-level comment page number' },
        { name: 'expand-replies', type: 'boolean', default: true, help: 'Include nested replies' },
        { name: 'max-scroll-rounds', type: 'int', default: 6, help: 'Maximum comment-area scroll rounds' },
        { name: 'expand-rounds', type: 'int', default: 3, help: 'Maximum reply-expansion rounds' },
    ],
    columns: ['note_id', 'title', 'author', 'comments'],
    func: async (pageApi, kwargs) => {
        const raw = String(kwargs['note-id']);
        const noteId = parseNoteId(raw);
        const pageNo = Math.max(1, Number(kwargs.page) || 1);
        const pageSize = Math.max(1, Math.min(Number(kwargs['page-size']) || 100, 100));
        const withReplies = kwargs['expand-replies'] !== false;
        const maxScrollRounds = Math.max(1, Math.min(Number(kwargs['max-scroll-rounds']) || 6, 40));
        const expandRounds = Math.max(1, Math.min(Number(kwargs['expand-rounds']) || 3, 10));
        const noteUrl = buildNoteUrl(raw, { commandName: 'xiaohongshu note-comments', allowUnsignedFallback: true });

        let existingIds = [];
        let cursorCommentId = '';
        let noteData;
        const noteStateKey = noteId;
        if (pageNo === 1) {
            try {
                await pageApi.goto(noteUrl);
                await pageApi.wait({ time: 2 + Math.random() * 3 });
            } catch (error) {
                throw new CliError(
                    'NOTE_COMMENTS_NAVIGATE_FAILED',
                    formatStageError('navigate', error),
                    'Failed to open the note detail page before collecting comments.',
                );
            }

            try {
                noteData = await pageApi.evaluate(NOTE_EXTRACT_JS);
            } catch (error) {
                throw new CliError(
                    'NOTE_COMMENTS_NOTE_EVAL_FAILED',
                    formatStageError('note-evaluate', error),
                    'Fetching note summary failed inside the page context.',
                );
            }
            if (!noteData || typeof noteData !== 'object') {
                throw new EmptyResultError('xiaohongshu/note-comments', 'Unexpected note evaluate response');
            }
            if (noteData.securityBlock) {
                throw new CliError('SECURITY_BLOCK', 'Xiaohongshu security block: the note detail page was blocked by risk control.', /^https?:\/\//.test(raw)
                    ? 'The page may be temporarily restricted. Try again later or from a different session.'
                    : 'Try using a full URL from search results (with xsec_token) instead of a bare note ID.');
            }
            if (noteData.loginWall) {
                throw new AuthRequiredError('www.xiaohongshu.com', 'Note content requires login');
            }
            if (noteData.notFound) {
                throw new EmptyResultError('xiaohongshu/note-comments', `Note ${noteId} not found or unavailable — it may have been deleted or restricted`);
            }
        } else {
            existingIds = await pageApi.evaluate(() => {
                const s = window.__xhsCommentState;
                return s && Array.isArray(s.collectedIds) && s.noteId ? s.collectedIds : [];
            });
            cursorCommentId = await pageApi.evaluate(() => {
                const s = window.__xhsCommentState;
                return s && s.noteId && typeof s.cursorCommentId === 'string' ? s.cursorCommentId : '';
            });
            noteData = await pageApi.evaluate(() => {
                const s = window.__xhsCommentState;
                return s && s.noteId ? s.noteData : null;
            });
            if (!noteData || typeof noteData !== 'object') {
                try { noteData = await pageApi.evaluate(NOTE_EXTRACT_JS); } catch {}
                if (!noteData || typeof noteData !== 'object') noteData = {};
            }
        }

        let commentData;
        try {
            const commentsEvalJs = buildCommentsExtractJs({
                withReplies,
                page: pageNo,
                pageSize,
                maxScrollRounds,
                expandRounds,
                existingIds,
                cursorCommentId,
            });
            commentData = pageApi.evaluateWithOptions
                ? await pageApi.evaluateWithOptions(commentsEvalJs, { timeoutSeconds: 60 })
                : await pageApi.evaluate(commentsEvalJs);
        } catch (error) {
            throw new CliError(
                'NOTE_COMMENTS_COMMENTS_EVAL_FAILED',
                formatStageError('comments-evaluate', error),
                'Fetching comments failed inside the page context.',
            );
        }
        if (!commentData || typeof commentData !== 'object') {
            throw new EmptyResultError('xiaohongshu/note-comments', 'Unexpected comments evaluate response');
        }
        if (commentData.securityBlock) {
            throw new CliError('SECURITY_BLOCK', 'Xiaohongshu security block: the note detail page was blocked by risk control.', /^https?:\/\//.test(raw)
                ? 'The page may be temporarily restricted. Try again later or from a different session.'
                : 'Try using a full URL from search results (with xsec_token) instead of a bare note ID.');
        }
        if (commentData.loginWall) {
            throw new AuthRequiredError('www.xiaohongshu.com', 'Note comments require login');
        }
        if (commentData.debugFatalError) {
            throw new CliError(
                'NOTE_COMMENTS_COMMENTS_SCRIPT_FAILED',
                `comments-script failed: ${String(commentData.debugFatalError)}`,
                'The comment extraction script hit a page-specific DOM/runtime edge case.',
            );
        }

        const newIds = Array.isArray(commentData.newIds) ? commentData.newIds : [];
        const collectedIds = Array.from(new Set([...existingIds, ...newIds].filter(Boolean)));
        const nextCursorCommentId = typeof commentData.cursorCommentId === 'string' && commentData.cursorCommentId
            ? commentData.cursorCommentId
            : (newIds.length > 0 ? newIds[newIds.length - 1] : cursorCommentId);
        await pageApi.evaluate((state) => { window.__xhsCommentState = state; }, { noteId: noteStateKey, noteData, collectedIds, cursorCommentId: nextCursorCommentId || '' });

        try {
            const authorProfileUrl = typeof noteData.authorProfileUrl === 'string' ? noteData.authorProfileUrl : '';
            const imageUrls = Array.isArray(noteData.images) ? noteData.images.filter((value) => typeof value === 'string' && value) : [];
            const tags = Array.isArray(noteData.tags) ? noteData.tags.filter((value) => typeof value === 'string' && value) : [];
            const comments = Array.isArray(commentData.results) ? commentData.results : [];

            return {
                note: {
                    note_id: noteId,
                    note_url: noteUrl,
                    title: noteData.title || '',
                    content: noteData.desc || '',
                    author_id: authorProfileUrl ? parseXhsProfileHref(authorProfileUrl) : '',
                    author_name: noteData.author || '',
                    author_avatar: noteData.authorAvatar || '',
                    cover_url: imageUrls[0] || '',
                    image_urls: imageUrls,
                    video_url: '',
                    video_addr: '',
                    likes: Number(normalizeCount(noteData.likes || '0')),
                    collects: Number(normalizeCount(noteData.collects || '0')),
                    comments: Number(normalizeCount(noteData.comments || '0')),
                    shares: 0,
                    type: noteData.type || '',
                    tags,
                    raw: {
                        pageUrl: noteData.pageUrl || noteUrl,
                        authorProfileUrl,
                        images: imageUrls,
                        tags,
                        _fallbackDebug: noteData._fallbackDebug || '',
                    },
                },
                comments,
                page: commentData.page || pageNo,
                page_size: commentData.pageSize || pageSize,
                top_level_count_current_page: commentData.topLevelCountCurrentPage || 0,
                estimated_total_top_level: commentData.estimatedTotalTopLevel || 0,
                has_more: Boolean(commentData.hasMore),
            };
        } catch (error) {
            throw new CliError(
                'NOTE_COMMENTS_POSTPROCESS_FAILED',
                formatStageError('postprocess', error),
                'The collected note/comments payload could not be normalized.',
            );
        }
    },
});
