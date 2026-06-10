// lib/telegram-handlers/revise.js — blog/guide revision via editor feedback,
// plus cross-table post lookup for smart-intent routing.
//
// Pure move out of server.js (decomposition step 3.3).

require('dotenv').config();
const { createLLM, parseLLMJson } = require('../llm');
const { getPostById } = require('../supabase');
const { sendNotification, removeButtons } = require('../telegram');

/**
 * Locate a post by ID, searching social posts then blog posts in both projects.
 * Returns { kind: 'social' | 'blog', brand, post } or null. Used by smart-intent
 * routing so a chat-typed "revise post X" command can dispatch to the correct
 * table/project even when the user doesn't specify which.
 */
async function findPostAnywhere(postId) {
  if (!postId) return null;
  // Try social first (primary project)
  try {
    const social = await getPostById(postId);
    if (social) return { kind: 'social', brand: social.brand || 'auctionbrain', post: social };
  } catch {}
  // Try blog in both projects
  for (const brand of ['auctionbrain', 'bridgematch']) {
    try {
      const { getBlogPostById } = require('../supabase');
      const blog = await getBlogPostById(postId, brand);
      if (blog) return { kind: 'blog', brand: blog.brand || brand, post: blog };
    } catch {}
  }
  return null;
}

/**
 * Apply an editor instruction to a blog/guide post using the same writer
 * context (voice rules, source articles, existing posts) the original
 * generator had. Updates the blog_posts row, optionally clears the original
 * Telegram review buttons, and sends a fresh review card with the new title.
 *
 * Used from both the Revise button callback and the natural-language
 * smart-intent revise path. originalCaption / messageId are optional —
 * when absent (smart-intent), we skip the "stamp REVISED" step.
 */
async function reviseBlogPost(opts) {
  const { postId, brand, contentType, editorText, chatId, messageId, originalCaption } = opts;
  const {
    getBlogClient,
    getBlogPostById,
    getSourceArticlesForPost,
    getPublishedPostsForBrand
  } = require('../supabase');
  const { getVoiceForBrand } = require('../voice');

  await sendNotification('Reading the draft, your feedback, and the source articles...');

  // Fetch the post + source articles + existing posts in parallel
  const [post, sourceArticles, existingPosts] = await Promise.all([
    getBlogPostById(postId, brand),
    getSourceArticlesForPost(postId, brand),
    getPublishedPostsForBrand(brand, 30)
  ]);

  // Persist the editor feedback for traceability (best-effort)
  try {
    const client = getBlogClient(brand);
    await client.from('blog_posts').update({ revision_feedback: editorText }).eq('id', postId);
  } catch (e) { console.warn(`  revision_feedback save failed: ${e.message}`); }

  const sysPrompt = getVoiceForBrand(brand);
  const baseDomain = brand === 'bridgematch' ? 'bridgematch.co.uk' : 'auctionbrain.co.uk';

  const sourceMaterialBlock = sourceArticles.length === 0
    ? '(Source material no longer linked to this post — work from the draft and editor instruction. Do not invent facts.)'
    : sourceArticles
        .map(a => `### ${a.title || 'Untitled'}${a.url ? ` (${a.url})` : ''}\n${(a.content || '').slice(0, 1500)}`)
        .join('\n\n---\n\n');

  const existingPostsBlock = existingPosts.length === 0
    ? '(No published posts available for internal linking yet.)'
    : existingPosts
        .map(p => `- "${p.title}" — ${p.summary || 'No summary'} [/blog/${p.slug}]${p.cluster ? ` [cluster: ${p.cluster}]` : ''}`)
        .join('\n');

  const userPrompt = `You wrote the draft below. The editor wants changes. Apply faithfully — and feel free to pull deeper from the source articles or add internal links where genuinely useful.

ORIGINAL DRAFT
TITLE: ${post.title}
SUMMARY: ${post.summary || ''}
CLUSTER: ${post.cluster || '(untagged)'}

MARKDOWN BODY:
${post.content || ''}

---

SOURCE MATERIAL (the same articles you originally drew from)

${sourceMaterialBlock}

---

EXISTING PUBLISHED POSTS (candidates for internal linking — anchor text must be descriptive, only link if genuinely relevant; full URL is https://${baseDomain}/blog/<slug>)

${existingPostsBlock}

---

EDITOR INSTRUCTION:
"${editorText}"

---

Apply the editor's instruction. Keep the voice rules. Use the source material for any fresh facts/quotes — do not fabricate. Return the FULL revised post — do not truncate.

Return ONLY this JSON (no commentary, no markdown fences):
{
  "title": "Updated title (or unchanged)",
  "summary": "Updated 1-2 sentence summary",
  "content": "Full revised markdown body — keep H1/H2/H3 hierarchy, end with the --- divider + author byline",
  "change_note": "One sentence describing what you changed and why"
}`;

  const resp = await createLLM().messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8000,
    system: sysPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });
  const txt = resp.content[0].text;
  const revised = parseLLMJson(txt, { label: 'blog-revise' });

  // Re-render markdown to HTML for the live blog page
  const { marked } = require('marked');
  const sanitizeHtml = require('sanitize-html');
  const newHtml = sanitizeHtml(await marked.parse(revised.content || post.content), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'h3', 'h4', 'img']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ['src', 'alt', 'title'] }
  });

  // Build the update object with only columns that definitely exist
  // across both Supabase projects. updated_at lives on AB's table but
  // not BM's, so omit it.
  const updateRow = {
    title: revised.title || post.title,
    summary: revised.summary || post.summary,
    content: revised.content || post.content,
    content_html: newHtml,
    iteration_count: (post.iteration_count || 1) + 1
  };
  const client = getBlogClient(brand);
  const { error: updateErr } = await client.from('blog_posts').update(updateRow).eq('id', postId);
  if (updateErr) throw new Error(updateErr.message);

  // Mark the original review message as superseded (only if we have it)
  if (chatId && messageId) {
    try {
      await removeButtons(chatId, messageId, `${(originalCaption || post.title)}\n\nREVISED · ${revised.change_note || 'edits applied'}`);
    } catch {}
  }

  // Re-send a fresh review message with the new title/summary
  const { sendBlogForReview } = require('../telegram');
  const wordCount = (revised.content || '').split(/\s+/).filter(Boolean).length;
  await sendBlogForReview({
    content_type: contentType,
    brand,
    source: 'revision',
    post_id: postId,
    title: revised.title || post.title,
    summary: revised.summary || post.summary,
    score: post.evaluation_score,
    word_count: wordCount
  });
  console.log(`[Telegram] Revised ${contentType} ${postId}: ${revised.change_note || 'edits applied'}`);
}


module.exports = { findPostAnywhere, reviseBlogPost };
