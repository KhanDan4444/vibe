/**
 * Zod schemas for list/report query parameters.
 */

const { z } = require('zod');

const emptyToUndefined = (v) => (v === '' || v == null ? undefined : v);

const paginationQuerySchema = z.object({
  page: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).optional()),
  limit: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(200).optional()),
});

const memberListSortSchema = z.enum(['name_asc', 'name_desc', 'expiry_asc', 'expiry_desc']).optional();

const gymListSortSchema = z.enum(['name_asc', 'name_desc', 'license_asc', 'license_desc']).optional();

const paymentSortSchema = z.enum(['date_desc', 'date_asc', 'name_asc', 'name_desc']).optional();

const memberFilterSchema = z.enum(['unpaid', 'due_soon', 'expired']).optional();

const gymFilterSchema = z.enum(['unpaid', 'due_soon', 'expired', 'needs_renewal']).optional();

const subscriptionStatusQuerySchema = z
  .enum(['active', 'suspended', 'expired', 'Active', 'Suspended', 'Expired', 'All'])
  .optional();

const paymentPresetSchema = z
  .enum(['today', 'this_week', 'this_month', 'last_month', 'last_30_days', 'this_year'])
  .optional();

const isoDateQuery = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
  .optional();

const optionalSearch = z.preprocess(
  emptyToUndefined,
  z.string().trim().max(200).optional()
);

const optionalPositiveIntQuery = z.preprocess((v) => {
  if (v === '' || v == null || v === 'all') return undefined;
  return v;
}, z.coerce.number().int().positive().optional());

const paymentMethodFilterSchema = z.preprocess(
  emptyToUndefined,
  z.string().trim().max(50).optional()
);

const memberListQuerySchema = paginationQuerySchema.extend({
  search: optionalSearch,
  status: z.preprocess(emptyToUndefined, z.string().trim().max(50).optional()),
  filter: memberFilterSchema,
  sort: memberListSortSchema,
  branch_id: optionalPositiveIntQuery,
});

const ownerPaymentListQuerySchema = paginationQuerySchema.extend({
  search: optionalSearch,
  method: paymentMethodFilterSchema,
  preset: paymentPresetSchema,
  from: isoDateQuery,
  to: isoDateQuery,
  sort: paymentSortSchema,
  branch_id: optionalPositiveIntQuery,
});

const adminGymListQuerySchema = paginationQuerySchema.extend({
  search: optionalSearch,
  status: subscriptionStatusQuerySchema,
  filter: gymFilterSchema,
  sort: gymListSortSchema,
  gym_id: optionalPositiveIntQuery,
});

const adminPaymentListQuerySchema = paginationQuerySchema.extend({
  search: optionalSearch,
  preset: paymentPresetSchema,
  from: isoDateQuery,
  to: isoDateQuery,
  sort: paymentSortSchema,
  gym_id: optionalPositiveIntQuery,
});

const ADMIN_SMS_TYPE_VALUES = [
  'all',
  'gym_license_due_in_3_days',
  'gym_license_expires_today',
  'gym_license_expired',
  'otp_forgot_password',
  'otp_gym_signup',
];

const MEMBER_SMS_TYPE_VALUES = [
  'all',
  'member_due_soon',
  'member_expires_today',
  'member_expired',
];

const adminGymSmsQuerySchema = paginationQuerySchema.extend({
  type: z.preprocess(
    (v) => (v == null || v === '' ? 'all' : String(v).toLowerCase()),
    z.enum(ADMIN_SMS_TYPE_VALUES)
  ),
  gym_id: optionalPositiveIntQuery,
});

const memberSmsQuerySchema = paginationQuerySchema.extend({
  type: z.preprocess(
    (v) => (v == null || v === '' ? 'all' : String(v).toLowerCase()),
    z.enum(MEMBER_SMS_TYPE_VALUES)
  ),
  branch_id: optionalPositiveIntQuery,
});

module.exports = {
  memberListQuerySchema,
  ownerPaymentListQuerySchema,
  adminGymListQuerySchema,
  adminPaymentListQuerySchema,
  adminGymSmsQuerySchema,
  memberSmsQuerySchema,
};
