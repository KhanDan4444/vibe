const { z } = require('zod');
const { STAFF_ROLES, DEFAULT_STAFF_ROLE } = require('../utils/roles');
const { isValidEthiopianPhone, normalizeEthiopianPhone } = require('../utils/phone');
const {
  refineEnrollMemberPayment,
  refineRenewMemberPayment,
  refineChangeMemberPlanPayment,
  refineAdminEnrollGymPayment,
  refineRenewGymPayment,
  refineChangeGymPlanPayment,
  refinePaymentDateNotFuture,
} = require('./paymentRefine');

const trimmed = (max) => z.string().trim().min(1, 'Required').max(max);
const optionalTrimmed = (max) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((v) => (v === '' || v == null ? undefined : v));

const dateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const optionalDate = z.union([dateField, z.null()]).optional();

const positiveInt = z.coerce.number().int().positive();
const optionalPositiveInt = z.coerce.number().int().positive().optional();

const positiveAmount = z.coerce.number().positive('Must be a positive number');

const email = z.string().trim().email().max(255);
const optionalEmail = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim().toLowerCase();
    return s === '' ? null : s;
  },
  z.union([email, z.null()])
);
const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters')
  .max(30, 'Username must be at most 30 characters')
  .regex(/^[a-z0-9._]+$/, 'Username may only contain letters, numbers, dots, and underscores');
const loginIdentifier = z.string().trim().min(1, 'Email or username is required').max(255);
const password = z.string().min(8, 'Password must be at least 8 characters').max(128);
const otpCode = z.string().trim().min(4, 'Enter the verification code').max(8);
const otpSessionId = z.string().uuid('Invalid or expired verification session');
const ethiopianPhone = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .max(30)
  .refine(isValidEthiopianPhone, 'Enter a valid Ethiopian mobile number')
  .transform(normalizeEthiopianPhone);

const optionalEthiopianPhone = z.preprocess(
  (v) => (v === '' || v == null ? undefined : v),
  z
    .string()
    .trim()
    .max(30)
    .refine(isValidEthiopianPhone, 'Enter a valid Ethiopian mobile number')
    .transform(normalizeEthiopianPhone)
    .optional()
);
const paymentMethod = z.string().trim().min(1).max(50).optional();

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const subscriptionStatus = z.enum(['active', 'suspended', 'expired']);

const loginSchema = z.object({
  email: loginIdentifier,
  password: z.string().min(1, 'Password is required').max(128),
  rememberMe: z.boolean().optional().default(false),
});

const registerAdminSchema = z.object({
  name: trimmed(200),
  email,
  password,
});

const registerGymSchema = z.object({
  gym_name: trimmed(200),
  owner_name: trimmed(200),
  email: optionalEmail,
  username,
  password,
  phone: ethiopianPhone,
  saas_plan_id: positiveInt,
});

const createMemberSchema = z.object({
  name: trimmed(200),
  phone: ethiopianPhone,
  plan_id: positiveInt,
  start_date: dateField,
  branch_id: positiveInt.optional(),
});

const enrollMemberSchema = z
  .object({
    name: trimmed(200),
    phone: ethiopianPhone,
    plan_id: positiveInt,
    start_date: dateField,
    amount: z.coerce.number().positive().optional(),
    date: optionalDate,
    method: paymentMethod,
    skip_payment: z.boolean().optional(),
    branch_id: positiveInt.optional(),
    photo: z.string().max(3_000_000).optional(),
  })
  .superRefine((data, ctx) => {
    refineEnrollMemberPayment(data, ctx);
  });

const renewMemberSchema = z
  .object({
    plan_id: optionalPositiveInt,
    start_date: optionalDate,
    amount: positiveAmount,
    date: optionalDate,
    method: paymentMethod,
  })
  .superRefine((data, ctx) => {
    refineRenewMemberPayment(data, ctx);
  });

