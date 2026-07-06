/**
 * Shared offset pagination helpers for list endpoints.
 */

function parsePaginationQuery(query, { defaultLimit = 10, maxLimit = 200 } = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function paginatedResponse(items, total, page, limit, extra = {}) {
  return {
    items,
    total,
    page,
    limit,
    totalPages: total > 0 ? Math.ceil(total / limit) : 1,
    ...extra,
  };
}

module.exports = {
  parsePaginationQuery,
  paginatedResponse,
};
