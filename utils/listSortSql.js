/**
 * @file listSortSql.js
 * @description Whitelisted ORDER BY clauses for list and report queries (SQL-injection safe).
 */

/** @param {string} sort - name_asc | name_desc */
function parseNameColumnSortOrder(sort, column) {
  return sort === 'name_desc'
    ? `LOWER(${column}) DESC, ${column} DESC`
    : `LOWER(${column}) ASC, ${column} ASC`;
}

/** Admin gym directory — name or SaaS license end. */
function parseGymListSortOrder(sort) {
  switch (sort) {
    case 'license_asc':
      return 'g.saas_end_date ASC NULLS LAST, LOWER(g.name) ASC';
    case 'license_desc':
      return 'g.saas_end_date DESC NULLS LAST, LOWER(g.name) ASC';
    case 'name_desc':
      return parseNameColumnSortOrder('name_desc', 'g.name');
    case 'name_asc':
    default:
      return parseNameColumnSortOrder('name_asc', 'g.name');
  }
}

/** Gym owner members — name or membership expiry. */
function parseMemberListSortOrder(sort) {
  switch (sort) {
    case 'expiry_asc':
      return 'm.end_date ASC NULLS LAST, LOWER(m.name) ASC';
    case 'expiry_desc':
      return 'm.end_date DESC NULLS LAST, LOWER(m.name) ASC';
    case 'name_desc':
      return parseNameColumnSortOrder('name_desc', 'm.name');
    case 'name_asc':
    default:
      return parseNameColumnSortOrder('name_asc', 'm.name');
  }
}

/** Admin platform revenue — date or gym name. */
function parseAdminPaymentSortOrder(sort) {
  switch (sort) {
    case 'name_asc':
      return `${parseNameColumnSortOrder('name_asc', 'g.name')}, p.date DESC, p.id DESC`;
    case 'name_desc':
      return `${parseNameColumnSortOrder('name_desc', 'g.name')}, p.date DESC, p.id DESC`;
    case 'date_asc':
      return 'p.date ASC, p.id ASC';
    case 'date_desc':
    default:
      return 'p.date DESC, p.id DESC';
  }
}

/** Gym owner revenue — date or member name. */
function parseOwnerPaymentSortOrder(sort) {
  switch (sort) {
    case 'name_asc':
      return `${parseNameColumnSortOrder('name_asc', 'm.name')}, p.date DESC, p.id DESC`;
    case 'name_desc':
      return `${parseNameColumnSortOrder('name_desc', 'm.name')}, p.date DESC, p.id DESC`;
    case 'date_asc':
      return 'p.date ASC, p.id ASC';
    case 'date_desc':
    default:
      return 'p.date DESC, p.id DESC';
  }
}

/** Default export sort order (A–Z directory tables). */
const DEFAULT_REPORT_MEMBER_SORT = 'name_asc';
const DEFAULT_REPORT_ADMIN_REVENUE_SORT = 'name_asc';
const DEFAULT_REPORT_OWNER_REVENUE_SORT = 'name_asc';

module.exports = {
  parseGymListSortOrder,
  parseMemberListSortOrder,
  parseAdminPaymentSortOrder,
  parseOwnerPaymentSortOrder,
  DEFAULT_REPORT_MEMBER_SORT,
  DEFAULT_REPORT_ADMIN_REVENUE_SORT,
  DEFAULT_REPORT_OWNER_REVENUE_SORT,
};