const changeMemberPlanSchema = z
  .object({
    plan_id: positiveInt,
    start_date: optionalDate,
    amount: z.coerce.number().min(0, 'Must be zero or more'),
    date: optionalDate,
    method: paymentMethod,
  })
  .superRefine((data, ctx) => {
    refineChangeMemberPlanPayment(data, ctx);
  });

const transferMemberSchema = z.object({
  branch_id: positiveInt,
});

const updateMemberSchema = z.object({
  name: trimmed(200).optional(),
  phone: optionalEthiopianPhone,
  plan_id: optionalPositiveInt,
  start_date: optionalDate,
});

const createPaymentSchema = z
  .object({
    member_id: positiveInt,
    amount: positiveAmount,
    date: optionalDate,
    method: paymentMethod,
  })
  .superRefine((data, ctx) => {
    refinePaymentDateNotFuture(data, ctx, 'date');
  });

const updatePaymentSchema = z
  .object({
    amount: positiveAmount,
    date: dateField,
    method: trimmed(50),
  })
  .superRefine((data, ctx) => {
    refinePaymentDateNotFuture(data, ctx, 'date');
  });

const createPlanSchema = z.object({
  name: trimmed(200),
  duration: z.coerce.number().int().min(1, 'Duration must be at least 1 month'),
  price: z.coerce
    .number()
    .min(0, 'Price cannot be negative'),
});

const updatePlanSchema = z.object({
  name: trimmed(200).optional(),
  duration: z.coerce.number().int().min(1).optional(),
  price: z.coerce.number().min(0).optional(),
});

const adminEnrollGymSchema = z
  .object({
    gym_name: trimmed(200),
    owner_name: trimmed(200),
    email: optionalEmail,
    username,
    password,
    phone: ethiopianPhone,
    saas_plan_id: positiveInt,
    start_date: optionalDate,
    amount: z.coerce.number().positive().optional(),
    date: optionalDate,
    method: paymentMethod,
    skip_payment: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    refineAdminEnrollGymPayment(data, ctx);
  });

const updateGymSchema = z.object({
  name: trimmed(200),
  owner_name: trimmed(200),
  phone: ethiopianPhone,
  subscription_status: subscriptionStatus.optional(),
  saas_plan_id: optionalPositiveInt,
});

/** Gym owner self-service profile (partial update). */
const updateOwnerProfileSchema = z
  .object({
    name: trimmed(200).optional(),
    gym_name: trimmed(200).optional(),
    phone: ethiopianPhone.optional(),
    email: email.optional(),
    username: username.optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.gym_name !== undefined ||
      data.phone !== undefined ||
      data.email !== undefined ||
      data.username !== undefined,
    { message: 'At least one field is required.' }
  );

const renewGymSchema = z
  .object({
    saas_plan_id: optionalPositiveInt,
    start_date: optionalDate,
    amount: positiveAmount,
    date: optionalDate,
    method: paymentMethod,
    notes: optionalTrimmed(500),
  })
  .superRefine((data, ctx) => {
    refineRenewGymPayment(data, ctx);
  });

const changeGymPlanSchema = z
  .object({
    saas_plan_id: positiveInt,
    start_date: optionalDate,
    amount: z.coerce.number().min(0, 'Must be zero or more'),
    date: optionalDate,
    method: paymentMethod,
    notes: optionalTrimmed(500),
  })
  .superRefine((data, ctx) => {
    refineChangeGymPlanPayment(data, ctx);
  });

const adminCreatePaymentSchema = z
  .object({
    gym_id: positiveInt,
    saas_plan_id: optionalPositiveInt,
    amount: positiveAmount,
    date: optionalDate,
    method: paymentMethod,
    notes: optionalTrimmed(500),
  })
  .superRefine((data, ctx) => {
    refinePaymentDateNotFuture(data, ctx, 'date');
  });

const adminUpdatePaymentSchema = z
  .object({
    amount: positiveAmount,
    date: dateField,
    method: trimmed(50),
    notes: optionalTrimmed(500),
  })
  .superRefine((data, ctx) => {
    refinePaymentDateNotFuture(data, ctx, 'date');
  });

const createSaasPlanSchema = z.object({
  name: trimmed(200),
  duration: z.coerce.number().int().min(1, 'Duration must be at least 1 month'),
  price: z.coerce
    .number()
    .min(0, 'Price cannot be negative'),
  description: optionalTrimmed(1000),
});

const updateSaasPlanSchema = z.object({
  name: trimmed(200).optional(),
  duration: z.coerce.number().int().min(1).optional(),
  price: z.coerce.number().min(0).optional(),
  description: optionalTrimmed(1000),
  is_active: z.boolean().optional(),
});

const forgotPasswordSchema = z.object({
  email,
});

const requestForgotOtpSchema = z.object({
  username: loginIdentifier,
});

const resetForgotOtpSchema = z.object({
  sessionId: otpSessionId,
  code: otpCode,
  password,
});

const gymSignupRequestOtpSchema = z.object({
  phone: ethiopianPhone,
});

const gymSignupCompleteSchema = z.object({
  sessionId: otpSessionId,
  code: otpCode,
  gym_name: trimmed(200),
  owner_name: trimmed(200),
  email: optionalEmail,
  username,
  password,
  phone: ethiopianPhone,
  saas_plan_id: positiveInt,
});

const resetPasswordSchema = z.object({
  token: z.string().trim().min(32).max(128),
  password,
});

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(128),
    newPassword: password,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must be different from the current password.',
    path: ['newPassword'],
  });

