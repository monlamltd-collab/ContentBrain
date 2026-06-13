'use strict';

// lib/dashboard/editorial-queries.js — data layer for the Editorial tab.
// Wraps the same lib/supabase helpers the /api/content/* JSON endpoints use
// so fragments and JSON stay consistent.

const {
  getPublishedBlogPostsBothBrands,
  getDraftBlogPosts,
  getPendingBriefsAll,
} = require('../supabase');

const VALID_BRANDS = ['auctionbrain', 'bridgematch'];

/**
 * Tag coverage across published posts, optionally brand-filtered.
 * Classification mirrors GET /api/content/coverage: 1-2 covered, 3+ saturated.
 */
async function getCoverage(brand) {
  const posts = await getPublishedBlogPostsBothBrands();
  const filtered = brand && VALID_BRANDS.includes(brand)
    ? posts.filter(p => p.brand === brand)
    : posts;

  const tagCount = {};
  for (const post of filtered) {
    const tags = Array.isArray(post.tags) ? post.tags : [];
    for (const tag of tags) tagCount[tag] = (tagCount[tag] || 0) + 1;
  }

  const coverage = Object.entries(tagCount)
    .map(([tag, count]) => ({ tag, count, status: count >= 3 ? 'saturated' : 'covered' }))
    .sort((a, b) => b.count - a.count);

  return { posts: filtered.length, coverage };
}

async function getQueue() {
  return getDraftBlogPosts();
}

async function getBriefs() {
  return getPendingBriefsAll();
}

module.exports = { getCoverage, getQueue, getBriefs, VALID_BRANDS };