/** Set a new password on behalf of a user (platform admin or gym owner). */
const adminSetPasswordSchema = z.object({
  password,
});

const createStaffSchema = z.object({
  name: trimmed(200),
  email: optionalEmail,
  username,
  password,
  staff_role: z.enum(STAFF_ROLES).default(DEFAULT_STAFF_ROLE),
  branch_id: positiveInt,
});

const updateStaffSchema = z
  .object({
    name: trimmed(200).optional(),
    email: optionalEmail.optional(),
    username: username.optional(),
    password: password.optional(),
    staff_role: z.enum(STAFF_ROLES).optional(),
    branch_id: positiveInt.optional(),
    is_active: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'At least one field is required.',
  });

const createBranchSchema = z.object({
  name: trimmed(200),
  phone: optionalEthiopianPhone,
  address: optionalTrimmed(500),
});

const reassignBranchStaffSchema = z.object({
  target_branch_id: positiveInt,
});

const updateBranchSchema = z
  .object({
    name: trimmed(200).optional(),
    phone: optionalEthiopianPhone.optional(),
    address: optionalTrimmed(500).optional(),
    is_active: z.boolean().optional(),
    is_default: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'At least one field is required.',
  });

module.exports = {
  idParamSchema,
  loginSchema,
  registerAdminSchema,
  registerGymSchema,
  createMemberSchema,
  enrollMemberSchema,
  renewMemberSchema,
  changeMemberPlanSchema,
  transferMemberSchema,
  updateMemberSchema,
  createPaymentSchema,
  updatePaymentSchema,
  createPlanSchema,
  updatePlanSchema,
  adminEnrollGymSchema,
  updateGymSchema,
  updateOwnerProfileSchema,
  renewGymSchema,
  changeGymPlanSchema,
  adminCreatePaymentSchema,
  adminUpdatePaymentSchema,
  createSaasPlanSchema,
  updateSaasPlanSchema,
  forgotPasswordSchema,
  requestForgotOtpSchema,
  resetForgotOtpSchema,
  gymSignupRequestOtpSchema,
  gymSignupCompleteSchema,
  resetPasswordSchema,
  changePasswordSchema,
  adminSetPasswordSchema,
  createStaffSchema,
  updateStaffSchema,
  createBranchSchema,
  updateBranchSchema,
  reassignBranchStaffSchema,
};
